import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Res } from '@nestjs/common';
import { setResponseHeaders, setResponseStatus, type HttpResponseLike } from './common/http';
import { AppConfigService } from './config';
import { AppService, HealthStatus, ReadinessStatus } from './app.service';

const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const METRICS_UNAUTHORIZED_BODY = 'Metrics token is required.\n';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly config: AppConfigService,
  ) {}

  @Get('health')
  health(): HealthStatus {
    return this.appService.health();
  }

  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: HttpResponseLike): Promise<ReadinessStatus> {
    const status = await this.appService.readiness();
    if (status.status !== 'ok') {
      setResponseStatus(res, 503);
    }
    return status;
  }

  @Get('metrics')
  async metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<string> {
    setResponseHeaders(res, { 'Content-Type': METRICS_CONTENT_TYPE });

    const token = this.config.metrics.token;
    if (token !== '' && !isBearerToken(authorization, token)) {
      setResponseStatus(res, 401);
      return METRICS_UNAUTHORIZED_BODY;
    }
    return this.appService.metrics();
  }
}

function isBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  if (authorization === undefined) {
    return false;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== 'Bearer' || token === undefined || token === '') {
    return false;
  }

  const actual = Buffer.from(token, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
