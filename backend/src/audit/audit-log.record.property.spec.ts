import fc from 'fast-check';
import { ClockService } from '../clock';
import { NowProvider } from '../clock/clock.constants';
import { TaskRepository, UserRepository } from '../repositories';
import { AuditFieldChange } from '../tasks/ports';
import { AuditEntryCreateData, AuditEntryRepository } from './audit-entry.repository';
import { AuditLogService } from './audit-log.service';

/**
 * **Feature: task-assignment-system, Property 56: Журнал изменений — корректная запись на каждое изменение**
 *
 * **Validates: Requirements 20.1**
 *
 * Для любой последовательности изменений параметров (Название, Описание,
 * Дедлайн, Исполнители, Менеджеры) или статуса Задачи на каждое изменение
 * создаётся ровно одна запись Журнала, и каждая запись несёт автора изменения,
 * наименование параметра, прежнее и новое значение, а также момент изменения
 * (`changedAt`), зафиксированный текущим временем {@link ClockService}.
 *
 * Тест прогоняется через {@link AuditLogService.record} с детерминированно
 * инъецированным временем и подменённым in-memory репозиторием
 * {@link AuditEntryRepository}, накапливающим созданные строки. Живая БД не
 * используется.
 */

/** Машинные имена параметров Задачи, изменения которых журналируются (Req 20.1). */
const FIELDS = ['title', 'description', 'deadline', 'executors', 'managers', 'status'] as const;

/** Базовый момент времени, от которого детерминированно отсчитываются записи. */
const BASE_MS = Date.UTC(2030, 0, 1, 0, 0, 0);

/**
 * Стабильный момент времени Задачи: каждый вызов {@link NowProvider.now}
 * возвращает свой возрастающий момент и фиксирует его, чтобы тест мог сверить
 * `changedAt` каждой записи с временем на момент её создания.
 */
function makeRecordingClock(): { clock: ClockService; emitted: Date[] } {
  const emitted: Date[] = [];
  const provider: NowProvider = {
    now: (): Date => {
      // Каждое изменение фиксируется уникальным моментом времени (1 мин шаг).
      const moment = new Date(BASE_MS + emitted.length * 60_000);
      emitted.push(moment);
      return moment;
    },
  };
  return { clock: new ClockService(provider), emitted };
}

/**
 * Собирает сервис Журнала с in-memory репозиторием записей. Репозитории Задач и
 * Пользователей не используются методом {@link AuditLogService.record}.
 */
function buildService() {
  const created: AuditEntryCreateData[] = [];
  const auditEntryRepository = {
    create: jest.fn(async (data: AuditEntryCreateData) => {
      created.push(data);
      return { id: `e${created.length}`, ...data };
    }),
    listByTaskNewestFirst: jest.fn(async () => []),
  } as unknown as AuditEntryRepository;

  const taskRepository = {} as unknown as TaskRepository;
  const userRepository = {} as unknown as UserRepository;

  const { clock, emitted } = makeRecordingClock();
  const service = new AuditLogService(auditEntryRepository, taskRepository, userRepository, clock);
  return { service, created, emitted };
}

/** Строковое значение параметра либо `null` (параметр не задан/очищен). */
const valueArb: fc.Arbitrary<string | null> = fc.option(fc.string({ maxLength: 50 }), {
  nil: null,
});

/** Генератор одного изменения параметра/статуса Задачи (Req 20.1). */
const changeArb: fc.Arbitrary<AuditFieldChange> = fc.record({
  taskId: fc.uuid(),
  authorId: fc.uuid(),
  field: fc.constantFrom(...FIELDS),
  oldValue: valueArb,
  newValue: valueArb,
});

describe('AuditLogService.record — Property 56: запись на каждое изменение', () => {
  it('создаёт ровно одну запись на каждое изменение со всеми полями и временем (Req 20.1)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(changeArb, { minLength: 1, maxLength: 30 }), async (changes) => {
        const { service, created, emitted } = buildService();

        for (const change of changes) {
          await service.record(change);
        }

        // Ровно одна запись Журнала на каждое изменение.
        expect(created).toHaveLength(changes.length);

        changes.forEach((change, i) => {
          const row = created[i];
          const moment = emitted[i];
          expect(row).toBeDefined();
          expect(moment).toBeDefined();
          if (row === undefined || moment === undefined) {
            return;
          }
          // Каждая запись несёт автора, параметр, прежнее и новое значение.
          expect(row.authorId).toBe(change.authorId);
          expect(row.taskId).toBe(change.taskId);
          expect(row.field).toBe(change.field);
          expect(row.oldValue).toBe(change.oldValue);
          expect(row.newValue).toBe(change.newValue);
          // Момент изменения зафиксирован текущим временем ClockService.
          expect(row.changedAt).toBeInstanceOf(Date);
          expect(row.changedAt.getTime()).toBe(moment.getTime());
        });
      }),
      { numRuns: 200 },
    );
  });
});
