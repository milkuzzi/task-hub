import { Role, TaskStatus } from '@prisma/client';
import { ValidationException } from '../common/errors';
import {
  buildSearchWhere,
  buildVisibilityWhere,
  validateSearchQuery,
  validateSearchText,
  validateTaskFilters,
} from './search-query';
import { SEARCH_TEXT_BOUNDS } from './search.types';

/**
 * Модульные тесты чистых функций поиска, фильтрации и построения запроса
 * (Req 18.1–18.7). Проверяются валидация строки запроса и фильтров (Req 18.2,
 * 18.4, 18.7), условие видимости по роли (Req 2.8–2.10) и конъюнкция
 * видимости ∧ текста ∧ фильтров (Req 18.1, 18.3).
 */

describe('validateSearchText — длина строки запроса (Req 18.1, 18.2)', () => {
  it('возвращает undefined при отсутствии строки (поиск без подстроки)', () => {
    expect(validateSearchText(undefined)).toBeUndefined();
  });

  it('принимает строку минимальной длины 1 (Req 18.1)', () => {
    expect(validateSearchText('a')).toBe('a');
  });

  it('принимает строку максимальной длины 256 (Req 18.1)', () => {
    const text = 'x'.repeat(SEARCH_TEXT_BOUNDS.maxLength);
    expect(validateSearchText(text)).toBe(text);
  });

  it('сохраняет исходный регистр строки (регистронезависимость — на уровне запроса)', () => {
    expect(validateSearchText('ОтЧёт')).toBe('ОтЧёт');
  });

  it('отклоняет пустую строку (Req 18.2)', () => {
    expect(() => validateSearchText('')).toThrow(ValidationException);
  });

  it('отклоняет строку длиной более 256 символов (Req 18.2)', () => {
    const tooLong = 'y'.repeat(SEARCH_TEXT_BOUNDS.maxLength + 1);
    expect(() => validateSearchText(tooLong)).toThrow(ValidationException);
  });
});

