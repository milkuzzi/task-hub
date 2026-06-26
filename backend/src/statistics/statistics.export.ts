import { TaskStatus } from '@prisma/client';
import { deflateRawSync } from 'node:zlib';
import { ALL_TASK_STATUSES } from './statistics.math';
import { Statistics } from './statistics.types';

/**
 * Формирование файла экспорта статистики (Req 17.9, 17.10).
 *
 * Здесь сосредоточены чистые функции построения экспортируемого набора строк по
 * рассчитанной статистике и их сериализации в форматы CSV и XLSX без внешних
 * зависимостей. Отделение от прикладного сервиса делает форматирование
 * детерминированным и пригодным для модульных и property-based-тестов
 * (свойство 51 — полнота экспортируемого файла).
 *
 * Расчёт самих показателей выполняется в {@link ./statistics.math}; данный
 * модуль лишь раскладывает готовую {@link Statistics} в плоскую таблицу
 * «Показатель → Значение», охватывающую все отображаемые Администратору
 * показатели за выбранный период.
 */

/** Поддерживаемые форматы экспорта (Req 17.9). */
export type ExportFormat = 'csv' | 'xlsx';

/**
 * Готовый к скачиванию файл экспорта статистики (соответствует `FileStream` из
 * дизайна): имя, MIME-тип и бинарное содержимое.
 */
export interface StatisticsFile {
  /** Имя файла для скачивания (с расширением, соответствующим формату). */
  filename: string;
  /** MIME-тип содержимого. */
  mimeType: string;
  /** Бинарное содержимое файла. */
  content: Buffer;
}

/** Строка экспортируемой таблицы: подпись показателя и его значение. */
export interface ExportRow {
  /** Человекочитаемая подпись показателя (RU). */
  label: string;
  /** Значение показателя — число или строка. */
  value: string | number;
}

/** Локализованные русские названия Статусов для подписей в экспорте (Req 17.1). */
export const STATUS_LABELS_RU: Record<TaskStatus, string> = {
  [TaskStatus.IN_PROGRESS]: 'В работе',
  [TaskStatus.WAITING]: 'Ожидает',
  [TaskStatus.DONE]: 'Выполнено',
  [TaskStatus.NEEDS_ADMIN]: 'Требует администратора',
  [TaskStatus.CANCELLED]: 'Отменено',
};

/** MIME-типы по формату экспорта. */
const MIME_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Строит плоский список строк экспорта из рассчитанной статистики, охватывающий
 * ВСЕ отображаемые Администратору показатели за период (Req 17.9).
 *
 * Порядок и состав показателей фиксированы: период, общее число задач, разбивка
 * по всем Статусам (включая нулевые), просрочки (количество и доля), среднее
 * время выполнения, разрезы по каждому Менеджеру и Исполнителю, активность
 * Чатов и признак отсутствия данных. Это гарантирует, что экспортируемый файл
 * содержит ровно те же показатели, что и отображаемая статистика.
 *
 * @param stats Рассчитанная статистика.
 * @param formatPeriod Функция форматирования момента времени в строку MSK
 *   (обычно {@link ClockService.formatMsk}), используемая для подписи периода.
 * @returns Упорядоченный список строк «Показатель → Значение».
 */
export function buildExportRows(
  stats: Statistics,
  formatPeriod: (date: Date) => string,
): ExportRow[] {
  const rows: ExportRow[] = [];

  const periodLabel =
    stats.period === null
      ? 'Весь период'
      : `${formatPeriod(stats.period.start)} — ${formatPeriod(stats.period.end)}`;
  rows.push({ label: 'Период', value: periodLabel });

  rows.push({ label: 'Всего задач', value: stats.totalTasks });

  // Разбивка по всем Статусам в стабильном порядке, включая нулевые (Req 17.1).
  for (const status of ALL_TASK_STATUSES) {
    rows.push({
      label: `Задач в статусе «${STATUS_LABELS_RU[status]}»`,
      value: stats.byStatus[status],
    });
  }

  rows.push({ label: 'Просрочено задач', value: stats.overdueCount });
  rows.push({ label: 'Доля просроченных, %', value: stats.overduePercent });
  rows.push({
    label: 'Среднее время выполнения, ч',
    value: stats.averageCompletionHours,
  });

  // Разрезы по участникам (Req 17.4): по одной строке на каждого Менеджера и
  // каждого Исполнителя, имеющего задачи за период.
  for (const [managerId, count] of Object.entries(stats.byManager)) {
    rows.push({ label: `Задач у менеджера ${managerId}`, value: count });
  }
  for (const [executorId, count] of Object.entries(stats.byExecutor)) {
    rows.push({ label: `Задач у исполнителя ${executorId}`, value: count });
  }

  rows.push({ label: 'Сообщений всего', value: stats.chatActivity.totalMessages });
  rows.push({ label: 'Активных чатов', value: stats.chatActivity.activeChats });

  rows.push({ label: 'Данные за период отсутствуют', value: stats.noData ? 'да' : 'нет' });

  return rows;
}

/** Заголовки колонок экспортируемой таблицы. */
const HEADER: readonly [string, string] = ['Показатель', 'Значение'];

/**
 * Экранирует значение поля для CSV по правилам RFC 4180: поля, содержащие
 * запятую, кавычку или перевод строки, заключаются в кавычки, внутренние
 * кавычки удваиваются.
 */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Сериализует строки экспорта в CSV (Req 17.9).
 *
 * Используются разделитель-запятая и перевод строки CRLF (RFC 4180); файл
 * предваряется BOM UTF-8, чтобы Excel корректно отображал кириллицу.
 *
 * @param rows Строки экспорта.
 * @returns Содержимое CSV-файла.
 */
