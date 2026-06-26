import { Role } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AuthService, SessionAuthGuard, AuthenticatedRequest } from '../auth';
import { ClockService } from '../clock';
import { UserRepository } from '../repositories';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Контроллерные тесты расширенного {@link UsersController} (задача 2).
 *
 * Проверяют тонкую маршрутизацию HTTP → доменный сервис: проброс
 * идентификатора инициатора, отображение `name → displayName`, проверку роли
 * на списках, валидацию режима удаления и формирование представлений. Сами
 * доменные правила и права проверяются в тестах {@link UsersService}.
 */
describe('UsersController', () => {
  const NOW = new Date('2026-06-19T00:00:00.000Z');

  const adminUserRow = {
    id: 'admin-1',
    email: 'admin@example.com',
    displayName: 'Админ',
    role: Role.ADMIN,
    avatarPath: null,
    isActive: true,
    lockedUntil: null,
    maxLink: null,
  };

  function buildController(
    opts: {
      role?: Role;
      userId?: string;
    } = {},
  ): {
    controller: UsersController;
    usersService: jest.Mocked<
      Pick<UsersService, 'transferAdmin' | 'restoreUser' | 'updateProfile' | 'deleteUser'>
    >;
    userRepository: {
      listActiveWithMaxLink: jest.Mock;
      listDeletedWithEmails: jest.Mock;
      findByIdWithMaxLink: jest.Mock;
    };
    req: AuthenticatedRequest;
  } {
    const usersService = {
      transferAdmin: jest.fn().mockResolvedValue(undefined),
      restoreUser: jest.fn().mockResolvedValue({ ...adminUserRow, id: 'u1' }),
      updateProfile: jest.fn().mockResolvedValue({ ...adminUserRow, id: 'u1' }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<
      Pick<UsersService, 'transferAdmin' | 'restoreUser' | 'updateProfile' | 'deleteUser'>
    >;

    const userRepository = {
      listActiveWithMaxLink: jest.fn().mockResolvedValue([adminUserRow]),
      listDeletedWithEmails: jest.fn().mockResolvedValue([
        {
          ...adminUserRow,
          id: 'd1',
          deletedAt: new Date('2026-06-10T00:00:00.000Z'),
          updatedAt: NOW,
          emails: [{ email: 'old@example.com' }, { email: 'older@example.com' }],
        },
      ]),
      findByIdWithMaxLink: jest.fn().mockResolvedValue({ ...adminUserRow, id: 'u1' }),
    };

    const clock = { now: () => NOW } as unknown as ClockService;

    const controller = new UsersController(
      {} as unknown as AuthService,
      usersService as unknown as UsersService,
      userRepository as unknown as UserRepository,
      clock,
    );

    const req = {
      user: { userId: opts.userId ?? 'admin-1', tokenId: 't1', role: opts.role ?? Role.ADMIN },
    } as AuthenticatedRequest;

    return { controller, usersService, userRepository, req };
  }

  it('передаёт роль администратора с идентификатором инициатора (Req 3)', async () => {
    const { controller, usersService, req } = buildController();
    await controller.transferAdmin('u1', req);
    expect(usersService.transferAdmin).toHaveBeenCalledWith('admin-1', 'u1');
  });

  it('отображает name → displayName при обновлении профиля (Req 6.3)', async () => {
    const { controller, usersService, req } = buildController();
    await controller.update('u1', { name: 'Новое имя', email: 'new@example.com' }, req);
    expect(usersService.updateProfile).toHaveBeenCalledWith('admin-1', 'u1', {
      email: 'new@example.com',
      displayName: 'Новое имя',
    });
  });

  it('восстанавливает Пользователя по выбранному адресу (Req 7.2)', async () => {
    const { controller, usersService, req } = buildController();
    const view = await controller.restore('u1', { email: 'old@example.com' }, req);
    expect(usersService.restoreUser).toHaveBeenCalledWith('admin-1', 'u1', 'old@example.com');
    expect(view.id).toBe('u1');
  });

  it('удаляет Пользователя в указанном режиме (Req 8.1)', async () => {
    const { controller, usersService, req } = buildController();
    await controller.remove('u1', 'hard', req);
    expect(usersService.deleteUser).toHaveBeenCalledWith('admin-1', 'u1', 'hard');
  });

  it('отклоняет недопустимый режим удаления', async () => {
    const { controller, req } = buildController();
    await expect(controller.remove('u1', 'bogus', req)).rejects.toBeInstanceOf(ValidationException);
  });

  it('возвращает список удалённых Пользователей с адресами (Req 7.3)', async () => {
    const { controller, req } = buildController();
    const list = await controller.listDeleted(req);
    expect(list).toHaveLength(1);
    expect(list[0]?.emails).toEqual(['old@example.com', 'older@example.com']);
  });

  it('возвращает справочник минимальными полями для любого аутентифицированного', async () => {
    const { controller, req } = buildController({ role: Role.EXECUTOR, userId: 'e1' });
    const dir = await controller.directory(req);
    expect(dir[0]).toEqual({ id: 'admin-1', name: 'Админ', role: Role.ADMIN });
  });

  it('запрещает не-Администратору список удалённых (Req 5.1)', async () => {
    const { controller, req } = buildController({ role: Role.MANAGER, userId: 'm1' });
    await expect(controller.listDeleted(req)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('SessionAuthGuard объявлен на контроллере', () => {
    const guards = Reflect.getMetadata('__guards__', UsersController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
