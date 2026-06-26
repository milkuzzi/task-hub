import fc from 'fast-check';
import { TaskStatus } from '@prisma/client';
import { inflateRawSync } from 'node:zlib';
import { buildExportRows, ExportRow, toCsv, toXlsx } from './statistics.export';
import { ALL_TASK_STATUSES } from './statistics.math';
import { DateRange, Statistics } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 51: Полнота экспортируемого файла статистики**
 *
 * Property 51 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.9**:
 *
 * Для любого набора отображаемых показателей экспортируемый файл (CSV или Excel)
 * содержит все эти показатели за выбранный период.
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Множество «отображаемых показателей»
 * — это плоская таблица строк «Показатель → Значение», формируемая чистой
 * функцией {@link buildExportRows} из рассчитанной статистики; именно эти строки
 * показываются Администратору и подлежат экспорту. Свойство проверяется так:
 * по произвольной {@link Statistics} строится набор отображаемых строк, затем
 * файл сериализуется в ОБА формата (CSV и XLSX), после чего из каждого файла
 * данные извлекаются обратно и проверяется, что КАЖДАЯ отображаемая строка
 * (подпись и значение) присутствует в экспортируемом файле.
 *
 * Сериализация и парсинг — чистые функции без внешних границ (БД/Redis/время/
 * файловое I/O отсутствуют), поэтому моки не требуются. Форматтер периода
 * инъецируется детерминированной функцией. Генератор строит произвольные наборы
 * показателей, в том числе с подписями участников, содержащими спецсимволы CSV
 * (запятые, кавычки, переводы строк) и XML (`<`, `>`, `&`, кавычки), чтобы
 * покрыть экранирование и гарантировать полноту независимо от содержимого.
 */
describe('Property 51: Полнота экспортируемого файла статистики (Req 17.9)', () => {
  /** Детерминированный форматтер момента времени в строку для подписи периода. */
  const formatMsk = (date: Date): string => `MSK:${date.toISOString()}`;

  /** Дробное значение с одним знаком после запятой (как доля/среднее). */
  const oneDecimalArb: fc.Arbitrary<number> = fc
    .integer({ min: 0, max: 100_000 })
    .map((n) => n / 10);

  /** Неотрицательный счётчик. */
  const countArb: fc.Arbitrary<number> = fc.nat({ max: 9999 });

  /**
   * Идентификатор участника — произвольная непустая строка, включающая символы,
   * требующие экранирования в CSV и XML, чтобы проверить полноту при любом
   * содержимом подписей.
   */
  const participantIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 12 });

  const periodArb: fc.Arbitrary<DateRange | null> = fc.option(
    fc
      .tuple(
        fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2035-12-31T23:59:59Z') }),
        fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2035-12-31T23:59:59Z') }),
      )
      .map(([start, end]) => ({ start, end })),
    { nil: null },
  );

  const statisticsArb: fc.Arbitrary<Statistics> = fc
    .record({
      byStatus: fc.record(
        ALL_TASK_STATUSES.reduce(
          (acc, status) => {
            acc[status] = countArb;
            return acc;
          },
          {} as Record<TaskStatus, fc.Arbitrary<number>>,
        ),
      ),
      totalTasks: countArb,
      overdueCount: countArb,
      overduePercent: oneDecimalArb,
      averageCompletionHours: oneDecimalArb,
      byManager: fc.dictionary(participantIdArb, countArb, { maxKeys: 6 }),
      byExecutor: fc.dictionary(participantIdArb, countArb, { maxKeys: 6 }),
      chatActivity: fc.record({ totalMessages: countArb, activeChats: countArb }),
      period: periodArb,
      noData: fc.boolean(),
    })
    .map((stats) => stats as Statistics);

  it('CSV содержит все отображаемые показатели за период', () => {
    fc.assert(
      fc.property(statisticsArb, (stats) => {
        const rows = buildExportRows(stats, formatMsk);
        const parsed = parseCsvRows(toCsv(rows));
        assertContainsAll(rows, parsed);
      }),
      { numRuns: 200 },
    );
  });

  it('XLSX содержит все отображаемые показатели за период', () => {
    fc.assert(
      fc.property(statisticsArb, (stats) => {
        const rows = buildExportRows(stats, formatMsk);
        const parsed = parseXlsxRows(toXlsx(rows));
        assertContainsAll(rows, parsed);
      }),
      { numRuns: 200 },
    );
  });
});

/** Пара «подпись → значение в строковом виде» для сравнения независимо от формата. */
interface ParsedRow {
  label: string;
  value: string;
}

/**
 * Проверяет, что каждая отображаемая строка (подпись + значение) присутствует
 * среди извлечённых из экспортируемого файла строк (полнота).
 */
function assertContainsAll(displayed: readonly ExportRow[], parsed: readonly ParsedRow[]): void {
  const present = new Set(parsed.map((r) => `${r.label}\u0000${r.value}`));
  for (const row of displayed) {
    expect(present.has(`${row.label}\u0000${String(row.value)}`)).toBe(true);
  }
}

/**
 * Разбирает CSV-буфер (с BOM UTF-8, разделитель-запятая, RFC 4180) в строки
 * данных без заголовка, возвращая пары «подпись → значение».
 */
function parseCsvRows(buf: Buffer): ParsedRow[] {
  // Снять BOM UTF-8, если присутствует.
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const text = buf.subarray(start).toString('utf8');

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\r') {
      // Перевод строки CRLF: завершить запись на \n.
      if (text[i + 1] === '\n') {
        i += 1;
      }
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else {
      field += ch;
    }
  }
  // Хвостовая запись без завершающего перевода строки.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Первая запись — заголовок «Показатель,Значение».
  return records.slice(1).map((cells) => ({ label: cells[0] ?? '', value: cells[1] ?? '' }));
}

/**
 * Распаковывает лист `xl/worksheets/sheet1.xml` из XLSX-контейнера и извлекает
 * строки данных без заголовка как пары «подпись → значение».
 */
function parseXlsxRows(zip: Buffer): ParsedRow[] {
  const sheetXml = extractZipEntry(zip, 'xl/worksheets/sheet1.xml');
  const rowMatches = sheetXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
  const parsed: ParsedRow[] = [];
  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellRe = /<c\b[^>]*?(?:t="inlineStr")?[^>]*>([\s\S]*?)<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = cellRe.exec(rowXml)) !== null) {
      const inner = match[1] ?? '';
      const inlineStr = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      if (inlineStr) {
        cells.push(unescapeXml(inlineStr[1] ?? ''));
      } else {
        const numeric = /<v>([\s\S]*?)<\/v>/.exec(inner);
        cells.push(numeric ? (numeric[1] ?? '') : '');
      }
    }
    parsed.push({ label: cells[0] ?? '', value: cells[1] ?? '' });
  }
  // Первая строка — заголовок.
  return parsed.slice(1);
}

/** Обратное XML-экранирование пяти стандартных сущностей. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Извлекает и распаковывает содержимое именованной записи из ZIP-буфера
 * (метод сжатия — deflate) — минимальный парсер для проверки в тестах.
 */
function extractZipEntry(zip: Buffer, name: string): string {
  const nameBuf = Buffer.from(name, 'utf8');
  let offset = 0;
  while (offset + 4 <= zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      break;
    }
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const entryName = zip.subarray(offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (entryName.equals(nameBuf)) {
      return inflateRawSync(data).toString('utf8');
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`Запись «${name}» не найдена в ZIP`);
}
