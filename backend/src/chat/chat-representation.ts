import { Attachment, Role } from '@prisma/client';
import { MessageWithAttachments } from '../repositories';
import { ChatMessageView, MessageReaderView } from './chat.service';

/**
 * HTTP-представления Чата для REST-слоя (контракт `frontend/src/lib/chat-api.ts`).
 *
 * Сопоставляют доменные сущности Сообщения/Вложения/отметки прочтения с формами,
 * ожидаемыми клиентом (`ChatMessage`, `AttachmentMeta`, `MessageReader`):
 * - {@link ChatMessageHttpView} — Сообщение ленты Чата (Req 11.3, 11.5, 11.7);
 * - {@link AttachmentMetaView} — метаданные Вложения (Req 11.10, 12.6–12.9);
 * - {@link MessageReaderHttpView} — один прочитавший Сообщение (Req 11.8).
 *
 * Все моменты времени сериализуются в ISO-8601 (UTC); клиент отображает их в
 * MSK (Req 1.2). Внутренние поля хранилища (`storagePath`, `thumbnailPath`) не
 * раскрываются — наличие миниатюры передаётся булевым `hasThumbnail` (Req 19.8).
 */

/**
 * Метаданные Вложения для раздела «Вложения» и ленты Сообщений (зеркалит
 * клиентский `AttachmentMeta`, Req 11.10, 12.6–12.9).
 *
 * `hasThumbnail` выводится из наличия `thumbnailPath` (Req 12.6); путь хранения
 * наружу не отдаётся. `sizeBytes` приводится из `BigInt` к числу (размер ≤25 МБ
 * укладывается в безопасный диапазон, Req 12.2).
 */
export interface AttachmentMetaView {
  id: string;
  /** Сообщение, к которому привязано Вложение; `null` для ещё не привязанного. */
  messageId: string | null;
  originalName: string;
  mimeType: string;
  /** Размер исходного (несжатого) содержимого в байтах. */
  sizeBytes: number;
  /** Есть ли сформированная миниатюра-изображение (Req 12.6). */
  hasThumbnail: boolean;
  /** Кодек сжатия хранимого объекта (`zstd`, `gzip`, …) (Req 12.8). */
  compression: string;
  /** Контрольная сумма исходного содержимого (sha256, hex) (Req 12.9). */
  checksum: string;
  /** Момент загрузки (ISO-8601, UTC). */
  createdAt: string;
}

/**
 * Сообщение ленты Чата (зеркалит клиентский `ChatMessage`, Req 11.3, 11.5, 11.7).
 *
 * `editedAt !== null` — метка «изменено» (Req 11.5); `deleted === true` — на
 * месте Сообщения отображается «Сообщение удалено» (Req 11.7); `authorId ===
 * null` означает удалённого автора при сохранённом `authorDisplayName` (Req 8.4).
 */
export interface ChatMessageHttpView {
  id: string;
  taskId: string;
  chatId: string;
  authorId: string | null;
  authorDisplayName: string;
  /** Роль автора, если запись Пользователя доступна; `null` для удалённого автора. */
  authorRole: Role | null;
  /**
   * Относительный путь до аватара автора Сообщения либо `null`, если автор
   * удалён или аватар не сохранён (дефект 4, Req 2.4). Несёт признак наличия
   * аватара для ленты Чата; сами байты аватара клиент запрашивает по
   * защищённому эндпоинту `/avatars/:userId` (`authorId`).
   */
  authorAvatarPath: string | null;
  text: string;
  /** Момент создания (ISO-8601, UTC). */
  createdAt: string;
  /** Момент последнего изменения (ISO-8601, UTC) либо `null`. */
  editedAt: string | null;
  deleted: boolean;
  /**
   * Число прочитавших Сообщение Участников на момент выборки (Req 11.8).
   * Начальное значение счётчика «Прочитали» для ленты; опускается в нагрузке
   * редактирования (клиент сохраняет ранее известное значение).
   */
  readCount?: number;
  /** Вложения Сообщения; опускается, если их нет. */
  attachments?: AttachmentMetaView[];
}

/** Один прочитавший Сообщение Участник (зеркалит клиентский `MessageReader`, Req 11.8). */
export interface MessageReaderHttpView {
  userId: string;
  displayName: string;
  /** Момент прочтения (ISO-8601, UTC). */
  readAt: string;
}

