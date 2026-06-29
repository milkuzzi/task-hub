import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, AuthSession, setSessionCookie } from '../../auth';
import { EntityNotFoundException } from '../../common/errors';
import type { HttpResponseLike } from '../../common/http';
import { AppConfigService } from '../../config';
import { UserRepository } from '../../repositories';
import { RateLimit, RateLimitGuard } from '../../security';
import { CurrentUserView, toCurrentUser } from '../../users/user-representation';
import { MaxMiniAppAuthService } from './max-mini-app-auth.service';
import { MaxMiniAppLinkDto, MaxMiniAppLoginDto } from './max-mini-app.dto';

interface MaxMiniAppSessionResponse {
  token: string;
  user: CurrentUserView;
}

@Controller('auth/max/mini-app')
export class MaxMiniAppAuthController {
  constructor(
    private readonly miniAppAuth: MaxMiniAppAuthService,
    private readonly users: UserRepository,
    private readonly config: AppConfigService,
  ) {}

  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit('login')
  async login(
    @Body() dto: MaxMiniAppLoginDto,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<MaxMiniAppSessionResponse> {
    return this.complete(await this.miniAppAuth.login(dto.initData), response);
  }

  @Post('link')
  @UseGuards(RateLimitGuard)
  @RateLimit('login')
  async link(
    @Body() dto: MaxMiniAppLinkDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<MaxMiniAppSessionResponse> {
    const ip = request.ip ?? request.socket?.remoteAddress ?? '';
    return this.complete(
      await this.miniAppAuth.linkAndLogin(dto.initData, dto.email, dto.password, ip),
      response,
    );
  }

  private async complete(
    session: AuthSession,
    response: HttpResponseLike,
  ): Promise<MaxMiniAppSessionResponse> {
    setSessionCookie(response, session, this.config);
    const user = await this.users.findByIdWithMaxLink(session.userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    return { token: session.accessToken, user: toCurrentUser(user) };
  }
}
