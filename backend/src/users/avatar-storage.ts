import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { AppConfigService } from '../config';
import { EntityNotFoundException, ValidationException } from '../common/errors';
import { UploadedFile } from './profile.types';

/**
 * Токен инъекции порта хранилища аватаров.
 *
 * Использование символа-токена позволяет подменять реализацию хранилища
 * (например, на S3/файловую систему вне веб-корня) без изменения
 * {@link UsersService}/контроллера отдачи и упрощает подмену в тестах.
 */
export const AVATAR_STORAGE = Symbol('AVATAR_STORAGE');

/**
 * Содержимое аватара для контролируемой отдачи (Req 6.4, 19.8).
 *
 * Возвращается портом хранилища при чтении ранее сохранённого аватара: поток
 * исходных байтов вместе с MIME-типом, выведенным из расширения объекта.
 */
export interface AvatarContent {
  /** Поток исходных байтов аватара для потоковой отдачи. */
  stream: Readable;
  /** MIME-тип содержимого (выводится из расширения сохранённого объекта). */
  contentType: string;
}

/**
 * Порт хранилища аватаров (Req 6.4, 6.5, 19.8).
 *
 * Инкапсулирует фактическое сохранение и чтение файла аватара. Валидация
 * формата и размера выполняется в {@link UsersService} до вызова хранилища,
 * поэтому {@link AvatarStorage.store} получает уже проверенный файл и возвращает
 * относительный путь сохранённого объекта для записи в `User.avatarPath`.
 * Чтение ({@link AvatarStorage.read}) используется контроллером контролируемой
 * отдачи (Req 19.8): файлы хранятся вне веб-корня и отдаются только через
 * сервис, а не статической раздачей.
 */
export interface AvatarStorage {
  /**
   * Сохраняет файл аватара и возвращает относительный путь сохранённого объекта.
   * @param userId Идентификатор владельца аватара.
   * @param file Проверенный файл аватара (содержимое в `buffer` обязательно).
   * @returns Относительный путь объекта для `User.avatarPath`.
   */
  store(userId: string, file: UploadedFile): Promise<string>;

  /**
   * Открывает ранее сохранённый аватар для контролируемой отдачи (Req 19.8).
   * @param storagePath Относительный путь объекта (значение `User.avatarPath`).
   * @returns Поток байтов и MIME-тип содержимого.
   */
  read(storagePath: string): Promise<AvatarContent>;
}

/**
 * Сопоставление расширения файла поддерживаемого растрового изображения с
 * MIME-типом (Req 6.4, 6.9). Список соответствует клиентской валидации
 * (`frontend/src/lib/avatar.ts`).
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** MIME-тип по умолчанию для неизвестного расширения (нейтральный поток байтов). */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Имя подкаталога аватаров внутри базового каталога хранения (Req 19.8). */
const AVATARS_SUBDIR = 'avatars';

/**
 * Файловое хранилище аватаров вне веб-корня (Req 6.4, 6.5, 19.8).
 *
 * Реальная запись байтов в файловую систему: аватар сохраняется по пути
 * `avatars/{userId}/{uuid}{ext}` относительно базового каталога хранения
 * (`AppConfigService.storage.baseDir`, env `STORAGE_DIR`). Подкаталог `avatars`
 * переиспользует уже настроенный каталог вложений вне веб-корня (корня статики
 * React), что минимизирует поверхность конфигурации и удовлетворяет требованию
 * контролируемой отдачи (Req 19.8): файлы не лежат в веб-корне и отдаются только
 * через {@link AvatarStorage.read}.
 *
 * Все пути проверяются на выход за пределы базового каталога (защита от path
 * traversal); каталоги создаются рекурсивно. Содержимое аватара (`file.buffer`)
 * обязательно — при его отсутствии операция отклоняется {@link ValidationException}.
 *
 * Сервис инъецируемый и тестируемый: базовый каталог берётся из конфигурации,
 * поэтому в тестах достаточно указать временный каталог.
 */
@Injectable()
export class FileSystemAvatarStorage implements AvatarStorage {
  constructor(private readonly config: AppConfigService) {}

