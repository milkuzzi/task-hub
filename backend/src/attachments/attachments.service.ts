import { Inject, Injectable, Logger } from '@nestjs/common';
import { AssignmentKind, Attachment, Role, User } from '@prisma/client';
import { AppConfigService } from '../config';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import {
  AttachmentRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StorageService, StoredObject, StoreOptions } from '../storage';
import { hasAdminPrivileges } from '../users/permissions';
import {
  AttachmentRepresentation,
  genericIconType,
  selectAttachmentRepresentation,
} from './attachment-representation';
import { DocumentPreviewService } from './document-preview.service';
import {
  CompressedStream,
  DocumentPreview,
  ThumbnailResult,
  UploadFile,
  UploadedAttachment,
} from './attachments.types';
import { THUMBNAIL_GENERATOR, ThumbnailGenerator } from './thumbnail-generator';

/**
 * Эффективная роль Участника в контексте Задачи (Req 2.4, 11.2).
 * Совпадает по смыслу с ролью отправителя в {@link ChatService}.
 */
type Participant = 'ADMIN' | 'MANAGER' | 'EXECUTOR';

const UNKNOWN_MIME_TYPE = 'application/octet-stream';

const AUDIO_MIME_BY_EXTENSION = new Map<string, string>([
  ['3gp', 'audio/3gpp'],
  ['3gpp', 'audio/3gpp'],
  ['aac', 'audio/aac'],
  ['amr', 'audio/amr'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['mpga', 'audio/mpeg'],
  ['oga', 'audio/ogg'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['wave', 'audio/wav'],
  ['weba', 'audio/webm'],
  ['webm', 'audio/webm'],
]);

/**
 * Прикладной сервис загрузки Вложений в Чат Задачи (Req 11.9, 12.1–12.5, 19.8,
 * 19.9).
 *
 * Реализует {@link upload} — приём файла любого типа в контексте конкретного
 * Сообщения с контролем целостности и лимитов:
 *
 * - **Любые типы файлов** разрешены (Req 12.1, 12.5); MIME-тип сохраняется как
 *   метаданное и не служит основанием для отказа.
 * - **Единый лимит размера 25 МБ** (Req 12.2, 12.3): превышение отклоняется
 *   {@link ValidationException}, при этом файл не сохраняется. Проверяется как
 *   заявленный размер (до чтения), так и фактический размер исходного
 *   содержимого после сохранения.
 * - **Не более 10 Вложений на Сообщение** (Req 11.9): при достижении лимита
 *   загрузка отклоняется без сохранения.
 * - **Хранение вне веб-корня и сжатие** через {@link StorageService}
 *   (Req 19.8, 12.8) с контрольной суммой исходного содержимого.
 * - **Отказ без частичного файла** при прерывании передачи (Req 12.4, 19.9):
 *   {@link StorageService.store} удаляет временный файл при ошибке, а запись
 *   Вложения создаётся только после успешного сохранения, поэтому осиротевших
 *   записей или частичных файлов не остаётся.
 * - **Доступ только Участникам чата** (Исполнитель/Менеджер Задачи или
 *   Администратор, Req 12.1, 11.2): недоступная Задача/Сообщение не
 *   раскрывается (Req 2.12).
 *
 * Формирование миниатюр и обобщённых значков (Req 12.6, 12.7) реализовано
 * методами {@link generateThumbnail} и {@link representationFor}: для
 * изображений в пределах лимита формируется миниатюра, для прочих типов
 * выбирается обобщённый значок. Контролируемая отдача сжатого содержимого для
 * полноэкранного просмотра выполняется методом {@link openCompressed}
 * (Req 12.8, 12.9).
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly attachmentRepository: AttachmentRepository,
    private readonly taskRepository: TaskRepository,
    private readonly userRepository: UserRepository,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    @Inject(THUMBNAIL_GENERATOR)
    private readonly thumbnailGenerator: ThumbnailGenerator,
    private readonly documentPreviewService: DocumentPreviewService = new DocumentPreviewService(),
  ) {}

  /**
   * Загружает «висящее» (непривязанное) Вложение в Чат Задачи до отправки
   * Сообщения (Req 11.9, 12.1–12.5, 19.8, 19.9).
   *
   * Фронтенд загружает Вложения отдельным вызовом ДО отправки Сообщения
   * (`POST /tasks/:id/attachments` предшествует `POST /tasks/:id/messages`).
   * Вложение создаётся без привязки к Сообщению (`messageId = null`) с прямыми
   * полями `taskId` и `uploaderId`, по которым проверяются членство и право на
   * последующую привязку (Req 11.2, 12.1); привязка к реальному Сообщению
   * выполняется при отправке в {@link ChatService.sendMessage}. До привязки
   * Вложение не отображается в разделе «Вложения».
   *
   * Порядок (любой отказ происходит ДО сохранения содержимого, поэтому при
   * отказе ничего не сохраняется, Req 12.3, 12.4):
   * 1. валидация метаданных файла (имя/тип присутствуют); тип не ограничивается
   *    (Req 12.5);
   * 2. учётная запись загружающего активна, иначе отказ в доступе;
   * 3. Задача существует и загружающий — Участник её чата (Исполнитель/Менеджер
   *    Задачи или Администратор); недоступная Задача не раскрывается
   *    (Req 11.2, 12.1, 2.12);
   * 4. контроль размера: заявленный размер > 25 МБ отклоняется немедленно
   *    (Req 12.2, 12.3);
   * 5. потоковое сохранение в хранилище (вне веб-корня, сжатие, контрольная
   *    сумма, Req 19.8, 12.8); при прерывании передачи частичный файл не
   *    остаётся (Req 12.4, 19.9), а запись не создаётся;
   * 6. контроль фактического размера исходного содержимого: при превышении
   *    лимита сохранённый объект удаляется, запись не создаётся (Req 12.3);
   * 7. создание «висящего» Вложения с метаданными;
   * 8. формирование миниатюры для изображений (Req 12.6), best-effort.
   *
   * Лимит «не более 10 Вложений на Сообщение» (Req 11.9) проверяется в точке
   * фактической привязки — {@link ChatService.sendMessage}, — поэтому здесь не
   * применяется.
   *
   * @param userId Идентификатор загружающего Участника чата.
   * @param taskId Идентификатор Задачи, в Чат которой загружается Вложение.
   * @param file Загружаемый файл (любого типа).
   * @returns Созданная запись Вложения и момент её загрузки.
   * @throws ValidationException Некорректные метаданные, превышение размера или
   *   прерывание передачи (Req 12.3, 12.4, 19.9).
   * @throws AccessDeniedException Учётная запись загружающего не найдена/удалена.
   * @throws EntityNotFoundException Задача не найдена либо загружающий не
   *   Участник чата (Req 11.2, 2.12).
   */
  async uploadToTask(
    userId: string,
    taskId: string,
    file: UploadFile,
  ): Promise<UploadedAttachment> {
    // 1. Валидация метаданных ДО любого обращения к хранилищу.
    this.validateFileMeta(file);
    const mimeType = this.resolveMimeType(file);

    // 2. Активность загружающего.
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new AccessDeniedException('Учётная запись пользователя не найдена или удалена.');
    }

    // 3. Принадлежность к Участникам чата: недоступная Задача не раскрывается (Req 11.2, 2.12).
    const task = await this.loadParticipantTaskByTaskId(user, taskId);

    // 4. Контроль размера по заявленному значению — отказ до чтения (Req 12.2, 12.3).
    const maxBytes = this.config.limits.attachmentMaxBytes;
    if (file.declaredSize !== undefined && file.declaredSize > maxBytes) {
      throw this.oversizeError(maxBytes);
    }

    // 5. Сохранение содержимого вне веб-корня со сжатием и контрольной суммой (Req 19.8, 12.8).
    //    При прерывании передачи временный файл удаляется хранилищем (Req 12.4, 19.9).
    let stored: StoredObject;
    try {
      const extension = this.extractExtension(file.originalName);
      const storeOptions: StoreOptions =
        extension === undefined ? { keyPrefix: task.id } : { keyPrefix: task.id, extension };
      stored = await this.storage.store(file.content, storeOptions);
    } catch (error) {
      throw new ValidationException(
        'Загрузка файла не выполнена: передача прервана, файл не сохранён.',
        { cause: (error as Error).message },
      );
    }

    // 6. Контроль фактического размера: при превышении удаляем объект, запись не создаём (Req 12.3).
    if (stored.originalSize > maxBytes) {
      await this.storage.delete(stored.storagePath);
      throw this.oversizeError(maxBytes);
    }

    // 7. Создание «висящего» (непривязанного) Вложения только после успешного
    //    сохранения (Req 12.4, 19.9): `messageId = null`, заполнены `taskId` и
    //    `uploaderId` для проверки членства и права на привязку (Req 11.2, 12.1).
    const created = await this.attachmentRepository.create({
      task: { connect: { id: task.id } },
      uploader: { connect: { id: user.id } },
      originalName: file.originalName,
      mimeType,
      sizeBytes: BigInt(stored.originalSize),
      storagePath: stored.storagePath,
      compression: stored.codec,
      checksum: stored.checksum,
    });

    // 8. Для изображений в пределах лимита формируем миниатюру (Req 12.6).
    //    Дефект 2: генерация выполняется best-effort с явным логированием и
    //    однократным повтором при сбое — без «тихого» проглатывания. Сбой
    //    генерации не срывает загрузку: раздел «Вложения» деградирует к
    //    обобщённому значку (Req 12.7).
    await this.generateThumbnailBestEffort(created.id);

    // Перечитываем запись, чтобы вернуть актуальный `thumbnailPath` (Req 12.6).
    const fresh = (await this.attachmentRepository.findById(created.id)) ?? created;

    this.logger.log(
      `Вложение «${fresh.id}» загружено в задачу «${task.id}» пользователем «${userId}»; ` +
        `размер=${stored.originalSize}Б, сжатый=${stored.compressedSize}Б, кодек=${stored.codec}; ` +
        'ожидает привязки к сообщению.',
    );
    return { attachment: fresh, createdAt: fresh.createdAt };
  }

  /**
   * Открывает представление Вложения для отдачи миниатюры (Req 12.6, 12.7,
   * 19.8).
   *
   * Для изображения с сформированной миниатюрой отдаётся распакованное
   * содержимое миниатюры, готовое к показу в `<img>` (миниатюра хранится сжатой
   * вне веб-корня, Req 19.8). Для изображения без сохранённой миниатюры, но в
   * пределах лимита, в качестве запасного представления отдаётся распакованное
   * исходное изображение. Для прочих типов миниатюры нет — возвращается
   * обобщённый значок по типу файла, который клиент отображает самостоятельно
   * (Req 12.7).
   *
   * Доступ предоставляется только Участникам чата Задачи (Req 11.2, 12.1);
   * недоступное Вложение/Сообщение/Задача не раскрывается (Req 2.12).
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param attachmentId Идентификатор Вложения.
   * @returns Распакованное изображение-миниатюра либо обобщённый значок.
   * @throws AccessDeniedException Учётная запись запрашивающего не найдена/удалена.
   * @throws EntityNotFoundException Вложение/Сообщение/Задача не найдены либо
   *   запрашивающий не Участник чата (Req 11.2, 2.12).
   */
  async openThumbnail(userId: string, attachmentId: string): Promise<ThumbnailResult> {
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new AccessDeniedException('Учётная запись пользователя не найдена или удалена.');
    }

    const attachment = await this.attachmentRepository.findById(attachmentId);
    if (attachment === null) {
      throw new EntityNotFoundException('Вложение не найдено или недоступно.');
    }

    // Принадлежность к Участникам чата Задачи Вложения (Req 11.2, 12.1, 2.12).
    await this.loadParticipantTaskForAttachment(user, attachment);

    if (attachment.thumbnailPath !== null) {
      const content = await this.storage.readDecompressed(attachment.thumbnailPath);
      return { kind: 'image', content, mimeType: attachment.mimeType };
    }

    // Запасной путь: изображение в пределах лимита без сохранённой миниатюры —
    // отдаём распакованный оригинал (Req 12.6).
    const representation = this.representationFor(attachment);
    if (representation.kind === 'thumbnail') {
      const content = await this.storage.readDecompressed(attachment.storagePath);
      return { kind: 'image', content, mimeType: attachment.mimeType };
    }

    // Не изображение — миниатюры нет; клиент показывает обобщённый значок (Req 12.7).
    return { kind: 'icon', icon: genericIconType(attachment.mimeType) };
  }

  /**
   * Формирует и сохраняет миниатюру Вложения-изображения (Req 12.6).
   *
   * Применяется к изображениям с поддержкой превью, размер исходного содержимого
   * которых не превышает единый лимит (25 МБ). Для прочих типов или превышающих
   * лимит файлов миниатюра не формируется — для них используется обобщённый
   * значок (Req 12.7), и метод завершается без изменений (идемпотентно).
   *
   * Порядок:
   * 1. поиск Вложения по идентификатору; отсутствие — {@link EntityNotFoundException};
   * 2. выбор представления по типу/размеру (чистый селектор): если не миниатюра —
   *    выход без изменений (используется обобщённый значок, Req 12.7);
   * 3. чтение распакованного исходного содержимого из хранилища (Req 12.8);
   * 4. генерация байтов миниатюры портом {@link ThumbnailGenerator} (Req 12.6) —
   *    тяжёлая обработка изображений скрыта за портом, что делает метод
   *    тестируемым без нативных зависимостей;
   * 5. сохранение миниатюры в хранилище (вне веб-корня, со сжатием, Req 19.8) и
   *    запись `Attachment.thumbnailPath`.
   *
   * @param attachmentId Идентификатор Вложения.
   * @throws EntityNotFoundException Вложение не найдено.
   */
  async generateThumbnail(attachmentId: string): Promise<void> {
    const attachment = await this.attachmentRepository.findById(attachmentId);
    if (attachment === null) {
      throw new EntityNotFoundException('Вложение не найдено.');
    }

    // Решение о представлении — чистая, разрешимая функция (Req 12.6, 12.7).
    const representation = this.representationFor(attachment);
    if (representation.kind !== 'thumbnail') {
      // Не изображение или превышение лимита: используется обобщённый значок (Req 12.7).
      return;
    }

    // Исходное содержимое распаковывается без потерь для генерации миниатюры (Req 12.8).
    const original = await this.storage.readDecompressed(attachment.storagePath);

    // Генерация делегируется порту; реализация по умолчанию не требует нативных библиотек.
    const thumbnailBytes = await this.thumbnailGenerator.generate({
      mimeType: attachment.mimeType,
      content: original,
    });

    // Миниатюра хранится рядом с оригиналом — вне веб-корня, со сжатием (Req 19.8).
    const keyPrefix = this.storagePrefixOf(attachment.storagePath);
    const storeOptions: StoreOptions =
      keyPrefix === undefined ? { extension: 'thumb' } : { keyPrefix, extension: 'thumb' };
    const stored = await this.storage.store(thumbnailBytes, storeOptions);

    await this.attachmentRepository.setThumbnailPath(attachment.id, stored.storagePath);
    this.logger.log(
      `Сформирована миниатюра вложения «${attachment.id}» (${attachment.mimeType}); ` +
        `путь=${stored.storagePath}.`,
    );
  }

  /**
   * Формирует миниатюру Вложения в режиме best-effort с явным логированием и
   * однократным повтором при сбое (Req 12.6, 12.7).
   *
   * Дефект 2: ранее сбой генерации проглатывался «тихо» — теперь каждая неудача
   * логируется явно (с деталями ошибки), а генерация повторяется один раз перед
   * деградацией к обобщённому значку. Метод никогда не бросает: формирование
   * миниатюры не является критичным для уже сохранённого Вложения, поэтому его
   * сбой не должен срывать загрузку (Req 12.7). Для не-изображений и файлов
   * сверх лимита {@link generateThumbnail} завершается без работы — повтор в
   * этом случае не выполняется (поведение ¬C не меняется).
   *
   * @param attachmentId Идентификатор Вложения.
   */
  private async generateThumbnailBestEffort(attachmentId: string): Promise<void> {
    const maxAttempts = 2; // первичная попытка + один повтор.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.generateThumbnail(attachmentId);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          this.logger.warn(
            `Сбой формирования миниатюры вложения «${attachmentId}» ` +
              `(попытка ${attempt}/${maxAttempts}): ${reason}. Повторяю.`,
          );
          continue;
        }
        this.logger.error(
          `Не удалось сформировать миниатюру вложения «${attachmentId}» после ` +
            `${maxAttempts} попыток: ${reason}. Будет использован обобщённый значок.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Возвращает представление Вложения в списке (Req 12.6, 12.7): миниатюра для
   * изображений в пределах лимита либо обобщённый значок по типу файла для
   * прочих. Тонкая обёртка над чистым селектором
   * {@link selectAttachmentRepresentation} с единым лимитом размера из
   * конфигурации.
   *
   * @param attachment Вложение (используются `mimeType` и `sizeBytes`).
   * @returns Решение о представлении Вложения.
   */
  representationFor(
    attachment: Pick<Attachment, 'mimeType' | 'sizeBytes'>,
  ): AttachmentRepresentation {
    return selectAttachmentRepresentation(
      { mimeType: attachment.mimeType, sizeBytes: Number(attachment.sizeBytes) },
      this.config.limits.attachmentMaxBytes,
    );
  }

  /**
   * Открывает сжатый поток Вложения для полноэкранного просмотра по миниатюре
   * (Req 12.9, 12.8, 19.8).
   *
   * Сервер отдаёт сжатые байты сохранённого объекта, а распаковка без потерь
   * выполняется на стороне клиента (Req 12.9). Доступ предоставляется только
   * Участникам чата Задачи (Исполнитель/Менеджер Задачи или Администратор,
   * Req 11.2, 12.1); недоступное Вложение/Сообщение/Задача не раскрывается
   * (Req 2.12).
   *
   * @param userId Идентификатор запрашивающего Участника чата.
   * @param attachmentId Идентификатор Вложения.
   * @returns Сжатый поток с метаданными для отдачи клиенту.
   * @throws AccessDeniedException Учётная запись запрашивающего не найдена/удалена.
   * @throws EntityNotFoundException Вложение/Сообщение/Задача не найдены либо
   *   запрашивающий не Участник чата (Req 11.2, 2.12).
   */
  async openCompressed(userId: string, attachmentId: string): Promise<CompressedStream> {
    // Активность запрашивающего.
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new AccessDeniedException('Учётная запись пользователя не найдена или удалена.');
    }

    const attachment = await this.attachmentRepository.findById(attachmentId);
    if (attachment === null) {
      // Недоступное Вложение не раскрывается (Req 2.12).
      throw new EntityNotFoundException('Вложение не найдено или недоступно.');
    }

    // Принадлежность к Участникам чата Задачи Вложения (Req 11.2, 12.1, 2.12).
    await this.loadParticipantTaskForAttachment(user, attachment);

    const stream = await this.storage.openCompressedStream(attachment.storagePath);
    return {
      stream,
      mimeType: attachment.mimeType,
      originalName: attachment.originalName,
      compression: attachment.compression,
      sizeBytes: Number(attachment.sizeBytes),
      checksum: attachment.checksum,
    };
  }

  /**
   * Открывает PDF-предпросмотр офисного Вложения.
   *
   * Доступ проверяется теми же правилами, что и для исходного содержимого:
   * только Участник чата Задачи или Администратор получает рендер. Сервер
   * читает распакованный оригинал из защищённого хранилища и конвертирует его в
   * PDF через LibreOffice, чтобы сохранить реальное форматирование документа.
   */
  async openDocumentPreview(userId: string, attachmentId: string): Promise<DocumentPreview> {
    const user = await this.userRepository.findActiveById(userId);
    if (user === null) {
      throw new AccessDeniedException('Учётная запись пользователя не найдена или удалена.');
    }

    const attachment = await this.attachmentRepository.findById(attachmentId);
    if (attachment === null) {
      throw new EntityNotFoundException('Вложение не найдено или недоступно.');
    }

    await this.loadParticipantTaskForAttachment(user, attachment);

    if (!this.documentPreviewService.supports(attachment.mimeType, attachment.originalName)) {
      throw new EntityNotFoundException('Предпросмотр недоступен для этого типа вложения.');
    }

    const original = await this.storage.readDecompressed(attachment.storagePath);
    const preview = await this.documentPreviewService.convertToPdf({
      content: original,
      mimeType: attachment.mimeType,
      originalName: attachment.originalName,
    });
    return {
      content: preview.content,
      mimeType: preview.mimeType,
      fileName: this.previewFileName(attachment.originalName),
    };
  }

  /**
   * Валидирует метаданные загружаемого файла. Тип файла не ограничивается
   * (Req 12.5); проверяется лишь наличие непустого имени. MIME-тип может быть
   * пустым у браузеров/ОС для части аудиофайлов и нормализуется отдельно.
   *
   * @throws ValidationException Имя отсутствует/пустое.
   */
  private validateFileMeta(file: UploadFile): void {
    if (typeof file.originalName !== 'string' || file.originalName.trim().length === 0) {
      throw new ValidationException('Имя файла обязательно.');
    }
    if (
      file.declaredSize !== undefined &&
      (!Number.isFinite(file.declaredSize) || file.declaredSize < 0)
    ) {
      throw new ValidationException('Некорректный размер файла.');
    }
  }

  /** Формирует единообразную ошибку превышения лимита размера (Req 12.3). */
  private oversizeError(maxBytes: number): ValidationException {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return new ValidationException(
      `Размер файла превышает допустимый предел ${maxMb} МБ. Вложение не сохранено.`,
    );
  }

  /**
   * Возвращает MIME-тип для хранения. Клиентские загрузки не всегда передают
   * тип для аудио (`File.type === ""`) или отправляют `application/octet-stream`;
   * в этих случаях восстанавливаем тип по расширению, чтобы браузерный
   * `<audio>` получал корректный Blob.
   */
  private resolveMimeType(file: UploadFile): string {
    const declared = typeof file.mimeType === 'string' ? this.normalizeMimeType(file.mimeType) : '';
    const inferred = this.inferMimeTypeByExtension(file.originalName);
    if (declared.length === 0 || declared === UNKNOWN_MIME_TYPE) {
      return inferred ?? UNKNOWN_MIME_TYPE;
    }
    return declared;
  }

  private inferMimeTypeByExtension(originalName: string): string | undefined {
    const extension = this.extractExtension(originalName)?.toLowerCase();
    if (extension === undefined) {
      return undefined;
    }
    return AUDIO_MIME_BY_EXTENSION.get(extension);
  }

  private normalizeMimeType(mimeType: string): string {
    const semicolon = mimeType.indexOf(';');
    const base = semicolon === -1 ? mimeType : mimeType.slice(0, semicolon);
    return base.trim().toLowerCase();
  }

  /**
   * Загружает Задачу Вложения, проверяя, что Пользователь — Участник её чата
   * (Исполнитель/Менеджер Задачи или Администратор) (Req 11.2, 12.1).
   * Недоступная Задача не раскрывается (Req 2.12).
   *
   * Принадлежность определяется по прямому полю `Attachment.taskId`, поэтому
   * проверка работает как для привязанных, так и для «висящих» (ещё не
   * привязанных к Сообщению) Вложений.
   *
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не
   *   Участник её чата.
   */
  private async loadParticipantTaskForAttachment(
    user: User,
    attachment: Attachment,
  ): Promise<TaskWithAssignments> {
    const task = await this.taskRepository.findByIdWithAssignments(attachment.taskId);
    const participant = task === null ? null : this.resolveParticipant(user.role, user.id, task);
    if (task === null || participant === null) {
      throw new EntityNotFoundException('Вложение не найдено или недоступно.');
    }
    return task;
  }

  /**
   * Загружает Задачу по её идентификатору, проверяя, что Пользователь —
   * Участник её чата (Исполнитель/Менеджер Задачи или Администратор) (Req 11.2,
   * 12.1). Недоступная Задача не раскрывается (Req 2.12).
   *
   * @throws EntityNotFoundException Задача не найдена либо Пользователь не Участник чата.
   */
  private async loadParticipantTaskByTaskId(
    user: User,
    taskId: string,
  ): Promise<TaskWithAssignments> {
    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const participant = task === null ? null : this.resolveParticipant(user.role, user.id, task);
    if (task === null || participant === null) {
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    return task;
  }

  /**
   * Определяет эффективную роль Пользователя в контексте Задачи либо `null`,
   * если он не Участник чата (Req 2.4, 11.2).
   *
   * Администратор всегда Участник. Для остальных роль определяется видом
   * назначения: назначение Исполнителем даёт роль Исполнителя (в т.ч. для
   * Менеджера, назначенного Исполнителем, Req 2.4); назначение только Менеджером
   * — роль Менеджера. Отсутствие назначения у не-Администратора означает, что
   * Пользователь не Участник чата.
   */
  private resolveParticipant(
    role: Role,
    userId: string,
    task: TaskWithAssignments,
  ): Participant | null {
    if (hasAdminPrivileges(role)) {
      return 'ADMIN';
    }
    const own = task.assignments.filter((a) => a.userId === userId);
    if (own.some((a) => a.kind === AssignmentKind.EXECUTOR)) {
      return 'EXECUTOR';
    }
    if (own.some((a) => a.kind === AssignmentKind.MANAGER)) {
      return 'MANAGER';
    }
    return null;
  }

  /**
   * Извлекает расширение из исходного имени файла (без точки) для включения в
   * имя объекта хранилища. Хранилище дополнительно очищает значение от
   * небезопасных символов.
   */
  private extractExtension(originalName: string): string | undefined {
    const dot = originalName.lastIndexOf('.');
    if (dot <= 0 || dot === originalName.length - 1) {
      return undefined;
    }
    return originalName.slice(dot + 1);
  }

  /** Формирует безопасное имя PDF-предпросмотра из исходного имени Вложения. */
  private previewFileName(originalName: string): string {
    const trimmed = originalName.trim();
    const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const baseName = slash === -1 ? trimmed : trimmed.slice(slash + 1);
    const dot = baseName.lastIndexOf('.');
    const withoutExtension = dot <= 0 ? baseName : baseName.slice(0, dot);
    return `${withoutExtension || 'preview'}.pdf`;
  }

  /**
   * Извлекает первый сегмент относительного пути хранилища (например, `taskId`)
   * для размещения миниатюры рядом с оригиналом. Возвращает `undefined`, если
   * путь не содержит каталога-префикса.
   */
  private storagePrefixOf(storagePath: string): string | undefined {
    const slash = storagePath.indexOf('/');
    if (slash <= 0) {
      return undefined;
    }
    return storagePath.slice(0, slash);
  }
}
