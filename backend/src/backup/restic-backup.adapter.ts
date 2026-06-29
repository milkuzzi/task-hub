import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config';
import { DatabaseDumpResult, ResticBackupPort } from './backup.types';

/**
 * Рабочий адаптер порта {@link ResticBackupPort} поверх инструмента restic и
 * утилиты `pg_dump` (Req 21.1, 21.2).
 *
 * Создаёт дамп PostgreSQL утилитой `pg_dump` (строка подключения берётся из
 * {@link import('../config').DatabaseConfig.url}), параллельно вычисляя
 * SHA-256-контрольную сумму содержимого до выгрузки (Req 21.6), затем помещает
 * полученный файл в дедуплицируемый репозиторий restic командой
 * `restic backup` и извлекает идентификатор снимка. Временный файл дампа
 * удаляется в любом случае.
 *
 * Бесплатно: restic — open-source (BSD-2), репозиторием может быть локальный
 * каталог VPS либо S3-совместимое хранилище (Backblaze B2 free / MinIO).
 *
 * Безопасность: внешние процессы запускаются через {@link spawn} с массивом
 * аргументов (без интерпретации оболочкой) — это исключает инъекцию команд
 * через строку подключения или путь репозитория. Пароль и строка подключения
 * передаются дочерним процессам через переменные окружения, а не в командной
 * строке.
 *
 * Мягкая деградация (Req 21.5): конструктор не бросает исключений даже при
 * отсутствии конфигурации, чтобы граф зависимостей собирался при старте. Если
 * к моменту вызова {@link createDump} репозиторий/пароль restic или строка
 * подключения к БД не заданы, метод бросает понятную ошибку
 * «не сконфигурирован» — {@link import('./backup.service').BackupService}
 * регистрирует сбой с причиной и сохраняет последнюю успешную копию.
 *
 * Отмена (Req 21.8): при срабатывании {@link AbortSignal} (превышение окна в
 * 60 минут) дочерний процесс принудительно завершается, а вызов отклоняется.
 */
