import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, SessionAuthGuard, setSessionCookie } from '../../auth';
import { AuthSession } from '../../auth/auth.types';
import { EntityNotFoundException, ValidationException } from '../../common/errors';
import type { HttpResponseLike } from '../../common/http';
import { AppConfigService } from '../../config';
import { UserRepository } from '../../repositories';
import { CurrentUserView, toCurrentUser } from '../../users/user-representation';
import { MaxBotAuthService, MaxBotAuthStart } from './max-bot-auth.service';

type MaxBotAuthStartView = Omit<MaxBotAuthStart, 'expiresAt'> & { expiresAt: string };

type MaxBotLoginStatusView =
  | { status: 'pending' | 'expired' }
  | { status: 'failed'; reason: string }
  | ({ status: 'confirmed' } & AuthSessionResponse);

type MaxBotLinkStatusView =
  | { status: 'pending' | 'expired' }
  | { status: 'failed'; reason: string }
  | { status: 'confirmed'; user: CurrentUserView };

interface AuthSessionResponse {
  token: string;
  user: CurrentUserView;
}

@Controller('max/bot/auth')
export class MaxBotAuthController {
  constructor(
    private readonly auth: MaxBotAuthService,
    private readonly users: UserRepository,
    private readonly config: AppConfigService,
  ) {}

  @Post('login/start')
  async startLogin(): Promise<MaxBotAuthStartView> {
    return this.toStartView(await this.auth.startLogin());
  }

  @Get('login/status')
  async loginStatus(
    @Query('state') state: string | undefined,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<MaxBotLoginStatusView> {
    const result = await this.auth.pollLogin(this.requireState(state));
    if (result.status !== 'confirmed') {
      return result;
    }
    if (result.session === undefined) {
      return { status: 'failed', reason: 'Сессия MAX не создана.' };
    }
    setSessionCookie(res, result.session, this.config);
    return { status: 'confirmed', ...(await this.toSessionResponse(result.session)) };
  }

  @Post('link/start')
  @UseGuards(SessionAuthGuard)
  async startLink(@Req() req: AuthenticatedRequest): Promise<MaxBotAuthStartView> {
    return this.toStartView(await this.auth.startLink(this.principal(req).userId));
  }

  @Get('link/status')
  @UseGuards(SessionAuthGuard)
  async linkStatus(
    @Query('state') state: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<MaxBotLinkStatusView> {
    const userId = this.principal(req).userId;
    const result = await this.auth.pollLink(userId, this.requireState(state));
    if (result.status !== 'confirmed') {
      return result;
    }
    return { status: 'confirmed', user: await this.loadCurrentUser(userId) };
  }

  private requireState(state: string | undefined): string {
    if (typeof state !== 'string' || state.trim() === '') {
      throw new ValidationException('Не указан state MAX.');
    }
    return state.trim();
  }

  private toStartView(start: MaxBotAuthStart): MaxBotAuthStartView {
    return { state: start.state, link: start.link, expiresAt: start.expiresAt.toISOString() };
  }

  private async toSessionResponse(session: AuthSession): Promise<AuthSessionResponse> {
    return {
      token: session.accessToken,
      user: await this.loadCurrentUser(session.userId),
    };
  }

  private async loadCurrentUser(userId: string): Promise<CurrentUserView> {
    const user = await this.users.findByIdWithMaxLink(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    return toCurrentUser(user);
  }

  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new ValidationException('Требуется вход в систему.');
    }
    return req.user;
  }
}
