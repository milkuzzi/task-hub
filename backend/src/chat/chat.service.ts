import { Inject, Injectable, Logger } from '@nestjs/common';
import { AssignmentKind, Attachment, Message, Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import {
  AccessDeniedException,
  EntityNotFoundException,
  RateLimitException,
  ValidationException,
} from '../common/errors';
import { PrismaService } from '../infra';
import {
  AttachmentRepository,
  AttachmentWithCreatedAt,
  ChatMuteRepository,
  MessageReadRepository,
  MessageReadWithUser,
  MessageRepository,
  MessageWithAttachments,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { Actor, StatusMachine } from '../status';
import { saturateMessageCount } from '../tasks/message-counter';
import { AUDIT_RECORDER, AuditRecorder } from '../tasks/ports';
import { ChatNotificationRouter } from '../notifications';
import { RateLimiter } from '../security';
import { StorageService } from '../storage';
import { hasAdminPrivileges } from '../users/permissions';
import { ChatGateway } from './chat.gateway';
import { AttachmentMetaView, ChatMessageHttpView, toAttachmentMeta } from './chat-representation';

/**
 * Представление Сообщения Чата для рассылки подключённым Участникам через
 * {@link ChatGateway} (Req 11.3, 11.5, 11.7).
 *
 * Несёт денормализованное имя автора на момент создания (Req 8.4), метку
 * «изменено» (`editedAt`, Req 11.5) и признак удаления (`deleted`, Req 11.7) —
 * по `deleted` клиент отображает на месте Сообщения метку «Сообщение удалено».
 * Поле `taskId` добавляется для адресации Сообщения к комнате Задачи на клиенте.
 */
export interface ChatMessageView {
  id: string;
  taskId: string;
  chatId: string;
  authorId: string | null;
  authorDisplayName: string;
  authorAvatarPath?: string | null;
  text: string;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
}

/**
 * Представление одного прочитавшего Сообщение Участника (Req 11.8).
 *
 * Несёт идентификатор Пользователя, его отображаемое имя и момент прочтения —
 * этого достаточно, чтобы показать список прочитавших всем Участникам чата.
 */
export interface MessageReaderView {
  userId: string;
  displayName: string;
  readAt: Date;
}

/**
 * Представление списка прочитавших Сообщение для рассылки в комнату Задачи
 * (Req 11.8). Адресует список к конкретному Сообщению и Задаче на клиенте.
 */
export interface MessageReadersView {
  messageId: string;
  taskId: string;
  readers: MessageReaderView[];
}

/** Результат атомарной отправки Сообщения: само Сообщение, счётчик и статус. */
interface SendOutcome {
  message: Message;
  messageCount: number;
  status: TaskStatus;
  statusChanged: boolean;
  previousStatus: TaskStatus;
}

/**
 * Прикладной сервис realtime-чата (Req 11.3–11.7, 10.1–10.3).
 *
 * Реализует отправку, редактирование и удаление Сообщений Чата Задачи с учётом
 * прав Участников и авто-переходом Статуса Задачи по сообщению (Req 10.1–10.3):
 *
 * - {@link sendMessage} — валидация длины текста (1–4000, Req 11.3, 11.4),
 *   проверка принадлежности отправителя к Участникам чата (Req 11.2),
 *   атомарное сохранение Сообщения с денормализованным именем автора,
 *   насыщающим инкрементом счётчика Сообщений (Req 9.7, 9.9) и авто-переходом
 *   Статуса через {@link StatusMachine.onChatMessage} (Req 10.1–10.3), а затем —
 *   немедленная рассылка Сообщения, счётчика и (при изменении) Статуса
 *   подключённым Участникам (доставка ≤2с, Req 11.3) и запись смены Статуса в
 *   Журнал изменений (Req 20.1);
 * - {@link editMessage} — права автора/Менеджера Задачи/Администратора
 *   (Req 11.5, 11.6), валидация длины и установка метки «изменено» с датой и
 *   временем (`editedAt`, Req 11.5);
 * - {@link deleteMessage} — права автора/Менеджера Задачи/Администратора
 *   (Req 11.6, 11.7) и пометка `deleted`, по которой на месте Сообщения
 *   отображается «Сообщение удалено» (Req 11.7).
 *
 * Доставка подключённым Участникам выполняется немедленно (синхронная рассылка
 * через Socket.IO после фиксации транзакции), что обеспечивает требование
 * ≤2 секунд (Req 11.3). Уведомления участникам вне сети (сайт/MAX) формирует
 * `NotificationsModule` (задачи 12.x) и здесь не затрагиваются.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageRepository: MessageRepository,
    private readonly messageReadRepository: MessageReadRepository,
    private readonly attachmentRepository: AttachmentRepository,
    private readonly chatMuteRepository: ChatMuteRepository,
    private readonly taskRepository: TaskRepository,
    private readonly userRepository: UserRepository,
    private readonly statusMachine: StatusMachine,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
    private readonly gateway: ChatGateway,
    private readonly chatNotifications: ChatNotificationRouter,
    private readonly rateLimiter: RateLimiter,
    @Inject(AUDIT_RECORDER) private readonly auditRecorder: AuditRecorder,
    private readonly storage: StorageService,
  ) {}

  /**
   * Отправляет Сообщение в Чат Задачи и доставляет его подключённым Участникам
   * (Req 11.3, 11.4, 11.2, 10.1–10.3, 9.7).
   *
   * Порядок (любой отказ происходит ДО сохранения, поэтому при ошибке ничего не
   * сохраняется, Req 11.4):
   * 0. ограничение частоты отправки Сообщений: не более 10 запросов с источника
   *    (отправителя) за скользящее окно 60с; избыточные отклоняются
   *    {@link RateLimitException} (HTTP 429) ДО любой валидации (Req 19.1, 19.2);
   * 1. валидация длины текста: 1–4000 символов; пустой или превышающий лимит
   *    текст отклоняется {@link ValidationException} (Req 11.3, 11.4);
   * 2. учётная запись отправителя активна, иначе отказ в доступе;
   * 3. Задача существует и отправитель — её Участник чата (Исполнитель/Менеджер
   *    Задачи или Администратор); недоступная Задача не раскрывается (Req 11.2,
   *    2.12) — проверка делегируется {@link TasksService.getVisibleTask} через
   *    его логику видимости;
   * 4. атомарно (в одной транзакции): вставка Сообщения с денормализованным
   *    именем автора (Req 8.4), насыщающий инкремент счётчика Сообщений
   *    (Req 9.7, 9.9) и авто-переход Статуса Задачи через
   *    {@link StatusMachine.onChatMessage} в зависимости от эффективной роли
   *    отправителя в Задаче (Исполнитель → «Ожидает»; Менеджер/Администратор →
   *    «В работе»; в «Выполнено»/«Отменено»/«Требует администратора» Статус
   *    стабилен — Req 10.1–10.3);
   * 5. после фиксации — немедленная рассылка Сообщения и счётчика, а при
   *    изменении Статуса — рассылка нового Статуса и запись смены Статуса в
   *    Журнал изменений (Req 11.3, 20.1).
   *
   * Эффективная роль для авто-перехода определяется по виду назначения в
   * Задаче: Менеджер, назначенный Исполнителем, считается Исполнителем (его
   * сообщение переводит Задачу в «Ожидает», Req 2.4, 10.1).
   *
   * @param senderId Идентификатор отправителя.
   * @param taskId Идентификатор Задачи.
   * @param text Текст Сообщения (1–4000 символов).
   * @param attachmentIds Идентификаторы ранее загруженных «висящих» Вложений,
   *   привязываемых к Сообщению при отправке (Req 12.1–12.5); допустимы лишь
   *   непривязанные Вложения этой Задачи, загруженные отправителем, числом не
   *   более лимита на Сообщение (Req 11.9).
   * @returns Сохранённое Сообщение в форме контракта ленты Чата
   *   ({@link ChatMessageHttpView}) с привязанными Вложениями и признаком
   *   наличия миниатюры (`hasThumbnail`) у каждого (Req 2.2, 12.6).
   * @throws RateLimitException Превышена частота отправки Сообщений (Req 19.1, 19.2).
   * @throws ValidationException Текст пуст или длиннее 4000 символов (Req 11.4).
   * @throws AccessDeniedException Учётная запись отправителя не найдена/удалена.
   * @throws EntityNotFoundException Задача недоступна отправителю (не Участник чата, Req 11.2, 2.12).
   */
  async sendMessage(
    senderId: string,
    taskId: string,
    text: string,
    attachmentIds: string[] = [],
  ): Promise<ChatMessageHttpView> {
    // 0. Ограничение частоты чувствительной операции отправки Сообщения
    //    (Req 19.1, 19.2): не более 10 запросов с источника за скользящее окно
    //    60с; избыточные отклоняются 429 ДО любой валидации и изменения
    //    состояния. Источником считается отправитель.
    const { allowed } = await this.rateLimiter.check(senderId, 'send_message');
    if (!allowed) {
      throw new RateLimitException();
    }

    // 1. Валидация длины ДО любого изменения состояния (Req 11.4).
    const validText = this.validateSendText(text, attachmentIds.length > 0);

    // 2. Активность отправителя.
    const sender = await this.userRepository.findActiveById(senderId);
    if (sender === null) {
      throw new AccessDeniedException('Учётная запись отправителя не найдена или удалена.');
    }

    // 3. Принадлежность к Участникам чата: недоступная Задача не раскрывается (Req 11.2, 2.12).
    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const actor = task === null ? null : this.resolveSenderActor(sender.role, senderId, task);
    if (task === null || actor === null) {
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }

    // 3a. Предварительная проверка привязываемых Вложений ДО сохранения Сообщения
    //     (Req 11.9, 12.1–12.5): привязать можно лишь «висящие» Вложения этой
    //     Задачи, загруженные отправителем, и не более лимита на Сообщение.
    //     Недопустимый идентификатор отклоняется без сохранения Сообщения.
    const linkIds =
      attachmentIds.length > 0
        ? await this.validateAttachmentsForLinking(task, sender, attachmentIds)
        : [];

    // 4. Атомарно: Сообщение + счётчик + авто-переход Статуса + привязка Вложений
    //    (Req 9.7, 10.1–10.3, 12.1–12.5).
    const outcome = await this.persistMessageAtomically(
      task,
      sender.id,
      sender.displayName,
      validText,
      actor,
      linkIds,
    );

    // 5. Немедленная доставка подключённым Участникам ≤2с (Req 11.3) и live-обновления.
    //    Дефект 2 («не отдан»): нагрузка несёт привязанные Вложения с признаком
    //    наличия миниатюры (`hasThumbnail`), чтобы свежеотправленное Сообщение
    //    показывало миниатюры без перезагрузки ленты (Req 2.2, 12.6).
    const view = await this.buildSentMessageView(
      outcome.message,
      taskId,
      linkIds,
      sender.avatarPath ?? null,
    );
    this.gateway.broadcastMessage(taskId, view);
    this.gateway.broadcastMessageCounter(taskId, { taskId, messageCount: outcome.messageCount });

    if (outcome.statusChanged) {
      // Журналируем смену Статуса (Req 20.1) и рассылаем новый Статус (live).
      await this.auditRecorder.record({
        taskId,
        authorId: sender.id,
        field: 'status',
        oldValue: outcome.previousStatus,
        newValue: outcome.status,
      });
      this.gateway.broadcastStatus(taskId, { taskId, status: outcome.status });
    }

    // Уведомление участникам о новом Сообщении (кроме автора и Администраторов,
    // Req 14.1, 14.2). Best-effort: сбой постановки уведомления в очередь не
    // должен влиять на уже сохранённое и разосланное Сообщение.
    await this.routeNewMessageNotification(task, outcome.message.id, sender.id);

    this.logger.log(
      `Сообщение «${outcome.message.id}» отправлено в задачу «${taskId}» пользователем ` +
        `«${senderId}» (роль в задаче ${actor}); счётчик=${outcome.messageCount}; ` +
        `привязано вложений: ${linkIds.length}; ` +
        `статус «${outcome.previousStatus}»${
          outcome.statusChanged ? ` → «${outcome.status}»` : ' без изменения'
        }.`,
    );
    return view;
  }

  /**
   * Редактирует текст Сообщения и проставляет метку «изменено» с датой и
   * временем (Req 11.5, 11.6).
   *
   * Право на редактирование имеют только автор Сообщения, Менеджер этой Задачи
   * и Администратор; иной Участник чата получает отказ, а исходное Сообщение
   * сохраняется без изменений (Req 11.6). Текст проверяется на длину 1–4000
   * (Req 11.5, 11.4). Момент изменения фиксируется в `editedAt` через
   * {@link ClockService} (метка «изменено», Req 11.5). Удалённое Сообщение
   * (помеченное `deleted`) редактировать нельзя.
   *
   * @param actorId Идентификатор инициатора правки.
   * @param messageId Идентификатор Сообщения.
   * @param text Новый текст (1–4000 символов).
   * @returns Обновлённое Сообщение в виде {@link ChatMessageView} с установленной
   *   меткой `editedAt` и идентификатором Задачи для REST-слоя.
   * @throws ValidationException Текст пуст или длиннее 4000 символов (Req 11.4).
   * @throws AccessDeniedException Учётная запись не найдена/удалена либо нет прав (Req 11.6).
   * @throws EntityNotFoundException Сообщение или Задача не найдены, либо Сообщение удалено.
   */
  async editMessage(actorId: string, messageId: string, text: string): Promise<ChatMessageView> {
    const validText = this.validateText(text);

    const { message, task, actor } = await this.loadMessageContext(actorId, messageId);
    if (message.deleted) {
      // Удалённое Сообщение остаётся в ленте как метка «Сообщение удалено» (Req 11.7).
      throw new EntityNotFoundException('Сообщение удалено и не может быть изменено.');
    }

    this.assertCanModify(actor.id, actor.role, message.authorId, task);

    const updated = await this.messageRepository.update(messageId, {
      text: validText,
      editedAt: this.clock.now(),
    });

    const view = this.toView(updated, task.id);
    this.gateway.broadcastMessage(task.id, view);

    this.logger.log(
      `Сообщение «${messageId}» отредактировано пользователем «${actorId}»; метка «изменено» установлена.`,
    );
    return view;
  }

  /**
   * Удаляет Сообщение, помечая его меткой «Сообщение удалено», и удаляет
   * связанные Вложения вместе с их файлами (Req 11.6, 11.7, 2.8).
   *
   * Право на удаление имеют только автор Сообщения, Менеджер этой Задачи и
   * Администратор; иной Участник чата получает отказ, а Сообщение сохраняется
   * без изменений (Req 11.6). Удаление Сообщения логическое: запись остаётся в
   * ленте, но помечается `deleted`, по которому на её месте отображается метка
   * «Сообщение удалено» (Req 11.7). Счётчик Сообщений Задачи при этом не
   * меняется — удалённые Сообщения остаются в ленте (Req 9.7).
   *
   * Дефект 8: если у Сообщения есть Вложения, они и их файлы не должны
   * оставаться осиротевшими. В одной транзакции выбираются связанные Вложения,
   * удаляются их записи и помечается удалённым само Сообщение; после фиксации
   * транзакции удаляются объекты в хранилище (`storagePath` и `thumbnailPath`).
   * Очистка файлов устойчива к отсутствию объекта: {@link StorageService.delete}
   * идемпотентно, а каждое удаление дополнительно обёрнуто в обработку ошибок,
   * чтобы сбой удаления одного файла не нарушал операцию. Для Сообщений без
   * Вложений путь не меняется: только пометка `deleted` и трансляция события.
   *
   * @param actorId Идентификатор инициатора удаления.
   * @param messageId Идентификатор Сообщения.
   * @throws AccessDeniedException Учётная запись не найдена/удалена либо нет прав (Req 11.6).
   * @throws EntityNotFoundException Сообщение или Задача не найдены.
   */
  async deleteMessage(actorId: string, messageId: string): Promise<void> {
    const { message, task, actor } = await this.loadMessageContext(actorId, messageId);
    this.assertCanModify(actor.id, actor.role, message.authorId, task);

    if (message.deleted) {
      // Идемпотентность: повторное удаление не меняет состояние, но синхронизирует клиентов.
      this.gateway.broadcastMessage(task.id, this.toView(message, task.id));
      return;
    }

    // Дефект 8: получаем связанные Вложения Сообщения. Их наличие определяет
    // путь удаления (Req 2.8).
    const attachments = await this.attachmentRepository.listByMessage(messageId);

    let updated: Message;
    if (attachments.length > 0) {
      // Сообщение с Вложениями: в транзакции удаляем записи Вложений и логически
      // удаляем Сообщение, затем (после фиксации) удаляем объекты в хранилище.
      updated = await this.prisma.runInTransaction(async (tx) => {
        await this.attachmentRepository.deleteByMessage(messageId, tx);
        return this.messageRepository.update(messageId, { deleted: true }, tx);
      });

      // После фиксации транзакции удаляем файлы Вложений и их миниатюры из
      // хранилища (Req 2.8). Очистка устойчива к отсутствию объекта.
      for (const attachment of attachments) {
        await this.deleteStorageObjectSafely(attachment.storagePath);
        if (attachment.thumbnailPath !== null) {
          await this.deleteStorageObjectSafely(attachment.thumbnailPath);
        }
      }
    } else {
      // Сообщение без Вложений: поведение не меняется — только пометка `deleted`
      // и последующая трансляция события; обращений к хранилищу нет (Req 3.8).
      updated = await this.messageRepository.update(messageId, { deleted: true });
    }

    this.gateway.broadcastMessage(task.id, this.toView(updated, task.id));

    this.logger.log(
      `Сообщение «${messageId}» удалено пользователем «${actorId}»; ` +
        `удалено вложений: ${attachments.length}; ` +
        'отображается метка «Сообщение удалено».',
    );
  }

  /**
   * Удаляет объект из хранилища, не прерывая операцию при сбое (дефект 8,
   * Req 2.8). {@link StorageService.delete} идемпотентно (устойчиво к
   * отсутствию объекта), а обработка ошибок гарантирует, что неудачное удаление
   * одного файла не нарушит удаление Сообщения и прочих файлов.
   */
  private async deleteStorageObjectSafely(storagePath: string): Promise<void> {
    try {
      await this.storage.delete(storagePath);
    } catch (error) {
      this.logger.warn(
        `Не удалось удалить объект хранилища «${storagePath}»: ` +
          `${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  /**
   * Отмечает Сообщение прочитанным Пользователем и рассылает обновлённый список
   * прочитавших всем Участникам чата (Req 11.8, 14.4).
   *
   * Отметка идемпотентна: повторный вызов для той же пары «Сообщение +
   * Пользователь» не создаёт дубликата (защита уникальным ограничением
   * `[messageId, userId]`) и не приводит к ошибке. Отмечать прочтение и видеть
   * список прочитавших вправе только Участники чата Задачи (Исполнитель/Менеджер
   * Задачи или Администратор); для прочих недоступная Задача не раскрывается
   * (Req 11.2, 2.12). Список прочитавших рассылается в комнату Задачи только при
   * фактическом появлении новой отметки, чтобы не плодить избыточные обновления.
   *
   * @param userId Идентификатор отмечающего Пользователя.
   * @param messageId Идентификатор Сообщения.
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Сообщение/Задача не найдены либо Пользователь не Участник чата.
   */
  async markRead(userId: string, messageId: string): Promise<void> {
    const { message, task } = await this.loadParticipantMessageContext(userId, messageId);

    const created = await this.messageReadRepository.markRead(message.id, userId);

    // Просмотр Сообщения очищает соответствующее Уведомление о нём (сайт + MAX)
    // ≤3с; операция идемпотентна и не затрагивает Уведомления прочих типов
    // (Req 14.4, 14.5). Best-effort: сбой очистки не должен ломать отметку
    // прочтения и рассылку списка прочитавших.
    await this.clearMessageNotificationSafely(userId, message.id);

    if (!created) {
      // Отметка уже существовала — состояние и список прочитавших не изменились.
      return;
    }

    const readers = await this.messageReadRepository.listReaders(message.id);
    this.gateway.broadcastMessageReaders(task.id, this.toReadersView(message.id, task.id, readers));

    this.logger.log(
      `Сообщение «${messageId}» отмечено прочитанным пользователем «${userId}»; ` +
        `прочитавших всего: ${readers.length}.`,
    );
  }

  /**
   * Возвращает список прочитавших Сообщение Участников, видимый всем Участникам
   * чата Задачи (Req 11.8).
   *
   * Доступно только Участникам чата (Исполнитель/Менеджер Задачи или
   * Администратор); для прочих недоступная Задача не раскрывается (Req 11.2,
   * 2.12). Список отсортирован по моменту прочтения (ранние → поздние).
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param messageId Идентификатор Сообщения.
   * @returns Список прочитавших с именем и моментом прочтения.
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Сообщение/Задача не найдены либо Пользователь не Участник чата.
   */
  async listReaders(userId: string, messageId: string): Promise<MessageReaderView[]> {
    const { message } = await this.loadParticipantMessageContext(userId, messageId);
    const readers = await this.messageReadRepository.listReaders(message.id);
    return readers.map((r) => this.toReaderView(r));
  }

  /**
   * Возвращает все Вложения Чата Задачи для раздела «Вложения» (Req 11.10).
   *
   * Доступно только Участникам чата Задачи (Исполнитель/Менеджер Задачи или
   * Администратор); для прочих недоступная Задача не раскрывается (Req 11.2,
   * 2.12). Возвращается полное множество Вложений всех Сообщений Чата —
   * множество, показываемое в разделе «Вложения», равно множеству всех
   * Вложений Чата (Req 11.10). Выборка выполняется одним запросом с
   * детерминированным порядком (старые → новые Сообщения), что обеспечивает
   * отображение в течение 2 секунд (Req 11.10).
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param taskId Идентификатор Задачи.
   * @returns Все Вложения Чата Задачи.
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  async listAttachments(userId: string, taskId: string): Promise<Attachment[]> {
    const { task } = await this.loadParticipantTaskContext(userId, taskId);
    return this.attachmentRepository.listByTask(task.id);
  }

  /**
   * Возвращает Вложения Чата Задачи вместе с моментом загрузки (момент создания
   * родительского Сообщения) для REST-представления раздела «Вложения»
   * (Req 11.10, 12.6–12.9).
   *
   * Вариант {@link listAttachments}, дополнительно несущий `message.createdAt` —
   * он требуется контракту `AttachmentMeta` (`createdAt`). Доступ ограничен
   * Участниками чата Задачи теми же правилами (Req 11.2, 2.12); проверка
   * членства делегируется {@link loadParticipantTaskContext}. Возвращаются
   * только Вложения отправленных Сообщений — служебные черновики-носители ещё
   * не привязанных Вложений исключаются на уровне запроса.
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param taskId Идентификатор Задачи.
   * @returns Вложения Чата Задачи с моментом создания их Сообщений.
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  async listAttachmentsWithCreatedAt(
    userId: string,
    taskId: string,
  ): Promise<AttachmentWithCreatedAt[]> {
    const { task } = await this.loadParticipantTaskContext(userId, taskId);
    return this.attachmentRepository.listByTaskWithCreatedAt(task.id);
  }

  /**
   * Возвращает историю Сообщений Чата Задачи вместе с Вложениями для REST-слоя,
   * отсортированную по дате создания (старые → новые) (Req 11.1, 11.2, 11.3).
   *
   * Доступно только Участникам чата Задачи (Исполнитель/Менеджер Задачи или
   * Администратор); для прочих недоступная Задача не раскрывается (Req 11.2,
   * 2.12) — проверка членства делегируется {@link loadParticipantTaskContext},
   * как и в разделе «Вложения». Удалённые Сообщения остаются в ленте и
   * отображаются как метка «Сообщение удалено» (Req 11.7), поэтому включаются
   * в выборку с признаком `deleted`.
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param taskId Идентификатор Задачи.
   * @returns Сообщения Чата Задачи с Вложениями (старые → новые).
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  async listMessages(userId: string, taskId: string): Promise<MessageWithAttachments[]> {
    const { task } = await this.loadParticipantTaskContext(userId, taskId);
    return this.messageRepository.listByTaskWithAttachments(task.id);
  }

  /**
   * Включает или снимает заглушение Чата Задачи для Пользователя (Req 16.9).
   *
   * Заглушать собственный вид Чата вправе только Участники этого чата
   * (Исполнитель/Менеджер Задачи или Администратор); для прочих недоступная
   * Задача не раскрывается (Req 11.2, 2.12). Операция идемпотентна: повторное
   * включение или снятие на текущем состоянии не приводит к ошибке. По наличию
   * записи заглушения канал MAX фильтрует доставку Уведомлений Задачи
   * (Req 16.9), при этом Уведомления на сайте сохраняются.
   *
   * @param userId Идентификатор Пользователя, управляющего своим заглушением.
   * @param taskId Идентификатор Задачи.
   * @param muted Желаемое состояние: `true` — заглушить, `false` — снять.
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  async setMute(userId: string, taskId: string, muted: boolean): Promise<void> {
    const { task } = await this.loadParticipantTaskContext(userId, taskId);
    await this.chatMuteRepository.setMute(userId, task.id, muted);

    this.logger.log(
      `Чат задачи «${task.id}» ${muted ? 'заглушён' : 'разглушён'} пользователем «${userId}».`,
    );
  }

  /**
   * Проверяет допустимость привязки ранее загруженных Вложений к отправляемому
   * Сообщению (Req 11.9, 12.1–12.5) ДО его сохранения.
   *
   * Фронтенд загружает Вложения отдельным вызовом до отправки Сообщения; до
   * этого момента они существуют «висящими» (непривязанными). Привязать к
   * Сообщению можно только Вложение, которое: ещё не привязано
   * (`messageId === null`); относится к Чату этой Задачи (`taskId`); загружено
   * самим отправителем (`uploaderId`). Любой иной идентификатор (несуществующий,
   * уже привязанный, чужой или из другой Задачи) — недопустим и отклоняется
   * {@link ValidationException} без сохранения Сообщения (Req 2.12).
   * Дополнительно проверяется лимит «не более 10 Вложений на Сообщение»
   * (Req 11.9): это и есть точка фактической привязки. Дубликаты
   * идентификаторов устраняются.
   *
   * @param task Задача, в Чат которой отправляется Сообщение.
   * @param sender Отправитель Сообщения (он же — загрузивший Вложения).
   * @param attachmentIds Идентификаторы привязываемых Вложений.
   * @returns Уникальные идентификаторы допустимых к привязке Вложений.
   * @throws ValidationException Превышен лимит на Сообщение либо хотя бы один
   *   идентификатор недопустим (Req 11.9, 12.1–12.5).
   */
  private async validateAttachmentsForLinking(
    task: TaskWithAssignments,
    sender: User,
    attachmentIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(attachmentIds)];

    const max = this.config.limits.maxAttachmentsPerMessage;
    if (uniqueIds.length > max) {
      throw new ValidationException(
        `Превышен лимит вложений на сообщение: не более ${max}. Сообщение не сохранено.`,
      );
    }

    for (const id of uniqueIds) {
      const attachment = await this.attachmentRepository.findById(id);
      if (
        attachment === null ||
        attachment.messageId !== null ||
        attachment.taskId !== task.id ||
        attachment.uploaderId !== sender.id
      ) {
        // Недопустимое Вложение не раскрывается (Req 2.12): причина не уточняется.
        throw new ValidationException(
          'Недопустимое вложение: оно не найдено, уже привязано или не принадлежит отправителю в этой задаче.',
        );
      }
    }

    return uniqueIds;
  }

  /**
   * Атомарно сохраняет Сообщение, инкрементирует счётчик с насыщением, выполняет
   * авто-переход Статуса и привязывает ранее загруженные Вложения (Req 9.7, 9.9,
   * 10.1–10.3, 12.1–12.5).
   *
   * Все операции выполняются в одной интерактивной транзакции, поэтому вставка
   * Сообщения, обновление счётчика, смена Статуса и привязка Вложений
   * фиксируются вместе или не фиксируются вовсе — промежуточного
   * несогласованного состояния не возникает. Привязка Вложений ограничена их
   * принадлежностью (Задача и загрузивший) на уровне запроса
   * {@link AttachmentRepository.linkToMessage}; идентификаторы предварительно
   * проверены {@link validateAttachmentsForLinking}.
   */
  private async persistMessageAtomically(
    task: TaskWithAssignments,
    senderId: string,
    senderDisplayName: string,
    text: string,
    actor: Actor,
    attachmentIds: string[] = [],
  ): Promise<SendOutcome> {
    const cap = this.config.limits.messageCounterCap;
    const nextCount = saturateMessageCount(task.messageCount + 1, cap);
    const nextStatus = this.statusMachine.onChatMessage(task.status, actor);
    const statusChanged = nextStatus !== task.status;

    return this.prisma.runInTransaction(async (tx) => {
      const message = await this.messageRepository.create(
        {
          text,
          authorDisplayName: senderDisplayName,
          chat: { connect: { taskId: task.id } },
          author: { connect: { id: senderId } },
        },
        tx,
      );

      // Привязка «висящих» Вложений к сохранённому Сообщению (Req 12.1–12.5).
      if (attachmentIds.length > 0) {
        await this.attachmentRepository.linkToMessage(
          attachmentIds,
          message.id,
          { taskId: task.id, uploaderId: senderId },
          tx,
        );
      }

      // Насыщающий инкремент счётчика: запись только при фактическом изменении (Req 9.9).
      if (nextCount !== task.messageCount) {
        await this.taskRepository.update(task.id, { messageCount: nextCount }, tx);
      }

      // Авто-переход Статуса: запись только при фактическом изменении (Req 10.1–10.3).
      if (statusChanged) {
        await this.taskRepository.setStatus(task.id, nextStatus, tx);
      }

      return {
        message,
        messageCount: nextCount,
        status: nextStatus,
        statusChanged,
        previousStatus: task.status,
      };
    });
  }

  /**
   * Формирует Уведомление участникам о новом Сообщении Чата, кроме автора и
   * Администраторов (Req 14.1, 14.2).
   *
   * Состав получателей (Исполнители ∪ Менеджеры − автор − Администратор(ы))
   * вычисляет {@link ChatNotificationRouter.notifyNewMessage}; здесь лишь
   * выделяются идентификаторы Исполнителей и Менеджеров из назначений Задачи.
   * Вызывается после сохранения и рассылки Сообщения; ошибки логируются и не
   * прерывают доставку Сообщения подключённым Участникам (Req 11.3).
   */
  private async routeNewMessageNotification(
    task: TaskWithAssignments,
    messageId: string,
    authorId: string,
  ): Promise<void> {
    const executorIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.EXECUTOR)
      .map((a) => a.userId);
    const managerIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);
    try {
      await this.chatNotifications.notifyNewMessage({
        taskId: task.id,
        taskTitle: task.title,
        messageId,
        authorId,
        executorIds,
        managerIds,
      });
    } catch (error) {
      this.logger.warn(
        `Не удалось поставить уведомление о новом сообщении «${messageId}» задачи ` +
          `«${task.id}»: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  /**
   * Очищает Уведомление о Сообщении по факту просмотра (Req 14.4), не прерывая
   * отметку прочтения при сбое очистки. Делегирует
   * {@link ChatNotificationRouter.clearMessageNotification} (удаление на сайте и
   * в Боте MAX, сохранность прочих типов — Req 14.4, 14.5, 14.7).
   */
  private async clearMessageNotificationSafely(userId: string, messageId: string): Promise<void> {
    try {
      await this.chatNotifications.clearMessageNotification(userId, messageId);
    } catch (error) {
      this.logger.warn(
        `Не удалось очистить уведомление о сообщении «${messageId}» для пользователя ` +
          `«${userId}»: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  /**
   * Загружает Сообщение вместе с его Задачей (и назначениями) для проверки прав
   * на редактирование/удаление (Req 11.6).
   *
   * @throws AccessDeniedException Учётная запись инициатора не найдена/удалена.
   * @throws EntityNotFoundException Сообщение или связанная Задача не найдены.
   */
  private async loadMessageContext(
    actorId: string,
    messageId: string,
  ): Promise<{ message: Message; task: TaskWithAssignments; actor: User }> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись инициатора не найдена или удалена.');
    }

    const message = await this.messageRepository.findById(messageId);
    if (message === null) {
      throw new EntityNotFoundException('Сообщение не найдено.');
    }

    const chat = await this.prisma.chat.findUnique({ where: { id: message.chatId } });
    const task =
      chat === null ? null : await this.taskRepository.findByIdWithAssignments(chat.taskId);
    if (task === null) {
      throw new EntityNotFoundException('Задача сообщения не найдена.');
    }

    return { message, task, actor };
  }

  /**
   * Загружает Сообщение и его Задачу, проверяя, что Пользователь — Участник
   * чата этой Задачи (Исполнитель/Менеджер Задачи или Администратор) (Req 11.2,
   * 11.8). Используется операциями списка прочитавших и отметки прочтения.
   *
   * Недоступная Пользователю Задача не раскрывается: при отсутствии назначения
   * у не-Администратора метод сообщает о ненайденном Сообщении/Задаче (Req 2.12).
   *
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Сообщение/Задача не найдены либо Пользователь не Участник чата.
   */
  private async loadParticipantMessageContext(
    userId: string,
    messageId: string,
  ): Promise<{ message: Message; task: TaskWithAssignments }> {
    const { message, task, actor } = await this.loadMessageContext(userId, messageId);
    const participant = this.resolveSenderActor(actor.role, actor.id, task);
    if (participant === null) {
      throw new EntityNotFoundException('Сообщение не найдено или недоступно.');
    }
    return { message, task };
  }

  /**
   * Загружает Задачу по идентификатору, проверяя, что Пользователь — Участник
   * её чата (Исполнитель/Менеджер Задачи или Администратор) (Req 11.2, 11.10,
   * 16.9). Используется операциями раздела «Вложения» и заглушения чата.
   *
   * Недоступная Пользователю Задача не раскрывается: при отсутствии назначения
   * у не-Администратора метод сообщает о ненайденной Задаче (Req 2.12).
   *
   * @throws AccessDeniedException Учётная запись Пользователя не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  private async loadParticipantTaskContext(
    userId: string,
    taskId: string,
  ): Promise<{ task: TaskWithAssignments }> {
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new AccessDeniedException('Учётная запись пользователя не найдена или удалена.');
    }

    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const participant = task === null ? null : this.resolveSenderActor(user.role, userId, task);
    if (task === null || participant === null) {
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    return { task };
  }

  /**
   * Проверяет право на редактирование/удаление Сообщения: автор, Менеджер
   * Задачи или Администратор (Req 11.5, 11.6, 11.7).
   *
   * @throws AccessDeniedException Если инициатор не автор, не Менеджер этой
   *   Задачи и не Администратор (Req 11.6).
   */
  private assertCanModify(
    actorId: string,
    actorRole: Role,
    authorId: string | null,
    task: TaskWithAssignments,
  ): void {
    if (authorId !== null && authorId === actorId) {
      return; // Автор Сообщения.
    }
    if (hasAdminPrivileges(actorRole)) {
      return; // Администратор обладает правами на правку любого Сообщения (Req 2.3, 11.6).
    }
    const isTaskManager = task.assignments.some(
      (a) => a.userId === actorId && a.kind === AssignmentKind.MANAGER,
    );
    if (isTaskManager) {
      return; // Менеджер этой Задачи (Req 11.6).
    }
    throw new AccessDeniedException(
      'Недостаточно прав для изменения сообщения: доступно автору, Менеджеру задачи или Администратору.',
    );
  }

  /**
   * Определяет эффективную роль отправителя в контексте Задачи для авто-перехода
   * Статуса либо `null`, если он не Участник чата (Req 10.1–10.3, 11.2).
   *
   * Администратор всегда действует как Администратор. Для остальных роль
   * определяется видом назначения в Задаче: назначение Исполнителем даёт роль
   * Исполнителя (даже для Пользователя с глобальной ролью Менеджера —
   * «Менеджер-как-Исполнитель» считается Исполнителем, Req 2.4); назначение
   * только Менеджером — роль Менеджера. Отсутствие назначения у не-Администратора
   * означает, что Пользователь не Участник чата.
   */
  private resolveSenderActor(role: Role, userId: string, task: TaskWithAssignments): Actor | null {
    if (hasAdminPrivileges(role)) {
      return 'ADMIN';
    }
    const own = task.assignments.filter((a) => a.userId === userId);
    if (own.some((a) => a.kind === AssignmentKind.EXECUTOR)) {
      return 'EXECUTOR';
    }
    if (own.some((a) => a.kind === AssignmentKind.MANAGER)) {
      return 'MANAGER';
    }
    return null;
  }

  /**
   * Проверяет длину текста Сообщения против границ Req 11.3/11.4 (1–4000).
   *
   * @throws ValidationException Текст не строка, пуст или длиннее лимита.
   */
  private validateText(text: unknown): string {
    if (typeof text !== 'string') {
      throw new ValidationException('Текст сообщения обязателен.');
    }
    const max = this.config.limits.messageTextMaxLength;
    if (text.length < 1 || text.length > max) {
      throw new ValidationException(`Длина текста сообщения должна быть от 1 до ${max} символов.`);
    }
    return text;
  }

  /**
   * Проверяет текст нового Сообщения: текст может быть пустым только для
   * сообщения с Вложениями, иначе действует прежняя граница 1..4000.
   */
  private validateSendText(text: unknown, hasAttachments: boolean): string {
    if (typeof text !== 'string') {
      throw new ValidationException('Текст сообщения обязателен.');
    }
    const max = this.config.limits.messageTextMaxLength;
    if (text.length > max || (!hasAttachments && text.length < 1)) {
      throw new ValidationException(`Длина текста сообщения должна быть от 1 до ${max} символов.`);
    }
    return text;
  }

  /**
   * Формирует представление отправленного Сообщения для ленты Чата
   * ({@link ChatMessageHttpView}) вместе с привязанными Вложениями (Req 11.3,
   * 2.2, 12.6).
   *
   * Используется при отправке Сообщения для realtime-рассылки и HTTP-ответа:
   * для каждого фактически привязанного Вложения формируется метаданное
   * контракта `AttachmentMeta` с признаком наличия миниатюры (`hasThumbnail`),
   * выведенным из сохранённого `thumbnailPath`. Благодаря этому свежеотправленное
   * Сообщение получает миниатюры без перезагрузки ленты («не отдан» —
   * корневая причина дефекта 2). Внутренние пути хранения наружу не
   * раскрываются (Req 19.8). В качестве момента загрузки Вложения берётся момент
   * создания Сообщения (Вложения загружаются вместе с ним).
   *
   * Перечитывание Вложений выполняется по их идентификаторам уже после фиксации
   * привязки в транзакции, поэтому их `messageId` указывает на это Сообщение;
   * любое неподтверждённое Вложение (не найдено или не привязано к данному
   * Сообщению) в нагрузку не включается.
   *
   * @param message Сохранённое Сообщение.
   * @param taskId Идентификатор Задачи, к Чату которой относится Сообщение.
   * @param attachmentIds Идентификаторы привязанных к Сообщению Вложений.
   * @returns Представление Сообщения с Вложениями для клиента.
   */
  private async buildSentMessageView(
    message: Message,
    taskId: string,
    attachmentIds: string[],
    authorAvatarPath: string | null,
  ): Promise<ChatMessageHttpView> {
    const view: ChatMessageHttpView = {
      id: message.id,
      taskId,
      chatId: message.chatId,
      authorId: message.authorId,
      authorDisplayName: message.authorDisplayName,
      authorAvatarPath,
      // Свежеотправленное Сообщение ещё никто не прочитал.
      readCount: 0,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt === null ? null : message.editedAt.toISOString(),
      deleted: message.deleted,
    };

    if (attachmentIds.length > 0) {
      const metas: AttachmentMetaView[] = [];
      for (const id of attachmentIds) {
        const attachment = await this.attachmentRepository.findById(id);
        // Включаем только подтверждённо привязанные к этому Сообщению Вложения.
        if (attachment !== null && attachment.messageId === message.id) {
          metas.push(toAttachmentMeta(attachment, message.createdAt));
        }
      }
      if (metas.length > 0) {
        view.attachments = metas;
      }
    }

    return view;
  }

  /** Формирует представление Сообщения для рассылки в комнату Задачи. */
  private toView(message: Message, taskId: string): ChatMessageView {
    return {
      id: message.id,
      taskId,
      chatId: message.chatId,
      authorId: message.authorId,
      authorDisplayName: message.authorDisplayName,
      text: message.text,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deleted: message.deleted,
    };
  }

  /** Формирует представление списка прочитавших Сообщение для рассылки (Req 11.8). */
  private toReadersView(
    messageId: string,
    taskId: string,
    reads: MessageReadWithUser[],
  ): MessageReadersView {
    return {
      messageId,
      taskId,
      readers: reads.map((r) => this.toReaderView(r)),
    };
  }

  /** Преобразует отметку о прочтении в представление одного прочитавшего. */
  private toReaderView(read: MessageReadWithUser): MessageReaderView {
    return {
      userId: read.userId,
      displayName: read.user.displayName,
      readAt: read.readAt,
    };
  }
}
