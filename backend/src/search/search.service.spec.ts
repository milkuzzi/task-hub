import { Role, Task, TaskStatus, User, Prisma } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { Page, PaginationQueryDto } from '../common/dto';
import { TaskRepository, UserRepository } from '../repositories';
import { SearchService } from './search.service';

/**
 * Модульные тесты {@link SearchService.search} (Req 18.1–18.7) с подменой
 * репозиториев, без обращения к реальной базе данных.
 *
 * Проверяются: отказ при неактивной учётной записи; делегирование выборки
 * репозиторию с условием видимости; нормализация пагинации (Req 18.5);
 * отклонение недопустимых строки запроса и фильтров без обращения к данным
 * (Req 18.2, 18.4, 18.7).
 */

function makeUser(partial: Partial<User> & { id: string; role: Role }): User {
  return {
    email: `${partial.id}@example.com`,
    displayName: partial.id,
    isActive: true,
    deletedAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    ...partial,
  } as unknown as User;
}

function emptyPage(): Page<Task> {
  return {
    items: [],
    meta: { page: 1, pageSize: 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false },
  };
}

function buildService(user: User | null) {
  const findActiveById = jest.fn(async () => user);
  let listArgs:
    | {
        pagination: PaginationQueryDto;
        where: Prisma.TaskWhereInput;
        orderBy: Prisma.TaskOrderByWithRelationInput[];
      }
    | undefined;
  const list = jest.fn(
    async (
      pagination: PaginationQueryDto,
      where: Prisma.TaskWhereInput,
      orderBy: Prisma.TaskOrderByWithRelationInput[],
    ) => {
      listArgs = { pagination, where, orderBy };
      return emptyPage();
    },
  );

  const taskRepository = { list } as unknown as TaskRepository;
  const userRepository = { findActiveById } as unknown as UserRepository;

  const service = new SearchService(taskRepository, userRepository);
  return { service, list, findActiveById, getListArgs: () => listArgs };
}

describe('SearchService.search — доступ и видимость', () => {
  it('отклоняет поиск для неактивной/отсутствующей учётной записи', async () => {
    const { service, list } = buildService(null);
    await expect(service.search('ghost', {})).rejects.toBeInstanceOf(AccessDeniedException);
    expect(list).not.toHaveBeenCalled();
  });

  it('делегирует выборку репозиторию с условием видимости назначенного Пользователя', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'e1', role: Role.EXECUTOR }));
    await service.search('e1', { text: 'отчёт' });
    const where = getListArgs()?.where as { AND: unknown[] };
    expect(where.AND[0]).toEqual({
      assignments: { some: { userId: 'e1' } },
    });
  });

  it('делегирует выборку репозиторию с той же видимостью для Менеджера', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'm1', role: Role.MANAGER }));
    await service.search('m1', {});
    const where = getListArgs()?.where as { AND: unknown[] };
    expect(where.AND[0]).toEqual({
      assignments: { some: { userId: 'm1' } },
    });
  });

  it('скрывает отменённые задачи в обычном списке', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', {});
    const where = getListArgs()?.where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ status: { not: TaskStatus.CANCELLED } });
  });

  it('не добавляет запрет отменённых задач при явном фильтре CANCELLED', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { filters: { statuses: [TaskStatus.CANCELLED] } });
    const where = getListArgs()?.where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ status: { in: [TaskStatus.CANCELLED] } });
    expect(where.AND).not.toContainEqual({ status: { not: TaskStatus.CANCELLED } });
  });
});

describe('SearchService.search — пагинация (Req 18.5)', () => {
  it('по умолчанию использует страницу 1 и размер 20', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', {});
    const { pagination } = getListArgs()!;
    expect(pagination.page).toBe(1);
    expect(pagination.pageSize).toBe(20);
  });

  it('ограничивает размер страницы максимумом 100 (Req 18.5)', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { pageSize: 500 });
    expect(getListArgs()!.pagination.pageSize).toBe(100);
  });

  it('приводит номер страницы менее 1 к 1', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { page: 0 });
    expect(getListArgs()!.pagination.page).toBe(1);
  });

  it('сохраняет корректные запрошенные значения пагинации', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { page: 3, pageSize: 50 });
    const { pagination } = getListArgs()!;
    expect(pagination.page).toBe(3);
    expect(pagination.pageSize).toBe(50);
  });
});

describe('SearchService.search — сортировка до пагинации', () => {
  it('по умолчанию запрашивает ближайшие Дедлайны первыми', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', {});
    expect(getListArgs()?.orderBy).toEqual([
      { deadline: 'asc' },
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('передаёт обратную сортировку по Статусу со стабильными ключами', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { sortBy: 'status', sortDirection: 'desc' });
    expect(getListArgs()?.orderBy).toEqual([
      { status: 'desc' },
      { deadline: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('передаёт алфавитную сортировку Названия', async () => {
    const { service, getListArgs } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await service.search('a', { sortBy: 'title', sortDirection: 'asc' });
    expect(getListArgs()?.orderBy).toEqual([{ title: 'asc' }, { deadline: 'asc' }, { id: 'asc' }]);
  });
});

describe('SearchService.search — отклонение недопустимых параметров (Req 18.2, 18.4, 18.7)', () => {
  it('отклоняет пустую строку запроса и не обращается к данным (Req 18.2)', async () => {
    const { service, list } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await expect(service.search('a', { text: '' })).rejects.toBeInstanceOf(ValidationException);
    expect(list).not.toHaveBeenCalled();
  });

  it('отклоняет строку длиннее 256 символов (Req 18.2)', async () => {
    const { service, list } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await expect(service.search('a', { text: 'z'.repeat(257) })).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('отклоняет недопустимое значение фильтра без обращения к данным (Req 18.4)', async () => {
    const { service, list } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await expect(
      service.search('a', { filters: { statuses: ['BAD' as TaskStatus] } }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(list).not.toHaveBeenCalled();
  });

  it('отклоняет весь запрос при недопустимом сочетании поиска и фильтра (Req 18.7)', async () => {
    const { service, list } = buildService(makeUser({ id: 'a', role: Role.ADMIN }));
    await expect(
      service.search('a', { text: '', filters: { statuses: [TaskStatus.DONE] } }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(list).not.toHaveBeenCalled();
  });
});
