import { Controller, Get, Header, Res } from '@nestjs/common';
import { setResponseStatus, type HttpResponseLike } from './common/http';
import { AppService, HealthStatus, ReadinessStatus } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

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
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    return this.appService.metrics();
  }
}
