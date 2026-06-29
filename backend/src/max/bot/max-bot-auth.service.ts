import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Role } from '@prisma/client';
import { ClockService } from '../../clock';
import {
  EntityNotFoundException,
  AppException,
  StateConflictException,
  ValidationException,
} from '../../common/errors';
import { AppConfigService } from '../../config';
import { PrismaService } from '../../infra';
import { UserRepository } from '../../repositories';
import { SessionTokenService } from '../../auth/session-token.service';
import { AuthSession } from '../../auth/auth.types';

const MAX_AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_STATE_PREFIX = 'th';
const PURPOSE_LINK = 'link';
const PURPOSE_LOGIN = 'login';

export interface MaxBotAuthStart {
  state: string;
  link: string;
  expiresAt: Date;
}

export type MaxBotAuthPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'failed'; reason: string }
  | { status: 'confirmed'; userId: string };

export interface MaxBotStartedResult {
  handled: boolean;
  message?: string;
}

@Injectable()
export class MaxBotAuthService {
  private readonly logger = new Logger(MaxBotAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly users: UserRepository,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  async startLink(userId: string): Promise<MaxBotAuthStart> {
    const user = await this.users.findActiveById(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена или удалена.');
    }
    return this.createState(PURPOSE_LINK, userId);
  }

  startLogin(): Promise<MaxBotAuthStart> {
    return this.createState(PURPOSE_LOGIN, null);
  }

  async pollLink(userId: string, state: string): Promise<MaxBotAuthPoll> {
    const row = await this.prisma.maxAuthState.findUnique({ where: { state } });
    const now = this.clock.now();
    if (row === null || row.purpose !== PURPOSE_LINK || row.userId !== userId) {
      return { status: 'expired' };
    }
    if (row.expiresAt <= now || row.consumedAt !== null) {
      return { status: 'expired' };
    }
    if (row.completedAt === null) {
      return { status: 'pending' };
    }
    if (row.error !== null) {
      await this.consumeState(row.state);
      return { status: 'failed', reason: row.error };
    }
    await this.consumeState(row.state);
    return { status: 'confirmed', userId };
  }

  async pollLogin(state: string): Promise<MaxBotAuthPoll & { session?: AuthSession }> {
    const row = await this.prisma.maxAuthState.findUnique({ where: { state } });
    const now = this.clock.now();
    if (row === null || row.purpose !== PURPOSE_LOGIN) {
      return { status: 'expired' };
    }
    if (row.expiresAt <= now || row.consumedAt !== null) {
      return { status: 'expired' };
    }
    if (row.completedAt === null) {
      return { status: 'pending' };
    }
    if (row.error !== null || row.completedUserId === null) {
      await this.consumeState(row.state);
      return { status: 'failed', reason: row.error ?? 'Профиль MAX не привязан.' };
    }

    await this.consumeState(row.state);
    const user = await this.users.findActiveById(row.completedUserId);
    if (user === null || !user.isActive) {
      return { status: 'failed', reason: 'Учётная запись недоступна.' };
    }
    const session = await this.sessionTokens.issue({
      id: user.id,
      role: user.role as Role,
    });
    return { status: 'confirmed', userId: user.id, session };
  }

  async handleBotStarted(maxUserId: string, payload: string | null): Promise<MaxBotStartedResult> {
    if (payload === null) {
      return { handled: false };
    }

    const row = await this.prisma.maxAuthState.findUnique({ where: { state: payload } });
    const now = this.clock.now();
    if (row === null) {
      return { handled: false };
    }
    if (row.expiresAt <= now || row.consumedAt !== null) {
      await this.completeState(row.state, maxUserId, null, 'Ссылка устарела.');
      return {
        handled: true,
        message: 'Ссылка устарела. Вернитесь на сайт и попробуйте ещё раз.',
      };
    }

    if (row.purpose === PURPOSE_LINK) {
      if (row.userId === null) {
        await this.completeState(row.state, maxUserId, null, 'Некорректная ссылка привязки.');
        return { handled: true, message: 'Ссылка привязки некорректна.' };
      }

      try {
        await this.linkMax(row.userId, maxUserId);
      } catch (error) {
        const message = error instanceof AppException ? error.message : 'Не удалось привязать MAX.';
        await this.completeState(row.state, maxUserId, null, message);
        return { handled: true, message };
      }
      await this.completeState(row.state, maxUserId, row.userId, null);
      return { handled: true, message: 'Готово! Ваш профиль MAX привязан к сайту.' };
    }

    if (row.purpose === PURPOSE_LOGIN) {
      const user = await this.users.findActiveUserByMaxUserId(maxUserId);
      if (user === null) {
        await this.completeState(row.state, maxUserId, null, 'MAX пока не привязан к аккаунту.');
        return {
          handled: true,
          message: 'MAX пока не привязан к аккаунту на сайте. Сначала привяжите MAX в профиле.',
        };
      }

      await this.completeState(row.state, maxUserId, user.id, null);
      return { handled: true, message: 'Вход подтверждён. Вернитесь на сайт.' };
    }

    return { handled: false };
  }

  private async createState(purpose: string, userId: string | null): Promise<MaxBotAuthStart> {
    const expiresAt = new Date(this.clock.now().getTime() + MAX_AUTH_STATE_TTL_MS);
    const state = `${MAX_AUTH_STATE_PREFIX}_${purpose}_${randomBytes(18).toString('base64url')}`;
    const link = this.buildDeepLink(state);
    await this.prisma.maxAuthState.create({
      data: {
        state,
        purpose,
        userId,
        expiresAt,
      },
    });
    return { state, link, expiresAt };
  }

  private buildDeepLink(state: string): string {
    const username = this.config.max.botUsername.trim().replace(/^@/, '');
    if (username === '') {
      throw new ValidationException(
        'MAX_BOT_USERNAME не задан: невозможно построить ссылку на бота.',
      );
    }
    const url = new URL(`https://max.ru/${encodeURIComponent(username)}`);
    url.searchParams.set('start', state);
    return url.toString();
  }

  private async linkMax(userId: string, maxUserId: string): Promise<void> {
    const user = await this.users.findActiveById(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена или удалена.');
    }

    await this.users.runInTransaction(async (tx) => {
      const existing = await this.users.findMaxLinkByMaxUserId(maxUserId, tx);
      if (existing !== null && existing.userId !== userId) {
        throw new StateConflictException('Этот профиль MAX уже привязан к другой учётной записи.');
      }
      await this.users.upsertMaxLink(userId, maxUserId, tx);
    });

    this.logger.log(`Пользователь «${userId}» привязал профиль MAX «${maxUserId}» через Бота.`);
  }

  private async completeState(
    state: string,
    maxUserId: string,
    completedUserId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.maxAuthState.update({
      where: { state },
      data: {
        maxUserId,
        completedUserId,
        error,
        completedAt: this.clock.now(),
      },
    });
  }

  private async consumeState(state: string): Promise<void> {
    await this.prisma.maxAuthState.update({
      where: { state },
      data: { consumedAt: this.clock.now() },
    });
  }
}
