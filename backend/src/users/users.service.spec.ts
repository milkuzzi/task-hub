import { Role, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  StateConflictException,
  ValidationException,
} from '../common/errors';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * Модульные тесты {@link UsersService.createPrimaryAdmin} (Req 4.1–4.4) с
 * подменой {@link UserRepository}, без обращения к реальной базе данных.
 */
describe('UsersService.createPrimaryAdmin (Req 4)', () => {
  let countActiveAdmins: jest.Mock;
  let findByEmail: jest.Mock;
  let create: jest.Mock;
  let acquirePrimaryAdminCreationLock: jest.Mock;
  let runInTransaction: jest.Mock;
  let service: UsersService;

  const fakeAdmin = {
    id: 'admin-id',
    email: 'admin@example.com',
    role: Role.ADMIN,
    isActive: false,
  } as unknown as User;

  beforeEach(() => {
    countActiveAdmins = jest.fn();
    findByEmail = jest.fn();
    create = jest.fn();
    acquirePrimaryAdminCreationLock = jest.fn().mockResolvedValue(undefined);
    // Прозрачно выполняет переданную функцию, передавая фиктивный tx-клиент.
    runInTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn({}));

    const repository = {
      countActiveAdmins,
      findByEmail,
      create,
      acquirePrimaryAdminCreationLock,
      runInTransaction,
    } as unknown as UserRepository;
    const taskRepository = {
      findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
      setStatus: jest.fn(),
    } as unknown as TaskRepository;
    const auth = { revokeAllSessions: jest.fn() } as unknown as AuthService;
    const mailer = { enqueue: jest.fn() } as unknown as MailerService;
    const clock = { now: () => new Date('2024-01-01T00:00:00Z') } as unknown as ClockService;
    const config = {
      limits: { avatarMaxBytes: 5 * 1024 * 1024 },
    } as unknown as AppConfigService;
    const avatarStorage = { store: jest.fn() } as unknown as AvatarStorage;
    service = new UsersService(
      repository,
      taskRepository,
      auth,
      mailer,
      clock,
      config,
      avatarStorage,
    );
  });

  it('создаёт единственного администратора при отсутствии существующего (Req 4.2)', async () => {
    countActiveAdmins.mockResolvedValue(0);
    findByEmail.mockResolvedValue(null);
    create.mockResolvedValue(fakeAdmin);

    const result = await service.createPrimaryAdmin('admin@example.com');

    expect(result).toBe(fakeAdmin);
    expect(create).toHaveBeenCalledTimes(1);
    expect(acquirePrimaryAdminCreationLock).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin@example.com',
        role: Role.ADMIN,
        isActive: false, // неактивен до установки пароля (Req 5.5)
      }),
      expect.anything(),
    );
  });

  it('отклоняет некорректный адрес и не создаёт администратора (Req 4.3)', async () => {
    await expect(service.createPrimaryAdmin('bad')).rejects.toBeInstanceOf(ValidationException);
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет отсутствующий адрес (Req 4.3)', async () => {
    await expect(service.createPrimaryAdmin(undefined)).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет создание при наличии администратора (Req 4.4)', async () => {
    countActiveAdmins.mockResolvedValue(1);

    await expect(service.createPrimaryAdmin('admin@example.com')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет создание при занятом адресе электронной почты', async () => {
    countActiveAdmins.mockResolvedValue(0);
    findByEmail.mockResolvedValue(fakeAdmin);

    await expect(service.createPrimaryAdmin('admin@example.com')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * Хелпер сборки {@link UsersService} с подменёнными зависимостями для тестов
 * операций со сменой ролей (Req 2, 3).
 */
function buildService(overrides: {
  users: Record<string, User>;
  adminCount?: number;
  revokeAllSessions?: jest.Mock;
  enqueue?: jest.Mock;
  now?: Date;
  soleTaskIdsByUser?: Record<string, string[]>;
  emailHistorySeed?: Array<{ userId: string; email: string }>;
}) {
  const store = { ...overrides.users };
  const findActiveById = jest.fn(async (id: string) => {
    const user = store[id];
    return user && user.deletedAt === null ? user : null;
  });
  const findById = jest.fn(async (id: string) => store[id] ?? null);
  const countActiveAdmins = jest.fn(
    async () =>
      overrides.adminCount ??
      Object.values(store).filter((u) => u.role === Role.ADMIN && u.deletedAt === null).length,
  );
  const update = jest.fn(async (id: string, data: Partial<User>) => {
    store[id] = { ...store[id], ...data } as User;
    return store[id];
  });
  const runInTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn({}));

  // История email и привязка MAX (Req 6, 7.1).
  const emailHistory: Array<{ userId: string; email: string }> = [
    ...(overrides.emailHistorySeed ?? []),
  ];
  const findByEmail = jest.fn(async (email: string) => {
    return Object.values(store).find((u) => u.email === email) ?? null;
  });
  const findActiveByEmail = jest.fn(async (email: string) => {
    return Object.values(store).find((u) => u.email === email && u.deletedAt === null) ?? null;
  });
  const deleteUser = jest.fn(async (id: string) => {
    const removed = store[id];
    delete store[id];
    return removed;
  });
  const addEmailToHistory = jest.fn(async (userId: string, email: string) => {
    if (!emailHistory.some((e) => e.userId === userId && e.email === email)) {
      emailHistory.push({ userId, email });
    }
    return { userId, email };
  });
  const listEmails = jest.fn(async (userId: string) =>
    emailHistory
      .filter((e) => e.userId === userId)
      .map((e) => ({ userId: e.userId, email: e.email })),
  );
  const maxLinks: Array<{ userId: string; maxUserId: string }> = [];
  const findMaxLinkByMaxUserId = jest.fn(
    async (maxUserId: string) => maxLinks.find((l) => l.maxUserId === maxUserId) ?? null,
  );
  const findMaxLinkByUserId = jest.fn(
    async (userId: string) => maxLinks.find((l) => l.userId === userId) ?? null,
  );
  const upsertMaxLink = jest.fn(async (userId: string, maxUserId: string) => {
    const existing = maxLinks.find((l) => l.userId === userId);
    if (existing) {
      existing.maxUserId = maxUserId;
      return existing;
    }
    const link = { userId, maxUserId };
    maxLinks.push(link);
    return link;
  });
  const deleteMaxLinkByUserId = jest.fn(async (userId: string) => {
    const index = maxLinks.findIndex((l) => l.userId === userId);
    if (index === -1) {
      return 0;
    }
    maxLinks.splice(index, 1);
    return 1;
  });

  const repository = {
    findActiveById,
    findById,
    findByEmail,
    findActiveByEmail,
    countActiveAdmins,
    update,
    delete: deleteUser,
    runInTransaction,
    addEmailToHistory,
    listEmails,
    findMaxLinkByMaxUserId,
    findMaxLinkByUserId,
    upsertMaxLink,
    deleteMaxLinkByUserId,
  } as unknown as UserRepository;

  // Репозиторий задач: переназначение осиротевших задач при удалении (Req 8.5).
  const taskStatuses: Record<string, string> = {};
  const findTaskIdsWhereUserIsSoleAssignee = jest.fn(
    async (userId: string) => overrides.soleTaskIdsByUser?.[userId] ?? [],
  );
  const setStatus = jest.fn(async (taskId: string, status: string) => {
    taskStatuses[taskId] = status;
    return { id: taskId, status };
  });
  const taskRepository = {
    findTaskIdsWhereUserIsSoleAssignee,
    setStatus,
  } as unknown as TaskRepository;

  const revokeAllSessions = overrides.revokeAllSessions ?? jest.fn(async () => 0);
  const auth = { revokeAllSessions } as unknown as AuthService;
  const enqueue = overrides.enqueue ?? jest.fn(async () => undefined);
  const mailer = { enqueue } as unknown as MailerService;
  const clock = {
    now: () => overrides.now ?? new Date('2024-01-01T00:00:00Z'),
  } as unknown as ClockService;

  const config = {
    limits: { avatarMaxBytes: 5 * 1024 * 1024 },
  } as unknown as AppConfigService;
  const store2 = jest.fn(async (userId: string) => `avatars/${userId}/stored`);
  const avatarStorage = { store: store2 } as unknown as AvatarStorage;

  const service = new UsersService(
    repository,
    taskRepository,
    auth,
    mailer,
    clock,
    config,
    avatarStorage,
  );
  return {
    service,
    store,
    findActiveById,
    update,
    deleteUser,
    revokeAllSessions,
    enqueue,
    avatarStore: store2,
    emailHistory,
    listEmails,
    findTaskIdsWhereUserIsSoleAssignee,
    setStatus,
    taskStatuses,
    maxLinks,
    addEmailToHistory,
    upsertMaxLink,
    deleteMaxLinkByUserId,
  };
}

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

describe('UsersService.updateRole (Req 2.2, 2.11)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  it('меняет роль между менеджером и исполнителем, сохраняя одного администратора', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const { service, store } = buildService({ users: { admin, m1: manager } });

    const result = await service.updateRole('admin', 'm1', Role.EXECUTOR);

    expect(result.role).toBe(Role.EXECUTOR);
    expect(store.m1?.role).toBe(Role.EXECUTOR);
  });

  it('отклоняет понижение единственного администратора (оставит 0)', async () => {
    const { service, store } = buildService({ users: { admin } });

    await expect(service.updateRole('admin', 'admin', Role.EXECUTOR)).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.admin?.role).toBe(Role.ADMIN);
  });

  it('отклоняет назначение второго администратора (станет 2)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const { service, store } = buildService({ users: { admin, m1: manager } });

    await expect(service.updateRole('admin', 'm1', Role.ADMIN)).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.m1?.role).toBe(Role.MANAGER);
  });

  it('запрещает операцию не администратору (Req 5.1)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const executor = makeUser({ id: 'e1', role: Role.EXECUTOR });
    const { service } = buildService({ users: { admin, m1: manager, e1: executor } });

    await expect(service.updateRole('m1', 'e1', Role.MANAGER)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('отклоняет смену роли несуществующего пользователя', async () => {
    const { service } = buildService({ users: { admin } });

    await expect(service.updateRole('admin', 'ghost', Role.MANAGER)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('UsersService.transferAdmin (Req 3)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  it('делает цель единственным администратором, бывшего — исполнителем (Req 3.1, 3.3)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const { service, store, revokeAllSessions, enqueue } = buildService({
      users: { admin, m1: manager },
    });

    await service.transferAdmin('admin', 'm1');

    expect(store.m1?.role).toBe(Role.ADMIN);
    expect(store.admin?.role).toBe(Role.EXECUTOR);
    // Сессии бывшего администратора аннулированы (Req 3.4).
    expect(revokeAllSessions).toHaveBeenCalledWith('admin');
    // Уведомления поставлены обоим участникам (Req 3.5).
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('сохраняет передачу роли при сбое постановки уведомления (Req 3.6)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const enqueue = jest.fn().mockRejectedValue(new Error('queue down'));
    const { service, store } = buildService({ users: { admin, m1: manager }, enqueue });

    // Сбой письма НЕ должен приводить к исключению и откату ролей.
    await expect(service.transferAdmin('admin', 'm1')).resolves.toBeUndefined();
    expect(store.m1?.role).toBe(Role.ADMIN);
    expect(store.admin?.role).toBe(Role.EXECUTOR);
  });

  it('отклоняет передачу несуществующему/удалённому пользователю (Req 3.2)', async () => {
    const deleted = makeUser({ id: 'd1', role: Role.EXECUTOR, deletedAt: new Date() });
    const { service, store } = buildService({ users: { admin, d1: deleted } });

    await expect(service.transferAdmin('admin', 'd1')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.admin?.role).toBe(Role.ADMIN);
  });

  it('отклоняет передачу заблокированному пользователю (Req 3.2)', async () => {
    const locked = makeUser({
      id: 'l1',
      role: Role.MANAGER,
      lockedUntil: new Date('2024-01-01T01:00:00Z'),
    });
    const { service, store } = buildService({
      users: { admin, l1: locked },
      now: new Date('2024-01-01T00:00:00Z'),
    });

    await expect(service.transferAdmin('admin', 'l1')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.admin?.role).toBe(Role.ADMIN);
  });

  it('отклоняет передачу самому себе (Req 3.2)', async () => {
    const { service, store } = buildService({ users: { admin } });

    await expect(service.transferAdmin('admin', 'admin')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.admin?.role).toBe(Role.ADMIN);
  });

  it('запрещает передачу не администратору (Req 5.1)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const executor = makeUser({ id: 'e1', role: Role.EXECUTOR });
    const { service } = buildService({ users: { admin, m1: manager, e1: executor } });

    await expect(service.transferAdmin('m1', 'e1')).rejects.toBeInstanceOf(AccessDeniedException);
  });
});

describe('UsersService.updateProfile (Req 6.2, 6.3, 6.8, 7.1)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN, email: 'admin@example.com' });

  it('Администратор меняет имя пользователя (Req 6.3)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, store } = buildService({ users: { admin, u1: user } });

    const result = await service.updateProfile('admin', 'u1', { displayName: 'Новое имя' });

    expect(result.displayName).toBe('Новое имя');
    expect(store.u1?.displayName).toBe('Новое имя');
  });

  it('Администратор меняет собственное имя', async () => {
    const { service, store } = buildService({ users: { admin } });

    const result = await service.updateProfile('admin', 'admin', { displayName: 'Михаил' });

    expect(result.displayName).toBe('Михаил');
    expect(store.admin?.displayName).toBe('Михаил');
  });

  it('Администратор меняет email и пополняет историю прежним и новым адресом (Req 6.2, 7.1)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'old@example.com' });
    const { service, store, emailHistory } = buildService({ users: { admin, u1: user } });

    await service.updateProfile('admin', 'u1', { email: 'new@example.com' });

    expect(store.u1?.email).toBe('new@example.com');
    expect(emailHistory).toEqual(
      expect.arrayContaining([
        { userId: 'u1', email: 'old@example.com' },
        { userId: 'u1', email: 'new@example.com' },
      ]),
    );
  });

  it('запрещает изменение email/имени не Администратору и не меняет данные (Req 6.8)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'old@example.com' });
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const { service, store } = buildService({ users: { admin, u1: user, m1: manager } });

    await expect(
      service.updateProfile('m1', 'u1', { displayName: 'Взлом', email: 'x@example.com' }),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(store.u1?.displayName).toBe('u1');
    expect(store.u1?.email).toBe('old@example.com');
  });

  it('даже сам пользователь не может менять собственные email/имя (только Администратор) (Req 6.2, 6.3)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service } = buildService({ users: { admin, u1: user } });

    await expect(service.updateProfile('u1', 'u1', { displayName: 'Сам' })).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('отклоняет некорректный новый email и не меняет данные', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'old@example.com' });
    const { service, store } = buildService({ users: { admin, u1: user } });

    await expect(service.updateProfile('admin', 'u1', { email: 'bad' })).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(store.u1?.email).toBe('old@example.com');
  });

  it('отклоняет занятый другим пользователем email (Req 7.5 семантика конфликта)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'old@example.com' });
    const other = makeUser({ id: 'u2', role: Role.EXECUTOR, email: 'taken@example.com' });
    const { service, store } = buildService({ users: { admin, u1: user, u2: other } });

    await expect(
      service.updateProfile('admin', 'u1', { email: 'taken@example.com' }),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(store.u1?.email).toBe('old@example.com');
  });

  it('отклоняет пустое имя', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service } = buildService({ users: { admin, u1: user } });

    await expect(
      service.updateProfile('admin', 'u1', { displayName: '   ' }),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('не записывает историю email при неизменном адресе', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'same@example.com' });
    const { service, emailHistory } = buildService({ users: { admin, u1: user } });

    await service.updateProfile('admin', 'u1', { email: 'same@example.com', displayName: 'X' });

    expect(emailHistory).toHaveLength(0);
  });
});