/**
 * Преобразует Вложение в метаданные контракта (`AttachmentMeta`).
 *
 * Поскольку у Вложения нет собственного момента загрузки, в качестве `createdAt`
 * берётся момент создания родительского Сообщения, к которому оно прикреплено
 * (Вложение загружается вместе с Сообщением). Внутренние пути хранения наружу
 * не раскрываются (Req 19.8).
 *
 * @param attachment Доменное Вложение.
 * @param createdAt Момент загрузки (момент создания родительского Сообщения).
 * @returns Метаданные Вложения для клиента.
 */
export function toAttachmentMeta(attachment: Attachment, createdAt: Date): AttachmentMetaView {
  return {
    id: attachment.id,
    messageId: attachment.messageId,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: Number(attachment.sizeBytes),
    hasThumbnail: attachment.thumbnailPath !== null,
    compression: attachment.compression,
    checksum: attachment.checksum,
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Преобразует Сообщение с Вложениями в представление ленты Чата (`ChatMessage`).
 *
 * Момент создания и метка «изменено» сериализуются в ISO-8601 (UTC). Поле
 * `attachments` добавляется только при наличии Вложений (учёт
 * `exactOptionalPropertyTypes`): для каждого Вложения момент загрузки
 * наследуется от Сообщения. Идентификатор Задачи передаётся вызывающим
 * контроллером из маршрута `GET /tasks/:id/messages` (связь Чат↔Задача — один
 * к одному, Req 9.5).
 *
 * @param message Сообщение Чата с подгруженными Вложениями.
 * @param taskId Идентификатор Задачи, к Чату которой относится Сообщение.
 * @returns Представление Сообщения для клиента.
 */
export function toChatMessage(
  message: MessageWithAttachments,
  taskId: string,
): ChatMessageHttpView {
  const view: ChatMessageHttpView = {
    id: message.id,
    taskId,
    chatId: message.chatId,
    authorId: message.authorId,
    authorDisplayName: message.authorDisplayName,
    authorRole: message.author?.role ?? null,
    authorAvatarPath: message.author?.avatarPath ?? null,
    readCount: message._count?.reads ?? 0,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt === null ? null : message.editedAt.toISOString(),
    deleted: message.deleted,
  };
  if (message.attachments.length > 0) {
    view.attachments = message.attachments.map((a) => toAttachmentMeta(a, message.createdAt));
  }
  return view;
}

/**
 * Преобразует серверное представление Сообщения {@link ChatMessageView} (несёт
 * `taskId`) в представление ленты Чата (`ChatMessage`).
 *
 * Используется для ответов операций отправки/редактирования, где Сообщение уже
 * содержит идентификатор Задачи, а Вложения отсутствуют в полезной нагрузке
 * (привязка Вложений — задача 6). Поле `attachments` опускается. Данные аватара
 * автора в этом представлении не подгружаются, поэтому `authorAvatarPath`
 * передаётся как `null`: лента запрашивает аватар по `authorId` отдельно, а
 * realtime-обновление лишь сигнализирует об изменении Сообщения.
 *
 * @param view Серверное представление Сообщения с `taskId`.
 * @returns Представление Сообщения для клиента.
 */
export function fromChatMessageView(view: ChatMessageView): ChatMessageHttpView {
  return {
    id: view.id,
    taskId: view.taskId,
    chatId: view.chatId,
    authorId: view.authorId,
    authorDisplayName: view.authorDisplayName,
    authorRole: view.authorRole ?? null,
    authorAvatarPath: view.authorAvatarPath ?? null,
    text: view.text,
    createdAt: view.createdAt.toISOString(),
    editedAt: view.editedAt === null ? null : view.editedAt.toISOString(),
    deleted: view.deleted,
  };
}

/**
 * Преобразует серверное представление прочитавшего {@link MessageReaderView} в
 * представление контракта (`MessageReader`): момент прочтения сериализуется в
 * ISO-8601 (UTC) (Req 11.8).
 *
 * @param reader Серверное представление прочитавшего.
 * @returns Представление прочитавшего для клиента.
 */
export function toMessageReader(reader: MessageReaderView): MessageReaderHttpView {
  return {
    userId: reader.userId,
    displayName: reader.displayName,
    readAt: reader.readAt.toISOString(),
  };
}