  /** Абсолютный путь базового каталога хранения (вне веб-корня). */
  private get baseDir(): string {
    return this.config.storage.baseDir;
  }

  /**
   * Сохраняет файл аватара на диск и возвращает относительный путь объекта.
   *
   * Записывает `file.buffer` по пути `avatars/{userId}/{uuid}{ext}` внутри
   * базового каталога; родительские каталоги создаются рекурсивно. Возвращает
   * относительный (не абсолютный) путь для записи в `User.avatarPath` —
   * абсолютные пути файловой системы наружу не раскрываются (Req 19.8).
   *
   * @throws ValidationException Если содержимое файла (`buffer`) отсутствует.
   */
  async store(userId: string, file: UploadedFile): Promise<string> {
    if (file.buffer === undefined) {
      throw new ValidationException('Отсутствует содержимое файла аватара.');
    }
    const segment = this.sanitizeSegment(userId);
    const ext = this.extensionOf(file.originalName);
    const storagePath = join(AVATARS_SUBDIR, segment, `${randomUUID()}${ext}`);
    const absolutePath = this.toAbsolute(storagePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.buffer);
    // Возвращается путь, разделённый POSIX-разделителем, для стабильного
    // хранения в БД независимо от платформы.
    return storagePath.split(sep).join('/');
  }

  /**
   * Открывает сохранённый аватар для контролируемой отдачи (Req 19.8).
   *
   * Относительный путь проверяется на выход за пределы базового каталога
   * (защита от path traversal); при отсутствии объекта/его недоступности
   * выбрасывается {@link EntityNotFoundException} (404 без раскрытия деталей).
   */
  async read(storagePath: string): Promise<AvatarContent> {
    const absolutePath = this.toAbsolute(storagePath);
    await this.ensureExists(absolutePath);
    return {
      stream: createReadStream(absolutePath),
      contentType: this.contentTypeOf(storagePath),
    };
  }

  /**
   * Преобразует относительный путь объекта в абсолютный внутри базового каталога,
   * не допуская выхода за его пределы (защита от path traversal).
   * @throws ValidationException При абсолютном пути или попытке выйти за каталог.
   */
  private toAbsolute(storagePath: string): string {
    if (isAbsolute(storagePath)) {
      throw new ValidationException('Недопустимый путь аватара.');
    }
    const base = resolve(this.baseDir);
    const absolutePath = resolve(base, storagePath);
    const rel = relative(base, absolutePath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ValidationException('Недопустимый путь аватара.');
    }
    return absolutePath;
  }

  /** Бросает NOT_FOUND, если объекта нет либо это не обычный файл (Req 2.12). */
  private async ensureExists(absolutePath: string): Promise<void> {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        throw new Error('not a file');
      }
    } catch {
      throw new EntityNotFoundException('Аватар не найден.');
    }
  }

  /** Извлекает расширение из имени файла (включая точку) в нижнем регистре либо ''. */
  private extensionOf(originalName: string): string {
    const dot = originalName.lastIndexOf('.');
    if (dot <= 0 || dot === originalName.length - 1) {
      return '';
    }
    const ext = originalName.slice(dot).toLowerCase();
    // Допускаются только буквенно-цифровые расширения (защита от инъекций пути).
    return /^\.[a-z0-9]+$/.test(ext) ? ext : '';
  }

  /** Выводит MIME-тип содержимого по расширению сохранённого объекта. */
  private contentTypeOf(storagePath: string): string {
    const dot = storagePath.lastIndexOf('.');
    if (dot < 0) {
      return DEFAULT_CONTENT_TYPE;
    }
    const ext = storagePath.slice(dot).toLowerCase();
    return CONTENT_TYPE_BY_EXTENSION[ext] ?? DEFAULT_CONTENT_TYPE;
  }

  /**
   * Оставляет в сегменте пути только безопасные символы и запрещает разделители
   * каталогов (защита от path traversal в идентификаторе пользователя).
   */
  private sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleaned === '') {
      throw new ValidationException('Недопустимый идентификатор владельца аватара.');
    }
    return cleaned;
  }
}
