import { AppService } from './app.service';
import { BackupRecordRepository } from './backup';
import { AppConfigService } from './config';
import { ALL_QUEUE_NAMES, PrismaService, QueueService, RedisService } from './infra';

describe('AppService metrics', () => {
  function build(repository: string): AppService {
    const queues = {
      getQueue: jest.fn(() => ({
        getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, delayed: 0, failed: 0 }),
      })),
    } as unknown as QueueService;
    const backups = {
      findLastSuccessful: jest.fn().mockResolvedValue({
        finishedAt: new Date('2026-06-28T00:00:00.000Z'),
      }),
    } as unknown as BackupRecordRepository;
    const config = {
      backup: { mode: 'required' },
      restic: { repository },
    } as unknown as AppConfigService;

    return new AppService({} as PrismaService, {} as RedisService, queues, backups, config);
  }

  it('marks remote restic repositories as offsite for release smoke', async () => {
    const metrics = await build('s3:s3.amazonaws.com/task-hub-backups').metrics();

    expect(metrics).toContain('taskhub_backup_restic_offsite_configured 1');
    for (const name of ALL_QUEUE_NAMES) {
      expect(metrics).toContain(`taskhub_queue_jobs{queue="${name}",state="waiting"} 0`);
    }
  });

  it('does not mark local filesystem restic repositories as offsite', async () => {
    const metrics = await build('/var/backups/task-hub-restic').metrics();

    expect(metrics).toContain('taskhub_backup_restic_offsite_configured 0');
  });
});
