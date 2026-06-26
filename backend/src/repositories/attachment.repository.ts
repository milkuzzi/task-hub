import { Injectable } from '@nestjs/common';
import { Attachment, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from './base.repository';

/**
 * Вложение Чата вместе с моментом создания родительского Сообщения (Req 11.10,
 * 12.6–12.9).
 *
 * Раздел «Вложения» показывает только привязанные Вложения (с непустым
 * `messageId`), поэтому момент создания их Сообщения всегда доступен. Этот тип
 * несёт его одним запросом, без отдельного обращения за каждым Сообщением.
 */
export type AttachmentWithCreatedAt = Attachment & { message: { createdAt: Date } };

/**
 * Ограничение принадлежности Вложения при привязке к Сообщению (Req 11.2,
 * 12.1–12.5).
 *
 * Привязать к новому Сообщению можно только «висящее» (непривязанное) Вложение,
 * загруженное тем же Участником в Чат той же Задачи. Поля используются как
 * условие `updateMany`, поэтому чужие, уже привязанные или относящиеся к иной
 * Задаче Вложения не затрагиваются и не раскрываются (Req 2.12).
 */
export interface AttachmentLinkGuard {
  /** Задача, в Чат которой отправлено Сообщение. */
  taskId: string;
  /** Загрузивший Вложение Участник (только он вправе его привязать). */
  uploaderId: string;
}

/**
 * Репозиторий-обёртка над сущностью {@link Attachment} (Req 11.10, 12).
 *
 * Инкапсулирует создание «висящих» (непривязанных) Вложений, их привязку к
 * Сообщению при отправке и выборку Вложений Чата для раздела «Вложения». Связь
 * Чат↔Задача — один к одному (Req 9.5); прямое поле `taskId` Вложения позволяет
 * проверять членство и формировать список без обращения к Сообщению. Все методы
 * поддерживают выполнение внутри транзакции.
 */
@Injectable()
export class AttachmentRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Возвращает привязанные Вложения всех Сообщений Чата указанной Задачи
   * (Req 11.10).
   *
   * Учитываются Вложения, привязанные к Сообщениям (`messageId IS NOT NULL`) —
   * «висящие» (ещё не отправленные) Вложения в раздел «Вложения» не попадают.
   * Сортировка детерминирована: по моменту создания Сообщения (старые → новые),
   * затем по идентификатору Вложения — это даёт стабильный порядок при
   * равенстве дат.
   *
   * @param taskId Идентификатор Задачи.
   * @returns Привязанные Вложения Чата Задачи в детерминированном порядке.
   */
  listByTask(taskId: string, tx?: Prisma.TransactionClient): Promise<Attachment[]> {
    return this.client(tx).attachment.findMany({
      where: { taskId, messageId: { not: null } },
      orderBy: [{ message: { createdAt: 'asc' } }, { id: 'asc' }],
    });
  }

  /**
   * Возвращает привязанные Вложения Чата Задачи вместе с моментом создания их
   * Сообщений для REST-представления раздела «Вложения» (Req 11.10, 12.6–12.9).
   *
   * В отличие от {@link listByTask}, дополнительно подгружает `message.createdAt`
   * (момент отправки Сообщения для контракта `AttachmentMeta`). «Висящие»
   * (непривязанные) Вложения исключаются на уровне запроса (`messageId IS NOT
   * NULL`). Порядок детерминирован (старые → новые Сообщения, затем по
   * идентификатору Вложения).
   *
   * @param taskId Идентификатор Задачи.
   * @returns Привязанные Вложения Чата с моментом создания их Сообщений.
   */
  async listByTaskWithCreatedAt(
    taskId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AttachmentWithCreatedAt[]> {
    const rows = await this.client(tx).attachment.findMany({
      where: { taskId, messageId: { not: null } },
      orderBy: [{ message: { createdAt: 'asc' } }, { id: 'asc' }],
      include: { message: { select: { createdAt: true } } },
    });
    // Запрос гарантирует наличие Сообщения (messageId IS NOT NULL), поэтому
    // `message` не равен null; сужаем тип для контракта `AttachmentWithCreatedAt`.
    return rows as AttachmentWithCreatedAt[];
  }

  /**
   * Возвращает все Вложения, привязанные к указанному Сообщению (дефект 8,
   * Req 2.8).
   *
   * Используется {@link ChatService.deleteMessage} для получения связанных
   * Вложений перед их удалением: по ним удаляются записи и объекты хранилища
   * (`storagePath` и `thumbnailPath`), чтобы не оставлять осиротевших Вложений
   * и файлов. Метод поддерживает выполнение внутри транзакции, что позволяет
   * выбрать Вложения и удалить их атомарно с логическим удалением Сообщения.
   *
   * @param messageId Идентификатор Сообщения.
   * @returns Вложения, привязанные к Сообщению (возможно, пустой список).
   */
  listByMessage(messageId: string, tx?: Prisma.TransactionClient): Promise<Attachment[]> {
    return this.client(tx).attachment.findMany({ where: { messageId } });
  }

  /**
   * Удаляет записи всех Вложений, привязанных к указанному Сообщению (дефект 8,
   * Req 2.8).
   *
   * Используется {@link ChatService.deleteMessage} в транзакции удаления
   * Сообщения: удаляются только записи Вложений данного Сообщения, после чего
   * вызывающий код удаляет соответствующие объекты в хранилище. Метод
   * поддерживает выполнение внутри транзакции.
   *
   * @param messageId Идентификатор Сообщения.
   * @returns Число удалённых записей Вложений.
   */
  async deleteByMessage(messageId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const result = await this.client(tx).attachment.deleteMany({ where: { messageId } });
    return result.count;
  }

  /**
   * Привязывает «висящие» Вложения к отправленному Сообщению (Req 12.1–12.5).
   *
   * Используется {@link ChatService.sendMessage} при отправке Сообщения:
   * затрагиваются только Вложения, которые ещё не привязаны (`messageId IS
   * NULL`), относятся к Чату этой Задачи и загружены отправителем (см.
   * {@link AttachmentLinkGuard}). Чужие, уже привязанные или относящиеся к иной
   * Задаче Вложения остаются нетронутыми и не раскрываются (Req 2.12). Метод
   * поддерживает выполнение внутри транзакции, что позволяет привязывать
   * Вложения атомарно с сохранением Сообщения.
   *
   * @param ids Идентификаторы привязываемых Вложений.
   * @param messageId Идентификатор Сообщения-получателя.
   * @param guard Ограничение принадлежности (Задача и загрузивший).
   * @returns Число фактически привязанных Вложений.
   */
  async linkToMessage(
    ids: string[],
    messageId: string,
    guard: AttachmentLinkGuard,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.client(tx).attachment.updateMany({
      where: {
        id: { in: ids },
        messageId: null,
        taskId: guard.taskId,
        uploaderId: guard.uploaderId,
      },
      data: { messageId },
    });
    return result.count;
  }

  /**
   * Создаёт запись Вложения (Req 12.1, 12.2, 12.8, 19.8).
   *
   * Запись создаётся только после успешного сохранения содержимого в
   * хранилище: при сбое сохранения {@link StorageService.store} не возвращает
   * метаданные и этот метод не вызывается, поэтому осиротевших записей без
   * файла не возникает (Req 12.4, 19.9). При загрузке до отправки Сообщения
   * создаётся «висящее» Вложение с `messageId = null` и заполненными `taskId`
   * и `uploaderId`. Метод поддерживает выполнение внутри транзакции.
   *
   * @param data Метаданные Вложения, включая связь с Задачей и загрузившим.
   * @returns Созданная запись Вложения.
   */
  create(data: Prisma.AttachmentCreateInput, tx?: Prisma.TransactionClient): Promise<Attachment> {
    return this.client(tx).attachment.create({ data });
  }

  /**
   * Находит Вложение по идентификатору (Req 12.1–12.7, 12.9).
   *
   * Используется при привязке Вложений к Сообщению, при формировании миниатюры
   * и при контролируемой отдаче сжатого содержимого. Метод поддерживает
   * выполнение внутри транзакции.
   *
   * @param id Идентификатор Вложения.
   * @returns Запись Вложения либо `null`, если оно не найдено.
   */
  findById(id: string, tx?: Prisma.TransactionClient): Promise<Attachment | null> {
    return this.client(tx).attachment.findUnique({ where: { id } });
  }

  /**
   * Сохраняет путь сформированной миниатюры Вложения (Req 12.6).
   *
   * Вызывается после успешной генерации и сохранения миниатюры изображения в
   * хранилище. Метод поддерживает выполнение внутри транзакции.
   *
   * @param id Идентификатор Вложения.
   * @param thumbnailPath Относительный путь сохранённой миниатюры в хранилище.
   * @returns Обновлённая запись Вложения.
   */
  setThumbnailPath(
    id: string,
    thumbnailPath: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Attachment> {
    return this.client(tx).attachment.update({ where: { id }, data: { thumbnailPath } });
  }
}
