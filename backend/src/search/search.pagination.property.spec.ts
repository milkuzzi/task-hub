import 'reflect-metadata';
import fc from 'fast-check';
import { Role, Task, User } from '@prisma/client';
import { buildPage, Page, PaginationQueryDto } from '../common/dto';
import { TaskRepository, UserRepository } from '../repositories';
import { SearchService } from './search.service';
import { SearchQuery } from './search.types';

/**
 * **Feature: task-assignment-system, Property 54: Пагинация**
 *
 * Property 54 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 18.5, 18.6**:
 *
 * Для любого запроса списка задач размер возвращаемой страницы не превышает
 * min(запрошенный_размер, 100), при отсутствии указанного размера используется
 * 20 (Req 18.5); запрос страницы за пределами доступных возвращает пустой
 * список и корректное общее число найденных задач (Req 18.6).
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Он прогоняет полную реализацию
 * пагинации {@link SearchService.search} → {@link SearchService.resolvePagination}
 * → репозиторий → {@link buildPage}, подменяя только границу БД: фейковый
 * {@link TaskRepository.list} честно воспроизводит семантику Prisma
 * (`skip`/`take`/`count`) над in-memory набором Задач, как это сделал бы
 * PostgreSQL. Видимость намеренно не ограничивает выборку (Пользователь —
 * Администратор, Req 2.10), чтобы изолировать поведение пагинации.
 */
describe('Property 54: Пагинация (Req 18.5, 18.6)', () => {
  const DEFAULT_PAGE_SIZE = 20;
  const MAX_PAGE_SIZE = 100;

  /** Эталонный нормализованный размер страницы (Req 18.5), независимый от кода сервиса. */
  function expectedPageSize(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) {
      return DEFAULT_PAGE_SIZE;
    }
    return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
  }

  /** Эталонный нормализованный номер страницы (≥1, по умолчанию 1). */
  function expectedPage(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) {
      return 1;
    }
    return Math.max(1, Math.floor(requested));
  }

  function makeAdmin(id: string): User {
    return {
      id,
      email: `${id}@example.com`,
      displayName: id,
      role: Role.ADMIN,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
    } as unknown as User;
  }

  /**
   * Создаёт сервис с фейковыми репозиториями. {@link TaskRepository.list}
   * воспроизводит выборку Prisma над `dataset`: срез `skip..skip+take` и полный
   * `count`, после чего собирает страницу через {@link buildPage}.
   */
  function buildService(dataset: Task[]) {
    const findActiveById = jest.fn(async () => makeAdmin('admin'));

    const list = jest.fn(async (pagination: PaginationQueryDto): Promise<Page<Task>> => {
      // Администратор видит все Задачи (Req 2.10) — изолируем пагинацию.
      const total = dataset.length;
      const items = dataset.slice(pagination.skip, pagination.skip + pagination.take);
      return buildPage(items, total, pagination.page, pagination.pageSize);
    });

    const taskRepository = { list } as unknown as TaskRepository;
    const userRepository = { findActiveById } as unknown as UserRepository;
    return new SearchService(taskRepository, userRepository);
  }

  // ---- Генераторы ---------------------------------------------------------

  const datasetArb = fc
    .nat({ max: 250 })
    .map((n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }) as unknown as Task));

  // Размер страницы: отсутствует, ниже 1, обычный, ровно/выше максимума.
  const pageSizeArb = fc.option(fc.integer({ min: -5, max: 250 }), { nil: undefined });
  // Номер страницы: отсутствует, ниже 1, внутри диапазона и за его пределами.
  const pageArb = fc.option(fc.integer({ min: -3, max: 60 }), { nil: undefined });

  it('размер страницы ≤ min(запрошенный, 100), по умолчанию 20; total корректен (Req 18.5, 18.6)', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, pageArb, pageSizeArb, async (dataset, page, pageSize) => {
        const service = buildService(dataset);
        const query: SearchQuery = {};
        if (page !== undefined) query.page = page;
        if (pageSize !== undefined) query.pageSize = pageSize;
        const result = await service.search('admin', query);

        const normSize = expectedPageSize(pageSize);
        const normPage = expectedPage(page);

        // Req 18.5: размер страницы нормализован к min(запрошенный, 100)/по умолчанию 20.
        expect(result.meta.pageSize).toBe(normSize);
        expect(result.meta.pageSize).toBeLessThanOrEqual(MAX_PAGE_SIZE);

        // Число элементов на странице не превышает действующий размер страницы.
        expect(result.items.length).toBeLessThanOrEqual(result.meta.pageSize);

        // Общее число найденных Задач всегда корректно (Req 18.6).
        expect(result.meta.total).toBe(dataset.length);

        // Содержимое страницы соответствует ожидаемому срезу.
        const skip = (normPage - 1) * normSize;
        const expectedSlice = dataset.slice(skip, skip + normSize).map((t) => t.id);
        expect(result.items.map((t) => t.id)).toEqual(expectedSlice);
      }),
      { numRuns: 300 },
    );
  });

  it('страница за пределами доступных → пустой список и корректное total (Req 18.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 200 }),
        fc.integer({ min: 1, max: MAX_PAGE_SIZE }),
        fc.integer({ min: 1, max: 50 }),
        async (total, pageSize, pagesBeyond) => {
          const dataset = Array.from(
            { length: total },
            (_, i) => ({ id: `t${i}` }) as unknown as Task,
          );
          const service = buildService(dataset);

          // Запрашиваем страницу строго за пределами доступных.
          const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
          const page = totalPages + pagesBeyond;

          const result = await service.search('admin', { page, pageSize });

          // Req 18.6: пустой список, но полное число найденных Задач сохранено.
          expect(result.items).toEqual([]);
          expect(result.meta.total).toBe(total);
        },
      ),
      { numRuns: 200 },
    );
  });
});
