import { api } from './api';

/**
 * Типы и REST-вызовы Чата Задачи «Системы поручений» (Req 11.3–11.8, 11.10).
 *
 * Контракты соответствуют ChatModule дизайна и серверному `ChatService`:
 * - `listMessages(taskId)` — лента Сообщений Чата (Req 11.3, история).
 * - `sendMessage(taskId, text, attachmentIds)` — отправка Сообщения (Req 11.3, 11.4).
 * - `editMessage(messageId, text)` — редактирование с меткой «изменено» (Req 11.5).
 * - `deleteMessage(messageId)` — удаление с меткой «Сообщение удалено» (Req 11.7).
 * - `markRead(messageId)` — отметка прочтения (Req 11.8, 14.4).
 * - `listReaders(messageId)` — список прочитавших (Req 11.8).
 * - `listAttachments(taskId)` — раздел «Вложения» (Req 11.10).
 * - `uploadAttachment(taskId, file)` — загрузка файла для прикрепления (Req 12.1–12.5).
 *
 * Realtime-доставка (новые/изменённые Сообщения, списки прочитавших, статус,
 * счётчик) приходит через Socket.IO (`src/lib/socket.ts`, событие `ChatEvents`),
 * имена которых синхронизированы с серверным `chat.events.ts`. REST-вызовы здесь
 * используются для первичной загрузки и команд; живые обновления — по сокету.
 *
 * Все моменты времени приходят в ISO-8601 (UTC); клиент отображает их в MSK
 * (`ДД.ММ.ГГГГ ЧЧ:ММ`, Req 1.2).
 */

/** Граница длины текста Сообщения (Req 11.3, 11.4). */
export const MESSAGE_TEXT_BOUNDS = { min: 1, max: 4000 } as const;

/** Единый лимит размера загружаемого Вложения — 25 МБ (Req 12.2). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Максимум Вложений на одно Сообщение (Req 11.9). */
export const ATTACHMENTS_PER_MESSAGE_MAX = 10;

/**
 * Представление Сообщения Чата (зеркалит серверный `ChatMessageView`).
 *
 * `editedAt !== null` — метка «изменено» с датой/временем (Req 11.5);
 * `deleted === true` — на месте Сообщения отображается «Сообщение удалено»
 * (Req 11.7). `authorId === null` означает удалённого автора — отображается
 * сохранённое `authorDisplayName` (Req 8.4).
 */
export interface ChatMessage {
  id: string;
  taskId: string;
  chatId: string;
  authorId: string | null;
  authorDisplayName: string;
  /**
   * Относительный путь до аватара автора либо `null` (автор удалён/нет аватара,
   * Req 2.4). Признак наличия аватара; сами байты лента запрашивает по
   * защищённому эндпоинту `/avatars/:userId` (`authorId`). Может отсутствовать в
   * realtime-нагрузке отправки/редактирования.
   */
  authorAvatarPath?: string | null;
  text: string;
  /** Момент создания (ISO-8601, UTC). */
  createdAt: string;
  /** Момент последнего изменения (ISO-8601, UTC) либо `null`. */
  editedAt: string | null;
  deleted: boolean;
  /**
   * Число прочитавших Сообщение Участников на момент загрузки ленты (Req 11.8).
   * Начальное значение счётчика «Прочитали», чтобы он не показывал 0 до первого
   * события `chat:reads`/ручного раскрытия списка. Может отсутствовать в
   * realtime-нагрузке редактирования (тогда сохраняется ранее известное).
   */
  readCount?: number | undefined;
  /** Вложения Сообщения (могут отсутствовать в realtime-нагрузке). */
  attachments?: AttachmentMeta[] | undefined;
}

/** Один прочитавший Сообщение Участник (Req 11.8). */
export interface MessageReader {
  userId: string;
  displayName: string;
  /** Момент прочтения (ISO-8601, UTC). */
  readAt: string;
}

/** Полезная нагрузка обновления списка прочитавших по сокету (Req 11.8). */
export interface MessageReadersUpdate {
  messageId: string;
  taskId: string;
  readers: MessageReader[];
}

/** Полезная нагрузка обновления счётчика Сообщений по сокету (Req 9.7). */
export interface MessageCounterUpdate {
  taskId: string;
  messageCount: number;
}

/** Полезная нагрузка обновления Статуса Задачи по сокету (Req 10). */
export interface TaskStatusUpdate {
  taskId: string;
  status: string;
}

/**
 * Метаданные Вложения для раздела «Вложения» и превью (Req 11.10, 12.6, 12.7).
 *
 * `compression` — кодек сжатого хранения (например, `zstd`); используется при
 * полноэкранном просмотре для распаковки на стороне клиента (Req 12.9).
 * `checksum` — контрольная сумма исходного содержимого (sha256, hex) для
 * проверки целостности после распаковки.
 */
export interface AttachmentMeta {
  id: string;
  messageId: string;
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

/** Лента Сообщений Чата Задачи (история, старые → новые). */
export function listMessages(taskId: string): Promise<ChatMessage[]> {
  return api.get<ChatMessage[]>(`/tasks/${taskId}/messages`);
}

/**
 * Отправляет Сообщение в Чат Задачи (Req 11.3, 11.4).
 *
 * Текст валидируется на длину 1–4000 и на сервере; при нарушении сервер
 * отклоняет операцию, ничего не сохраняя (Req 11.4). Прикрепляемые Вложения
 * передаются идентификаторами, полученными из {@link uploadAttachment}.
 */
export function sendMessage(
  taskId: string,
  text: string,
  attachmentIds: string[] = [],
): Promise<ChatMessage> {
  return api.post<ChatMessage>(`/tasks/${taskId}/messages`, { text, attachmentIds });
}

/** Редактирует текст Сообщения; сервер проставляет метку «изменено» (Req 11.5). */
export function editMessage(messageId: string, text: string): Promise<ChatMessage> {
  return api.patch<ChatMessage>(`/messages/${messageId}`, { text });
}

/** Удаляет Сообщение; на его месте отображается «Сообщение удалено» (Req 11.7). */
export function deleteMessage(messageId: string): Promise<void> {
  return api.delete<void>(`/messages/${messageId}`);
}

/** Отмечает Сообщение прочитанным текущим Пользователем (Req 11.8, 14.4). */
export function markRead(messageId: string): Promise<void> {
  return api.post<void>(`/messages/${messageId}/read`);
}

/** Возвращает список прочитавших Сообщение Участников (Req 11.8). */
export function listReaders(messageId: string): Promise<MessageReader[]> {
  return api.get<MessageReader[]>(`/messages/${messageId}/readers`);
}

/** Возвращает все Вложения Чата Задачи для раздела «Вложения» (Req 11.10). */
export function listAttachments(taskId: string): Promise<AttachmentMeta[]> {
  return api.get<AttachmentMeta[]>(`/tasks/${taskId}/attachments`);
}

/**
 * Загружает файл-Вложение в Чат Задачи и возвращает его метаданные (Req 12.1–12.5).
 *
 * Лимит размера (25 МБ) и количества (≤10 на Сообщение) проверяются на сервере;
 * прерванная загрузка не сохраняет частичный файл (Req 12.3, 12.4, 19.9). Файл
 * передаётся как `multipart/form-data` (клиент `api` снимает JSON-заголовок).
 */
export function uploadAttachment(taskId: string, file: File): Promise<AttachmentMeta> {
  const form = new FormData();
  form.append('file', file, file.name);
  return api.post<AttachmentMeta>(`/tasks/${taskId}/attachments`, form);
}