describe('UsersService.setAvatar (Req 6.4, 6.5, 6.9)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  const pngFile = {
    originalName: 'a.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
  };

  it('Исполнитель меняет собственный аватар (Req 6.4)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, store, avatarStore } = buildService({ users: { admin, u1: user } });

    await service.setAvatar('u1', 'u1', pngFile);

    expect(avatarStore).toHaveBeenCalledWith('u1', pngFile);
    expect(store.u1?.avatarPath).toBe('avatars/u1/stored');
  });

  it('Администратор меняет аватар другого пользователя (Req 6.5)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, store } = buildService({ users: { admin, u1: user } });

    await service.setAvatar('admin', 'u1', pngFile);

    expect(store.u1?.avatarPath).toBe('avatars/u1/stored');
  });

  it('запрещает менять чужой аватар не Администратору и не сохраняет данные (Req 6.8)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const { service, store, avatarStore } = buildService({
      users: { admin, u1: user, m1: manager },
    });

    await expect(service.setAvatar('m1', 'u1', pngFile)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect(avatarStore).not.toHaveBeenCalled();
    expect(store.u1?.avatarPath).toBeUndefined();
  });

  it('отклоняет неподдерживаемый формат и сохраняет данные без изменений (Req 6.9)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, avatarStore } = buildService({ users: { admin, u1: user } });

    await expect(
      service.setAvatar('u1', 'u1', { ...pngFile, mimeType: 'application/pdf' }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(avatarStore).not.toHaveBeenCalled();
  });

  it('отклоняет аватар свыше 5 МБ (Req 6.9)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, avatarStore } = buildService({ users: { admin, u1: user } });

    await expect(
      service.setAvatar('u1', 'u1', { ...pngFile, sizeBytes: 5 * 1024 * 1024 + 1 }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(avatarStore).not.toHaveBeenCalled();
  });
});