@Injectable()
export class ResticBackupAdapter implements ResticBackupPort {
  private readonly logger = new Logger(ResticBackupAdapter.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * Создаёт дамп БД и помещает его в репозиторий restic (Req 21.1, 21.2, 21.6).
   *
   * @param signal Сигнал отмены при превышении предельной длительности (Req 21.8).
   * @returns Контрольная сумма дампа, идентификатор снимка restic и размер.
   * @throws Error если restic/БД не сконфигурированы (мягкая деградация, Req 21.5)
   *   либо если внешний процесс завершился с ошибкой.
   */
  async createDump(signal?: AbortSignal): Promise<DatabaseDumpResult> {
    const { repository, password, tmpDir } = this.config.restic;
    const databaseUrl = this.config.database.url;

    if (repository === '' || password === '') {
      throw new Error(
        'Резервное копирование restic не сконфигурировано: задайте RESTIC_REPOSITORY и RESTIC_PASSWORD.',
      );
    }
    if (databaseUrl === '') {
      throw new Error(
        'Резервное копирование restic не сконфигурировано: отсутствует строка подключения DATABASE_URL.',
      );
    }

    this.throwIfAborted(signal);

    await mkdir(tmpDir, { recursive: true });
    const dumpFile = join(tmpDir, `task-hub-dump-${Date.now()}-${process.pid}.sql`);

    try {
      const { checksum, sizeBytes } = await this.createPgDump(databaseUrl, dumpFile, signal);
      const snapshotId = await this.resticBackup(repository, password, dumpFile, signal);

      this.logger.log(
        `Создан дамп БД (${sizeBytes} байт, sha256=${checksum.slice(0, 12)}…), снимок restic: ${
          snapshotId ?? 'без идентификатора'
        }`,
      );

      return {
        checksum,
        sizeBytes,
        ...(snapshotId !== undefined ? { snapshotId } : {}),
      };
    } finally {
      await unlink(dumpFile).catch(() => undefined);
    }
  }

  /**
   * Выполняет `pg_dump`, потоково записывая результат во временный файл и
   * одновременно вычисляя его SHA-256-сумму и размер (Req 21.1, 21.6).
   */
  private createPgDump(
    databaseUrl: string,
    dumpFile: string,
    signal?: AbortSignal,
  ): Promise<{ checksum: string; sizeBytes: number }> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      let sizeBytes = 0;
      const out = createWriteStream(dumpFile);

      const connectionEnv = this.postgresEnvironment(databaseUrl);
      const child = spawn('pg_dump', ['--no-password', '--format=plain'], {
        env: { ...process.env, ...connectionEnv, PGCONNECT_TIMEOUT: '30' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const detach = this.bindAbort(child, signal, reject);

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        sizeBytes += chunk.length;
        out.write(chunk);
      });
      child.stdout?.on('end', () => out.end());

      child.on('error', (error) => {
        detach();
        out.destroy();
        reject(new Error(`Не удалось запустить pg_dump: ${error.message}`));
      });
      child.on('close', (code) => {
        detach();
        if (code === 0) {
          out.end(() => resolve({ checksum: hash.digest('hex'), sizeBytes }));
        } else {
          out.destroy();
          reject(new Error(`pg_dump завершился с кодом ${code ?? 'null'}: ${stderr.trim()}`));
        }
      });
    });
  }

  /**
   * Переводит DATABASE_URL в переменные libpq, чтобы пароль не попадал в argv
   * дочернего процесса и системные списки процессов.
   */
  private postgresEnvironment(databaseUrl: string): Record<string, string> {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const env: Record<string, string> = {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGDATABASE: database,
    };
    if (url.username !== '') {
      env.PGUSER = decodeURIComponent(url.username);
    }
    if (url.password !== '') {
      env.PGPASSWORD = decodeURIComponent(url.password);
    }
    const sslMode = url.searchParams.get('sslmode');
    if (sslMode !== null && sslMode !== '') {
      env.PGSSLMODE = sslMode;
    }
    return env;
  }

  /**
   * Помещает файл дампа в репозиторий restic командой `restic backup --json` и
   * извлекает идентификатор снимка из итоговой сводки (Req 21.2).
   */
  private resticBackup(
    repository: string,
    password: string,
    dumpFile: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const child = spawn('restic', ['backup', '--json', dumpFile], {
        env: this.resticEnvironment(repository, password),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const detach = this.bindAbort(child, signal, reject);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        detach();
        reject(new Error(`Не удалось запустить restic: ${error.message}`));
      });
      child.on('close', (code) => {
        detach();
        if (code === 0) {
          resolve(this.parseSnapshotId(stdout));
        } else {
          reject(new Error(`restic backup завершился с кодом ${code ?? 'null'}: ${stderr.trim()}`));
        }
      });
    });
  }

  /**
   * Restic для S3-репозиториев читает стандартные AWS_* переменные. Приложение
   * уже имеет S3_* конфигурацию для манифестов, поэтому передаём её в дочерний
   * процесс как fallback, не перетирая явно заданные AWS_* значения.
   */
  private resticEnvironment(repository: string, password: string): NodeJS.ProcessEnv {
    const s3 = (
      this.config as {
        s3?: { accessKeyId?: string; secretAccessKey?: string; region?: string };
      }
    ).s3;
    return {
      ...process.env,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || s3?.accessKeyId || undefined,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || s3?.secretAccessKey || undefined,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || s3?.region || undefined,
      RESTIC_REPOSITORY: repository,
      RESTIC_PASSWORD: password,
    };
  }

  /**
   * Извлекает `snapshot_id` из JSON-вывода `restic backup --json` (строка со
   * сводкой `message_type: "summary"`). Возвращает `undefined`, если разобрать
   * вывод не удалось.
   */
  private parseSnapshotId(jsonOutput: string): string | undefined {
    for (const line of jsonOutput.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as { message_type?: string; snapshot_id?: string };
        if (parsed.message_type === 'summary' && typeof parsed.snapshot_id === 'string') {
          return parsed.snapshot_id;
        }
      } catch {
        // Не-JSON строка вывода — пропускаем.
      }
    }
    return undefined;
  }

  /**
   * Привязывает обработчик отмены к дочернему процессу (Req 21.8): при
   * срабатывании сигнала процесс принудительно завершается, а внешний промис
   * отклоняется. Возвращает функцию снятия подписки.
   */
  private bindAbort(
    child: ReturnType<typeof spawn>,
    signal: AbortSignal | undefined,
    reject: (error: Error) => void,
  ): () => void {
    if (signal === undefined) {
      return () => undefined;
    }

    const onAbort = (): void => {
      child.kill('SIGTERM');
      reject(new Error('Резервное копирование прервано: превышена предельная длительность.'));
    };

    if (signal.aborted) {
      onAbort();
      return () => undefined;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  /** Бросает ошибку, если сигнал уже отменён до запуска внешних процессов. */
  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw new Error('Резервное копирование прервано: превышена предельная длительность.');
    }
  }
}
