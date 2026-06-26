import { AssignmentKind, AuditEntry, Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { TaskRepository, TaskWithAssignments, UserRepository } from '../repositories';
import { AuditFieldChange } from '../tasks/ports';
import { AuditEntryCreateData, AuditEntryRepository } from './audit-entry.repository';
import { AuditLogService } from './audit-log.service';

/**
 * Модульные тесты {@link AuditLogService} (Req 20.1–20.4) с подменой
 * репозиториев и сервиса времени.
 *
 * Проверяется: добавление записи в Журнал (append-only) с фиксацией времени и
 * прежнего/нового значения (Req 20.1); порядок «новые → старые» и форматирование
 * времени в MSK при чтении (Req 20.1, 20.2); права просмотра — Менеджер Задачи и
 * Администратор разрешены, прочим (в т.ч. Исполнителю и Менеджеру, назначенному
 * Исполнителем) отказано (Req 20.3); отсутствие в API операций правки/удаления
 * записей (Req 20.4).
 */

const FIXED_NOW = new Date('2030-03-04T07:08:00Z'); // 10:08 MSK

function makeUser(id: string, role: Role): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role,
    isActive: true,
    deletedAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
  } as unknown as User;
}

function makeTask(
  id: string,
  assignments: Array<{ userId: string; kind: AssignmentKind }>,
): TaskWithAssignments {
  return {
    id,
    title: `task-${id}`,
    description: null,
    deadline: new Date('2030-01-01T10:00:00Z'),
    status: TaskStatus.IN_PROGRESS,
    adminReviewed: false,
    messageCount: 0,
    createdAt: new Date('2029-12-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2029-12-01T00:00:00Z'),
    assignments: assignments.map((a, i) => ({
      id: `${id}-a${i}`,
      taskId: id,
      userId: a.userId,
      kind: a.kind,
    })),
  } as unknown as TaskWithAssignments;
}

function makeEntry(overrides: Partial<AuditEntry> & { id: string; changedAt: Date }): AuditEntry {
  return {
    taskId: 't1',
    authorId: 'mgr',
    field: 'title',
    oldValue: null,
    newValue: 'Новое',
    ...overrides,
  } as unknown as AuditEntry;
}

interface Fixture {
  users?: Record<string, User>;
  task?: TaskWithAssignments | null;
  entries?: AuditEntry[];
}

function buildService(fixture: Fixture = {}) {
  const users = fixture.users ?? {};
  const created: AuditEntryCreateData[] = [];

  const create = jest.fn(async (data: AuditEntryCreateData) => {
    created.push(data);
    return makeEntry({ id: `e${created.length}`, ...data });
  });
  const listByTaskNewestFirst = jest.fn(async () => fixture.entries ?? []);
  const auditEntryRepository = {
    create,
    listByTaskNewestFirst,
  } as unknown as AuditEntryRepository;

  const findActiveById = jest.fn(async (id: string) => users[id] ?? null);
  const userRepository = { findActiveById } as unknown as UserRepository;

  const findByIdWithAssignments = jest.fn(async () =>
    fixture.task === undefined ? null : fixture.task,
  );
  const taskRepository = { findByIdWithAssignments } as unknown as TaskRepository;

  const clock = new ClockService({ now: () => FIXED_NOW });

  const service = new AuditLogService(auditEntryRepository, taskRepository, userRepository, clock);
  return { service, create, listByTaskNewestFirst, created };
}

