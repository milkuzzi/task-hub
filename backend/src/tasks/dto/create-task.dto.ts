import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * Границы параметров Задачи (Req 9.1).
 *
 * Единый источник истины для DTO-границы контроллеров и прикладной валидации
 * {@link TasksService.create}. Значения соответствуют требованию 9.1:
 * Название 1–200, Описание 0–5000, Исполнители/Менеджеры 1–100.
 */
export const TASK_PARAM_BOUNDS = {
  /** Минимальная длина Названия (Req 9.1). */
  titleMinLength: 1,
  /** Максимальная длина Названия (Req 9.1). */
  titleMaxLength: 200,
  /** Минимальная длина Описания (Req 9.1). */
  descriptionMinLength: 0,
  /** Максимальная длина Описания (Req 9.1). */
  descriptionMaxLength: 5000,
  /** Минимум Исполнителей/Менеджеров на Задаче (Req 9.1). */
  assigneesMin: 1,
  /** Максимум Исполнителей/Менеджеров на Задаче (Req 9.1). */
  assigneesMax: 100,
} as const;

/**
 * DTO создания Задачи на границе контроллеров (Req 9.1, 9.2, 9.3).
 *
 * Применяется глобальным `ValidationPipe` (whitelist + transform): строковое
 * представление Дедлайна приводится к {@link Date} через `@Type(() => Date)`,
 * границы значений проверяются декораторами. Нарушения преобразуются глобальным
 * фильтром исключений в единый формат `{ code, message, details? }` с
 * локализованным русским сообщением (Req 1.1, 9.3). Поскольку проверка
 * выполняется до изменения состояния, ранее введённые значения не теряются
 * (Req 9.3) — клиент сохраняет переданный ввод.
 *
 * Те же границы дополнительно проверяются в {@link TasksService.create}, чтобы
 * инвариант параметров Задачи (Req 9.1) выполнялся независимо от точки входа
 * (REST, Бот MAX, внутренние вызовы).
 */
export class CreateTaskDto {
  /** Название Задачи — обязательное, 1..200 символов (Req 9.1). */
  @IsString({ message: 'Название должно быть строкой.' })
  @Length(TASK_PARAM_BOUNDS.titleMinLength, TASK_PARAM_BOUNDS.titleMaxLength, {
    message: `Название должно содержать от ${TASK_PARAM_BOUNDS.titleMinLength} до ${TASK_PARAM_BOUNDS.titleMaxLength} символов.`,
  })
  title!: string;

  /** Описание Задачи — необязательное, 0..5000 символов (Req 9.1). */
  @IsOptional()
  @IsString({ message: 'Описание должно быть строкой.' })
  @Length(TASK_PARAM_BOUNDS.descriptionMinLength, TASK_PARAM_BOUNDS.descriptionMaxLength, {
    message: `Описание не должно превышать ${TASK_PARAM_BOUNDS.descriptionMaxLength} символов.`,
  })
  description?: string;

  /** Дедлайн Задачи — обязательная дата и время (Req 9.1). */
  @Type(() => Date)
  @IsDate({ message: 'Дедлайн должен быть корректной датой и временем.' })
  deadline!: Date;

  /** Идентификаторы Исполнителей — обязательно, 1..100 (Req 9.1). */
  @IsArray({ message: 'Исполнители должны быть переданы списком.' })
  @ArrayMinSize(TASK_PARAM_BOUNDS.assigneesMin, {
    message: `Должен быть назначен хотя бы ${TASK_PARAM_BOUNDS.assigneesMin} Исполнитель.`,
  })
  @ArrayMaxSize(TASK_PARAM_BOUNDS.assigneesMax, {
    message: `Число Исполнителей не может превышать ${TASK_PARAM_BOUNDS.assigneesMax}.`,
  })
  @IsString({ each: true, message: 'Идентификатор Исполнителя должен быть строкой.' })
  executorIds!: string[];

  /** Идентификаторы Менеджеров — обязательно, 1..100 (Req 9.1). */
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
