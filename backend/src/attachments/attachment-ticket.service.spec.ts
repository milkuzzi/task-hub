import { EntityNotFoundException } from '../common/errors';
import { RedisService } from '../infra';
import { AttachmentTicketService } from './attachment-ticket.service';
import { AttachmentsService } from './attachments.service';

describe('AttachmentTicketService', () => {
  function buildHarness(): {
    service: AttachmentTicketService;
    redis: {
      set: jest.Mock;
      get: jest.Mock;
    };
    attachments: {
      describeDocumentLinks: jest.Mock;
      openDocumentPreview: jest.Mock;
      openOriginalContent: jest.Mock;
    };
  } {
    const redis = {
      set: jest.fn(async () => undefined),
      get: jest.fn(),
    };
    const attachments = {
      describeDocumentLinks: jest.fn(async () => ({
        previewFileName: 'report.pdf',
        originalFileName: 'report.xlsx',
      })),
      openDocumentPreview: jest.fn(async () => ({
        content: Buffer.from('pdf-bytes'),
        mimeType: 'application/pdf' as const,
        fileName: 'report.pdf',
      })),
      openOriginalContent: jest.fn(async () => ({
        content: Buffer.from('xlsx-bytes'),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'report.xlsx',
      })),
    };
    const service = new AttachmentTicketService(
      redis as unknown as RedisService,
      attachments as unknown as AttachmentsService,
    );
    return { service, redis, attachments };
  }

  it('выдаёт две ticket-ссылки на PDF и оригинал с TTL 5 минут', async () => {
    const h = buildHarness();

    const result = await h.service.issueDocumentLinks('user-1', 'attachment-1');

    expect(h.attachments.describeDocumentLinks).toHaveBeenCalledWith('user-1', 'attachment-1');
    expect(result.preview.fileName).toBe('report.pdf');
    expect(result.original.fileName).toBe('report.xlsx');
    expect(result.preview.url).toMatch(/^\/api\/attachment-tickets\//);
    expect(result.original.url).toMatch(/^\/api\/attachment-tickets\//);
    expect(result.preview.url).not.toBe(result.original.url);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(h.redis.set).toHaveBeenCalledTimes(2);
    expect(h.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments:external-ticket:[0-9a-f]{64}$/),
      JSON.stringify({
        userId: 'user-1',
        attachmentId: 'attachment-1',
        kind: 'preview',
      }),
      300,
    );
    expect(h.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments:external-ticket:[0-9a-f]{64}$/),
      JSON.stringify({
        userId: 'user-1',
        attachmentId: 'attachment-1',
        kind: 'original',
      }),
      300,
    );
  });

  it('открывает preview ticket через повторную проверку доступа', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({
        userId: 'user-1',
        attachmentId: 'attachment-1',
        kind: 'preview',
      }),
    );

    const result = await h.service.openTicket('preview-token');

    expect(result.kind).toBe('preview');
    expect(h.attachments.openDocumentPreview).toHaveBeenCalledWith('user-1', 'attachment-1');
  });

  it('открывает original ticket как распакованный оригинал', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(
      JSON.stringify({
        userId: 'user-1',
        attachmentId: 'attachment-1',
        kind: 'original',
      }),
    );

    const result = await h.service.openTicket('original-token');

    expect(result.kind).toBe('original');
    expect(h.attachments.openOriginalContent).toHaveBeenCalledWith('user-1', 'attachment-1');
  });

  it('отклоняет отсутствующий или просроченный ticket', async () => {
    const h = buildHarness();
    h.redis.get.mockResolvedValueOnce(null);

    await expect(h.service.openTicket('expired-token')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});
