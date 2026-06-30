import { Controller, Get, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { readSingleMultipartFile, setResponseHeaders, type HttpResponseLike } from '../common/http';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatService } from '../chat';
import { AttachmentMetaView, toAttachmentMeta } from '../chat';
import { RateLimit, RateLimitGuard } from '../security';
import { AttachmentTicketService } from './attachment-ticket.service';
import { AttachmentsService } from './attachments.service';
import { DocumentExternalLinks, UploadFile } from './attachments.types';

/**
 * Единый лимит размера загружаемого Вложения — 25 МБ (Req 12.2, 12.3).
 *
 * Задаётся при streaming-разборе multipart-запроса и дополнительно
 * перепроверяется {@link AttachmentsService} по значению из
 * конфигурации — источника истины (двойной контроль, Req 12.3).
 */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function contentDisposition(
  disposition: 'inline' | 'attachment',
  fallbackFileName: string,
  fileName: string,
): string {
  return `${disposition}; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(
    fileName,
  )}`;
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
    private readonly attachmentTickets: AttachmentTicketService,
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
   * задаётся при streaming-разборе и перепроверяется сервисом; тип файла не
   * ограничивается (Req 12.5). Делегирует
   * {@link AttachmentsService.uploadToTask}: членство в чате, лимиты и хранение
   * вне веб-корня выполняет сервис. Возвращает метаданные созданного Вложения.
   */
  @Post('tasks/:id/attachments')
  @UseGuards(RateLimitGuard)
  @RateLimit('upload')
  async upload(
    @Param('id') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AttachmentMetaView> {
    const userId = this.principal(req).userId;
    const file = await readSingleMultipartFile(req as unknown as FastifyRequest, {
      fieldName: 'file',
      maxBytes: ATTACHMENT_MAX_BYTES,
    });
    const uploadFile: UploadFile = {
      originalName: file.originalName,
      mimeType: file.mimeType,
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
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile> {
    const userId = this.principal(req).userId;
    const compressed = await this.attachmentsService.openCompressed(userId, attachmentId);
    setResponseHeaders(res, {
      'X-Compression': compressed.compression,
      'X-Checksum': compressed.checksum,
    });
    return new StreamableFile(compressed.stream, { type: compressed.mimeType });
  }

  /**
   * PDF-предпросмотр офисного Вложения.
   *
   * В отличие от `/content`, этот endpoint отдаёт не исходный файл, а
   * серверный рендер в PDF, чтобы сохранить форматирование документа. Доступ и
   * видимость проверяет {@link AttachmentsService.openDocumentPreview}.
   */
  @Get('attachments/:id/preview')
  async preview(
    @Param('id') attachmentId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile> {
    const userId = this.principal(req).userId;
    const preview = await this.attachmentsService.openDocumentPreview(userId, attachmentId);
    setResponseHeaders(res, {
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="preview.pdf"; filename*=UTF-8''${encodeURIComponent(
        preview.fileName,
      )}`,
    });
    return new StreamableFile(preview.content, { type: preview.mimeType });
  }

  /**
   * Короткоживущие внешние ссылки на PDF-предпросмотр и оригинал Вложения.
   *
   * Используется MAX mini-app: внешний browser/PDF viewer не может передать
   * Bearer-токен mini-app, поэтому клиент сначала получает ticket-ссылки через
   * авторизованный запрос, а затем открывает их через MAX Bridge.
   */
  @Post('attachments/:id/document-links')
  async documentLinks(
    @Param('id') attachmentId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<DocumentExternalLinks> {
    const userId = this.principal(req).userId;
    return this.attachmentTickets.issueDocumentLinks(userId, attachmentId);
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

/**
 * Публичная отдача временных ticket-ссылок.
 *
 * Guard здесь намеренно отсутствует: ticket уже является короткоживущим
 * секретом, а сервис при каждом открытии заново проверяет права пользователя,
 * сохранённого в payload ticket.
 */
@Controller()
export class AttachmentTicketsController {
  constructor(private readonly attachmentTickets: AttachmentTicketService) {}

  @Get('attachment-tickets/:token')
  async open(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile> {
    const ticket = await this.attachmentTickets.openTicket(token);
    setResponseHeaders(res, { 'Cache-Control': 'no-store' });

    if (ticket.kind === 'preview') {
      setResponseHeaders(res, {
        'Content-Disposition': contentDisposition('inline', 'preview.pdf', ticket.content.fileName),
      });
      return new StreamableFile(ticket.content.content, { type: ticket.content.mimeType });
    }

    setResponseHeaders(res, {
      'Content-Disposition': contentDisposition(
        'attachment',
        'attachment',
        ticket.content.fileName,
      ),
    });
    return new StreamableFile(ticket.content.content, { type: ticket.content.mimeType });
  }
}
