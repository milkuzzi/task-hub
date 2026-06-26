import { AssignmentKind, Attachment, Role, User } from '@prisma/client';
import { Readable } from 'node:stream';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { AppConfigService } from '../config';
import {
  AttachmentRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StorageService } from '../storage';
import { AttachmentsService } from './attachments.service';
import { ThumbnailGenerator } from './thumbnail-generator';

/**
 * Модульные тесты формирования миниатюр и контролируемой отдачи сжатого
 * содержимого {@link AttachmentsService} (Req 12.6, 12.7, 12.8, 12.9, 19.8) с
 * подменой репозиториев, хранилища, конфигурации и порта генерации миниатюр —
 * без обращения к реальной базе и файловой системе.
 */

const MAX_BYTES = 25 * 1024 * 1024; // Req 12.2
const LIMITS = { attachmentMaxBytes: MAX_BYTES, maxAttachmentsPerMessage: 10 };

function makeUser(id: string, role: Role): User {
  return { id, role, isActive: true, deletedAt: null } as unknown as User;
}

function makeTask(): TaskWithAssignments {
  return {
    id: 'task-1',
    assignments: [
      { id: 'a-0', taskId: 'task-1', userId: 'executor-1', kind: AssignmentKind.EXECUTOR },
    ],
  } as unknown as TaskWithAssignments;
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    messageId: 'message-1',
    taskId: 'task-1',
    uploaderId: 'executor-1',
    originalName: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: BigInt(1024),
    storagePath: 'task-1/abc.zst',
    thumbnailPath: null,
    compression: 'zstd',
    checksum: 'checksum-abc',
    createdAt: new Date('2030-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as Attachment;
}

interface Harness {
  service: AttachmentsService;
  attachmentRepository: {
    findById: jest.Mock;
    setThumbnailPath: jest.Mock;
  };
  storage: {
    readDecompressed: jest.Mock;
    store: jest.Mock;
    openCompressedStream: jest.Mock;
  };
  thumbnailGenerator: { generate: jest.Mock };
}

function buildHarness(attachment: Attachment | null = makeAttachment()): Harness {
  const users: Record<string, User> = {
    'executor-1': makeUser('executor-1', Role.EXECUTOR),
    'outsider-1': makeUser('outsider-1', Role.EXECUTOR),
  };
  const task = makeTask();

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
  } as unknown as TaskRepository;

  const attachmentRepository = {
    findById: jest.fn(async (id: string) =>
      attachment !== null && id === attachment.id ? attachment : null,
    ),
    setThumbnailPath: jest.fn(async (id: string, thumbnailPath: string) => ({
      ...(attachment as Attachment),
      id,
      thumbnailPath,
    })),
  };

  const storage = {
    readDecompressed: jest.fn(async () => Buffer.from('image-bytes')),
    store: jest.fn(async () => ({
      storagePath: 'task-1/thumb.zst',
      checksum: 'thumb-checksum',
      originalSize: 11,
      compressedSize: 9,
      codec: 'zstd' as const,
    })),
    openCompressedStream: jest.fn(async () => Readable.from(Buffer.from('compressed'))),
  };

  const config = { limits: LIMITS } as unknown as AppConfigService;

  const thumbnailGenerator = {
    generate: jest.fn(async (input: { content: Buffer }) => input.content),
  };

  const service = new AttachmentsService(
    attachmentRepository as unknown as AttachmentRepository,
    taskRepository,
    userRepository,
    storage as unknown as StorageService,
    config,
    thumbnailGenerator as unknown as ThumbnailGenerator,
  );

  return { service, attachmentRepository, storage, thumbnailGenerator };
}

describe('AttachmentsService.generateThumbnail', () => {
  it('формирует и сохраняет миниатюру для изображения в пределах лимита (Req 12.6)', async () => {
    const h = buildHarness(makeAttachment({ mimeType: 'image/png', sizeBytes: BigInt(2048) }));

    await h.service.generateThumbnail('att-1');

    expect(h.storage.readDecompressed).toHaveBeenCalledWith('task-1/abc.zst');
    expect(h.thumbnailGenerator.generate).toHaveBeenCalledWith({
      mimeType: 'image/png',
      content: Buffer.from('image-bytes'),
    });
    expect(h.storage.store).toHaveBeenCalledWith(Buffer.from('image-bytes'), {
      keyPrefix: 'task-1',
      extension: 'thumb',
    });
    expect(h.attachmentRepository.setThumbnailPath).toHaveBeenCalledWith(
      'att-1',
      'task-1/thumb.zst',
    );
  });

  it('не формирует миниатюру для неизображения — используется обобщённый значок (Req 12.7)', async () => {
    const h = buildHarness(makeAttachment({ mimeType: 'application/pdf' }));

    await h.service.generateThumbnail('att-1');

    expect(h.storage.readDecompressed).not.toHaveBeenCalled();
    expect(h.thumbnailGenerator.generate).not.toHaveBeenCalled();
    expect(h.attachmentRepository.setThumbnailPath).not.toHaveBeenCalled();
  });

  it('не формирует миниатюру для изображения сверх лимита (Req 12.6, 12.7)', async () => {
    const h = buildHarness(
      makeAttachment({ mimeType: 'image/png', sizeBytes: BigInt(MAX_BYTES + 1) }),
    );

    await h.service.generateThumbnail('att-1');

    expect(h.thumbnailGenerator.generate).not.toHaveBeenCalled();
    expect(h.attachmentRepository.setThumbnailPath).not.toHaveBeenCalled();
  });

  it('сообщает о ненайденном вложении (Req 12.6)', async () => {
    const h = buildHarness(null);

    await expect(h.service.generateThumbnail('missing')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('AttachmentsService.representationFor', () => {
  it('возвращает миниатюру для изображения и значок для прочих (Req 12.6, 12.7)', () => {
    const h = buildHarness();
    expect(h.service.representationFor({ mimeType: 'image/png', sizeBytes: BigInt(10) })).toEqual({
      kind: 'thumbnail',
    });
    expect(
      h.service.representationFor({ mimeType: 'application/zip', sizeBytes: BigInt(10) }),
    ).toEqual({ kind: 'icon', icon: 'archive' });
  });
});

describe('AttachmentsService.openCompressed', () => {
  it('отдаёт сжатый поток с метаданными участнику чата (Req 12.9, 19.8)', async () => {
    const h = buildHarness();

    const result = await h.service.openCompressed('executor-1', 'att-1');

    expect(h.storage.openCompressedStream).toHaveBeenCalledWith('task-1/abc.zst');
    expect(result).toMatchObject({
      mimeType: 'image/png',
      originalName: 'photo.png',
      compression: 'zstd',
      sizeBytes: 1024,
      checksum: 'checksum-abc',
    });
    expect(result.stream).toBeInstanceOf(Readable);
  });

  it('не раскрывает вложение постороннему участнику (Req 11.2, 2.12)', async () => {
    const h = buildHarness();

    await expect(h.service.openCompressed('outsider-1', 'att-1')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(h.storage.openCompressedStream).not.toHaveBeenCalled();
  });

  it('сообщает о ненайденном вложении (Req 2.12)', async () => {
    const h = buildHarness(null);

    await expect(h.service.openCompressed('executor-1', 'missing')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('отклоняет запрос от неактивного пользователя (Req 12.1)', async () => {
    const h = buildHarness();

    await expect(h.service.openCompressed('ghost', 'att-1')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });
});
