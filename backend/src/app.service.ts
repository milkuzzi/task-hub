import { Injectable } from '@nestjs/common';
import { AppConfigService } from './config';
import { ALL_QUEUE_NAMES, PrismaService, QueueService, RedisService } from './infra';
import { BackupRecordRepository } from './backup';

export interface HealthStatus {
  status: 'ok';
  service: string;
}

export interface DependencyStatus {
  status: 'ok' | 'error';
  detail?: string;
}

export interface ReadinessStatus {
  status: 'ok' | 'degraded';
  service: string;
  checks: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
    queues: DependencyStatus;
    backup: DependencyStatus;
  };
}

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly backups: BackupRecordRepository,
    private readonly config: AppConfigService,
  ) {}

  /** Простая проверка работоспособности приложения. */
  health(): HealthStatus {
    return { status: 'ok', service: 'task-assignment-system' };
  }

  async readiness(): Promise<ReadinessStatus> {
    const [postgres, redis, queues, backup] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkQueues(),
      this.checkBackupFreshness(),
    ]);
    const checks = { postgres, redis, queues, backup };
    const status = Object.values(checks).every((check) => check.status === 'ok')
      ? 'ok'
      : 'degraded';
    return { status, service: 'task-assignment-system', checks };
  }

  async metrics(): Promise<string> {
    const lines = [
      '# HELP taskhub_process_uptime_seconds Node.js process uptime.',
      '# TYPE taskhub_process_uptime_seconds gauge',
      `taskhub_process_uptime_seconds ${process.uptime().toFixed(0)}`,
      '# HELP taskhub_process_resident_memory_bytes Node.js RSS memory.',
      '# TYPE taskhub_process_resident_memory_bytes gauge',
      `taskhub_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    ];

    await this.appendQueueMetrics(lines);
    await this.appendBackupMetrics(lines);
    return `${lines.join('\n')}\n`;
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', detail: this.errorMessage(error) };
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      await this.redis.client.ping();
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', detail: this.errorMessage(error) };
    }
  }

  private async checkQueues(): Promise<DependencyStatus> {
    try {
      await Promise.all(
        ALL_QUEUE_NAMES.map((name) => this.queues.getQueue(name).getJobCounts('waiting')),
      );
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', detail: this.errorMessage(error) };
    }
  }

  private async checkBackupFreshness(): Promise<DependencyStatus> {
    if (this.config.backup.mode === 'disabled') {
      return { status: 'error', detail: 'BACKUP_MODE=disabled' };
    }
    try {
      const latest = await this.backups.findLastSuccessful();
      if (latest === null) {
        return { status: 'error', detail: 'successful backup not found' };
      }
      if (latest.finishedAt === null) {
        return { status: 'error', detail: 'last successful backup has no finish timestamp' };
      }
      const ageHours = (Date.now() - latest.finishedAt.getTime()) / 3_600_000;
      if (ageHours > 36) {
        return { status: 'error', detail: `last successful backup is ${ageHours.toFixed(1)}h old` };
      }
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', detail: this.errorMessage(error) };
    }
  }

  private async appendQueueMetrics(lines: string[]): Promise<void> {
    lines.push(
      '# HELP taskhub_queue_jobs BullMQ jobs by queue and state.',
      '# TYPE taskhub_queue_jobs gauge',
    );
    for (const name of ALL_QUEUE_NAMES) {
      try {
        const counts = await this.queues
          .getQueue(name)
          .getJobCounts('waiting', 'delayed', 'failed');
        for (const state of ['waiting', 'delayed', 'failed'] as const) {
          lines.push(`taskhub_queue_jobs{queue="${name}",state="${state}"} ${counts[state] ?? 0}`);
        }
      } catch {
        lines.push(`taskhub_queue_jobs{queue="${name}",state="metrics_error"} 1`);
      }
    }
  }

  private async appendBackupMetrics(lines: string[]): Promise<void> {
    lines.push(
      '# HELP taskhub_backup_last_success_timestamp_seconds Last successful backup timestamp.',
      '# TYPE taskhub_backup_last_success_timestamp_seconds gauge',
    );
    try {
      const latest = await this.backups.findLastSuccessful();
      const timestamp =
        latest?.finishedAt === null || latest?.finishedAt === undefined
          ? 0
          : Math.floor(latest.finishedAt.getTime() / 1000);
      lines.push(`taskhub_backup_last_success_timestamp_seconds ${timestamp}`);
      lines.push(`taskhub_backup_mode_required ${this.config.backup.mode === 'required' ? 1 : 0}`);
      lines.push(
        `taskhub_backup_restic_offsite_configured ${
          isOffsiteResticRepository(this.config.restic.repository) ? 1 : 0
        }`,
      );
    } catch {
      lines.push('taskhub_backup_last_success_timestamp_seconds 0');
      lines.push(`taskhub_backup_mode_required ${this.config.backup.mode === 'required' ? 1 : 0}`);
      lines.push(
        `taskhub_backup_restic_offsite_configured ${
          isOffsiteResticRepository(this.config.restic.repository) ? 1 : 0
        }`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function isOffsiteResticRepository(repository: string): boolean {
  const normalized = repository.trim().toLowerCase();
  return (
    normalized.startsWith('s3:') ||
    normalized.startsWith('sftp:') ||
    normalized.startsWith('rest:') ||
    normalized.startsWith('rclone:') ||
    normalized.startsWith('b2:') ||
    normalized.startsWith('azure:') ||
    normalized.startsWith('gs:') ||
    normalized.startsWith('swift:')
  );
}
