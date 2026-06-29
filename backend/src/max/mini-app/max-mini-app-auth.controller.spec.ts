import { Role } from '@prisma/client';
import { MaxMiniAppAuthController } from './max-mini-app-auth.controller';

describe('MaxMiniAppAuthController', () => {
  it('возвращает token вместе с профилем для desktop web mini-app', async () => {
    const session = {
      accessToken: 'session-token',
      tokenId: 'token-1',
      userId: 'user-1',
      role: Role.ADMIN,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const miniAppAuth = { login: jest.fn().mockResolvedValue(session) };
    const users = {
      findByIdWithMaxLink: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Администратор',
        role: Role.ADMIN,
        avatarPath: null,
        maxLink: { maxUserId: '12345' },
      }),
    };
    const response = { cookie: jest.fn() };
    const controller = new MaxMiniAppAuthController(
      miniAppAuth as never,
      users as never,
      { isProduction: true } as never,
    );

    await expect(
      controller.login({ initData: 'auth_date=1&hash=test' }, response as never),
    ).resolves.toMatchObject({
      token: 'session-token',
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Администратор',
        role: Role.ADMIN,
        avatarPath: null,
        maxLinked: true,
      },
    });
    expect(response.cookie).toHaveBeenCalledWith(
      'taskhub_session',
      'session-token',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' }),
    );
  });
});
