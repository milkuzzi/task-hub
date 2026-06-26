import fc from 'fast-check';
import { AssignmentKind, Attachment, Role, User } from '@prisma/client';
import { EntityNotFoundException } from '../common/errors';
import { AppConfigService } from '../config';
import {
  AttachmentRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StorageService } from '../storage';
import { ChatService } from '../chat';
import { AttachmentMetaView, toAttachmentMeta } from '../chat';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ThumbnailGenerator } from './thumbnail-generator';
import { isPreviewableImage, genericIconType } from './attachment-representation';
import { AuthenticatedRequest } from '../auth';

/**
 * **Bugfix: task-hub-bug-fixes — Property 4 (Preservation): обобщённый значок
 * для не-изображений / превышения лимита**
 *
 * **Validates: Requirements 3.2**
 *
 * Preservation-тест для дефекта 2. Фиксирует базовое поведение для входов ¬C,
 * где `isBugCondition_2` ЛОЖНО — то есть НЕ выполняется
 * `isPreviewableImage(mime) И sizeBytes ≤ attachmentMaxBytes`
 * (не-изображение / непревьюшный тип ИЛИ превышение лимита размера).
 *
 * **Методология «сначала наблюдение»**: тест запускается на НЕИСПРАВЛЕННОМ коде
 * и фиксирует наблюдаемое поведение, которое не должно меняться после
 * исправления дефекта 2:
 *  - миниатюра НЕ формируется (`thumbnailPath` остаётся `null`) —
 *    `AttachmentsService.generateThumbnail` завершается без `setThumbnailPath`;
 *  - в отданном `AttachmentMeta` `hasThumbnail = false`
 *    (`toAttachmentMeta`, Req 12.6);
 *  - эндпоинт миниатюры отвечает 404 — `AttachmentsController.thumbnail`
 *    бросает {@link EntityNotFoundException}, так как
 *    `AttachmentsService.openThumbnail` возвращает обобщённый значок по типу
 *    файла, а не изображение (Req 12.7).
 *
 * **Scoped PBT**: property-based генерация входов ¬C (не-изображение или
 * превышение лимита) через fast-check.
 *
 * **EXPECTED OUTCOME**: тест ПРОХОДИТ на неисправленном коде (фиксирует ¬C для
 * предотвращения регрессий).
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 МБ (Req 12.2)
const LIMITS = { attachmentMaxBytes: MAX_BYTES, maxAttachmentsPerMessage: 10 };
const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');

const TASK_ID = 'task-1';
const MEMBER_ID = 'executor-1';

function makeUser(id: string, role: Role): User {
  return { id, role, isActive: true, deletedAt: null } as unknown as User;
}

function makeTask(): TaskWithAssignments {
  return {
    id: TASK_ID,
    assignments: [{ id: 'a-0', taskId: TASK_ID, userId: MEMBER_ID, kind: AssignmentKind.EXECUTOR }],
  } as unknown as TaskWithAssignments;
}

/** ¬C-Вложение: миниатюра не сформирована (`thumbnailPath = null`). */
function makeAttachment(mimeType: string, sizeBytes: number): Attachment {
  return {
    id: 'att-1',
    messageId: 'message-1',
    taskId: TASK_ID,
    uploaderId: MEMBER_ID,
    originalName: `file.${mimeType.split('/')[1] ?? 'bin'}`,
    mimeType,
    sizeBytes: BigInt(sizeBytes),
    storagePath: 'task-1/orig.zst',
    thumbnailPath: null,
    compression: 'zstd',
    checksum: 'checksum-att-1',
    createdAt: FIXED_NOW,
  } as unknown as Attachment;
}

interface Harness {
  service: AttachmentsService;
  controller: AttachmentsController;
  setThumbnailPath: jest.Mock;
  thumbnailGenerate: jest.Mock;
}