describe('UsersService.linkMax (Req 6.6, 6.9, 16.2)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  it('привязывает собственный профиль MAX (Req 6.6)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user } });

    await service.linkMax('u1', { maxUserId: 'max-1', verified: true });

    expect(maxLinks).toEqual([{ userId: 'u1', maxUserId: 'max-1' }]);
  });

  it('идемпотентно при повторной привязке того же профиля', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user } });

    await service.linkMax('u1', { maxUserId: 'max-1', verified: true });
    await service.linkMax('u1', { maxUserId: 'max-1', verified: true });

    expect(maxLinks).toHaveLength(1);
  });

  it('отклоняет неуспешную привязку (verified=false) (Req 6.9)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user } });

    await expect(
      service.linkMax('u1', { maxUserId: 'max-1', verified: false }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(maxLinks).toHaveLength(0);
  });

  it('отклоняет привязку чужого профиля (ownerUserId не совпадает) (Req 6.9)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user } });

    await expect(
      service.linkMax('u1', { maxUserId: 'max-1', verified: true, ownerUserId: 'u2' }),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(maxLinks).toHaveLength(0);
  });

  it('отклоняет профиль MAX, уже привязанный к другой учётной записи (Req 6.9)', async () => {
    const user1 = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const user2 = makeUser({ id: 'u2', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user1, u2: user2 } });

    await service.linkMax('u2', { maxUserId: 'max-1', verified: true });

    await expect(
      service.linkMax('u1', { maxUserId: 'max-1', verified: true }),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(maxLinks).toEqual([{ userId: 'u2', maxUserId: 'max-1' }]);
  });

  it('отклоняет привязку для несуществующего пользователя', async () => {
    const { service } = buildService({ users: { admin } });

    await expect(
      service.linkMax('ghost', { maxUserId: 'max-1', verified: true }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });
});

describe('UsersService.unlinkMax', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  it('отвязывает собственный профиль MAX', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, maxLinks } = buildService({ users: { admin, u1: user } });

    await service.linkMax('u1', { maxUserId: 'max-1', verified: true });
    await service.unlinkMax('u1');

    expect(maxLinks).toEqual([]);
  });

  it('идемпотентна, если профиль MAX уже не привязан', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, deleteMaxLinkByUserId } = buildService({ users: { admin, u1: user } });

    await service.unlinkMax('u1');

    expect(deleteMaxLinkByUserId).toHaveBeenCalledWith('u1');
  });

  it('отклоняет отвязку для несуществующего пользователя', async () => {
    const { service, deleteMaxLinkByUserId } = buildService({ users: { admin } });

    await expect(service.unlinkMax('ghost')).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(deleteMaxLinkByUserId).not.toHaveBeenCalled();
  });
});

