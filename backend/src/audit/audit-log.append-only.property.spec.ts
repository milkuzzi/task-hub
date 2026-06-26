import fc from 'fast-check';
import { AuditEntryRepository } from './audit-entry.repository';
import { AuditLogService } from './audit-log.service';

/**
 * **Feature: task-assignment-system, Property 58: Неизменяемость журнала (append-only)**
 *
 * Property 58 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 20.4**:
 *
 * Для любой последовательности операций множество записей Журнала изменений
 * только растёт: ранее созданные записи не изменяются и не удаляются, и в
 * системе отсутствуют операции их правки или удаления.
 *
 * Тест использует stateful-модель журнала в памяти ({@link InMemoryAuditLog}),
 * которая поддерживает ТОЛЬКО добавление записи (`append`) и чтение
 * (`list` / `listByTaskNewestFirst`) — операций изменения или удаления у неё нет
 * по построению. Для произвольной последовательности операций (добавление и
 * чтение, в т.ч. с пересекающимися задачами) после каждого шага проверяется, что:
 *   - количество записей только не убывает (растёт ровно на 1 при добавлении и
 *     не меняется при чтении);
 *   - все ранее зафиксированные записи по-прежнему присутствуют и не изменены
 *     (префикс журнала совпадает с предыдущим снимком, новая запись лишь
 *     дописывается в конец);
 *   - чтение не изменяет состояние журнала.
 *
 * Дополнительно статически проверяется поверхность API
 * {@link AuditLogService} и {@link AuditEntryRepository}: на них отсутствуют
 * какие-либо методы правки/удаления записей (update/delete/remove/edit/…),
 * то есть запрет изменения и удаления Журнала закреплён в самом интерфейсе
 * (Req 20.4). БД не используется.
 *
 * Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */

/** Запись Журнала в модели (зеркало полей хранимой сущности AuditEntry). */
interface LoggedEntry {
  id: string;
  taskId: string;
  authorId: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
}

/** Полезная нагрузка добавляемой записи (без присваиваемого журналом id). */
type AppendPayload = Omit<LoggedEntry, 'id'>;

/**
 * Append-only журнал в памяти: умеет ТОЛЬКО дописывать запись в конец и читать.
 * Намеренно не предоставляет операций изменения/удаления — это и есть
 * моделируемое инвариантное поведение Журнала (Req 20.4).
 */
class InMemoryAuditLog {
  private readonly entries: LoggedEntry[] = [];
  private seq = 0;

  /** Дописывает одну запись в конец журнала и возвращает её копию. */
  append(payload: AppendPayload): LoggedEntry {
    const entry: LoggedEntry = { id: `e${++this.seq}`, ...payload };
    this.entries.push(entry);
    return { ...entry };
  }

  /** Возвращает копию всех записей в порядке добавления (старые → новые). */
  list(): LoggedEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Возвращает копии записей задачи в порядке от новых к старым (как репозиторий). */
  listByTaskNewestFirst(taskId: string): LoggedEntry[] {
    return this.entries
      .filter((e) => e.taskId === taskId)
      .map((e) => ({ ...e }))
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  }

  /** Текущее количество записей. */
  get size(): number {
    return this.entries.length;
  }
}

type Operation = { type: 'append'; payload: AppendPayload } | { type: 'read'; taskId: string };

const taskIdArb = fc.constantFrom('t1', 't2', 't3');
const nullableStringArb = fc.option(fc.string({ maxLength: 32 }), { nil: null });

const appendPayloadArb: fc.Arbitrary<AppendPayload> = fc.record({
  taskId: taskIdArb,
  authorId: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: null }),
  field: fc.constantFrom('title', 'description', 'deadline', 'executors', 'managers', 'status'),
  oldValue: nullableStringArb,
  newValue: nullableStringArb,
  changedAt: fc.date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2035-01-01T00:00:00Z'),
  }),
});

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 3,
    arbitrary: appendPayloadArb.map((payload) => ({ type: 'append', payload }) as Operation),
  },
  { weight: 1, arbitrary: taskIdArb.map((taskId) => ({ type: 'read', taskId }) as Operation) },
);

/** Имена методов прототипа класса (исключая конструктор). */
function instanceMethodNames(ctor: new (...args: never[]) => unknown): string[] {
  return Object.getOwnPropertyNames(ctor.prototype).filter((name) => name !== 'constructor');
}

describe('Property 58: Неизменяемость журнала (append-only) (Req 20.4)', () => {
  // Запрещённые по смыслу операции правки/удаления записей Журнала.
  const FORBIDDEN = /(update|delete|remove|destroy|edit|modify|patch|^set)/i;

  it('последовательность операций только дописывает записи; ранее созданные не изменяются и не удаляются', () => {
    // Статическая проверка поверхности API: ни сервис, ни репозиторий Журнала не
    // предоставляют операций правки/удаления записей (Req 20.4).
    for (const ctor of [AuditLogService, AuditEntryRepository]) {
      for (const method of instanceMethodNames(
        ctor as unknown as new (...args: never[]) => unknown,
      )) {
        expect(method).not.toMatch(FORBIDDEN);
      }
    }

    fc.assert(
      fc.property(fc.array(operationArb, { maxLength: 60 }), (operations) => {
        const log = new InMemoryAuditLog();
        let previous: LoggedEntry[] = [];

        for (const op of operations) {
          const sizeBefore = log.size;

          if (op.type === 'read') {
            // Чтение не изменяет состояние журнала.
            const byTask = log.listByTaskNewestFirst(op.taskId);
            expect(log.size).toBe(sizeBefore);
            // Чтение согласовано: содержит ровно записи задачи, новые → старые.
            const expectedByTask = previous
              .filter((e) => e.taskId === op.taskId)
              .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
            expect(byTask).toEqual(expectedByTask);
            continue;
          }

          log.append(op.payload);
          const current = log.list();

          // Количество записей только растёт — ровно на одну при добавлении.
          expect(current.length).toBe(sizeBefore + 1);

          // Префикс журнала идентичен предыдущему снимку: ранее созданные записи
          // не изменены и не удалены, новая запись лишь дописана в конец.
          expect(current.slice(0, previous.length)).toEqual(previous);

          previous = current;
        }
      }),
      { numRuns: 200 },
    );
  });
});
