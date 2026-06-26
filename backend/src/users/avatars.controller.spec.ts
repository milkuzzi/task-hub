import { Readable } from 'node:stream';
import { Role, User } from '@prisma/client';
import { Response } from 'express';
import { StreamableFile } from '@nestjs/common';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { UserRepository } from '../repositories';
import { AvatarsController } from './avatars.controller';
import { AvatarContent, AvatarStorage } from './avatar-storage';

/**
 * Контроллерные тесты {@link AvatarsController} (задача 10.5, 10.6).
 *
 * Проверяют контролируемую отдачу аватара вне веб-корня (Req 19.8): поиск
 * Пользователя и его `avatarPath`, потоковую отдачу как {@link StreamableFile} с
 * корректным `Content-Type`, 404 при отсутствии Пользователя/аватара/файла без
 * раскрытия деталей (Req 2.12) и наличие {@link SessionAuthGuard}. Доменные
 * правила хранения проверяются в тестах {@link FileSystemAvatarStorage}.
 */
describe('AvatarsController', () => {
  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: 'user-1',
      avatarPath: 'avatars/user-1/abc.png',
      deletedAt: null,
      ...overrides,
    } as unknown as User;
  }

  function buildController(opts: { user?: User | null } = {}): {
    controller: AvatarsController;
    userRepository: { findActiveById: jest.Mock };
    avatarStorage: { read: jest.Mock };
    req: AuthenticatedRequest;
    res: Response;
    headers: Record<string, string>;
  } {
    const content: AvatarContent = {
      stream: Readable.from(Buffer.from('avatar-bytes')),
      contentType: 'image/png',
    };
    const userRepository = {
      findActiveById: jest.fn().mockResolvedValue(opts.user === undefined ? makeUser() : opts.user),
    };
    const avatarStorage = {
      read: jest.fn().mockResolvedValue(content),
    };
    const controller = new AvatarsController(
      userRepository as unknown as UserRepository,
      avatarStorage as unknown as AvatarStorage,
    );
    const req = {
      user: { userId: 'viewer-1', tokenId: 't1', role: Role.EXECUTOR },
    } as AuthenticatedRequest;
    const headers: Record<string, string> = {};
    const res = {
      set: jest.fn((value: Record<string, string>) => Object.assign(headers, value)),
    } as unknown as Response;
    return { controller, userRepository, avatarStorage, req, res, headers };
  }

  it('отдаёт аватар как поток с корректным Content-Type (Req 6.4, 19.8)', async () => {
    const { controller, userRepository, avatarStorage, req, res, headers } = buildController();
    const result = await controller.serve('user-1', req, res);
    expect(userRepository.findActiveById).toHaveBeenCalledWith('user-1');
    expect(avatarStorage.read).toHaveBeenCalledWith('avatars/user-1/abc.png');
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('возвращает 404, если Пользователь не найден (Req 2.12)', async () => {
    const { controller, avatarStorage, req, res } = buildController({ user: null });
    await expect(controller.serve('ghost', req, res)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(avatarStorage.read).not.toHaveBeenCalled();
  });

  it('возвращает 404, если у Пользователя нет аватара (Req 2.12)', async () => {
    const { controller, avatarStorage, req, res } = buildController({
      user: makeUser({ avatarPath: null }),
    });
    await expect(controller.serve('user-1', req, res)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(avatarStorage.read).not.toHaveBeenCalled();
  });

  it('пробрасывает 404, если файл аватара недоступен в хранилище (Req 2.12, 19.8)', async () => {
    const { controller, avatarStorage, req, res } = buildController();
    avatarStorage.read.mockRejectedValueOnce(new EntityNotFoundException('Аватар не найден.'));
    await expect(controller.serve('user-1', req, res)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('требует входа, если субъект не установлен (Req 1.5)', async () => {
    const { controller, res } = buildController();
    const anon = {} as AuthenticatedRequest;
    await expect(controller.serve('user-1', anon, res)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5, 19.8)', () => {
    const guards = Reflect.getMetadata('__guards__', AvatarsController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
