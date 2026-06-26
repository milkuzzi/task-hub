import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { TASK_PARAM_BOUNDS } from './create-task.dto';

/**
 * DTO изменения параметров Задачи без смены Статуса (Req 10.12, 10.13).
 *
 * Описывает частичную правку параметров Задачи: Название, Описание, Дедлайн.
 * Любое поле необязательно — применяются только переданные поля; Статус Задачи
 * при этом сохраняется без изменения (Req 10.12). Изменение состава участников
 * (Исполнители/Менеджеры) выполняется отдельной операцией
 * {@link TasksService.assign} с собственными правилами ролей (Req 2.4–2.7) и
 * здесь не выполняется.
 *
 * Семантика `description`:
 * - поле отсутствует (`undefined`) — Описание не изменяется;
 * - `null` — Описание очищается (0 символов допустимо, Req 9.1);
 * - строка — Описание заменяется (0..5000 символов, Req 9.1).
 *
 * Те же границы дополнительно проверяются в {@link TasksService.update}, чтобы
 * инвариант параметров Задачи (Req 9.1) выполнялся независимо от точки входа
 * (REST, Бот MAX, внутренние вызовы).
 */
export class UpdateTaskDto {
  /** Новое Название — необязательно; при наличии 1..200 символов (Req 9.1). */
  @IsOptional()
  @IsString({ message: 'Название должно быть строкой.' })
  @Length(TASK_PARAM_BOUNDS.titleMinLength, TASK_PARAM_BOUNDS.titleMaxLength, {
    message: `Название должно содержать от ${TASK_PARAM_BOUNDS.titleMinLength} до ${TASK_PARAM_BOUNDS.titleMaxLength} символов.`,
  })
  title?: string;

  /**
   * Новое Описание — необязательно; `null` очищает, строка заменяет (0..5000,
   * Req 9.1). Валидация длины применяется только к строковому значению.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'Описание должно быть строкой.' })
  @Length(TASK_PARAM_BOUNDS.descriptionMinLength, TASK_PARAM_BOUNDS.descriptionMaxLength, {
    message: `Описание не должно превышать ${TASK_PARAM_BOUNDS.descriptionMaxLength} символов.`,
  })
  description?: string | null;

  /** Новый Дедлайн — необязательно; при наличии корректная дата и время (Req 9.1). */
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'Дедлайн должен быть корректной датой и временем.' })
  deadline?: Date;
}