describe('AuditLogService.record — append-only запись (Req 20.1, 20.4)', () => {
  it('добавляет запись с автором, параметром, прежним/новым значением и временем (Req 20.1)', async () => {
    const { service, created } = buildService();
    const change: AuditFieldChange = {
      taskId: 't1',
      authorId: 'mgr',
      field: 'title',
      oldValue: 'Старое',
      newValue: 'Новое',
    };

    await service.record(change);

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      taskId: 't1',
      authorId: 'mgr',
      field: 'title',
      oldValue: 'Старое',
      newValue: 'Новое',
      changedAt: FIXED_NOW,
    });
  });

  it('не предоставляет операций правки или удаления записей (append-only, Req 20.4)', () => {
    const { service } = buildService();
    // У сервиса есть только добавление (record) и чтение (list); операций
    // изменения/удаления записей не существует.
    expect((service as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((service as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((service as unknown as Record<string, unknown>).remove).toBeUndefined();
  });
});

describe('AuditLogService.list — порядок, формат времени и права (Req 20.1, 20.2, 20.3)', () => {
  it('возвращает записи в порядке от новых к старым с временем в MSK (Req 20.1, 20.2)', async () => {
    const newer = makeEntry({ id: 'e-new', changedAt: new Date('2030-03-04T07:08:00Z') });
    const older = makeEntry({ id: 'e-old', changedAt: new Date('2030-01-01T00:00:00Z') });
    const { service } = buildService({
      users: { mgr: makeUser('mgr', Role.MANAGER) },
      task: makeTask('t1', [{ userId: 'mgr', kind: AssignmentKind.MANAGER }]),
      // Репозиторий уже сортирует новые → старые.
      entries: [newer, older],
    });

    const result = await service.list('mgr', 't1');

    expect(result.map((e) => e.id)).toEqual(['e-new', 'e-old']);
    // 07:08 UTC = 10:08 MSK (UTC+3).
    expect(result[0]?.changedAtMsk).toBe('04.03.2030 10:08');
    expect(result[1]?.changedAtMsk).toBe('01.01.2030 03:00');
  });

  it('разрешает просмотр Менеджеру Задачи (Req 20.2)', async () => {
    const { service } = buildService({
      users: { mgr: makeUser('mgr', Role.MANAGER) },
      task: makeTask('t1', [{ userId: 'mgr', kind: AssignmentKind.MANAGER }]),
      entries: [makeEntry({ id: 'e1', changedAt: FIXED_NOW })],
    });

    await expect(service.list('mgr', 't1')).resolves.toHaveLength(1);
  });

  it('разрешает просмотр Администратору, не назначенному на Задачу (Req 20.3)', async () => {
    const { service } = buildService({
      users: { adm: makeUser('adm', Role.ADMIN) },
      task: makeTask('t1', [{ userId: 'other', kind: AssignmentKind.MANAGER }]),
      entries: [],
    });

    await expect(service.list('adm', 't1')).resolves.toEqual([]);
  });

  it('отказывает Исполнителю Задачи (Req 20.3)', async () => {
    const { service } = buildService({
      users: { exe: makeUser('exe', Role.EXECUTOR) },
      task: makeTask('t1', [{ userId: 'exe', kind: AssignmentKind.EXECUTOR }]),
    });

    await expect(service.list('exe', 't1')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('отказывает Менеджеру, назначенному на Задачу Исполнителем (Req 20.3)', async () => {
    const { service } = buildService({
      users: { mgr: makeUser('mgr', Role.MANAGER) },
      // Глобальная роль MANAGER, но в задаче он назначен Исполнителем.
      task: makeTask('t1', [{ userId: 'mgr', kind: AssignmentKind.EXECUTOR }]),
    });

    await expect(service.list('mgr', 't1')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('отказывает Менеджеру, не назначенному на Задачу (Req 20.3)', async () => {
    const { service } = buildService({
      users: { stranger: makeUser('stranger', Role.MANAGER) },
      task: makeTask('t1', [{ userId: 'mgr', kind: AssignmentKind.MANAGER }]),
    });

    await expect(service.list('stranger', 't1')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('отклоняет неактивную/несуществующую учётную запись инициатора', async () => {
    const { service } = buildService({
      users: {},
      task: makeTask('t1', [{ userId: 'mgr', kind: AssignmentKind.MANAGER }]),
    });

    await expect(service.list('ghost', 't1')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('сообщает о несуществующей Задаче', async () => {
    const { service } = buildService({
      users: { mgr: makeUser('mgr', Role.MANAGER) },
      task: null,
    });

    await expect(service.list('mgr', 'missing')).rejects.toBeInstanceOf(EntityNotFoundException);
  });
});
