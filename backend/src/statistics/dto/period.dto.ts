import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { ExportFormat } from '../statistics.export';

/** Допустимые форматы экспорта Статистики (Req 17.9). */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'xlsx'];

/**
 * DTO периода и формата для эндпоинтов Статистики (Req 17.6, 17.7, 17.9).
 *
 * Соответствует клиентскому контракту `frontend/src/lib/statistics-api.ts`:
 * период задаётся датами `from`/`to` в ISO-8601 (включительно, Req 17.6), а
 * экспорт дополнительно принимает `format` (`csv`|`xlsx`, Req 17.9). Применяется
 * глобальным `ValidationPipe` (whitelist + transform): некорректные значения
 * (не-ISO даты, неизвестный формат) отклоняются до контроллера и
 * преобразуются глобальным фильтром в единый формат `{ code, message }`
 * (Req 1.1).
 *
 * Валидация согласованности диапазона (начало не позже конца) выполняется
 * доменным {@link import('../statistics.service').StatisticsService.compute}
 * (Req 17.7) — DTO проверяет лишь форму отдельных параметров.
 */
export class PeriodDto {
  /** Начало периода (включительно), ISO-8601 (UTC) (Req 17.6). */
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'Начало периода должно быть датой в формате ISO-8601.' })
  from?: string;

  /** Конец периода (включительно), ISO-8601 (UTC) (Req 17.6). */
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'Конец периода должен быть датой в формате ISO-8601.' })
  to?: string;

  /** Формат экспортируемого файла (`csv`|`xlsx`, Req 17.9). */
  @IsOptional()
  @IsIn(EXPORT_FORMATS, { message: 'Недопустимый формат экспорта: ожидается «csv» или «xlsx».' })
  format?: ExportFormat;
}
