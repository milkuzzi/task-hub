import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuthService, AuthSession, SessionTokenService } from '../../auth';
import { AuthenticationException, StateConflictException } from '../../common/errors';
import { AppConfigService } from '../../config';
import { ClockService } from '../../clock';
import { UserRepository } from '../../repositories';

const INIT_DATA_MAX_LENGTH = 8192;
const MAX_FUTURE_SKEW_SECONDS = 60;

interface MaxInitUser {
  id: string | number;
}

@Injectable()
export class MaxMiniAppAuthService {
  private readonly logger = new Logger(MaxMiniAppAuthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly users: UserRepository,
    private readonly auth: AuthService,
    private readonly sessions: SessionTokenService,
  ) {}

  async login(initData: string): Promise<AuthSession> {
    const maxUserId = this.validateInitData(initData);
    const user = await this.users.findActiveUserByMaxUserId(maxUserId);
    if (user === null) {
      throw new StateConflictException('Профиль MAX ещё не привязан к Task Hub.', {
        reason: 'MAX_NOT_LINKED',
      });
    }
    this.logger.log(`Вход в mini-app MAX выполнен для пользователя «${user.id}».`);
    return this.sessions.issue(user);
  }

  async linkAndLogin(
    initData: string,
    email: string,
    password: string,
    ip: string,
  ): Promise<AuthSession> {
    const maxUserId = this.validateInitData(initData);
    const user = await this.auth.authenticateCredentials(email, password, ip);

    await this.users.runInTransaction(async (tx) => {
      const [maxLink, userLink] = await Promise.all([
        this.users.findMaxLinkByMaxUserId(maxUserId, tx),
        this.users.findMaxLinkByUserId(user.id, tx),
      ]);
      if (maxLink !== null && maxLink.userId !== user.id) {
        throw new StateConflictException('Этот профиль MAX уже привязан к другой учётной записи.');
      }
      if (userLink !== null && userLink.maxUserId !== maxUserId) {
        throw new StateConflictException(
          'Учётная запись уже привязана к другому профилю MAX. Сначала удалите прежнюю привязку в профиле.',
          { reason: 'ACCOUNT_LINKED_TO_ANOTHER_MAX' },
        );
      }
      await this.users.upsertMaxLink(user.id, maxUserId, tx);
    });

    this.logger.log(`Профиль MAX привязан при входе в mini-app к пользователю «${user.id}».`);
    return this.sessions.issue(user);
  }

  validateInitData(initData: string): string {
    if (initData.length === 0 || initData.length > INIT_DATA_MAX_LENGTH) {
      throw this.invalidInitData();
    }
    const token = this.config.max.botToken;
    if (token === '') {
      this.logger.error('Вход в mini-app невозможен: MAX_BOT_TOKEN не настроен.');
      throw this.invalidInitData();
    }

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(initData);
    } catch {
      throw this.invalidInitData();
    }
    const entries = [...params.entries()];
    const hashEntries = entries.filter(([key]) => key === 'hash');
    if (hashEntries.length !== 1) {
      throw this.invalidInitData();
    }
    const receivedHash = hashEntries[0]?.[1] ?? '';
    if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
      throw this.invalidInitData();
    }
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw this.invalidInitData();
    }

    const launchParams = entries
      .filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
    const expectedHash = createHmac('sha256', secretKey).update(launchParams).digest();
    const received = Buffer.from(receivedHash, 'hex');
    if (received.length !== expectedHash.length || !timingSafeEqual(received, expectedHash)) {
      throw this.invalidInitData();
    }

    this.assertFresh(params.get('auth_date'));
    return this.parseUserId(params.get('user'));
  }

  private assertFresh(value: string | null): void {
    if (value === null || !/^\d+$/.test(value)) {
      throw this.invalidInitData();
    }
    const authDate = Number(value);
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    if (
      !Number.isSafeInteger(authDate) ||
      authDate > nowSeconds + MAX_FUTURE_SKEW_SECONDS ||
      nowSeconds - authDate > this.config.max.miniAppInitDataTtlSeconds
    ) {
      throw this.invalidInitData(
        'Срок действия данных запуска MAX истёк. Откройте mini-app заново.',
      );
    }
  }

  private parseUserId(value: string | null): string {
    if (value === null) {
      throw this.invalidInitData();
    }
    try {
      const parsed = JSON.parse(value) as MaxInitUser;
      const id = typeof parsed.id === 'number' ? String(parsed.id) : parsed.id?.trim();
      if (id === undefined || id === '' || !/^\d+$/.test(id)) {
        throw this.invalidInitData();
      }
      return id;
    } catch (error) {
      if (error instanceof AuthenticationException) {
        throw error;
      }
      throw this.invalidInitData();
    }
  }

  private invalidInitData(
    message = 'Не удалось подтвердить запуск из MAX. Откройте mini-app заново.',
  ): AuthenticationException {
    return new AuthenticationException(message);
  }
}
