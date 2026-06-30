import { AppConfigService } from './config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpResponseLike } from './common/http';

describe('AppController metrics access', () => {
  function build(metricsToken: string) {
    const appService = {
      health: jest.fn(),
      readiness: jest.fn(),
      metrics: jest.fn(async () => 'taskhub_process_uptime_seconds 1\n'),
    } as unknown as AppService;
    const config = {
      metrics: { token: metricsToken },
    } as unknown as AppConfigService;

    return {
      appService,
      controller: new AppController(appService, config),
    };
  }

  function response(): HttpResponseLike {
    return {
      status: jest.fn(),
      header: jest.fn(),
    };
  }

  it('keeps metrics public when METRICS_TOKEN is not configured', async () => {
    const { appService, controller } = build('');
    const res = response();

    await expect(controller.metrics(undefined, res)).resolves.toContain(
      'taskhub_process_uptime_seconds',
    );
    expect(res.header).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(appService.metrics).toHaveBeenCalledTimes(1);
  });

  it('requires a matching Bearer token when METRICS_TOKEN is configured', async () => {
    const token = 'metrics-token-1234567890';
    const { appService, controller } = build(token);
    const missingTokenRes = response();
    const wrongTokenRes = response();
    const correctTokenRes = response();

    await expect(controller.metrics(undefined, missingTokenRes)).resolves.toBe(
      'Metrics token is required.\n',
    );
    expect(missingTokenRes.status).toHaveBeenCalledWith(401);

    await expect(controller.metrics('Bearer wrong-token', wrongTokenRes)).resolves.toBe(
      'Metrics token is required.\n',
    );
    expect(wrongTokenRes.status).toHaveBeenCalledWith(401);
    expect(appService.metrics).not.toHaveBeenCalled();

    await expect(controller.metrics(`Bearer ${token}`, correctTokenRes)).resolves.toContain(
      'taskhub_process_uptime_seconds',
    );
    expect(correctTokenRes.status).not.toHaveBeenCalled();
    expect(appService.metrics).toHaveBeenCalledTimes(1);
  });
});
