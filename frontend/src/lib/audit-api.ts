import { api } from './api';

/**
 * Типы и REST-вызов Журнала изменений Задачи (Req 20.1, 20.2, 20.3).
 *
 * Контракт соответствует AuditLogModule дизайна и серверному
 * `AuditLogService.list`: записи возвращаются упорядоченными от новых к старым
 * (Req 20.2) и доступны только Менеджеру Задачи или Администратору; иным
 * Пользователям сервер отвечает ошибкой доступа (Req 20.3). Записи неизменяемы
 * (append-only, Req 20.4) — клиент их только отображает.
 */

/**
 * Запись Журнала изменений (зеркалит серверный `AuditLogEntryView`).
 *
 * Содержит автора изменения, машинное имя изменённого параметра, прежнее и
 * новое значения и момент изменения. Момент дополнительно приходит
 * отформатированным в MSK (`changedAtMsk`, `ДД.ММ.ГГГГ ЧЧ:ММ`, Req 20.1);
 * абсолютный момент (`changedAt`, ISO-8601 UTC) сохранён для совместимости.
 */
export interface AuditLogEntry {
  id: string;
  taskId: string;
  authorId: string | null;
  /** Машинное имя параметра: `title`, `description`, `deadline`, `status`, … */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** Момент изменения (ISO-8601, UTC). */
  changedAt: string;
  /** Момент изменения в MSK (`ДД.ММ.ГГГГ ЧЧ:ММ`) (Req 20.1). */
  changedAtMsk: string;
}

/**
 * Возвращает все записи Журнала изменений Задачи, упорядоченные от новых к
 * старым (Req 20.2). Доступ контролируется сервером (Req 20.3): при отсутствии
 * прав вызов завершается `ApiError` со статусом 403.
 */
export function listAuditEntries(taskId: string): Promise<AuditLogEntry[]> {
  return api.get<AuditLogEntry[]>(`/tasks/${taskId}/audit`);
}
