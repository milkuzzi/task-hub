import { Injectable, Logger } from '@nestjs/common';
import { Task, User } from '@prisma/client';
import { AttachmentsService, UploadFile } from '../../attachments';
import { ChatService } from '../../chat';
import { AccessDeniedException, ValidationException } from '../../common/errors';
import { PaginationQueryDto } from '../../common/dto';
import { AppConfigService } from '../../config';
import { UserRepository } from '../../repositories';
import { TasksService } from '../../tasks';

/**
 * Прикладной сервис Бота MAX (Req 16.5–16.12).
 *
 * Единая точка обработки команд Бота MAX: идентифицирует Пользователя Системы по
 * идентификатору профиля MAX (`maxUserId`) через
 * {@link UserRepository.findActiveUserByMaxUserId} (Req 16.1, 16.2) и делегирует
 * выполнение существующим прикладным сервисам, не дублируя бизнес-правила:
 *
 * - {@link listTasks} — список Задач в пределах видимости Пользователя через
 *   {@link TasksService.listVisible} (Req 16.7, видимость по Req 2);
 * - {@link sendMessageFromBot} — отправка Сообщения в Чат Задачи через
 *   {@link ChatService.sendMessage} с прикреплением Вложений через
 *   {@link AttachmentsService.upload} и единым лимитом размера/количества как на
 *   сайте (Req 16.8, 16.10, 16.11);
 * - {@link setMuteFromBot} — заглушение/снятие заглушения Чата Задачи через
 *   {@link ChatService.setMute} (Req 16.9);
 * - {@link unsubscribeAll} — полная отписка от Уведомлений через Бот MAX
 *   ({@link UserRepository.setMaxMutedAllByMaxUserId}, Req 16.5);
 * - {@link unsubscribeTask} — отписка от Уведомлений конкретной Задачи через её
 *   заглушение ({@link ChatService.setMute}, Req 16.6);
 * - {@link onMessageSeen} — отметка Сообщения прочитанным через
 *   {@link ChatService.markRead}, что очищает Уведомление о Сообщении на сайте и
 *   в Боте MAX (Req 16.12).
 *
 * Любая команда от профиля MAX, не привязанного к активному Пользователю,
 * отклоняется {@link AccessDeniedException} (Req 16.1, 16.2) — Бот не раскрывает
 * данные Системы непривязанному профилю.
 *
 * Действия в Боте MAX не изменяют Уведомления на сайте (Req 16.13): заглушение и
 * отписки влияют только на фильтрацию канала MAX
 * ({@link import('../../notifications/delivery/max-delivery-filter').MaxDeliveryFilter}),
 * а очистка Уведомления по просмотру выполняется штатным путём чата.
 */
