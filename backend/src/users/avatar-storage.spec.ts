import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { AppConfigService } from '../config';
import { EntityNotFoundException, ValidationException } from '../common/errors';
import { FileSystemAvatarStorage } from './avatar-storage';
import { UploadedFile } from './profile.types';

/**
 * Unit-тесты {@link FileSystemAvatarStorage} (задача 10.5, 10.6).
 *
 * Проверяют реальную запись байтов вне веб-корня и round-trip чтения, защиту от
 * path traversal, обязательность содержимого файла и вывод MIME-типа из
 * расширения (Req 6.4, 6.5, 19.8). Базовый каталог — временный, что делает
 * тест герметичным.
 */
describe('FileSystemAvatarStorage', () => {
  let baseDir: string;
  let storage: FileSystemAvatarStorage;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'avatar-store-'));
    const config = { storage: { baseDir } } as unknown as AppConfigService;
    storage = new FileSystemAvatarStorage(config);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function makeFile(overrides: Partial<UploadedFile> = {}): UploadedFile {
    return {
      originalName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      buffer: Buffer.from([1, 2, 3, 4]),
      ...overrides,
    };
  }

  async function drain(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  it('записывает байты на диск внутри базового каталога и возвращает относительный путь (Req 6.4, 19.8)', async () => {
    const bytes = Buffer.from('binary-avatar-content');
    const storagePath = await storage.store('user-1', makeFile({ buffer: bytes }));

    expect(isAbsolute(storagePath)).toBe(false);
    expect(storagePath.startsWith('avatars/user-1/')).toBe(true);
    expect(storagePath.endsWith('.png')).toBe(true);

    // Файл реально записан внутри базового каталога вне веб-корня.
    const onDisk = await readFile(join(baseDir, storagePath));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('round-trip: read возвращает ровно сохранённые байты и MIME из расширения (Req 6.4, 19.8)', async () => {
    const bytes = Buffer.from([10, 20, 30, 40, 50]);
    const storagePath = await storage.store('user-2', makeFile({ buffer: bytes }));

    const { stream, contentType } = await storage.read(storagePath);
    const readBack = await drain(stream);

    expect(readBack.equals(bytes)).toBe(true);
    expect(contentType).toBe('image/png');
  });

  it('выводит MIME-тип jpeg для .jpg (Req 6.4)', async () => {
    const storagePath = await storage.store('user-3', makeFile({ originalName: 'me.JPG' }));
    const { contentType } = await storage.read(storagePath);
    expect(contentType).toBe('image/jpeg');
  });

  it('отклоняет файл без содержимого (buffer) (Req 6.9)', async () => {
    const file = makeFile();
    delete (file as { buffer?: Buffer }).buffer;
    await expect(storage.store('user-4', file)).rejects.toBeInstanceOf(ValidationException);
  });

  it('отклоняет чтение по пути с обходом каталога (path traversal) (Req 19.8)', async () => {
    await expect(storage.read('../../etc/passwd')).rejects.toBeInstanceOf(ValidationException);
  });

  it('отклоняет чтение по абсолютному пути (Req 19.8)', async () => {
    await expect(storage.read('/etc/passwd')).rejects.toBeInstanceOf(ValidationException);
  });

  it('возвращает 404 при чтении отсутствующего объекта (Req 2.12)', async () => {
    await expect(storage.read('avatars/user-x/missing.png')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('очищает небезопасный идентификатор владельца от разделителей пути (Req 19.8)', async () => {
    const storagePath = await storage.store('../evil', makeFile());
    // Разделители и точки удалены — запись остаётся внутри avatars/.
    expect(storagePath.startsWith('avatars/evil/')).toBe(true);
    const onDisk = await readFile(join(baseDir, storagePath));
    expect(onDisk.length).toBeGreaterThan(0);
  });
});
