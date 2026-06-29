import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BackupRecordRepository, BackupWorker } from '../src/backup';
import { PrismaService, QueueService, REDIS_CLIENT } from '../src/infra';
import { EmailWorker } from '../src/mailer';
import { DeadlineReminderWorker, NotificationDeliveryWorker } from '../src/notifications';

describe('AppModule (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      })
      .overrideProvider(REDIS_CLIENT)
      .useValue({
        ping: jest.fn().mockResolvedValue('PONG'),
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      })
      .overrideProvider(QueueService)
      .useValue({
        getQueue: jest.fn(() => ({
          getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, delayed: 0, failed: 0 }),
          add: jest.fn().mockResolvedValue(undefined),
        })),
        add: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(BackupRecordRepository)
      .useValue({
        findLastSuccessful: jest.fn().mockResolvedValue(null),
      })
      .overrideProvider(EmailWorker)
      .useValue(noopLifecycle())
      .overrideProvider(NotificationDeliveryWorker)
      .useValue(noopLifecycle())
      .overrideProvider(DeadlineReminderWorker)
      .useValue(noopLifecycle())
      .overrideProvider(BackupWorker)
      .useValue(noopLifecycle())
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health возвращает статус ok', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'task-assignment-system',
    });
  });
});

function noopLifecycle(): { onModuleInit: jest.Mock; onModuleDestroy: jest.Mock } {
  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };
}
