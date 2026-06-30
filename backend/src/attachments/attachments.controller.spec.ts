import { Readable } from 'node:stream';
import { Role } from '@prisma/client';
import { Response } from 'express';
import { StreamableFile } from '@nestjs/common';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatService } from '../chat';
import { AttachmentWithCreatedAt } from '../repositories';
import { AttachmentTicketsController, AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import {
  CompressedStream,
  DocumentPreview,
  ThumbnailResult,
  UploadedAttachment,
} from './attachments.types';

/**
 * Контроллерные тесты {@link AttachmentsController} (задача 6.3).
 *
 * Проверяют тонкую маршрутизацию HTTP → {@link ChatService}/{@link AttachmentsService}:
 * проброс инициатора и параметров, формирование контракта `AttachmentMeta`,
 * отображение multipart-файла в форму сервиса, проброс отказа доступа без
 * раскрытия (Req 6.5, 2.12), отдачу потоков (`StreamableFile`) и заголовков
 * распаковки, поведение лимита 25 МБ (отклонение сервисом) и отдачу миниатюр.
 * Доменные правила, лимиты и членство проверяются в тестах сервисов; здесь
 * моделируется только поведение контроллера.
 */
describe('AttachmentsController', () => {
  const TASK_ID = 'task-1';
  const ATTACHMENT_ID = 'att-1';
  const NOW = new Date('2026-06-19T10:00:00.000Z');

  function makeAttachmentRow(): AttachmentWithCreatedAt {
    return {
      id: ATTACHMENT_ID,
      messageId: 'message-1',
      originalName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: BigInt(2048),
      storagePath: 'task-1/secret.zst',
      thumbnailPath: 'task-1/secret.thumb.zst',
      compression: 'zstd',
      checksum: 'abc123',
      message: { createdAt: NOW },
    } as unknown as AttachmentWithCreatedAt;
  }

  function buildController(opts: { userId?: string; role?: Role } = {}): {
    controller: AttachmentsController;
    chatService: {
      listAttachmentsWithCreatedAt: jest.Mock;
    };
    attachmentsService: {
      uploadToTask: jest.Mock;
      openCompressed: jest.Mock;
      openDocumentPreview: jest.Mock;
      openThumbnail: jest.Mock;
    };
    attachmentTickets: {
      issueDocumentLinks: jest.Mock;
      openTicket: jest.Mock;
    };
    req: AuthenticatedRequest;
    res: Response;
    headers: Record<string, string>;
  } {
    const chatService = {
      listAttachmentsWithCreatedAt: jest.fn().mockResolvedValue([makeAttachmentRow()]),
    };

    const uploaded: UploadedAttachment = {
      attachment: {
        id: 'att-new',
        messageId: 'draft-1',
        originalName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(4096),
        storagePath: 'task-1/new.zst',
        thumbnailPath: null,
        compression: 'zstd',
        checksum: 'def456',
      } as unknown as UploadedAttachment['attachment'],
      createdAt: NOW,
    };

    const compressed: CompressedStream = {
      stream: Readable.from(Buffer.from('compressed-bytes')),
      mimeType: 'image/png',
      originalName: 'photo.png',
      compression: 'zstd',
      sizeBytes: 2048,
      checksum: 'abc123',
    };

    const thumbnail: ThumbnailResult = {
      kind: 'image',
      content: Buffer.from('thumb-bytes'),
      mimeType: 'image/png',
    };

    const preview: DocumentPreview = {
      content: Buffer.from('pdf-bytes'),
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
    };

    const attachmentsService = {
      uploadToTask: jest.fn().mockResolvedValue(uploaded),
      openCompressed: jest.fn().mockResolvedValue(compressed),
      openDocumentPreview: jest.fn().mockResolvedValue(preview),
      openThumbnail: jest.fn().mockResolvedValue(thumbnail),
    };
    const attachmentTickets = {
      issueDocumentLinks: jest.fn().mockResolvedValue({
        preview: { url: '/api/attachment-tickets/preview-token', fileName: 'report.pdf' },
        original: { url: '/api/attachment-tickets/original-token', fileName: 'report.xlsx' },
        expiresAt: '2026-06-30T10:05:00.000Z',
      }),
      openTicket: jest.fn(),
    };

    const controller = new AttachmentsController(
      chatService as unknown as ChatService,
      attachmentsService as unknown as AttachmentsService,
      attachmentTickets as unknown as import('./attachment-ticket.service').AttachmentTicketService,
    );

    const req = {
      user: {
        userId: opts.userId ?? 'executor-1',
        tokenId: 't1',
        role: opts.role ?? Role.EXECUTOR,
      },
    } as AuthenticatedRequest;

    const headers: Record<string, string> = {};
    const res = {
      set: jest.fn((value: Record<string, string>) => Object.assign(headers, value)),
    } as unknown as Response;

    return { controller, chatService, attachmentsService, attachmentTickets, req, res, headers };
  }

  function makeMulterFile(): {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  } {
    return {
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
      size: 4096,
      buffer: Buffer.from('file-bytes'),
    };
  }

  function withMultipartFile(
    req: AuthenticatedRequest,
    file: ReturnType<typeof makeMulterFile> | undefined,
  ): AuthenticatedRequest {
    return Object.assign(req, {
      isMultipart: () => true,
      file: jest.fn().mockResolvedValue(file === undefined ? undefined : toMultipartPart(file)),
    }) as AuthenticatedRequest;
  }

  function toMultipartPart(file: ReturnType<typeof makeMulterFile>): unknown {
    const stream = Readable.from(file.buffer) as Readable & { truncated?: boolean };
    stream.truncated = false;
    return {
      type: 'file',
      fieldname: 'file',
      filename: file.originalname,
      mimetype: file.mimetype,
      file: stream,
      fields: {},
    };
  }

  it('возвращает список Вложений в форме контракта с createdAt сообщения (Req 6.1, 11.10)', async () => {
    const { controller, chatService, req } = buildController();
    const list = await controller.list(TASK_ID, req);
    expect(chatService.listAttachmentsWithCreatedAt).toHaveBeenCalledWith('executor-1', TASK_ID);
    expect(list).toEqual([
      {
        id: ATTACHMENT_ID,
        messageId: 'message-1',
        originalName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        hasThumbnail: true,
        compression: 'zstd',
        checksum: 'abc123',
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('отображает multipart-файл в форму сервиса и возвращает метаданные (Req 6.2, 12.1–12.5)', async () => {
    const { controller, attachmentsService, req } = buildController();
    const meta = await controller.upload(TASK_ID, withMultipartFile(req, makeMulterFile()));
    expect(attachmentsService.uploadToTask).toHaveBeenCalledWith('executor-1', TASK_ID, {
      originalName: 'doc.pdf',
      mimeType: 'application/pdf',
      declaredSize: 10,
      content: Buffer.from('file-bytes'),
    });
    expect(meta).toMatchObject({ id: 'att-new', originalName: 'doc.pdf', hasThumbnail: false });
  });

  it('отклоняет загрузку без файла (Req 6.2)', async () => {
    const { controller, attachmentsService, req } = buildController();
    await expect(
      controller.upload(TASK_ID, withMultipartFile(req, undefined)),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(attachmentsService.uploadToTask).not.toHaveBeenCalled();
  });

  it('пробрасывает отказ сервиса при превышении лимита 25 МБ (Req 6.2, 12.3)', async () => {
    const { controller, attachmentsService, req } = buildController();
    attachmentsService.uploadToTask.mockRejectedValueOnce(
      new ValidationException('Размер файла превышает допустимый предел 25 МБ.'),
    );
    await expect(
      controller.upload(TASK_ID, withMultipartFile(req, makeMulterFile())),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('отдаёт сжатый поток содержимого с заголовками распаковки (Req 6.3, 12.8, 12.9)', async () => {
    const { controller, attachmentsService, req, res, headers } = buildController();
    const result = await controller.content(ATTACHMENT_ID, req, res);
    expect(attachmentsService.openCompressed).toHaveBeenCalledWith('executor-1', ATTACHMENT_ID);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['X-Compression']).toBe('zstd');
    expect(headers['X-Checksum']).toBe('abc123');
  });

  it('не раскрывает содержимое не-участнику чата (Req 6.5, 2.12)', async () => {
    const { controller, attachmentsService, req, res } = buildController({ userId: 'outsider-1' });
    attachmentsService.openCompressed.mockRejectedValueOnce(
      new EntityNotFoundException('Вложение не найдено или недоступно.'),
    );
    await expect(controller.content(ATTACHMENT_ID, req, res)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('отдаёт PDF-предпросмотр таблицы inline (Req 12.9)', async () => {
    const { controller, attachmentsService, req, res, headers } = buildController();
    const result = await controller.preview(ATTACHMENT_ID, req, res);
    expect(attachmentsService.openDocumentPreview).toHaveBeenCalledWith(
      'executor-1',
      ATTACHMENT_ID,
    );
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Disposition']).toBe(
      'inline; filename="preview.pdf"; filename*=UTF-8\'\'report.pdf',
    );
  });

  it('выдаёт временные ссылки на документ через авторизованный маршрут', async () => {
    const { controller, attachmentTickets, req } = buildController();
    const result = await controller.documentLinks(ATTACHMENT_ID, req);

    expect(attachmentTickets.issueDocumentLinks).toHaveBeenCalledWith('executor-1', ATTACHMENT_ID);
    expect(result).toEqual({
      preview: { url: '/api/attachment-tickets/preview-token', fileName: 'report.pdf' },
      original: { url: '/api/attachment-tickets/original-token', fileName: 'report.xlsx' },
      expiresAt: '2026-06-30T10:05:00.000Z',
    });
  });

  it('отдаёт миниатюру изображения как поток (Req 6.4, 12.6)', async () => {
    const { controller, attachmentsService, req } = buildController();
    const result = await controller.thumbnail(ATTACHMENT_ID, req);
    expect(attachmentsService.openThumbnail).toHaveBeenCalledWith('executor-1', ATTACHMENT_ID);
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('для не-изображения миниатюра отсутствует — 404 (Req 6.4, 12.7)', async () => {
    const { controller, attachmentsService, req } = buildController();
    attachmentsService.openThumbnail.mockResolvedValueOnce({ kind: 'icon', icon: 'pdf' });
    await expect(controller.thumbnail(ATTACHMENT_ID, req)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('пробрасывает отказ доступа к миниатюре без раскрытия (Req 6.5, 2.12)', async () => {
    const { controller, attachmentsService, req } = buildController({ userId: 'outsider-1' });
    attachmentsService.openThumbnail.mockRejectedValueOnce(
      new EntityNotFoundException('Вложение не найдено или недоступно.'),
    );
    await expect(controller.thumbnail(ATTACHMENT_ID, req)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('требует входа, если субъект не установлен (Req 1.5)', async () => {
    const { controller } = buildController();
    const anon = {} as AuthenticatedRequest;
    await expect(controller.list(TASK_ID, anon)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', AttachmentsController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});

describe('AttachmentTicketsController', () => {
  function buildTicketController(): {
    controller: AttachmentTicketsController;
    attachmentTickets: { openTicket: jest.Mock };
    res: Response;
    headers: Record<string, string>;
  } {
    const attachmentTickets = {
      openTicket: jest.fn(),
    };
    const controller = new AttachmentTicketsController(
      attachmentTickets as unknown as import('./attachment-ticket.service').AttachmentTicketService,
    );
    const headers: Record<string, string> = {};
    const res = {
      set: jest.fn((value: Record<string, string>) => Object.assign(headers, value)),
    } as unknown as Response;
    return { controller, attachmentTickets, res, headers };
  }

  it('отдаёт PDF ticket inline без SessionAuthGuard', async () => {
    const { controller, attachmentTickets, res, headers } = buildTicketController();
    attachmentTickets.openTicket.mockResolvedValueOnce({
      kind: 'preview',
      content: {
        content: Buffer.from('pdf-bytes'),
        mimeType: 'application/pdf',
        fileName: 'отчёт.pdf',
      },
    });

    const result = await controller.open('preview-token', res);

    expect(attachmentTickets.openTicket).toHaveBeenCalledWith('preview-token');
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Disposition']).toBe(
      'inline; filename="preview.pdf"; filename*=UTF-8\'\'%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf',
    );
    expect(Reflect.getMetadata('__guards__', AttachmentTicketsController)).toBeUndefined();
  });

  it('отдаёт original ticket как attachment с исходным именем', async () => {
    const { controller, attachmentTickets, res, headers } = buildTicketController();
    attachmentTickets.openTicket.mockResolvedValueOnce({
      kind: 'original',
      content: {
        content: Buffer.from('xlsx-bytes'),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'report.xlsx',
      },
    });

    const result = await controller.open('original-token', res);

    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Disposition']).toBe(
      'attachment; filename="attachment"; filename*=UTF-8\'\'report.xlsx',
    );
  });
});
