import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatService } from '../chat';
import { AttachmentMetaView, toAttachmentMeta } from '../chat';
import { RateLimit, RateLimitGuard } from '../security';
import { AttachmentsService } from './attachments.service';
import { UploadFile } from './attachments.types';

/**
 * Единый лимит размера загружаемого Вложения — 25 МБ (Req 12.2, 12.3).
 *
 * Задаётся на интерсепторе загрузки (быстрый отказ до буферизации тела) и
 * дополнительно перепроверяется {@link AttachmentsService} по значению из
 * конфигурации — источника истины (двойной контроль, Req 12.3).
 */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Минимально необходимое представление загруженного файла из multer
 * (`memoryStorage`), используемое контроллером (Req 12.1–12.5).
 *
 * Описано локально, чтобы не зависеть от внешних типов multer: содержимое
 * приходит буфером в памяти, метаданные — из формы.
 */
interface UploadedMulterFile {
  /** Исходное имя файла. */
  originalname: string;
  /** MIME-тип файла (тип не ограничивается, Req 12.5). */
  mimetype: string;
  /** Размер содержимого в байтах. */
  size: number;
  /** Содержимое файла целиком в памяти. */
  buffer: Buffer;
}

/**
 * HTTP-слой Вложений Чата Задачи (Req 6.1–6.5 спеки; Req 11.9, 11.10, 12).
 *
 * Тонкий контроллер над {@link ChatService} и {@link AttachmentsService}:
 * - список Вложений раздела «Вложения» (Req 11.10);
 * - загрузка файла до отправки Сообщения с лимитами (Req 12.1–12.5);
 * - контролируемая отдача сжатого содержимого для распаковки на клиенте
 *   (Req 12.8, 12.9, 19.8);
 * - отдача миниатюры изображения либо обобщённого представления по типу
 *   (Req 12.6, 12.7).
 *
 * Все маршруты требуют действующей Сессии ({@link SessionAuthGuard}). Членство
 * в чате Задачи (доступ к спискам, содержимому и миниатюрам) и доменные лимиты
 * проверяются в сервисах — контроллер не дублирует бизнес-логику. Файлы
 * хранятся вне веб-корня и отдаются только через {@link StorageService}-потоки
 * после проверки прав (Req 19.8). Глобальный префикс `/api` применяется в
 * `main.ts`; доменные исключения преобразуются глобальным фильтром в единый
 * формат `{ code, message }`.
 */
@Controller()
@UseGuards(SessionAuthGuard)
export class AttachmentsController {
  constructor(
    private readonly chatService: ChatService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  /**
   * Все Вложения Чата Задачи для раздела «Вложения» Участнику чата (Req 6.1,
   * 11.10).
   *
   * Делегирует {@link ChatService.listAttachmentsWithCreatedAt}; членство в чате
   * проверяет сервис. Возвращает метаданные в форме контракта `AttachmentMeta`;
   * внутренние пути хранения наружу не раскрываются (Req 19.8).
   */
  @Get('tasks/:id/attachments')
  async list(
    @Param('id') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AttachmentMetaView[]> {
    const userId = this.principal(req).userId;
    const rows = await this.chatService.listAttachmentsWithCreatedAt(userId, taskId);
    return rows.map((row) => toAttachmentMeta(row, row.message.createdAt));
  }

  /**
   * Загрузка файла-Вложения в Чат Задачи до отправки Сообщения (Req 6.2,
   * 12.1–12.5).
   *
   * Поле формы — `file` (контракт `frontend/src/lib/chat-api.ts`). Лимит 25 МБ
   * задаётся на интерсепторе и перепроверяется сервисом; тип файла не
   * ограничивается (Req 12.5). Делегирует
   * {@link AttachmentsService.uploadToTask}: членство в чате, лимиты и хранение
   * вне веб-корня выполняет сервис. Возвращает метаданные созданного Вложения.
   */
  @Post('tasks/:id/attachments')
  @UseGuards(RateLimitGuard)
  @RateLimit('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES } }))
  async upload(
    @Param('id') taskId: string,
    @UploadedFile() file: UploadedMulterFile | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AttachmentMetaView> {
    const userId = this.principal(req).userId;
    if (file === undefined) {
      throw new ValidationException('Файл не передан: ожидается поле «file».');
    }
    const uploadFile: UploadFile = {
      originalName: file.originalname,
      mimeType: file.mimetype,
      declaredSize: file.size,
      content: file.buffer,
    };
    const { attachment, createdAt } = await this.attachmentsService.uploadToTask(
      userId,
      taskId,
      uploadFile,
    );
    return toAttachmentMeta(attachment, createdAt);
  }

  /**
   * Контролируемая отдача сжатого содержимого Вложения для распаковки на клиенте
   * (Req 6.3, 12.8, 12.9, 19.8).
   *
   * Делегирует {@link AttachmentsService.openCompressed}: членство в чате
   * проверяет сервис; отсутствие/недоступность — 404 без раскрытия (Req 2.12).
   * Отдаёт сжатый поток вне веб-корня вместе с метаданными в заголовках
   * (`X-Compression`, `X-Checksum`), которые клиент использует для распаковки и
   * проверки целостности (Req 12.9).
   */
  @Get('attachments/:id/content')
  async content(
    @Param('id') attachmentId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const userId = this.principal(req).userId;
    const compressed = await this.attachmentsService.openCompressed(userId, attachmentId);
    res.set({
      'X-Compression': compressed.compression,
      'X-Checksum': compressed.checksum,
    });
    return new StreamableFile(compressed.stream, { type: compressed.mimeType });
  }

  /**
   * Документный PDF-предпросмотр табличного Вложения.
   *
   * В отличие от `/content`, этот endpoint отдаёт не исходный файл, а
   * серверный рендер в PDF, чтобы сохранить форматирование таблиц. Доступ и
   * видимость проверяет {@link AttachmentsService.openDocumentPreview}.
   */
  @Get('attachments/:id/preview')
  async preview(
    @Param('id') attachmentId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const userId = this.principal(req).userId;
    const preview = await this.attachmentsService.openDocumentPreview(userId, attachmentId);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="preview.pdf"; filename*=UTF-8''${encodeURIComponent(
        preview.fileName,
      )}`,
    });
    return new StreamableFile(preview.content, { type: preview.mimeType });
  }

  /**
   * Отдача миниатюры Вложения-изображения (Req 6.4, 12.6, 12.7, 19.8).
   *
   * Делегирует {@link AttachmentsService.openThumbnail}: членство в чате
   * проверяет сервис. Для изображения отдаётся распакованное содержимое
   * миниатюры, готовое к показу в `<img>`. Для прочих типов миниатюры нет —
   * клиент отображает обобщённый значок по типу файла самостоятельно
   * (`frontend/src/lib/attachments.ts`), поэтому эндпоинт отвечает 404
   * (Req 12.7).
   */
  @Get('attachments/:id/thumbnail')
  async thumbnail(
    @Param('id') attachmentId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<StreamableFile> {
    const userId = this.principal(req).userId;
    const result = await this.attachmentsService.openThumbnail(userId, attachmentId);
    if (result.kind !== 'image') {
      // Для не-изображений серверная миниатюра не формируется; клиент использует
      // обобщённый значок по типу файла (Req 12.7).
      throw new EntityNotFoundException('Миниатюра недоступна для этого типа вложения.');
    }
    return new StreamableFile(result.content, { type: result.mimeType });
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
