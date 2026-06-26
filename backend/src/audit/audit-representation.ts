import { AuditLogEntryView } from './audit-log.types';

/**
 * HTTP-представление записи Журнала изменений (контракт
 * `frontend/src/lib/audit-api.ts`).
 *
 * Доменное {@link AuditLogEntryView} хранит момент изменения как {@link Date}
 * ({@link AuditLogEntryView.changedAt}); фронтенд ожидает его строкой ISO-8601
 * (UTC). Этот модуль выполняет чистое сопоставление: момент сериализуется в ISO,
 * отформатированное представление MSK (`changedAtMsk`) и остальные поля
 * передаются как есть (Req 20.1, 20.2).
 */

/** Запись Журнала изменений в форме контракта фронтенда (Req 20.1, 20.2). */
export interface AuditEntryView {
  /** Идентификатор записи Журнала. */
  id: string;
  /** Идентификатор Задачи, к которой относится изменение. */
  taskId: string;
  /** Идентификатор автора изменения; `null`, если автор удалён (hard-delete). */
  authorId: string | null;
  /** Машинное имя изменённого параметра (`title`, `description`, `deadline`, …). */
  field: string;
  /** Прежнее значение параметра (`null`, если не было). */
  oldValue: string | null;
  /** Новое значение параметра (`null`, если очищено). */
  newValue: string | null;
  /** Момент изменения (ISO-8601, UTC). */
  changedAt: string;
  /** Момент изменения в MSK для отображения, формат `ДД.ММ.ГГГГ ЧЧ:ММ` (Req 20.1). */
  changedAtMsk: string;
}

/**
 * Преобразует доменную запись Журнала в представление контракта фронтенда:
 * момент изменения сериализуется в ISO-8601 (UTC), остальные поля без изменений.
 *
 * @param entry Доменная запись Журнала (момент как {@link Date}).
 * @returns Запись Журнала для клиента (момент как ISO-строка).
 */
export function toAuditEntryView(entry: AuditLogEntryView): AuditEntryView {
  return {
    id: entry.id,
    taskId: entry.taskId,
    authorId: entry.authorId,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    changedAt: entry.changedAt.toISOString(),
    changedAtMsk: entry.changedAtMsk,
  };
}
