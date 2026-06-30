import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityNotFoundException, ValidationException } from '../common/errors';
import { RedisService } from '../infra';
import { AttachmentsService } from './attachments.service';
import {
  DocumentExternalLinks,
  DocumentPreview,
  OriginalAttachmentContent,
} from './attachments.types';

const TICKET_KEY_PREFIX = 'attachments:external-ticket:';
const TICKET_BYTES = 32;
const TICKET_TTL_SECONDS = 5 * 60;

type AttachmentTicketKind = 'preview' | 'original';

interface AttachmentTicketPayload {
  userId: string;
  attachmentId: string;
  kind: AttachmentTicketKind;
}

export type AttachmentTicketContent =
  | {
      kind: 'preview';
      content: DocumentPreview;
    }
  | {
      kind: 'original';
      content: OriginalAttachmentContent;
    };

/**
 * Короткоживущие ссылки на Вложения для внешнего viewer'а MAX mini-app.
 *
 * Внешний браузер/PDF viewer не может отправить Bearer-токен mini-app и не
 * выполняет клиентскую распаковку zstd/gzip. Поэтому клиент получает временный
 * ticket, а backend при каждом открытии ticket заново проверяет права и отдаёт
 * уже готовый PDF-предпросмотр или распакованный оригинал.
 */
@Injectable()
export class AttachmentTicketService {
  constructor(
    private readonly redis: RedisService,
    private readonly attachments: AttachmentsService,
  ) {}

  async issueDocumentLinks(userId: string, attachmentId: string): Promise<DocumentExternalLinks> {
    const descriptor = await this.attachments.describeDocumentLinks(userId, attachmentId);
    const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString();
    const [previewToken, originalToken] = await Promise.all([
      this.issueTicket({ userId, attachmentId, kind: 'preview' }),
      this.issueTicket({ userId, attachmentId, kind: 'original' }),
    ]);

    return {
      preview: {
        url: this.ticketUrl(previewToken),
        fileName: descriptor.previewFileName,
      },
      original: {
        url: this.ticketUrl(originalToken),
        fileName: descriptor.originalFileName,
      },
      expiresAt,
    };
  }

  async openTicket(token: string): Promise<AttachmentTicketContent> {
    const payload = await this.readPayload(token);
    if (payload.kind === 'preview') {
      return {
        kind: 'preview',
        content: await this.attachments.openDocumentPreview(payload.userId, payload.attachmentId),
      };
    }

    return {
      kind: 'original',
      content: await this.attachments.openOriginalContent(payload.userId, payload.attachmentId),
    };
  }

  private async issueTicket(payload: AttachmentTicketPayload): Promise<string> {
    const token = randomBytes(TICKET_BYTES).toString('base64url');
    await this.redis.set(this.keyFor(token), JSON.stringify(payload), TICKET_TTL_SECONDS);
    return token;
  }

  private async readPayload(token: string): Promise<AttachmentTicketPayload> {
    const normalized = token.trim();
    if (normalized === '') {
      throw new EntityNotFoundException('Ссылка на вложение недействительна или устарела.');
    }

    const raw = await this.redis.get(this.keyFor(normalized));
    if (raw === null) {
      throw new EntityNotFoundException('Ссылка на вложение недействительна или устарела.');
    }

    try {
      const parsed = JSON.parse(raw) as Partial<AttachmentTicketPayload>;
      if (
        typeof parsed.userId !== 'string' ||
        typeof parsed.attachmentId !== 'string' ||
        (parsed.kind !== 'preview' && parsed.kind !== 'original')
      ) {
        throw new Error('Invalid attachment ticket payload.');
      }
      return {
        userId: parsed.userId,
        attachmentId: parsed.attachmentId,
        kind: parsed.kind,
      };
    } catch {
      throw new ValidationException('Ссылка на вложение повреждена.');
    }
  }

  private keyFor(token: string): string {
    const hash = createHash('sha256').update(token).digest('hex');
    return `${TICKET_KEY_PREFIX}${hash}`;
  }

  private ticketUrl(token: string): string {
    return `/api/attachment-tickets/${encodeURIComponent(token)}`;
  }
}
