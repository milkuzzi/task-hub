import { TaskStatus } from '@prisma/client';
import { inflateRawSync } from 'node:zlib';
import {
  buildExportRows,
  buildStatisticsFile,
  STATUS_LABELS_RU,
  toCsv,
  toXlsx,
} from './statistics.export';
import { ALL_TASK_STATUSES } from './statistics.math';
import { Statistics } from './statistics.types';

/**
 * Модульные тесты формирования файла экспорта статистики (Req 17.9, 17.10).
 *
 * Проверяют полноту набора строк (все отображаемые показатели), корректность
 * сериализации в CSV (BOM, экранирование) и валидность контейнера XLSX
 * (распаковка ZIP-записи листа и присутствие значений).
 */

const fixedFormatMsk = (date: Date): string => `MSK:${date.toISOString()}`;

function makeStatistics(overrides: Partial<Statistics> = {}): Statistics {
  const byStatus = {
    [TaskStatus.IN_PROGRESS]: 2,
    [TaskStatus.WAITING]: 1,
    [TaskStatus.DONE]: 3,
    [TaskStatus.NEEDS_ADMIN]: 0,
    [TaskStatus.CANCELLED]: 1,
  } as Record<TaskStatus, number>;
  return {
    byStatus,
    totalTasks: 7,
    overdueCount: 2,
    overduePercent: 28.6,
    averageCompletionHours: 5.5,
    byManager: { 'mgr-1': 4, 'mgr-2': 3 },
    byExecutor: { 'exec-1': 5 },
    chatActivity: { totalMessages: 42, activeChats: 3 },
    period: {
      start: new Date('2024-01-01T00:00:00.000Z'),
      end: new Date('2024-01-31T23:59:00.000Z'),
    },
    noData: false,
    ...overrides,
  };
}

describe('buildExportRows — полнота показателей (Req 17.9)', () => {
  it('включает период, итог, все статусы, просрочки, среднее, участников, чаты и признак отсутствия данных', () => {
    const stats = makeStatistics();
    const rows = buildExportRows(stats, fixedFormatMsk);
    const labels = rows.map((r) => r.label);
    const find = (label: string) => rows.find((r) => r.label === label)?.value;

    expect(find('Период')).toBe(
      `MSK:${stats.period!.start.toISOString()} — MSK:${stats.period!.end.toISOString()}`,
    );
    expect(find('Всего задач')).toBe(7);

    // Каждый статус присутствует, включая нулевой NEEDS_ADMIN (Req 17.1).
    for (const status of ALL_TASK_STATUSES) {
      const label = `Задач в статусе «${STATUS_LABELS_RU[status]}»`;
      expect(labels).toContain(label);
      expect(find(label)).toBe(stats.byStatus[status]);
    }

    expect(find('Просрочено задач')).toBe(2);
    expect(find('Доля просроченных, %')).toBe(28.6);
    expect(find('Среднее время выполнения, ч')).toBe(5.5);

    expect(find('Задач у менеджера mgr-1')).toBe(4);
    expect(find('Задач у менеджера mgr-2')).toBe(3);
    expect(find('Задач у исполнителя exec-1')).toBe(5);

    expect(find('Сообщений всего')).toBe(42);
    expect(find('Активных чатов')).toBe(3);
    expect(find('Данные за период отсутствуют')).toBe('нет');
  });

  it('для отсутствующего периода подписывает «Весь период» и отражает признак отсутствия данных', () => {
    const stats = makeStatistics({ period: null, noData: true });
    const rows = buildExportRows(stats, fixedFormatMsk);
    expect(rows.find((r) => r.label === 'Период')?.value).toBe('Весь период');
    expect(rows.find((r) => r.label === 'Данные за период отсутствуют')?.value).toBe('да');
  });
});

describe('toCsv (Req 17.9)', () => {
  it('начинается с BOM UTF-8 и содержит заголовок и строки через CRLF', () => {
    const stats = makeStatistics({ period: null });
    const buf = toCsv(buildExportRows(stats, fixedFormatMsk));
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = buf.subarray(3).toString('utf8');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('Показатель,Значение');
    expect(lines).toContain('Всего задач,7');
  });

  it('экранирует поля с запятыми и кавычками по RFC 4180', () => {
    const stats = makeStatistics({ period: null, byManager: { 'a,b"c': 1 }, byExecutor: {} });
    const text = toCsv(buildExportRows(stats, fixedFormatMsk)).subarray(3).toString('utf8');
    expect(text).toContain('"Задач у менеджера a,b""c",1');
  });
});

describe('toXlsx (Req 17.9)', () => {
  it('формирует валидный ZIP-контейнер (сигнатура PK) с записью листа', () => {
    const buf = toXlsx(buildExportRows(makeStatistics(), fixedFormatMsk));
    // Локальный заголовок ZIP начинается с PK\x03\x04.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // Присутствует запись конца центрального каталога.
    expect(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    // Имена ключевых частей пакета присутствуют в контейнере.
    expect(buf.includes(Buffer.from('xl/worksheets/sheet1.xml', 'utf8'))).toBe(true);
    expect(buf.includes(Buffer.from('[Content_Types].xml', 'utf8'))).toBe(true);
  });

  it('хранит данные листа в распаковываемом виде, содержащем значения показателей', () => {
    const stats = makeStatistics();
    const buf = toXlsx(buildExportRows(stats, fixedFormatMsk));
    const sheetXml = extractZipEntry(buf, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toContain('Показатель');
    expect(sheetXml).toContain('Всего задач');
    // Числовое значение итога хранится как <v>7</v>.
    expect(sheetXml).toContain('<v>7</v>');
  });
});

describe('buildStatisticsFile (Req 17.9)', () => {
  it('возвращает CSV-файл с именем и MIME-типом', () => {
    const file = buildStatisticsFile(makeStatistics(), 'csv', fixedFormatMsk);
    expect(file.filename).toBe('statistics.csv');
    expect(file.mimeType).toContain('text/csv');
    expect(file.content.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('возвращает XLSX-файл с именем и MIME-типом', () => {
    const file = buildStatisticsFile(makeStatistics(), 'xlsx', fixedFormatMsk);
    expect(file.filename).toBe('statistics.xlsx');
    expect(file.mimeType).toContain('spreadsheetml.sheet');
    expect(file.content.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  });
});

/**
 * Извлекает и распаковывает содержимое именованной записи из ZIP-буфера —
 * минимальный парсер для проверки в тестах (метод сжатия — deflate).
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
