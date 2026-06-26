import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('node:child_process');
import { spawn } from 'node:child_process';
import { AppConfigService } from '../config';
import { ResticBackupAdapter } from './restic-backup.adapter';

const spawnMock = spawn as unknown as jest.Mock;

/**
 * Поддельный дочерний процесс: эмиттер событий с потоками stdout/stderr и
 * заглушкой {@link kill}, позволяющий тесту управлять поведением `pg_dump`/`restic`
 * без реального запуска внешних процессов.
 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('ResticBackupAdapter', () => {
  let tmpDir: string;

  const configFor = (overrides?: {
    repository?: string;
    password?: string;
    databaseUrl?: string;
  }): AppConfigService =>
    ({
      restic: {
        repository: overrides?.repository ?? 'repo',
        password: overrides?.password ?? 'pw',
        tmpDir,
      },
      database: { url: overrides?.databaseUrl ?? 'postgresql://u:p@localhost:5432/db' },
    }) as unknown as AppConfigService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'restic-spec-'));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('создаёт дамп и возвращает контрольную сумму, снимок и размер (успех)', async () => {
    const part1 = Buffer.from('dump-part-1');
    const part2 = Buffer.from('dump-part-2');
    const expectedChecksum = createHash('sha256').update(part1).update(part2).digest('hex');

    spawnMock.mockImplementation((command: string) => {
      const child = makeChild();
      if (command === 'pg_dump') {
        queueMicrotask(() => {
          child.stdout.emit('data', part1);
          child.stdout.emit('data', part2);
          child.stdout.emit('end');
          child.emit('close', 0);
        });
      } else {
        queueMicrotask(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ message_type: 'summary', snapshot_id: 'snap-123' })}\n`,
            ),
          );
          child.emit('close', 0);
        });
      }
      return child;
    });

    const adapter = new ResticBackupAdapter(configFor());
    const result = await adapter.createDump();

    expect(result.checksum).toBe(expectedChecksum);
    expect(result.snapshotId).toBe('snap-123');
    expect(result.sizeBytes).toBe(part1.length + part2.length);

    // Учетные данные подключения не попадают в argv процесса.
    expect(spawnMock).toHaveBeenCalledWith(
      'pg_dump',
      ['--no-password', '--format=plain'],
      expect.objectContaining({
        env: expect.objectContaining({
          PGHOST: 'localhost',
          PGPORT: '5432',
          PGDATABASE: 'db',
          PGUSER: 'u',
          PGPASSWORD: 'p',
        }),
      }),
    );
    const pgDumpArgs = spawnMock.mock.calls.find(([command]) => command === 'pg_dump')?.[1];
    expect(JSON.stringify(pgDumpArgs)).not.toContain('postgresql://');
    expect(JSON.stringify(pgDumpArgs)).not.toContain(':p@');
    expect(spawnMock).toHaveBeenCalledWith(
      'restic',
      ['backup', '--json', expect.any(String)],
      expect.anything(),
    );
  });

  it('бросает понятную ошибку «не сконфигурировано» при отсутствии репозитория (мягкая деградация)', async () => {
    const adapter = new ResticBackupAdapter(configFor({ repository: '' }));

    await expect(adapter.createDump()).rejects.toThrow(/не сконфигурировано/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('прерывает выполнение и завершает дочерний процесс при отмене (Req 21.8)', async () => {
    const controller = new AbortController();
    let pgChild: FakeChild | undefined;

    spawnMock.mockImplementation((command: string) => {
      const child = makeChild();
      if (command === 'pg_dump') {
        pgChild = child;
        // Имитируем превышение окна: сигнал отменяется до завершения процесса.
        queueMicrotask(() => controller.abort());
      }
      return child;
    });

    const adapter = new ResticBackupAdapter(configFor());

    await expect(adapter.createDump(controller.signal)).rejects.toThrow(/прервано/i);
    expect(pgChild?.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
