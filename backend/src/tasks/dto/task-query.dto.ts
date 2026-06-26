import { Transform, Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { TaskStatus } from '@prisma/client';
import { PAGINATION } from '../../common/dto';
import { SEARCH_TEXT_BOUNDS } from '../../search';

/**
 * Приводит значение query-параметра к массиву строк (Req 18.3).
 *
 * Повторяющиеся query-ключи (`?statuses=A&statuses=B`) Express отдаёт массивом,
 * а единичный — строкой. Чтобы фильтры-множества (Статусы, участники)
 * единообразно валидировались и обрабатывались, единичное значение
 * оборачивается в массив; отсутствующее значение остаётся `undefined`.
 */
function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item));
}

/**
 * DTO параметров запроса списка Задач (поиск + фильтры + пагинация, Req 18).
 *
 * Соответствует клиентскому `TaskQuery` (`frontend/src/lib/tasks-api.ts`):
 * строка подстрочного поиска (1–256, Req 18.1, 18.2), конъюнктивные фильтры по
 * Статусу/Дедлайну/участникам (Req 18.3) и пагинация (по умолчанию 20, максимум
 * 100, Req 18.5). Применяется глобальным `ValidationPipe` (whitelist +
 * transform): числовые и датовые значения приводятся из строковых
 * query-параметров, множества — к массивам. Контроллер преобразует этот DTO в
 * доменный `SearchQuery` и делегирует {@link import('../../search').SearchService.search}.
 */
export class TaskQueryDto {
  /** Номер запрашиваемой страницы (начиная с 1, Req 18.5). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Номер страницы должен быть целым числом.' })
  @Min(PAGINATION.minPage, { message: 'Номер страницы должен быть не меньше 1.' })
  page?: number;

  /** Размер страницы (1..100, по умолчанию 20, Req 18.5). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Размер страницы должен быть целым числом.' })
  @Min(PAGINATION.minPageSize, { message: 'Размер страницы должен быть не меньше 1.' })
  @Max(PAGINATION.maxPageSize, {
    message: `Размер страницы не может превышать ${PAGINATION.maxPageSize}.`,
  })
  pageSize?: number;

  /** Строка подстрочного поиска по Названию/Описанию (1–256, Req 18.1, 18.2). */
  @IsOptional()
  @IsString({ message: 'Поисковый запрос должен быть строкой.' })
  @Length(SEARCH_TEXT_BOUNDS.minLength, SEARCH_TEXT_BOUNDS.maxLength, {
    message: `Поисковый запрос должен содержать от ${SEARCH_TEXT_BOUNDS.minLength} до ${SEARCH_TEXT_BOUNDS.maxLength} символов.`,
  })
  text?: string;

  /** Фильтр по Статусу: один из перечисленных Статусов (Req 18.3). */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsIn(Object.values(TaskStatus), {
    each: true,
    message: 'Недопустимый Статус в фильтре.',
  })
  statuses?: TaskStatus[];

  /** Нижняя граница Дедлайна включительно (Req 18.3). */
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'Нижняя граница Дедлайна должна быть корректной датой.' })
  deadlineFrom?: Date;

  /** Верхняя граница Дедлайна включительно (Req 18.3). */
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'Верхняя граница Дедлайна должна быть корректной датой.' })
  deadlineTo?: Date;

  /** Фильтр по участникам: назначен хотя бы один из Пользователей (Req 18.3). */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsString({ each: true, message: 'Идентификатор участника должен быть строкой.' })
  participantIds?: string[];
}
