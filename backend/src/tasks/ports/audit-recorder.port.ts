import { Injectable, Logger } from '@nestjs/common';

/**
 * Черновик записи журнала изменений Задачи (Req 20.1).
 *
 * Описывает одно изменение одного параметра Задачи: кто изменил, какой параметр,
 * прежнее и новое значение. Время изменения (MSK) и неизменяемость записи —
 * ответственность реализации порта (append-only, Req 20.1, 20.4). Поля
 * соответствуют модели `AuditEntry` схемы данных (`taskId`, `authorId`, `field`,
 * `oldValue`, `newValue`).
 */
export interface AuditFieldChange {
  /** Идентификатор Задачи, к которой относится изменение. */
  taskId: string;
  /** Идентификатор инициатора изменения (автор записи журнала). */
  authorId: string;
  /** Машинное имя изменённого параметра, например `title`, `description`, `deadline`. */
  field: string;
  /** Прежнее значение параметра в строковом представлении (null, если не было). */
  oldValue: string | null;
  /** Новое значение параметра в строковом представлении (null, если очищено). */
  newValue: string | null;
}

/**
 * Порт журналирования изменений Задачи (Req 20.1).
 *
 * Абстрагирует запись в журнал изменений (append-only) от прикладной логики
 * Задач. Прикладной код {@link TasksService} вызывает {@link record} на каждое
 * изменённое поле при редактировании параметров Задачи (Req 10.12, 20.1).
 *
 * Реальная реализация (append-only журнал с правами просмотра и фиксацией
 * времени MSK) появится в `AuditLogModule` (задача 8.1) и будет привязана к
 * токену {@link AUDIT_RECORDER} вместо реализации по умолчанию
 * {@link NoopAuditRecorder}.
 */
export interface AuditRecorder {
  /**
   * Фиксирует одно изменение параметра Задачи в журнале изменений.
   *
   * @param change Описание изменённого параметра.
   */
  record(change: AuditFieldChange): Promise<void>;
}

/**
 * DI-токен порта {@link AuditRecorder}.
 *
 * Используется для инъекции реализации в {@link TasksService}. До готовности
 * `AuditLogModule` (задача 8.1) к токену привязана безопасная реализация-заглушка
 * {@link NoopAuditRecorder}.
 */
export const AUDIT_RECORDER = Symbol('AUDIT_RECORDER');

/**
 * Реализация порта {@link AuditRecorder} по умолчанию — безопасная заглушка.
 *
 * Ничего не записывает в журнал и не имеет побочных эффектов, помимо отладочного
 * лога. Позволяет {@link TasksService} вызывать журналирование уже сейчас, не
 * дожидаясь `AuditLogModule` (задача 8.1). После реализации журнала эта заглушка
 * будет заменена реальной привязкой токена {@link AUDIT_RECORDER}.
 */
@Injectable()
export class NoopAuditRecorder implements AuditRecorder {
  private readonly logger = new Logger(NoopAuditRecorder.name);

  async record(change: AuditFieldChange): Promise<void> {
    // Заглушка до реализации AuditLogModule (задача 8.1): фиксируем только в
    // отладочном логе, чтобы не терять трассируемость при отладке.
    this.logger.debug(
      `Журнал изменений (заглушка): задача «${change.taskId}», параметр «${change.field}», ` +
        `инициатор «${change.authorId}».`,
    );
  }
}
