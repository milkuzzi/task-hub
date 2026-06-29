import { ValidationException } from '../common/errors';
import { AuthController } from './auth.controller';

describe('AuthController MAX OAuth start', () => {
  const authService = {
    login: jest.fn(),
    loginWithMax: jest.fn(),
    setPassword: jest.fn(),
    changePassword: jest.fn(),
    revokeAllSessions: jest.fn(),
    refreshSession: jest.fn(),
  };
  const userRepository = { findByIdWithMaxLink: jest.fn() };

  function makeController(overrides: Record<string, unknown> = {}): AuthController {
    return new AuthController(
      authService as never,
      userRepository as never,
      {
        app: { publicUrl: 'https://tasks.example.test' },
        max: {
          oauthAuthorizeUrl: 'https://max.example.test/oauth/authorize',
          oauthClientId: 'client-1',
          ...overrides,
        },
      } as never,
    );
  }

  it('строит redirect на MAX для привязки профиля', () => {
    const controller = makeController();
    const res = { redirect: jest.fn() };

    controller.startMax(
      {
        purpose: 'link',
        redirect_uri: 'https://tasks.example.test/profile/max/callback',
        state: 'state-1',
      },
      res as never,
    );

    const target = new URL(res.redirect.mock.calls[0]?.[0] as string);
    expect(target.origin + target.pathname).toBe('https://max.example.test/oauth/authorize');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('client-1');
    expect(target.searchParams.get('redirect_uri')).toBe(
      'https://tasks.example.test/profile/max/callback',
    );
    expect(target.searchParams.get('state')).toBe('state-1');
  });

  it('подставляет callback входа по умолчанию', () => {
    const controller = makeController();
    const res = { redirect: jest.fn() };

    controller.startMax({ state: 'state-2' }, res as never);

    const target = new URL(res.redirect.mock.calls[0]?.[0] as string);
    expect(target.searchParams.get('redirect_uri')).toBe(
      'https://tasks.example.test/auth/max/callback',
    );
  });

  it('отклоняет callback вне PUBLIC_URL', () => {
    const controller = makeController();

    expect(() =>
      controller.startMax({ redirect_uri: 'https://evil.example.test/profile/max/callback' }, {
        redirect: jest.fn(),
      } as never),
    ).toThrow(ValidationException);
  });

  it('возвращает на callback с ошибкой, если OAuth не настроен', () => {
    const controller = makeController({ oauthAuthorizeUrl: '' });
    const res = { redirect: jest.fn() };

    controller.startMax({ purpose: 'link', state: 'state-3' }, res as never);

    const target = new URL(res.redirect.mock.calls[0]?.[0] as string);
    expect(target.toString()).toBe(
      'https://tasks.example.test/profile/max/callback?error=oauth_not_configured&state=state-3',
    );
  });
});
