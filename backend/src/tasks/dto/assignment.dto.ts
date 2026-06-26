import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';
import { TASK_PARAM_BOUNDS } from './create-task.dto';

/**
 * DTO назначения участников Задачи (Req 2.4–2.7).
 *
 * Описывает авторитетный (полный) желаемый состав Исполнителей и Менеджеров
 * Задачи. Операция {@link TasksService.assign} применяет переданные списки
 * целиком, поэтому границы 1–100 для каждого вида (Req 9.1) проверяются как на
 * границе контроллеров этим DTO, так и повторно в прикладном сервисе —
 * инвариант состава Задачи выполняется независимо от точки входа (REST, Бот
 * MAX, внутренние вызовы).
 *
 * Применяется глобальным `ValidationPipe` (whitelist + transform). Нарушения
 * преобразуются глобальным фильтром исключений в единый формат
 * `{ code, message, details? }` с локализованным русским сообщением (Req 1.1).
 */
export class AssignmentDto {
  /** Идентификаторы Исполнителей — обязательно, 1..100 (Req 9.1, 2.4–2.6). */
  @IsArray({ message: 'Исполнители должны быть переданы списком.' })
  @ArrayMinSize(TASK_PARAM_BOUNDS.assigneesMin, {
    message: `Должен быть назначен хотя бы ${TASK_PARAM_BOUNDS.assigneesMin} Исполнитель.`,
  })
  @ArrayMaxSize(TASK_PARAM_BOUNDS.assigneesMax, {
    message: `Число Исполнителей не может превышать ${TASK_PARAM_BOUNDS.assigneesMax}.`,
  })
  @IsString({ each: true, message: 'Идентификатор Исполнителя должен быть строкой.' })
  executorIds!: string[];

  /** Идентификаторы Менеджеров — обязательно, 1..100 (Req 9.1, 2.7). */
  @IsArray({ message: 'Менеджеры должны быть переданы списком.' })
  @ArrayMinSize(TASK_PARAM_BOUNDS.assigneesMin, {
    message: `Должен быть назначен хотя бы ${TASK_PARAM_BOUNDS.assigneesMin} Менеджер.`,
  })
  @ArrayMaxSize(TASK_PARAM_BOUNDS.assigneesMax, {
    message: `Число Менеджеров не может превышать ${TASK_PARAM_BOUNDS.assigneesMax}.`,
  })
  @IsString({ each: true, message: 'Идентификатор Менеджера должен быть строкой.' })
  managerIds!: string[];
}
