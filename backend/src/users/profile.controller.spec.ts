import { Role } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { MaxOAuthExchangeError, type MaxOAuthPort } from '../max/oauth';
import { UserRepository } from '../repositories';
import { ProfileController } from './profile.controller';
import { UsersService } from './users.service';

/**
 * Контроллерные тесты {@link ProfileController} (задача 3.2).
 *
 * Проверяют тонкую маршрутизацию HTTP → {@link UsersService}: отображение
 * multer-файла в форму {@link UploadedFile} и делегирование загрузки аватара
 * собственному Пользователю (инициатор == цель), отклонение запроса без файла,
 * обмен кода авторизации MAX через порт и последующую привязку профиля, проброс
 * доменных ошибок и формирование представления `CurrentUser`. Доменные правила
 * (формат/размер аватара, верификация MAX) проверяются в тестах
 * {@link UsersService}; здесь моделируется только поведение контроллера.
 */
describe('ProfileController', () => {
  const USER_ID = 'user-1';
  const MAX_BYTES = 5 * 1024 * 1024;

  const currentUserRow = {
    id: USER_ID,
    email: 'user@example.com',
    displayName: 'Пользователь',
    role: Role.EXECUTOR,
    avatarPath: '/avatars/user-1.png',
    maxLink: { userId: USER_ID, maxUserId: 'max-1' },
  };

  function buildController(opts: { userId?: string; role?: Role } = {}): {
    controller: ProfileController;
    usersService: { setAvatar: jest.Mock; linkMax: jest.Mock };
    userRepository: { findByIdWithMaxLink: jest.Mock };
    maxOAuth: { exchangeAuthCode: jest.Mock };
    req: AuthenticatedRequest;
  } {
    const usersService = {
      setAvatar: jest.fn().mockResolvedValue(undefined),
      linkMax: jest.fn().mockResolvedValue(undefined),
    };

    const userRepository = {
      findByIdWithMaxLink: jest.fn().mockResolvedValue(currentUserRow),
    };

    const maxOAuth = {
      exchangeAuthCode: jest.fn().mockResolvedValue('max-1'),
    };

    const controller = new ProfileController(
      usersService as unknown as UsersService,
      userRepository as unknown as UserRepository,
      maxOAuth as unknown as MaxOAuthPort,
    );

    const req = {
      user: { userId: opts.userId ?? USER_ID, tokenId: 't1', role: opts.role ?? Role.EXECUTOR },
    } as AuthenticatedRequest;

    return { controller, usersService, userRepository, maxOAuth, req };
  }

  function makeMulterFile(): {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  } {
    return {
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 2048,
      buffer: Buffer.from('image-bytes'),
    };
  }

  it('отображает multer-файл в форму сервиса и делегирует собственному Пользователю (Req 3.1)', async () => {
    const { controller, usersService, req } = buildController();
    const view = await controller.uploadAvatar(makeMulterFile(), req);
    expect(usersService.setAvatar).toHaveBeenCalledWith(USER_ID, USER_ID, {
      originalName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      buffer: Buffer.from('image-bytes'),
    });
    expect(view).toEqual({
      id: USER_ID,
      email: 'user@example.com',
      name: 'Пользователь',
      role: Role.EXECUTOR,
      avatarPath: '/avatars/user-1.png',
      maxLinked: true,
    });
  });

  it('отклоняет загрузку аватара без файла (Req 3.1)', async () => {
    const { controller, usersService, req } = buildController();
    await expect(controller.uploadAvatar(undefined, req)).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(usersService.setAvatar).not.toHaveBeenCalled();
  });

  it('пробрасывает отказ сервиса при превышении 5 МБ/неподдерживаемом формате (Req 3.3)', async () => {
    const { controller, usersService, req } = buildController();
    usersService.setAvatar.mockRejectedValueOnce(
      new ValidationException('размер аватара превышает допустимый предел в 5 МБ.'),
    );
    const big = { ...makeMulterFile(), size: MAX_BYTES + 1 };
    await expect(controller.uploadAvatar(big, req)).rejects.toBeInstanceOf(ValidationException);
  });

  it('обменивает authCode и привязывает верифицированный профиль MAX (Req 3.2)', async () => {
    const { controller, usersService, maxOAuth, req } = buildController();
    const view = await controller.linkMax({ authCode: 'code-xyz' }, req);
    expect(maxOAuth.exchangeAuthCode).toHaveBeenCalledWith('code-xyz');
    expect(usersService.linkMax).toHaveBeenCalledWith(USER_ID, {
      maxUserId: 'max-1',
      verified: true,
    });
    expect(view.maxLinked).toBe(true);
  });

  it('не задаёт ownerUserId в профиле MAX (Req 6.9)', async () => {
    const { controller, usersService, req } = buildController();
    await controller.linkMax({ authCode: 'code-xyz' }, req);
    const profile = usersService.linkMax.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(profile).not.toHaveProperty('ownerUserId');
  });

  it('приводит ошибку обмена кода авторизации MAX к доменной ValidationException (Req 3.2, 9.6)', async () => {
    const { controller, usersService, maxOAuth, req } = buildController();
    maxOAuth.exchangeAuthCode.mockRejectedValueOnce(
      new MaxOAuthExchangeError('Интеграция MAX не настроена.'),
    );
    await expect(controller.linkMax({ authCode: 'code-xyz' }, req)).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(usersService.linkMax).not.toHaveBeenCalled();
  });

  it('требует входа, если субъект не установлен (Req 1.5)', async () => {
    const { controller } = buildController();
    const anon = {} as AuthenticatedRequest;
    await expect(controller.uploadAvatar(makeMulterFile(), anon)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', ProfileController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