describe('validateTaskFilters — значения фильтров (Req 18.3, 18.4)', () => {
  it('возвращает undefined при отсутствии фильтров', () => {
    expect(validateTaskFilters(undefined)).toBeUndefined();
  });

  it('возвращает undefined, когда все фильтры пусты', () => {
    expect(validateTaskFilters({ statuses: [], participantIds: [] })).toBeUndefined();
  });

  it('нормализует и дедуплицирует Статусы', () => {
    const result = validateTaskFilters({
      statuses: [TaskStatus.IN_PROGRESS, TaskStatus.IN_PROGRESS, TaskStatus.DONE],
    });
    expect(result?.statuses).toEqual([TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
  });

  it('отклоняет недопустимое значение Статуса (Req 18.4)', () => {
    expect(() => validateTaskFilters({ statuses: ['NOT_A_STATUS' as TaskStatus] })).toThrow(
      ValidationException,
    );
  });

  it('принимает корректный диапазон Дедлайна', () => {
    const from = new Date('2030-01-01T00:00:00Z');
    const to = new Date('2030-02-01T00:00:00Z');
    const result = validateTaskFilters({ deadlineFrom: from, deadlineTo: to });
    expect(result?.deadlineFrom).toEqual(from);
    expect(result?.deadlineTo).toEqual(to);
  });

  it('отклоняет диапазон, где нижняя граница позже верхней (Req 18.4)', () => {
    expect(() =>
      validateTaskFilters({
        deadlineFrom: new Date('2030-02-01T00:00:00Z'),
        deadlineTo: new Date('2030-01-01T00:00:00Z'),
      }),
    ).toThrow(ValidationException);
  });

  it('отклоняет некорректную дату Дедлайна (Req 18.4)', () => {
    expect(() => validateTaskFilters({ deadlineFrom: new Date('not-a-date') })).toThrow(
      ValidationException,
    );
  });

  it('отклоняет пустой идентификатор участника (Req 18.4)', () => {
    expect(() => validateTaskFilters({ participantIds: [''] })).toThrow(ValidationException);
  });
});

describe('validateSearchQuery — целостный запрос (Req 18.7)', () => {
  it('отклоняет весь запрос, если недопустима строка при допустимых фильтрах (Req 18.7)', () => {
    expect(() =>
      validateSearchQuery({ text: '', filters: { statuses: [TaskStatus.DONE] } }),
    ).toThrow(ValidationException);
  });

  it('отклоняет весь запрос, если недопустим фильтр при допустимой строке (Req 18.7)', () => {
    expect(() =>
      validateSearchQuery({ text: 'отчёт', filters: { statuses: ['BAD' as TaskStatus] } }),
    ).toThrow(ValidationException);
  });

  it('возвращает нормализованные строку и фильтры при корректном запросе', () => {
    const result = validateSearchQuery({
      text: 'отчёт',
      filters: { statuses: [TaskStatus.WAITING] },
    });
    expect(result.text).toBe('отчёт');
    expect(result.filters?.statuses).toEqual([TaskStatus.WAITING]);
  });
});

describe('buildVisibilityWhere — видимость по доступу (Req 2.8–2.10)', () => {
  it('Администратор видит все Задачи (без ограничений, Req 2.10)', () => {
    expect(buildVisibilityWhere('admin', Role.ADMIN)).toEqual({});
  });

  it('Менеджер видит Задачи, где он назначен в любом виде', () => {
    expect(buildVisibilityWhere('m1', Role.MANAGER)).toEqual({
      assignments: { some: { userId: 'm1' } },
    });
  });

  it('Исполнитель видит Задачи, где он назначен в любом виде', () => {
    expect(buildVisibilityWhere('e1', Role.EXECUTOR)).toEqual({
      assignments: { some: { userId: 'e1' } },
    });
  });
});

describe('buildSearchWhere — конъюнкция видимости ∧ текста ∧ фильтров (Req 18.1, 18.3)', () => {
  it('применяет только видимость, когда нет строки и фильтров', () => {
    const where = buildSearchWhere('e1', Role.EXECUTOR, {});
    expect(where).toEqual({
      AND: [{ assignments: { some: { userId: 'e1' } } }],
    });
  });

  it('добавляет регистронезависимый подстрочный поиск по Названию ИЛИ Описанию (Req 18.1)', () => {
    const where = buildSearchWhere('admin', Role.ADMIN, { text: 'Отчёт' });
    expect(where.AND).toContainEqual({
      OR: [
        { title: { contains: 'Отчёт', mode: 'insensitive' } },
        { description: { contains: 'Отчёт', mode: 'insensitive' } },
      ],
    });
  });

  it('объединяет фильтры по Статусу, Дедлайну и участникам конъюнктивно (Req 18.3)', () => {
    const from = new Date('2030-01-01T00:00:00Z');
    const to = new Date('2030-02-01T00:00:00Z');
    const where = buildSearchWhere('admin', Role.ADMIN, {
      filters: {
        statuses: [TaskStatus.IN_PROGRESS],
        deadlineFrom: from,
        deadlineTo: to,
        participantIds: ['u1', 'u2'],
      },
    });
    expect(where.AND).toContainEqual({ status: { in: [TaskStatus.IN_PROGRESS] } });
    expect(where.AND).toContainEqual({ deadline: { gte: from, lte: to } });
    expect(where.AND).toContainEqual({
      assignments: { some: { userId: { in: ['u1', 'u2'] } } },
    });
  });

  it('всегда включает условие видимости первым элементом конъюнкции', () => {
    const where = buildSearchWhere('m1', Role.MANAGER, {
      text: 'x',
      filters: { statuses: [TaskStatus.DONE] },
    });
    expect((where.AND as unknown[])[0]).toEqual({
      assignments: { some: { userId: 'm1' } },
    });
  });
});
