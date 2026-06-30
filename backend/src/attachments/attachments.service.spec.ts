import { AssignmentKind, Attachment, Role, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { AppConfigService } from '../config';
import {
  AttachmentRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StorageService, StoredObject } from '../storage';
import { AttachmentsService } from './attachments.service';
import { DocumentPreviewService } from './document-preview.service';
import { ThumbnailGenerator } from './thumbnail-generator';
import { UploadFile } from './attachments.types';

/**
 * Модульные тесты {@link AttachmentsService.uploadToTask} (Req 12.1–12.5, 19.8,
 * 19.9) с подменой репозиториев, хранилища и конфигурации — без обращения к
 * реальной базе и файловой системе.
 *
 * Проверяются: загрузка файлов любого типа как «висящих» (непривязанных)
 * Вложений (Req 12.1, 12.5); отказ при превышении 25 МБ без сохранения
 * (Req 12.2, 12.3) — как по заявленному, так и по фактическому размеру; отказ
 * без сохранения частичного файла при прерывании передачи (Req 12.4, 19.9);
 * хранение через {@link StorageService} вне веб-корня (Req 19.8); проверка
 * принадлежности к Участникам чата Задачи (Req 11.2, 12.1, 2.12). Лимит ≤10
 * Вложений на Сообщение проверяется в точке привязки ({@link ChatService}) и
 * здесь не применяется.
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 МБ (Req 12.2)
const MAX_PER_MESSAGE = 10; // Req 11.9
const LIMITS = { attachmentMaxBytes: MAX_BYTES, maxAttachmentsPerMessage: MAX_PER_MESSAGE };

function makeUser(id: string, role: Role): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: `Имя ${id}`,
    role,
    isActive: true,
    deletedAt: null,
  } as unknown as User;
}

function makeTask(
  assignments: Array<{ userId: string; kind: AssignmentKind }> = [],
): TaskWithAssignments {
  return {
    id: 'task-1',
    title: 'Задача',
    status: TaskStatus.IN_PROGRESS,
    messageCount: 0,
    assignments: assignments.map((a, index) => ({
      id: `assignment-${index}`,
      taskId: 'task-1',
      userId: a.userId,
      kind: a.kind,
    })),
  } as unknown as TaskWithAssignments;
}

interface Harness {
  service: AttachmentsService;
  createdAttachments: Array<Record<string, unknown>>;
  storage: { store: jest.Mock; delete: jest.Mock; readDecompressed: jest.Mock };
  attachmentRepository: { create: jest.Mock; findById: jest.Mock; setThumbnailPath: jest.Mock };
  documentPreviewService: { supports: jest.Mock; convertToPdf: jest.Mock };
  storedResult: { value: StoredObject };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'attachment-1',
    messageId: 'message-1',
    taskId: 'task-1',
    uploaderId: 'executor-1',
    originalName: 'report.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: BigInt(100),
    storagePath: 'task-1/report.zst',
    thumbnailPath: null,
    compression: 'zstd',
    checksum: 'checksum-report',
    createdAt: new Date('2026-06-19T10:00:00.000Z'),
    updatedAt: new Date('2026-06-19T10:00:00.000Z'),
    ...overrides,
  } as unknown as Attachment;
}

function buildHarness(
  options: {
    users?: Record<string, User>;
    task?: TaskWithAssignments;
    attachment?: Attachment;
    storeImpl?: () => Promise<StoredObject>;
    documentPreviewService?: { supports: jest.Mock; convertToPdf: jest.Mock };
  } = {},
): Harness {
  const users = options.users ?? {
    'executor-1': makeUser('executor-1', Role.EXECUTOR),
    'manager-1': makeUser('manager-1', Role.MANAGER),
    'admin-1': makeUser('admin-1', Role.ADMIN),
    'outsider-1': makeUser('outsider-1', Role.EXECUTOR),
  };
  const task =
    options.task ??
    makeTask([
      { userId: 'executor-1', kind: AssignmentKind.EXECUTOR },
      { userId: 'manager-1', kind: AssignmentKind.MANAGER },
    ]);

  const createdAttachments: Array<Record<string, unknown>> = [];
  const storedResult: { value: StoredObject } = {
    value: {
      storagePath: 'task-1/abc.zst',
      checksum: 'checksum-abc',
      originalSize: 100,
      compressedSize: 40,
      codec: 'zstd',
    },
  };

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
  } as unknown as TaskRepository;

  // Последнее созданное Вложение для перечитывания при формировании миниатюры.
  let lastCreated: Attachment | null = options.attachment ?? null;
  const attachmentRepository = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      createdAttachments.push(data);
      lastCreated = { id: 'attachment-new', thumbnailPath: null, ...data } as unknown as Attachment;
      return lastCreated;
    }),
    findById: jest.fn(async () => lastCreated),
    setThumbnailPath: jest.fn(async () => lastCreated as Attachment),
  };

  const storage = {
    store: jest.fn(options.storeImpl ?? (async () => storedResult.value)),
    delete: jest.fn(async () => undefined),
    readDecompressed: jest.fn(async () => Buffer.from('image-bytes')),
  };

  const config = { limits: LIMITS } as unknown as AppConfigService;

  const thumbnailGenerator = {
    generate: jest.fn(async (input: { content: Buffer }) => input.content),
  } as unknown as ThumbnailGenerator;

  const documentPreviewService = options.documentPreviewService ?? {
    supports: jest.fn(() => false),
    convertToPdf: jest.fn(),
  };

  const service = new AttachmentsService(
    attachmentRepository as unknown as AttachmentRepository,
    taskRepository,
    userRepository,
    storage as unknown as StorageService,
    config,
    thumbnailGenerator,
    documentPreviewService as unknown as DocumentPreviewService,
  );

  return {
    service,
    createdAttachments,
    storage,
    attachmentRepository,
    documentPreviewService,
    storedResult,
  };
}

function makeFile(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    originalName: 'photo.png',
    mimeType: 'image/png',
    content: Buffer.from('binary-content'),
    ...overrides,
  };
}

describe('AttachmentsService.uploadToTask', () => {
  it('сохраняет «висящее» вложение любого типа с метаданными taskId/uploaderId (Req 12.1, 12.5, 19.8)', async () => {
    const h = buildHarness();

    const { attachment } = await h.service.uploadToTask(
      'executor-1',
      'task-1',
      makeFile({ originalName: 'archive.bin', mimeType: 'application/x-custom' }),
    );

    expect(h.storage.store).toHaveBeenCalledTimes(1);
    // Хранение вне веб-корня с префиксом задачи (Req 19.8).
    expect(h.storage.store).toHaveBeenCalledWith(expect.anything(), {
      keyPrefix: 'task-1',
      extension: 'bin',
    });
    expect(h.createdAttachments).toHaveLength(1);
    expect(h.createdAttachments[0]).toMatchObject({
      task: { connect: { id: 'task-1' } },
      uploader: { connect: { id: 'executor-1' } },
      originalName: 'archive.bin',
      mimeType: 'application/x-custom',
      sizeBytes: BigInt(100),
      storagePath: 'task-1/abc.zst',
      compression: 'zstd',
      checksum: 'checksum-abc',
    });
    // Вложение создаётся непривязанным (messageId не задаётся).
    expect(h.createdAttachments[0]).not.toHaveProperty('message');
    expect(attachment.id).toBe('attachment-new');
  });

  it('сохраняет аудиофайл с пустым MIME-типом, выводя тип по расширению', async () => {
    const h = buildHarness();

    await h.service.uploadToTask(
      'executor-1',
      'task-1',
      makeFile({ originalName: 'voice.mp3', mimeType: '' }),
    );

    expect(h.createdAttachments[0]).toMatchObject({
      originalName: 'voice.mp3',
      mimeType: 'audio/mpeg',
    });
  });

  it('уточняет application/octet-stream для аудио по расширению файла', async () => {
    const h = buildHarness();

    await h.service.uploadToTask(
      'executor-1',
      'task-1',
      makeFile({ originalName: 'recording.m4a', mimeType: 'application/octet-stream' }),
    );

    expect(h.createdAttachments[0]).toMatchObject({
      originalName: 'recording.m4a',
      mimeType: 'audio/mp4',
    });
  });

  it('сохраняет неизвестный файл без MIME как application/octet-stream', async () => {
    const h = buildHarness();

    await h.service.uploadToTask(
      'executor-1',
      'task-1',
      makeFile({ originalName: 'payload.bin', mimeType: '' }),
    );

    expect(h.createdAttachments[0]).toMatchObject({
      originalName: 'payload.bin',
      mimeType: 'application/octet-stream',
    });
  });

  it('администратор может загрузить вложение (Req 12.1)', async () => {
    const h = buildHarness();
    await expect(h.service.uploadToTask('admin-1', 'task-1', makeFile())).resolves.toBeDefined();
    expect(h.createdAttachments).toHaveLength(1);
  });

  it('отклоняет файл больше 25 МБ по заявленному размеру без сохранения (Req 12.2, 12.3)', async () => {
    const h = buildHarness();

    await expect(
      h.service.uploadToTask('executor-1', 'task-1', makeFile({ declaredSize: MAX_BYTES + 1 })),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(h.storage.store).not.toHaveBeenCalled();
    expect(h.createdAttachments).toHaveLength(0);
  });

  it('отклоняет файл, фактический размер которого превышает лимит, удаляя сохранённый объект (Req 12.3)', async () => {
    const h = buildHarness();
    h.storedResult.value = { ...h.storedResult.value, originalSize: MAX_BYTES + 5 };

    await expect(h.service.uploadToTask('executor-1', 'task-1', makeFile())).rejects.toBeInstanceOf(
      ValidationException,
    );

    // Сохранённый объект удалён, запись не создана (без частичного файла).
    expect(h.storage.delete).toHaveBeenCalledWith('task-1/abc.zst');
    expect(h.createdAttachments).toHaveLength(0);
  });

  it('при прерывании передачи не сохраняет частичный файл и не создаёт запись (Req 12.4, 19.9)', async () => {
    const h = buildHarness({
      storeImpl: async () => {
        throw new Error('transfer aborted');
      },
    });

    await expect(h.service.uploadToTask('executor-1', 'task-1', makeFile())).rejects.toBeInstanceOf(
      ValidationException,
    );

    expect(h.createdAttachments).toHaveLength(0);
  });

  it('не раскрывает недоступную задачу постороннему участнику (Req 11.2, 2.12)', async () => {
    const h = buildHarness();

    await expect(h.service.uploadToTask('outsider-1', 'task-1', makeFile())).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );

    expect(h.storage.store).not.toHaveBeenCalled();
    expect(h.createdAttachments).toHaveLength(0);
  });

  it('отклоняет загрузку от неактивного/несуществующего пользователя (Req 12.1)', async () => {
    const h = buildHarness();

    await expect(h.service.uploadToTask('ghost', 'task-1', makeFile())).rejects.toBeInstanceOf(
      AccessDeniedException,
    );

    expect(h.storage.store).not.toHaveBeenCalled();
  });

  it('сообщает о ненайденной задаче, если она отсутствует (Req 12.1, 2.12)', async () => {
    const h = buildHarness();

    await expect(
      h.service.uploadToTask('executor-1', 'missing-task', makeFile()),
    ).rejects.toBeInstanceOf(EntityNotFoundException);

    expect(h.storage.store).not.toHaveBeenCalled();
  });

  it('отклоняет файл без имени до обращения к хранилищу (Req 12.5)', async () => {
    const h = buildHarness();

    await expect(
      h.service.uploadToTask('executor-1', 'task-1', makeFile({ originalName: '   ' })),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(h.storage.store).not.toHaveBeenCalled();
  });
});

describe('AttachmentsService.openDocumentPreview', () => {
  it('рендерит Word-документ в PDF через LibreOffice-сервис', async () => {
    const documentPreviewService = {
      supports: jest.fn(() => true),
      convertToPdf: jest.fn(async () => ({
        content: Buffer.from('pdf-bytes'),
        mimeType: 'application/pdf' as const,
      })),
    };
    const h = buildHarness({
      attachment: makeAttachment({
        originalName: 'brief.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      documentPreviewService,
    });

    const result = await h.service.openDocumentPreview('executor-1', 'attachment-1');

    expect(h.documentPreviewService.supports).toHaveBeenCalledWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
    );
    expect(h.storage.readDecompressed).toHaveBeenCalledWith('task-1/report.zst');
    expect(h.documentPreviewService.convertToPdf).toHaveBeenCalledWith({
      content: Buffer.from('image-bytes'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalName: 'brief.docx',
    });
    expect(result).toEqual({
      content: Buffer.from('pdf-bytes'),
      mimeType: 'application/pdf',
      fileName: 'brief.pdf',
    });
  });

  it('рендерит PowerPoint-презентацию в PDF через LibreOffice-сервис', async () => {
    const documentPreviewService = {
      supports: jest.fn(() => true),
      convertToPdf: jest.fn(async () => ({
        content: Buffer.from('presentation-pdf'),
        mimeType: 'application/pdf' as const,
      })),
    };
    const h = buildHarness({
      attachment: makeAttachment({
        originalName: 'quarterly-review.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
      documentPreviewService,
    });

    const result = await h.service.openDocumentPreview('executor-1', 'attachment-1');

    expect(h.documentPreviewService.convertToPdf).toHaveBeenCalledWith({
      content: Buffer.from('image-bytes'),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      originalName: 'quarterly-review.pptx',
    });
    expect(result).toEqual({
      content: Buffer.from('presentation-pdf'),
      mimeType: 'application/pdf',
      fileName: 'quarterly-review.pdf',
    });
  });

  it('не читает файл, если тип не поддерживает PDF-предпросмотр', async () => {
    const h = buildHarness({
      attachment: makeAttachment({
        originalName: 'archive.zip',
        mimeType: 'application/zip',
      }),
    });

    await expect(
      h.service.openDocumentPreview('executor-1', 'attachment-1'),
    ).rejects.toBeInstanceOf(EntityNotFoundException);

    expect(h.storage.readDecompressed).not.toHaveBeenCalled();
    expect(h.documentPreviewService.convertToPdf).not.toHaveBeenCalled();
  });
});

describe('AttachmentsService.describeDocumentLinks', () => {
  it('возвращает имена PDF и оригинала без чтения файла и конвертации', async () => {
    const documentPreviewService = {
      supports: jest.fn(() => true),
      convertToPdf: jest.fn(),
    };
    const h = buildHarness({
      attachment: makeAttachment({
        originalName: 'report.final.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      documentPreviewService,
    });

    const result = await h.service.describeDocumentLinks('executor-1', 'attachment-1');

    expect(result).toEqual({
      previewFileName: 'report.final.pdf',
      originalFileName: 'report.final.xlsx',
    });
    expect(h.documentPreviewService.supports).toHaveBeenCalledWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'report.final.xlsx',
    );
    expect(h.storage.readDecompressed).not.toHaveBeenCalled();
    expect(h.documentPreviewService.convertToPdf).not.toHaveBeenCalled();
  });

  it('не выдаёт descriptor для неподдержанного вложения', async () => {
    const h = buildHarness({
      attachment: makeAttachment({ originalName: 'archive.zip', mimeType: 'application/zip' }),
    });

    await expect(
      h.service.describeDocumentLinks('executor-1', 'attachment-1'),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });
});

describe('AttachmentsService.openOriginalContent', () => {
  it('отдаёт распакованный оригинал после проверки доступа', async () => {
    const h = buildHarness({
      attachment: makeAttachment({
        originalName: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    });

    const result = await h.service.openOriginalContent('executor-1', 'attachment-1');

    expect(h.storage.readDecompressed).toHaveBeenCalledWith('task-1/report.zst');
    expect(result).toEqual({
      content: Buffer.from('image-bytes'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'report.xlsx',
    });
  });

  it('не раскрывает оригинал постороннему участнику', async () => {
    const h = buildHarness();

    await expect(
      h.service.openOriginalContent('outsider-1', 'attachment-1'),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(h.storage.readDecompressed).not.toHaveBeenCalled();
  });
});
