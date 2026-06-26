import fc from 'fast-check';
import { AssignmentKind, Attachment, Role, TaskStatus, User } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { AppConfigService } from '../config';
import {
  AttachmentRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StorageService, StoredObject } from '../storage';
import { AttachmentsService } from './attachments.service';
import { ThumbnailGenerator } from './thumbnail-generator';
import { UploadFile } from './attachments.types';

/**
 * **Feature: task-assignment-system, Property 32: Лимит размера Вложения при загрузке**
 *
 * Property 32 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 12.1, 12.2, 12.3, 16.11, 19.8, 19.9**:
 *
 * Для любого загружаемого файла (тип — любой) загрузка «висящего» Вложения
 * через {@link AttachmentsService.uploadToTask} разрешена тогда и только тогда,
 * когда размер файла не превышает 25 МБ; иначе загрузка отклоняется и ничего не
 * сохраняется (ни запись Вложения, ни частичный файл в хранилище).
 *
 * Примечание: лимит «не более 10 Вложений на Сообщение» (Req 11.9) после
 * рефакторинга применяется в точке фактической привязки —
 * {@link ChatService.sendMessage}, — и проверяется тестами модуля Chat.
 *
 * Тест прогоняет реальный {@link AttachmentsService.uploadToTask} поверх
 * stateful in-memory репозиториев и подменённого {@link StorageService},
 * который отслеживает фактически сохранённые объекты (store/delete) и моделирует
 * отсутствие осиротевшей записи при отказе. Доступ Участника чата предоставлен.
 * Без реальной БД и файловой системы. Реализует ровно ОДНО свойство; ≥100
 * итераций fast-check (здесь — 200).
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 МБ (Req 12.2)
const MAX_PER_MESSAGE = 10; // Req 11.9
const LIMITS = { attachmentMaxBytes: MAX_BYTES, maxAttachmentsPerMessage: MAX_PER_MESSAGE };

const TASK_ID = 'task-1';
const UPLOADER_ID = 'executor-1';

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

function makeTask(): TaskWithAssignments {
  return {
    id: TASK_ID,
    title: 'Задача',
    status: TaskStatus.IN_PROGRESS,
    messageCount: 0,
    assignments: [
      { id: 'assignment-0', taskId: TASK_ID, userId: UPLOADER_ID, kind: AssignmentKind.EXECUTOR },
    ],
  } as unknown as TaskWithAssignments;
}

interface Harness {
  service: AttachmentsService;
  /** Текущее число сохранённых записей Вложений (stateful). */
  rowCount(): number;
  /** Число объектов, фактически персистентных в хранилище (store без delete). */
  persistedObjects(): number;
}

/**
 * Строит изоляцию сервиса с stateful in-memory репозиториями и хранилищем,
 * отслеживающим персистентность. `storedOriginalSize` — фактический размер,
 * возвращаемый хранилищем после сохранения исходного содержимого (Req 12.3).
 */
function buildHarness(storedOriginalSize: number): Harness {
  const uploader = makeUser(UPLOADER_ID, Role.EXECUTOR);
  const task = makeTask();

  // Stateful in-memory хранилище записей Вложений.
  const rows: Array<Record<string, unknown>> = [];
  let lastCreated: Attachment | null = null;

  // Множество фактически персистентных путей в хранилище (store - delete).
  const persisted = new Set<string>();
  let storeSeq = 0;

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => (id === uploader.id ? uploader : null)),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
  } as unknown as TaskRepository;

  const attachmentRepository = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      lastCreated = {
        id: `attachment-${rows.length}`,
        thumbnailPath: null,
        ...data,
      } as unknown as Attachment;
      rows.push(lastCreated as unknown as Record<string, unknown>);
      return lastCreated;
    }),
    findById: jest.fn(async () => lastCreated),
    setThumbnailPath: jest.fn(async () => lastCreated as Attachment),
  };

  const storage = {
    store: jest.fn(async (): Promise<StoredObject> => {
      const storagePath = `${TASK_ID}/obj-${storeSeq++}.zst`;
      // Успешное сохранение делает объект персистентным до возможного delete.
      persisted.add(storagePath);
      return {
        storagePath,
        checksum: `checksum-${storagePath}`,
        originalSize: storedOriginalSize,
        compressedSize: Math.max(1, Math.floor(storedOriginalSize / 2)),
        codec: 'zstd',
      };
    }),
    delete: jest.fn(async (path: string) => {
      persisted.delete(path);
    }),
    readDecompressed: jest.fn(async () => Buffer.from('payload')),
  };

  const config = { limits: LIMITS } as unknown as AppConfigService;

  const service = new AttachmentsService(
    attachmentRepository as unknown as AttachmentRepository,
    taskRepository,
    userRepository,
    storage as unknown as StorageService,
    config,
    {
      generate: jest.fn(async (input: { content: Buffer }) => input.content),
    } as unknown as ThumbnailGenerator,
  );

  return {
    service,
    rowCount: () => rows.length,
    persistedObjects: () => persisted.size,
  };
}

describe('Property 32: Лимит размера Вложения при загрузке (Req 12.1, 12.2, 12.3, 16.11, 19.8, 19.9)', () => {
  // Размер файла: широкий охват с концентрацией вокруг границы 25 МБ.
  const fileSizeArb = fc.oneof(
    fc.integer({ min: 0, max: MAX_BYTES }),
    fc.integer({ min: MAX_BYTES - 16, max: MAX_BYTES + 16 }),
    fc.integer({ min: 0, max: MAX_BYTES * 2 }),
  );

  // Любой тип файла (Req 12.1, 12.5): известные и произвольные MIME-типы. Не-
  // изображения избегают формирования миниатюры (отдельного объекта хранилища),
  // что упрощает подсчёт исходных персистентных объектов.
  const mimeArb = fc.constantFrom(
    'application/pdf',
    'application/zip',
    'text/plain',
    'application/octet-stream',
    'application/x-custom-binary',
    'video/mp4',
  );

  const extArb = fc.constantFrom('pdf', 'zip', 'txt', 'bin', 'mp4', 'dat');

  it('загрузка принимается ТТогда размер ≤ 25 МБ; иначе отказ без сохранения', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileSizeArb,
        mimeArb,
        extArb,
        fc.boolean(),
        async (fileSize, mimeType, ext, provideDeclared) => {
          const h = buildHarness(fileSize);

          const file: UploadFile = {
            originalName: `файл.${ext}`,
            mimeType,
            content: Buffer.from('payload'),
            ...(provideDeclared ? { declaredSize: fileSize } : {}),
          };

          // Определяющее условие Property 32 (тип файла не влияет).
          const shouldAccept = fileSize <= MAX_BYTES;

          let accepted = false;
          let rejected = false;
          try {
            await h.service.uploadToTask(UPLOADER_ID, TASK_ID, file);
            accepted = true;
          } catch (error) {
            rejected = true;
            // Отказ по размеру — доменная ошибка валидации (Req 12.3).
            expect(error).toBeInstanceOf(ValidationException);
          }

          if (shouldAccept) {
            // Принято: создана ровно одна новая запись и сохранён исходный
            // объект в хранилище (Req 12.1, 19.8).
            expect(accepted).toBe(true);
            expect(h.rowCount()).toBe(1);
            expect(h.persistedObjects()).toBe(1);
          } else {
            // Отклонено: ничего не сохранено — ни запись Вложения, ни
            // частичный/полный файл в хранилище (Req 12.3, 12.4, 19.9).
            expect(rejected).toBe(true);
            expect(h.rowCount()).toBe(0);
            expect(h.persistedObjects()).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