@Injectable()
export class MaxBotService {
  private readonly logger = new Logger(MaxBotService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly tasks: TasksService,
    private readonly chat: ChatService,
    private readonly attachments: AttachmentsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Возвращает Задачи, видимые Пользователю Бота MAX согласно его роли и
   * назначениям (Req 16.7, видимость по Req 2).
   *
   * Делегирует {@link TasksService.listVisible} — тот же источник видимости, что
   * и на сайте, поэтому Бот не показывает Задачи вне видимости Пользователя.
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @param query Параметры пагинации (по умолчанию — первая страница).
   * @returns Видимые Пользователю Задачи.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   */
  async listTasks(
    maxUserId: string,
    query: PaginationQueryDto = new PaginationQueryDto(),
  ): Promise<Task[]> {
    const user = await this.resolveUser(maxUserId);
    const page = await this.tasks.listVisible(user.id, query);
    return page.items;
  }

  /**
   * Отправляет Сообщение в Чат выбранной Задачи через Бот MAX с прикреплением
   * Вложений и единым лимитом размера/количества (Req 16.8, 16.10, 16.11).
   *
   * Порядок (любой отказ происходит ДО отправки Сообщения, поэтому при ошибке
   * Сообщение остаётся неотправленным, Req 16.11):
   * 1. идентификация Пользователя по профилю MAX (Req 16.1);
   * 2. предварительная проверка Вложений против тех же лимитов, что и на сайте:
   *    не более {@link LimitsConfig.maxAttachmentsPerMessage} файлов на Сообщение
   *    (Req 16.10, 11.9) и заявленный размер каждого файла не более
   *    {@link LimitsConfig.attachmentMaxBytes} (Req 16.11, 12.2). При нарушении —
   *    {@link ValidationException} ДО отправки;
   * 3. прикрепление каждого Вложения через
   *    {@link AttachmentsService.uploadToTask} — создаётся «висящее»
   *    (непривязанное) Вложение с повторной проверкой единого лимита размера к
   *    фактическому содержимому (Req 12.2, 12.3);
   * 4. отправка Сообщения через {@link ChatService.sendMessage} с
   *    идентификаторами загруженных Вложений: оно валидирует текст, права
   *    Участника чата, авто-переход Статуса и привязывает Вложения (Req 11.3,
   *    11.2, 10.1–10.3, 12.1–12.5).
   *
   * @param maxUserId Идентификатор профиля MAX отправителя.
   * @param taskId Идентификатор Задачи.
   * @param text Текст Сообщения (1–4000 символов, Req 11.3, 11.4).
   * @param files Прикрепляемые файлы (содержимое уже загружено из Бота MAX).
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   * @throws ValidationException Превышен лимит количества/размера Вложений
   *   (Req 16.10, 16.11) либо текст некорректен (Req 11.4).
   * @throws EntityNotFoundException Задача недоступна отправителю (не Участник чата).
   */
  async sendMessageFromBot(
    maxUserId: string,
    taskId: string,
    text: string,
    files: UploadFile[] = [],
  ): Promise<void> {
    const user = await this.resolveUser(maxUserId);

    // Единый лимит вложений как на сайте — проверка ДО загрузки и отправки, чтобы
    // при нарушении Сообщение осталось неотправленным (Req 16.10, 16.11).
    this.assertAttachmentLimits(files);

    // Загрузка Вложений как «висящих» (непривязанных); привязка к Сообщению
    // выполняется при его отправке (Req 12.1–12.5).
    const attachmentIds: string[] = [];
    for (const file of files) {
      const { attachment } = await this.attachments.uploadToTask(user.id, taskId, file);
      attachmentIds.push(attachment.id);
    }

    const message = await this.chat.sendMessage(user.id, taskId, text, attachmentIds);

    this.logger.log(
      `Бот MAX: пользователь «${user.id}» отправил сообщение «${message.id}» в задачу «${taskId}» ` +
        `с ${files.length} вложением(ями).`,
    );
  }

  /**
   * Включает или снимает заглушение Чата Задачи для Пользователя через Бот MAX
   * (Req 16.9).
   *
   * Делегирует {@link ChatService.setMute} (проверка принадлежности к Участникам
   * чата, идемпотентность). По наличию заглушения канал MAX фильтрует доставку
   * Уведомлений Задачи; Уведомления на сайте сохраняются (Req 16.13).
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @param taskId Идентификатор Задачи.
   * @param muted Желаемое состояние: `true` — заглушить, `false` — снять.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   * @throws EntityNotFoundException Задача недоступна Пользователю (не Участник чата).
   */
  async setMuteFromBot(maxUserId: string, taskId: string, muted: boolean): Promise<void> {
    const user = await this.resolveUser(maxUserId);
    await this.chat.setMute(user.id, taskId, muted);
    this.logger.log(
      `Бот MAX: пользователь «${user.id}» ${muted ? 'заглушил' : 'снял заглушение'} чат задачи «${taskId}».`,
    );
  }

  /**
   * Включает полную отписку Пользователя от Уведомлений через Бот MAX (Req 16.5).
   *
   * Устанавливает `MaxLink.mutedAll = true` по профилю MAX; после этого канал
   * MAX подавляет доставку всех последующих Уведомлений этому Пользователю до
   * повторного включения. Уведомления на сайте сохраняются (Req 16.13).
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   */
  async unsubscribeAll(maxUserId: string): Promise<void> {
    const user = await this.resolveUser(maxUserId);
    await this.userRepository.setMaxMutedAllByMaxUserId(maxUserId, true);
    this.logger.log(
      `Бот MAX: пользователь «${user.id}» отписался от всех уведомлений через Бот MAX.`,
    );
  }

  /**
   * Повторно включает доставку всех Уведомлений Пользователю через Бот MAX
   * (снятие полной отписки, Req 16.5).
   *
   * Устанавливает `MaxLink.mutedAll = false` по профилю MAX. Отписки от
   * отдельных Задач (заглушения их Чатов) при этом сохраняются и снимаются
   * отдельно через {@link setMuteFromBot}/{@link unsubscribeTask}.
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   */
  async resubscribeAll(maxUserId: string): Promise<void> {
    const user = await this.resolveUser(maxUserId);
    await this.userRepository.setMaxMutedAllByMaxUserId(maxUserId, false);
    this.logger.log(
      `Бот MAX: пользователь «${user.id}» возобновил получение уведомлений через Бот MAX.`,
    );
  }

  /**
   * Отписывает Пользователя от Уведомлений конкретной Задачи через Бот MAX
   * (Req 16.6).
   *
   * Реализуется заглушением Чата Задачи ({@link ChatService.setMute}) — той же
   * записью {@link import('@prisma/client').ChatMute}, по которой канал MAX
   * фильтрует доставку Уведомлений Задачи. Повторное включение выполняется через
   * {@link setMuteFromBot} с `muted = false`.
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @param taskId Идентификатор Задачи.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   * @throws EntityNotFoundException Задача недоступна Пользователю (не Участник чата).
   */
  async unsubscribeTask(maxUserId: string, taskId: string): Promise<void> {
    const user = await this.resolveUser(maxUserId);
    await this.chat.setMute(user.id, taskId, true);
    this.logger.log(
      `Бот MAX: пользователь «${user.id}» отписался от уведомлений задачи «${taskId}».`,
    );
  }

  /**
   * Обрабатывает просмотр Сообщения Пользователем в Боте MAX (Req 16.12).
   *
   * Делегирует {@link ChatService.markRead}: отметка о прочтении очищает
   * Уведомление о Сообщении на сайте и в Боте MAX (Req 14.4, 16.12), не
   * затрагивая Уведомления прочих типов (Req 14.5).
   *
   * @param maxUserId Идентификатор профиля MAX.
   * @param messageId Идентификатор просмотренного Сообщения.
   * @throws AccessDeniedException Профиль MAX не привязан к активному Пользователю.
   * @throws EntityNotFoundException Сообщение/Задача недоступны Пользователю.
   */
  async onMessageSeen(maxUserId: string, messageId: string): Promise<void> {
    const user = await this.resolveUser(maxUserId);
    await this.chat.markRead(user.id, messageId);
    this.logger.log(
      `Бот MAX: пользователь «${user.id}» просмотрел сообщение «${messageId}»; ` +
        'уведомление о сообщении очищено.',
    );
  }

  /**
   * Идентифицирует активного Пользователя Системы по идентификатору профиля MAX
   * (Req 16.1, 16.2).
   *
   * @throws AccessDeniedException Профиль MAX не привязан к активному
   *   Пользователю (привязка отсутствует либо учётная запись удалена/не
   *   активирована).
   */
  private async resolveUser(maxUserId: string): Promise<User> {
    const user = await this.userRepository.findActiveUserByMaxUserId(maxUserId);
    if (user === null) {
      throw new AccessDeniedException('Профиль MAX не привязан к активной учётной записи Системы.');
    }
    return user;
  }

  /**
   * Проверяет единый лимит Вложений Сообщения, отправляемого через Бот MAX
   * (Req 16.10, 16.11): количество файлов и заявленный размер каждого.
   *
   * @throws ValidationException Превышен лимит количества Вложений на Сообщение
   *   (Req 16.10, 11.9) либо заявленный размер файла превышает единый предел
   *   (Req 16.11, 12.2).
   */
  private assertAttachmentLimits(files: UploadFile[]): void {
    const maxCount = this.config.limits.maxAttachmentsPerMessage;
    if (files.length > maxCount) {
      throw new ValidationException(
        `Превышен лимит вложений на сообщение: не более ${maxCount}. Сообщение не отправлено.`,
      );
    }

    const maxBytes = this.config.limits.attachmentMaxBytes;
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    for (const file of files) {
      if (file.declaredSize !== undefined && file.declaredSize > maxBytes) {
        throw new ValidationException(
          `Размер файла «${file.originalName}» превышает допустимый предел ${maxMb} МБ. ` +
            'Сообщение не отправлено.',
        );
      }
    }
  }
}