describe('UsersService.deleteUser (Req 8)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN });

  it('soft-удаление: помечает запись удалённой, сохраняет её и аннулирует сессии (Req 8.2, 8.6)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, store, revokeAllSessions, deleteUser } = buildService({
      users: { admin, u1: user },
    });

    await service.deleteUser('admin', 'u1', 'soft');

    // Запись сохранена и помечена удалённой (Req 8.2).
    expect(store.u1).toBeDefined();
    expect(store.u1?.deletedAt).toBeInstanceOf(Date);
    expect(store.u1?.isActive).toBe(false);
    // Жёсткое удаление записи не выполнялось.
    expect(deleteUser).not.toHaveBeenCalled();
    // Сессии аннулированы ≤5с (Req 8.6).
    expect(revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('hard-удаление: удаляет запись пользователя и аннулирует сессии (Req 8.3, 8.6)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, store, revokeAllSessions, deleteUser } = buildService({
      users: { admin, u1: user },
    });

    await service.deleteUser('admin', 'u1', 'hard');

    // Запись пользователя удалена из хранилища (Req 8.3).
    expect(store.u1).toBeUndefined();
    expect(deleteUser).toHaveBeenCalledWith('u1', expect.anything());
    expect(revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('переводит осиротевшие задачи в «Требует администратора» до удаления (Req 8.5)', async () => {
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service, taskStatuses, setStatus } = buildService({
      users: { admin, u1: user },
      soleTaskIdsByUser: { u1: ['t1', 't2'] },
    });

    await service.deleteUser('admin', 'u1', 'hard');

    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(taskStatuses.t1).toBe(TaskStatus.NEEDS_ADMIN);
    expect(taskStatuses.t2).toBe(TaskStatus.NEEDS_ADMIN);
  });

  it('отклоняет самоудаление администратора и не меняет данные (Req 8.8)', async () => {
    const { service, store, revokeAllSessions } = buildService({ users: { admin } });

    await expect(service.deleteUser('admin', 'admin', 'soft')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.admin?.deletedAt).toBeNull();
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('отклоняет удаление администратора (инвариант единственного администратора) (Req 2.11, 8.8)', async () => {
    // Передача роли создаёт второго администратора лишь временно невозможна;
    // здесь моделируем второго администратора, которого нельзя удалить.
    const other = makeUser({ id: 'a2', role: Role.ADMIN });
    const { service, store } = buildService({ users: { admin, a2: other }, adminCount: 2 });

    await expect(service.deleteUser('admin', 'a2', 'soft')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(store.a2).toBeDefined();
    expect(store.a2?.deletedAt).toBeNull();
  });

  it('запрещает удаление не администратору (Req 5.1)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const user = makeUser({ id: 'u1', role: Role.EXECUTOR });
    const { service } = buildService({ users: { admin, m1: manager, u1: user } });

    await expect(service.deleteUser('m1', 'u1', 'soft')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('отклоняет удаление несуществующего/уже удалённого пользователя', async () => {
    const { service } = buildService({ users: { admin } });

    await expect(service.deleteUser('admin', 'ghost', 'soft')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('UsersService.restoreUser / listDeletedUserEmails (Req 7)', () => {
  const admin = makeUser({ id: 'admin', role: Role.ADMIN, email: 'admin@example.com' });

  it('возвращает сохранённые адреса удалённого пользователя для выбора (Req 7.3)', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
    });
    const { service } = buildService({
      users: { admin, d1: deleted },
      emailHistorySeed: [
        { userId: 'd1', email: 'old@example.com' },
        { userId: 'd1', email: 'cur@example.com' },
      ],
    });

    const emails = await service.listDeletedUserEmails('admin', 'd1');

    expect(emails).toEqual(expect.arrayContaining(['old@example.com', 'cur@example.com']));
  });

  it('восстанавливает удалённого пользователя по выбранному адресу как активную учётную запись (Req 7.2)', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
      isActive: false,
      passwordHash: 'existing-password-hash',
    });
    const { service, store } = buildService({
      users: { admin, d1: deleted },
      emailHistorySeed: [{ userId: 'd1', email: 'cur@example.com' }],
    });

    const restored = await service.restoreUser('admin', 'd1', 'cur@example.com');

    expect(restored.deletedAt).toBeNull();
    expect(restored.isActive).toBe(true);
    expect(restored.email).toBe('cur@example.com');
    expect(store.d1?.deletedAt).toBeNull();
    expect(store.d1?.isActive).toBe(true);
  });

  it('оставляет восстановленного пользователя без пароля неактивным до setup flow', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
      isActive: false,
      passwordHash: null,
    });
    const { service, store } = buildService({
      users: { admin, d1: deleted },
      emailHistorySeed: [{ userId: 'd1', email: 'cur@example.com' }],
    });

    const restored = await service.restoreUser('admin', 'd1', 'cur@example.com');

    expect(restored.deletedAt).toBeNull();
    expect(restored.isActive).toBe(false);
    expect(store.d1?.isActive).toBe(false);
  });

  it('отклоняет восстановление при адресе, занятом другой активной учётной записью, не меняя данные (Req 7.5)', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
    });
    const active = makeUser({ id: 'u2', role: Role.EXECUTOR, email: 'taken@example.com' });
    const { service, store } = buildService({
      users: { admin, d1: deleted, u2: active },
      emailHistorySeed: [{ userId: 'd1', email: 'taken@example.com' }],
    });

    await expect(service.restoreUser('admin', 'd1', 'taken@example.com')).rejects.toBeInstanceOf(
      StateConflictException,
    );
    // Данные удалённого пользователя не изменились (Req 7.5).
    expect(store.d1?.deletedAt).toBeInstanceOf(Date);
  });

  it('отклоняет восстановление при отсутствии сохранённых адресов (Req 7.6)', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
    });
    const { service } = buildService({ users: { admin, d1: deleted } });

    await expect(service.restoreUser('admin', 'd1', 'cur@example.com')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('отклоняет адрес, отсутствующий среди сохранённых', async () => {
    const deleted = makeUser({
      id: 'd1',
      role: Role.EXECUTOR,
      email: 'cur@example.com',
      deletedAt: new Date(),
    });
    const { service } = buildService({
      users: { admin, d1: deleted },
      emailHistorySeed: [{ userId: 'd1', email: 'cur@example.com' }],
    });

    await expect(service.restoreUser('admin', 'd1', 'unknown@example.com')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('отклоняет восстановление неудалённого пользователя', async () => {
    const active = makeUser({ id: 'u1', role: Role.EXECUTOR, email: 'a@example.com' });
    const { service } = buildService({
      users: { admin, u1: active },
      emailHistorySeed: [{ userId: 'u1', email: 'a@example.com' }],
    });

    await expect(service.restoreUser('admin', 'u1', 'a@example.com')).rejects.toBeInstanceOf(
      StateConflictException,
    );
  });

  it('запрещает восстановление не администратору (Req 5.1)', async () => {
    const manager = makeUser({ id: 'm1', role: Role.MANAGER });
    const deleted = makeUser({ id: 'd1', role: Role.EXECUTOR, deletedAt: new Date() });
    const { service } = buildService({ users: { admin, m1: manager, d1: deleted } });

    await expect(service.restoreUser('m1', 'd1', 'd1@example.com')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });
});
