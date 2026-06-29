import { Type } from 'class-transformer';
import { IsIn, IsObject, ValidateIf, ValidateNested } from 'class-validator';
import { TaskStatus } from '@prisma/client';

/**
 * Допустимые типы действия смены Статуса (Req 10.4–10.10).
 *
 * Единый источник истины для DTO-границы контроллера; значения совпадают с
 * действиями конечного автомата {@link import('../../status').StatusAction}.
 */
export const STATUS_ACTION_TYPES = [
  'COMPLETE', // Пометить «Выполнено» (Req 10.4)
  'START_WORK', // Вернуть из «Ожидает» в «В работе»
  'REOPEN', // Переоткрыть из «Выполнено» (Req 10.5)
  'CANCEL', // Отменить (Req 10.6)
  'RETURN', // Вернуть из «Отменено» (Req 10.7)
  'REQUEST_ADMIN', // Запросить «Требует администратора» (Req 10.8)
  'ADMIN_SET', // Администратор выбирает целевой Статус (Req 10.9)
  'CLEAR_ADMIN', // Менеджер снимает «Требует администратора» (Req 10.10)
] as const;

/** Тип действия смены Статуса. */
export type StatusActionType = (typeof STATUS_ACTION_TYPES)[number];

/**
 * DTO действия смены Статуса на границе контроллера (Req 10.4–10.10).
 *
 * Соответствует клиентскому объединению `StatusAction` (`frontend/src/lib/status-api.ts`):
 * несёт тип действия и — только для `ADMIN_SET` — целевой Статус, выбранный
 * Администратором из «Требует администратора» (Req 10.9). Для прочих действий
 * поле `target` не требуется и не передаётся.
 *
 * Права и допустимость перехода повторно проверяет {@link import('../../status').StatusMachine}
 * в {@link import('../tasks.service').TasksService.changeStatus}; DTO лишь
 * проверяет форму запроса.
 */
export class StatusActionDto {
  /** Тип действия смены Статуса (Req 10.4–10.10). */
  @IsIn(STATUS_ACTION_TYPES, {
    message: 'Недопустимый тип действия смены статуса.',
  })
  type!: StatusActionType;

  /**
   * Целевой Статус для `ADMIN_SET` (Req 10.9). Обязателен только для этого
   * действия; для остальных типов не проверяется и игнорируется.
   */
  @ValidateIf((o: StatusActionDto) => o.type === 'ADMIN_SET')
  @IsIn(Object.values(TaskStatus), {
    message: 'Недопустимый целевой статус для действия ADMIN_SET.',
  })
  target?: TaskStatus;
}

/**
 * Тело запроса смены Статуса (Req 10.4–10.10).
 *
 * Совпадает с клиентским `ChangeStatusBody` (`{ action: StatusAction }`):
 * `POST /tasks/:id/status` принимает действие, которое контроллер передаёт в
 * {@link import('../tasks.service').TasksService.changeStatus}. Применяется
 * глобальным `ValidationPipe` (whitelist + transform); нарушения преобразуются
 * глобальным фильтром в единый формат `{ code, message, details? }` (Req 1.1).
 */
export class ChangeStatusDto {
  /** Действие смены Статуса (Req 10.4–10.10). */
  @IsObject({ message: 'Действие смены статуса обязательно.' })
  @ValidateNested()
  @Type(() => StatusActionDto)
  action!: StatusActionDto;
}
