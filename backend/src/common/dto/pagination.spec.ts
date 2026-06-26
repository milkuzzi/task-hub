import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PAGINATION, PaginationQueryDto } from './pagination';
import { buildPage } from './page';

/**
 * Юнит-тесты общих типов пагинации и ответов (задача 2.2).
 * Проверяют значения по умолчанию, границы валидации, приведение типов из
 * query-строки и корректность сборки страницы результатов (Req 18.5, 18.6).
 */
describe('PaginationQueryDto', () => {
  /** Преобразует «сырой» query-объект в DTO как это делает ValidationPipe. */
  function toDto(raw: Record<string, unknown>): PaginationQueryDto {
    return plainToInstance(PaginationQueryDto, raw);
  }

  it('применяет значения по умолчанию при отсутствии параметров', () => {
    const dto = toDto({});
    expect(dto.page).toBe(PAGINATION.defaultPage);
    expect(dto.pageSize).toBe(PAGINATION.defaultPageSize);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('приводит строковые query-параметры к числам', () => {
    const dto = toDto({ page: '3', pageSize: '50' });
    expect(dto.page).toBe(3);
    expect(dto.pageSize).toBe(50);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('вычисляет skip и take для запроса к БД', () => {
    const dto = toDto({ page: '3', pageSize: '20' });
    expect(dto.skip).toBe(40);
    expect(dto.take).toBe(20);
  });

  it('отклоняет размер страницы больше максимума', () => {
    const dto = toDto({ pageSize: String(PAGINATION.maxPageSize + 1) });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('pageSize');
  });

  it('отклоняет номер страницы меньше 1', () => {
    const dto = toDto({ page: '0' });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('page');
  });

  it('отклоняет нецелочисленные значения', () => {
    const dto = toDto({ page: '1.5' });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('page');
  });
});

describe('buildPage', () => {
  it('формирует метаданные для непустой страницы', () => {
    const page = buildPage(['a', 'b'], 5, 1, 2);
    expect(page.items).toEqual(['a', 'b']);
    expect(page.meta).toEqual({
      page: 1,
      pageSize: 2,
      total: 5,
      totalPages: 3,
      hasNext: true,
      hasPrevious: false,
    });
  });

  it('возвращает пустую страницу при превышении номера страницы, сохраняя total', () => {
    const page = buildPage<string>([], 5, 10, 2);
    expect(page.items).toEqual([]);
    expect(page.meta.total).toBe(5);
    expect(page.meta.totalPages).toBe(3);
    expect(page.meta.hasNext).toBe(false);
    expect(page.meta.hasPrevious).toBe(true);
  });

  it('обрабатывает отсутствие результатов', () => {
    const page = buildPage<string>([], 0, 1, 20);
    expect(page.meta.total).toBe(0);
    expect(page.meta.totalPages).toBe(0);
    expect(page.meta.hasNext).toBe(false);
    expect(page.meta.hasPrevious).toBe(false);
  });
});