function buildHarness(attachment: Attachment): Harness {
  const user = makeUser(MEMBER_ID, Role.EXECUTOR);
  const task = makeTask();

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => (id === user.id ? user : null)),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
  } as unknown as TaskRepository;

  const setThumbnailPath = jest.fn(async () => attachment);
  const attachmentRepository = {
    findById: jest.fn(async (id: string) => (id === attachment.id ? attachment : null)),
    setThumbnailPath,
  } as unknown as AttachmentRepository;

  const storage = {
    readDecompressed: jest.fn(async () => Buffer.from('image-bytes')),
    store: jest.fn(async () => ({
      storagePath: 'task-1/thumb.zst',
      checksum: 'thumb-checksum',
      originalSize: 11,
      compressedSize: 9,
      codec: 'zstd' as const,
    })),
  } as unknown as StorageService;

  const config = { limits: LIMITS } as unknown as AppConfigService;

  const thumbnailGenerate = jest.fn(async (input: { content: Buffer }) => input.content);
  const thumbnailGenerator = {
    generate: thumbnailGenerate,
  } as unknown as ThumbnailGenerator;

  const service = new AttachmentsService(
    attachmentRepository,
    taskRepository,
    userRepository,
    storage,
    config,
    thumbnailGenerator,
  );

  // ChatService не участвует в пути миниатюры — достаточно заглушки.
  const chatService = {} as unknown as ChatService;
  const controller = new AttachmentsController(chatService, service);

  return { service, controller, setThumbnailPath, thumbnailGenerate };
}

function authedRequest(userId: string): AuthenticatedRequest {
  return { user: { userId } } as unknown as AuthenticatedRequest;
}

describe('Property 4 (Preservation): обобщённый значок для не-изображений / превышения лимита (Req 3.2)', () => {
  // Непревьюшные типы: не-изображения + векторный SVG (не растрируется).
  const nonPreviewableMimeArb = fc.constantFrom(
    'application/pdf',
    'application/zip',
    'text/plain',
    'video/mp4',
    'audio/mpeg',
    'application/msword',
    'image/svg+xml',
  );
  // Любой превьюшный тип изображения.
  const previewableImageMimeArb = fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  );
  const inLimitSizeArb = fc.integer({ min: 1, max: MAX_BYTES });
  const overLimitSizeArb = fc.integer({ min: MAX_BYTES + 1, max: MAX_BYTES * 4 });

  // Вход ¬C: НЕ (previewable И ≤ лимита).
  const notBugConditionArb = fc.oneof(
    // непревьюшный тип, любой размер до лимита
    fc.record({ mimeType: nonPreviewableMimeArb, sizeBytes: inLimitSizeArb }),
    // превьюшное изображение, но сверх лимита
    fc.record({ mimeType: previewableImageMimeArb, sizeBytes: overLimitSizeArb }),
    // непревьюшный тип сверх лимита
    fc.record({ mimeType: nonPreviewableMimeArb, sizeBytes: overLimitSizeArb }),
  );

  it('миниатюра не формируется и hasThumbnail = false для входов ¬C', async () => {
    await fc.assert(
      fc.asyncProperty(notBugConditionArb, async ({ mimeType, sizeBytes }) => {
        // Предусловие ¬C: isBugCondition_2 ложно.
        expect(isPreviewableImage(mimeType) && sizeBytes <= MAX_BYTES).toBe(false);

        const attachment = makeAttachment(mimeType, sizeBytes);
        const h = buildHarness(attachment);

        // Генерация миниатюры завершается без сохранения пути (Req 12.7).
        await h.service.generateThumbnail(attachment.id);
        expect(h.thumbnailGenerate).not.toHaveBeenCalled();
        expect(h.setThumbnailPath).not.toHaveBeenCalled();

        // В отданном AttachmentMeta hasThumbnail = false (Req 12.6).
        const meta: AttachmentMetaView = toAttachmentMeta(attachment, FIXED_NOW);
        expect(meta.hasThumbnail).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('эндпоинт миниатюры отвечает 404 (обобщённый значок по типу файла) для входов ¬C', async () => {
    await fc.assert(
      fc.asyncProperty(notBugConditionArb, async ({ mimeType, sizeBytes }) => {
        expect(isPreviewableImage(mimeType) && sizeBytes <= MAX_BYTES).toBe(false);

        const attachment = makeAttachment(mimeType, sizeBytes);
        const h = buildHarness(attachment);

        // Сервис возвращает обобщённый значок по типу файла, а не изображение.
        const result = await h.service.openThumbnail(MEMBER_ID, attachment.id);
        expect(result.kind).toBe('icon');
        if (result.kind === 'icon') {
          expect(result.icon).toBe(genericIconType(mimeType));
        }

        // Эндпоинт миниатюры отвечает 404 (Req 12.7).
        await expect(
          h.controller.thumbnail(attachment.id, authedRequest(MEMBER_ID)),
        ).rejects.toBeInstanceOf(EntityNotFoundException);
      }),
      { numRuns: 100 },
    );
  });
});