export function toCsv(rows: readonly ExportRow[]): Buffer {
  const lines: string[] = [];
  lines.push(HEADER.map(escapeCsvField).join(','));
  for (const row of rows) {
    lines.push([escapeCsvField(row.label), escapeCsvField(String(row.value))].join(','));
  }
  const body = lines.join('\r\n');
  // BOM UTF-8 для корректного распознавания кодировки Excel.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
}

/** Экранирует текст для XML-содержимого ячеек XLSX. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Имя ячейки в нотации A1 по индексам строки (0-based) и колонки (0-based). */
function cellRef(rowIndex: number, colIndex: number): string {
  let col = '';
  let n = colIndex;
  do {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${col}${rowIndex + 1}`;
}

/** Формирует XML одной ячейки: число — как `<v>`, строка — как inlineStr. */
function cellXml(ref: string, value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    String(value),
  )}</t></is></c>`;
}

/** Формирует XML листа из строк (включая строку заголовка). */
function buildSheetXml(rows: readonly ExportRow[]): string {
  const matrix: (string | number)[][] = [
    [HEADER[0], HEADER[1]],
    ...rows.map((row) => [row.label, row.value]),
  ];
  const xmlRows = matrix
    .map((cells, rowIndex) => {
      const xmlCells = cells
        .map((value, colIndex) => cellXml(cellRef(rowIndex, colIndex), value))
        .join('');
      return `<row r="${rowIndex + 1}">${xmlCells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${xmlRows}</sheetData>` +
    '</worksheet>'
  );
}

/** Предвычисленная таблица CRC32 (полином 0xEDB88320). */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Вычисляет CRC32 буфера (для записей ZIP-контейнера). */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] as number;
    const index = (crc ^ byte) & 0xff;
    crc = (CRC32_TABLE[index] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Запись для упаковки в ZIP-контейнер. */
interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Упаковывает набор файлов в минимальный валидный ZIP-контейнер с дефлейт-сжатием
 * (метод 8). Используется для формирования контейнера XLSX (Office Open XML)
 * без внешних зависимостей.
 */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressed = deflateRawSync(entry.data);
    const compressedSize = compressed.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // сигнатура локального заголовка
    localHeader.writeUInt16LE(20, 4); // версия для распаковки
    localHeader.writeUInt16LE(0, 6); // флаги
    localHeader.writeUInt16LE(8, 8); // метод сжатия — deflate
    localHeader.writeUInt16LE(0, 10); // время модификации
    localHeader.writeUInt16LE(0, 12); // дата модификации
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // длина доп. поля

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // сигнатура записи каталога
    centralHeader.writeUInt16LE(20, 4); // версия создателя
    centralHeader.writeUInt16LE(20, 6); // версия для распаковки
    centralHeader.writeUInt16LE(0, 8); // флаги
    centralHeader.writeUInt16LE(8, 10); // метод сжатия — deflate
    centralHeader.writeUInt16LE(0, 12); // время
    centralHeader.writeUInt16LE(0, 14); // дата
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // доп. поле
    centralHeader.writeUInt16LE(0, 32); // комментарий
    centralHeader.writeUInt16LE(0, 34); // номер диска
    centralHeader.writeUInt16LE(0, 36); // внутренние атрибуты
    centralHeader.writeUInt32LE(0, 38); // внешние атрибуты
    centralHeader.writeUInt32LE(offset, 42); // смещение локального заголовка

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // сигнатура конца каталога
  end.writeUInt16LE(0, 4); // номер диска
  end.writeUInt16LE(0, 6); // диск с началом каталога
  end.writeUInt16LE(entries.length, 8); // записей на диске
  end.writeUInt16LE(entries.length, 10); // всего записей
  end.writeUInt32LE(centralDirectory.length, 12); // размер каталога
  end.writeUInt32LE(localSection.length, 16); // смещение каталога
  end.writeUInt16LE(0, 20); // длина комментария

  return Buffer.concat([localSection, centralDirectory, end]);
}

/**
 * Сериализует строки экспорта в файл XLSX (Office Open XML) (Req 17.9).
 *
 * Формирует минимальный валидный пакет XLSX: типы содержимого, корневые связи,
 * книгу с одним листом и сам лист с данными. Все строковые значения хранятся как
 * inline-строки, что не требует таблицы общих строк.
 *
 * @param rows Строки экспорта.
 * @returns Содержимое XLSX-файла.
 */
export function toXlsx(rows: readonly ExportRow[]): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Статистика" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  const sheet = buildSheetXml(rows);

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

/**
 * Формирует готовый к скачиванию файл статистики в выбранном формате (Req 17.9).
 *
 * Чистая функция: по рассчитанной статистике и форматтеру MSK строит набор строк
 * и сериализует их в CSV или XLSX, возвращая имя файла, MIME-тип и содержимое.
 *
 * @param stats Рассчитанная статистика.
 * @param format Выбранный Администратором формат (`csv` или `xlsx`).
 * @param formatPeriod Форматтер момента времени в строку MSK.
 * @returns Файл экспорта.
 */
export function buildStatisticsFile(
  stats: Statistics,
  format: ExportFormat,
  formatPeriod: (date: Date) => string,
): StatisticsFile {
  const rows = buildExportRows(stats, formatPeriod);
  const content = format === 'csv' ? toCsv(rows) : toXlsx(rows);
  return {
    filename: `statistics.${format}`,
    mimeType: MIME_TYPES[format],
    content,
  };
}
