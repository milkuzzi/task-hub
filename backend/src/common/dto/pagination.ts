import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Значения по умолчанию и границы пагинации (Req 18.5, 18.6).
 *
 * По умолчанию возвращается первая страница из 20 элементов; размер страницы
 * ограничен сверху значением 100. Эти константы используются как DTO-границей
 * запроса, так и сервисами при формировании страниц результатов.
 */
export const PAGINATION = {
  /** Номер страницы по умолчанию. */
  defaultPage: 1,
  /** Минимально допустимый номер страницы. */
  minPage: 1,
  /** Размер страницы по умолчанию (Req 18.5). */
  defaultPageSize: 20,
  /** Минимально допустимый размер страницы. */
  minPageSize: 1,
  /** Максимально допустимый размер страницы (Req 18.5). */
  maxPageSize: 100,
} as const;

/**
 * DTO параметров пагинации на границе контроллеров (Req 18.5, 18.6).
 *
 * Применяется глобальным `ValidationPipe` (whitelist + transform): значения
 * приводятся к числу из строковых query-параметров, проверяются на целочисленность
 * и попадание в допустимые границы. Недопустимые значения отклоняются до
 * выполнения запроса (Req 18.7), а отсутствующие — заменяются значениями по
 * умолчанию.
 */
export class PaginationQueryDto {
  /** Номер запрашиваемой страницы (начиная с 1). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Номер страницы должен быть целым числом.' })
  @Min(PAGINATION.minPage, { message: 'Номер страницы должен быть не меньше 1.' })
  page: number = PAGINATION.defaultPage;

  /** Количество элементов на странице (1..100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Размер страницы должен быть целым числом.' })
  @Min(PAGINATION.minPageSize, { message: 'Размер страницы должен быть не меньше 1.' })
  @Max(PAGINATION.maxPageSize, {
    message: `Размер страницы не может превышать ${PAGINATION.maxPageSize}.`,
  })
  pageSize: number = PAGINATION.defaultPageSize;

  /** Смещение для запроса к БД (`OFFSET`). */
  get skip(): number {
    return (this.page - PAGINATION.minPage) * this.pageSize;
  }

  /** Количество извлекаемых записей (`LIMIT`). */
  get take(): number {
    return this.pageSize;
  }
}
