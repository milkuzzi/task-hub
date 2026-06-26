import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { AppConfigService, configuration } from './config';
import { REDIS_CLIENT } from './infra';
import { StorageService } from './storage';

/**
 * Smoke-тесты конфигурации и безопасности (задача 21.3, Req 1.3, 19.8).
 *
 * Покрывают три аспекта:
 * 1. Конфигурация безопасности по умолчанию: каталог вложений вне веб-корня,
 *    лимиты размера для проверки загрузок (Req 19.8).
 * 2. Контролируемая отдача и хранение вложений строго внутри базового каталога,
 *    защита от выхода за его пределы (Req 19.8).
 * 3. Базовый запуск приложения: граф зависимостей всех модулей собирается без
 *    ошибок (внешние подключения Redis/Postgres подменяются/не инициируются).
 *
 * Внешние границы (Redis) подменяются, чтобы тесты выполнялись без живой
 * инфраструктуры. Подключение к PostgreSQL и фоновые воркеры BullMQ
 * устанавливаются только в lifecycle-хуках `onModuleInit`, которые при сборке
 * тестового модуля (`compile()` без `init()`) не вызываются.
 */
describe('Smoke: конфигурация и безопасность (Req 1.3, 19.8)', () => {
  describe('Конфигурация хранилища и лимитов загрузки (Req 19.8)', () => {
    const ORIGINAL_STORAGE_DIR = process.env.STORAGE_DIR;

    afterEach(() => {
      if (ORIGINAL_STORAGE_DIR === undefined) {
        delete process.env.STORAGE_DIR;
      } else {
        process.env.STORAGE_DIR = ORIGINAL_STORAGE_DIR;
      }
    });

    it('по умолчанию хранит вложения в абсолютном каталоге вне веб-корня', () => {
      delete process.env.STORAGE_DIR;

      const { storage } = configuration();

      // Путь абсолютный (вне веб-корня статики React/Nginx), Req 19.8.
      expect(isAbsolute(storage.baseDir)).toBe(true);
      // Каталог — выделенный var/attachments, не каталог раздаваемой статики.
      expect(storage.baseDir.endsWith(join('var', 'attachments'))).toBe(true);
      // Каталог не находится внутри клиентской статики (frontend / public / dist).
      const segments = storage.baseDir.split(sep);
      expect(segments).not.toContain('frontend');
      expect(segments).not.toContain('public');
      expect(segments).not.toContain('dist');
    });

    it('применяет настраиваемый каталог хранения из STORAGE_DIR', () => {
      process.env.STORAGE_DIR = join(tmpdir(), 'attachments-smoke');

      const { storage } = configuration();

      expect(storage.baseDir).toBe(resolve(process.env.STORAGE_DIR));
    });

    it('задаёт лимиты размера для проверки загрузок (Req 19.8, 19.9)', () => {
      const { limits } = configuration();

      // 25 МБ для вложений и 5 МБ для аватаров — границы проверки размера.
      expect(limits.attachmentMaxBytes).toBe(25 * 1024 * 1024);
      expect(limits.avatarMaxBytes).toBe(5 * 1024 * 1024);
      expect(limits.maxAttachmentsPerMessage).toBe(10);
    });
  });

  describe('Контролируемая отдача и хранение вложений (Req 19.8)', () => {
    let baseDir: string;
    let storage: StorageService;

    /** Заглушка конфигурации: сервис использует только storage.baseDir. */
    const configFor = (dir: string): AppConfigService =>
      ({ storage: { baseDir: dir } }) as unknown as AppConfigService;

    beforeEach(async () => {
      baseDir = await mkdtemp(join(tmpdir(), 'attachments-smoke-'));
      storage = new StorageService(configFor(baseDir));
    });

    afterEach(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('физически сохраняет файл строго внутри базового каталога вне веб-корня', async () => {
      const original = Buffer.from('содержимое вложения для smoke-теста', 'utf8');

      const stored = await storage.store(original, { keyPrefix: 'task-7', extension: '.txt' });

      // Относительный путь не выходит за пределы базового каталога.
      expect(isAbsolute(stored.storagePath)).toBe(false);
      const absolute = resolve(baseDir, stored.storagePath);
      expect(absolute.startsWith(resolve(baseDir) + sep)).toBe(true);
      // Файл действительно создан на диске внутри базового каталога.
      await expect(stat(absolute)).resolves.toBeDefined();
    });

    it('отдаёт содержимое только через контролируемые методы сервиса', async () => {
      const original = Buffer.from('контролируемая отдача'.repeat(50), 'utf8');
      const stored = await storage.store(original);

      // Контролируемая отдача: распаковка без потерь через метод сервиса.
      const restored = await storage.readDecompressed(stored.storagePath);
      expect(restored.equals(original)).toBe(true);

      // Сжатый поток также доступен только через сервис.
      const stream = await storage.openCompressedStream(stored.storagePath);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    });

    it('запрещает доступ к путям вне базового каталога (path traversal)', async () => {
      await expect(storage.readDecompressed('../escape.zst')).rejects.toBeDefined();
      await expect(storage.openCompressedStream('../../etc/passwd')).rejects.toBeDefined();
    });
  });

  describe('Базовый запуск приложения (bootstrap)', () => {
    it('собирает граф зависимостей всех модулей без живой инфраструктуры', async () => {
      // Заглушка общего клиента Redis: предотвращает реальное TCP-подключение,
      // создаваемое фабрикой провайдера при инстанцировании.
      const fakeRedis = { quit: jest.fn().mockResolvedValue('OK') };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(REDIS_CLIENT)
        .useValue(fakeRedis)
        .compile();

      try {
        // Ключевые провайдеры разрешаются из контейнера — граф собран корректно.
        expect(moduleRef.get(AppConfigService)).toBeInstanceOf(AppConfigService);
        expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);

        const appService = moduleRef.get(AppService);
        expect(appService.health()).toEqual({
          status: 'ok',
          service: 'task-assignment-system',
        });
      } finally {
        await moduleRef.close();
      }
    });
  });
});
