import type { SpreadsheetPreview, SpreadsheetPreviewOptions } from './attachments';

const DEFAULT_PREVIEW_ROWS = 80;
const DEFAULT_PREVIEW_COLUMNS = 16;
const XLS_OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const FREE_SECT = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECT = 0xfffffffd;
const DIFAT_SECT = 0xfffffffc;

interface CompoundDirectoryEntry {
  name: string;
  type: number;
  startSector: number;
  size: number;
}

interface BiffRecord {
  id: number;
  data: Uint8Array;
}

function u16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    return 0;
  }
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    return FREE_SECT;
  }
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function isRegularSector(sector: number): boolean {
  return sector < DIFAT_SECT;
}

function isOleCompoundFile(bytes: Uint8Array): boolean {
  return XLS_OLE_MAGIC.every((byte, index) => bytes[index] === byte);
}

function sectorOffset(sector: number, sectorSize: number): number {
  return (sector + 1) * sectorSize;
}

function sector(bytes: Uint8Array, sectorId: number, sectorSize: number): Uint8Array | null {
  const offset = sectorOffset(sectorId, sectorSize);
  if (!isRegularSector(sectorId) || offset < 0 || offset + sectorSize > bytes.length) {
    return null;
  }
  return bytes.subarray(offset, offset + sectorSize);
}

function concat(parts: Uint8Array[], sizeLimit?: number): Uint8Array {
  const totalSize =
    sizeLimit ??
    parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    const chunk = part.subarray(0, Math.min(part.length, totalSize - offset));
    out.set(chunk, offset);
    offset += chunk.length;
    if (offset >= totalSize) {
      break;
    }
  }
  return out;
}

function readChain(
  bytes: Uint8Array,
  fat: number[],
  startSector: number,
  sectorSize: number,
  sizeLimit?: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const seen = new Set<number>();
  let current = startSector;
  let total = 0;

  while (isRegularSector(current) && !seen.has(current) && current < fat.length) {
    seen.add(current);
    const currentSector = sector(bytes, current, sectorSize);
    if (currentSector === null) {
      break;
    }
    parts.push(currentSector);
    total += currentSector.length;
    if (sizeLimit !== undefined && total >= sizeLimit) {
      return concat(parts, sizeLimit);
    }
    const next = fat[current];
    if (next === undefined || next === END_OF_CHAIN || next === FREE_SECT) {
      break;
    }
    current = next;
  }

  return concat(parts, sizeLimit);
}

function parseFatEntries(bytes: Uint8Array): number[] {
  const entries: number[] = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    entries.push(u32(bytes, offset));
  }
  return entries;
}

function utf16Le(bytes: Uint8Array, offset: number, byteLength: number): string {
  let text = '';
  const end = Math.min(bytes.length, offset + byteLength);
  for (let index = offset; index + 1 < end; index += 2) {
    const code = u16(bytes, index);
    if (code === 0) {
      break;
    }
    text += String.fromCharCode(code);
  }
  return text;
}

function readDirectoryEntries(directory: Uint8Array): CompoundDirectoryEntry[] {
  const entries: CompoundDirectoryEntry[] = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameBytes = u16(directory, offset + 64);
    const name = nameBytes >= 2 ? utf16Le(directory, offset, nameBytes - 2) : '';
    const type = directory[offset + 66] ?? 0;
    const lowSize = u32(directory, offset + 120);
    const highSize = u32(directory, offset + 124);
    entries.push({
      name,
      type,
      startSector: u32(directory, offset + 116),
      size: lowSize + highSize * 2 ** 32,
    });
  }
  return entries;
}

function extractWorkbookStream(bytes: Uint8Array): { bytes: Uint8Array; sheetName: string | null } {
  if (!isOleCompoundFile(bytes)) {
    return { bytes, sheetName: null };
  }

  const sectorSize = 2 ** u16(bytes, 30);
  const miniSectorSize = 2 ** u16(bytes, 32);
  const firstDirectorySector = u32(bytes, 48);
  const miniStreamCutoff = u32(bytes, 56);
  const firstMiniFatSector = u32(bytes, 60);
  const firstDifatSector = u32(bytes, 68);
  const difatSectorCount = u32(bytes, 72);

  if (![512, 4096].includes(sectorSize) || miniSectorSize !== 64) {
    return { bytes, sheetName: null };
  }

  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const value = u32(bytes, 76 + index * 4);
    if (isRegularSector(value) || value === FAT_SECT) {
      fatSectors.push(value);
    }
  }

  let difatSector = firstDifatSector;
  for (let index = 0; index < difatSectorCount && isRegularSector(difatSector); index += 1) {
    const difat = sector(bytes, difatSector, sectorSize);
    if (difat === null) {
      break;
    }
    const entryCount = sectorSize / 4 - 1;
    for (let entry = 0; entry < entryCount; entry += 1) {
      const value = u32(difat, entry * 4);
      if (isRegularSector(value) || value === FAT_SECT) {
        fatSectors.push(value);
      }
    }
    difatSector = u32(difat, sectorSize - 4);
  }

  const fat: number[] = [];
  for (const fatSector of fatSectors) {
    const fatBytes = sector(bytes, fatSector, sectorSize);
    if (fatBytes !== null) {
      fat.push(...parseFatEntries(fatBytes));
    }
  }

  const directory = readChain(bytes, fat, firstDirectorySector, sectorSize);
  const entries = readDirectoryEntries(directory);
  const root = entries.find((entry) => entry.type === 5);
  const workbook = entries.find((entry) => {
    const name = entry.name.trim().toLowerCase();
    return entry.type === 2 && (name === 'workbook' || name === 'book');
  });

  if (workbook === undefined) {
    return { bytes, sheetName: null };
  }

  const readRegularStream = (entry: CompoundDirectoryEntry): Uint8Array =>
    readChain(bytes, fat, entry.startSector, sectorSize, entry.size);

  if (
    root !== undefined &&
    workbook.size > 0 &&
    workbook.size < miniStreamCutoff &&
    isRegularSector(firstMiniFatSector)
  ) {
    const miniFatBytes = readChain(bytes, fat, firstMiniFatSector, sectorSize);
    const miniFat = parseFatEntries(miniFatBytes);
    const miniStream = readRegularStream(root);
    const parts: Uint8Array[] = [];
    const seen = new Set<number>();
    let current = workbook.startSector;
    let total = 0;

    while (isRegularSector(current) && !seen.has(current) && current < miniFat.length) {
      seen.add(current);
      const offset = current * miniSectorSize;
      if (offset + miniSectorSize > miniStream.length) {
        break;
      }
      parts.push(miniStream.subarray(offset, offset + miniSectorSize));
      total += miniSectorSize;
      if (total >= workbook.size) {
        return { bytes: concat(parts, workbook.size), sheetName: workbook.name };
      }
      const next = miniFat[current];
      if (next === undefined || next === END_OF_CHAIN || next === FREE_SECT) {
        break;
      }
      current = next;
    }
    return { bytes: concat(parts, workbook.size), sheetName: workbook.name };
  }

  return { bytes: readRegularStream(workbook), sheetName: workbook.name };
}

function readBiffRecords(bytes: Uint8Array): BiffRecord[] {
  const records: BiffRecord[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const id = u16(bytes, offset);
    const length = u16(bytes, offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) {
      break;
    }
    records.push({ id, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return records;
}

class SegmentedReader {
  private segmentIndex = 0;
  private offset = 0;

  constructor(private readonly segments: Uint8Array[]) {}

  private current(): Uint8Array | null {
    while (
      this.segmentIndex < this.segments.length &&
      this.offset >= (this.segments[this.segmentIndex]?.length ?? 0)
    ) {
      this.segmentIndex += 1;
      this.offset = 0;
    }
    return this.segments[this.segmentIndex] ?? null;
  }

  readByte(): number | null {
    const current = this.current();
    if (current === null) {
      return null;
    }
    const value = current[this.offset] ?? null;
    this.offset += 1;
    return value;
  }

  readUInt16(): number | null {
    const low = this.readByte();
    const high = this.readByte();
    return low === null || high === null ? null : low + (high << 8);
  }

  readUInt32(): number | null {
    const b0 = this.readByte();
    const b1 = this.readByte();
    const b2 = this.readByte();
    const b3 = this.readByte();
    if (b0 === null || b1 === null || b2 === null || b3 === null) {
      return null;
    }
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  skip(byteCount: number): void {
    for (let index = 0; index < byteCount; index += 1) {
      if (this.readByte() === null) {
        break;
      }
    }
  }

  readCharacters(characterCount: number, highByte: boolean): string {
    let isHighByte = highByte;
    const codes: number[] = [];

    const readTextByte = (): number | null => {
      while (this.segmentIndex < this.segments.length) {
        const current = this.segments[this.segmentIndex];
        if (current !== undefined && this.offset < current.length) {
          const value = current[this.offset] ?? null;
          this.offset += 1;
          return value;
        }
        this.segmentIndex += 1;
        this.offset = 0;
        const flags = this.readByte();
        if (flags === null) {
          return null;
        }
        isHighByte = (flags & 0x01) !== 0;
      }
      return null;
    };

    for (let index = 0; index < characterCount; index += 1) {
      const low = readTextByte();
      if (low === null) {
        break;
      }
      const high = isHighByte ? readTextByte() : 0;
      if (high === null) {
        break;
      }
      codes.push(low + (high << 8));
    }

    return String.fromCharCode(...codes);
  }
}

function parseBiffString(reader: SegmentedReader): string | null {
  const length = reader.readUInt16();
  const flags = reader.readByte();
  if (length === null || flags === null) {
    return null;
  }

  const hasExtended = (flags & 0x04) !== 0;
  const hasRichText = (flags & 0x08) !== 0;
  const richRuns = hasRichText ? reader.readUInt16() ?? 0 : 0;
  const extendedBytes = hasExtended ? reader.readUInt32() ?? 0 : 0;
  const text = reader.readCharacters(length, (flags & 0x01) !== 0);

  reader.skip(richRuns * 4);
  reader.skip(extendedBytes);
  return text;
}

function parseInlineBiffString(bytes: Uint8Array, offset: number): string {
  const reader = new SegmentedReader([bytes.subarray(offset)]);
  return parseBiffString(reader) ?? '';
}

function parseSst(records: BiffRecord[]): string[] {
  const sst: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record?.id !== 0x00fc) {
      continue;
    }

    const uniqueCount = u32(record.data, 4);
    const segments = [record.data.subarray(8)];
    let next = index + 1;
    while (records[next]?.id === 0x003c) {
      segments.push(records[next]?.data ?? new Uint8Array());
      next += 1;
    }

    const reader = new SegmentedReader(segments);
    for (let stringIndex = 0; stringIndex < uniqueCount; stringIndex += 1) {
      const value = parseBiffString(reader);
      if (value === null) {
        break;
      }
      sst.push(value);
    }
    break;
  }
  return sst;
}

function parseBoundSheetNames(records: BiffRecord[]): string[] {
  const names: string[] = [];
  for (const record of records) {
    if (record.id !== 0x0085 || record.data.length < 8) {
      continue;
    }
    const length = record.data[6] ?? 0;
    const flags = record.data[7] ?? 0;
    const offset = 8;
    if ((flags & 0x01) !== 0) {
      names.push(utf16Le(record.data, offset, length * 2));
    } else {
      let name = '';
      for (let index = 0; index < length && offset + index < record.data.length; index += 1) {
        name += String.fromCharCode(record.data[offset + index] ?? 0);
      }
      names.push(name);
    }
  }
  return names;
}

function decodeRk(raw: number): number {
  const multiplied = (raw & 0x01) !== 0;
  const isInteger = (raw & 0x02) !== 0;
  let value: number;

  if (isInteger) {
    value = raw >> 2;
  } else {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, raw & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }

  return multiplied ? value / 100 : value;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  }
  return String(value);
}

function buildPreview(
  rows: Map<number, Map<number, unknown>>,
  sheetName: string | null,
  options: SpreadsheetPreviewOptions,
): SpreadsheetPreview {
  const maxRows = options.maxRows ?? DEFAULT_PREVIEW_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_PREVIEW_COLUMNS;
  const maxRow = Math.max(-1, ...rows.keys());
  let maxColumn = -1;
  for (const row of rows.values()) {
    maxColumn = Math.max(maxColumn, ...row.keys());
  }

  const totalRows = maxRow + 1;
  const totalColumns = maxColumn + 1;
  const visibleRows = Math.min(totalRows, maxRows);
  const visibleColumns = Math.min(totalColumns, maxColumns);
  const previewRows = Array.from({ length: visibleRows }, (_, rowIndex) => {
    const row = rows.get(rowIndex);
    return Array.from({ length: visibleColumns }, (_, columnIndex) =>
      formatCell(row?.get(columnIndex)),
    );
  });

  return {
    sheetName,
    rows: previewRows,
    totalRows,
    totalColumns,
    visibleRows,
    visibleColumns,
  };
}

function setCell(
  rows: Map<number, Map<number, unknown>>,
  rowIndex: number,
  columnIndex: number,
  value: unknown,
): void {
  if (value === null || value === undefined || value === '') {
    return;
  }
  const row = rows.get(rowIndex) ?? new Map<number, unknown>();
  row.set(columnIndex, value);
  rows.set(rowIndex, row);
}

function parseWorksheetCells(records: BiffRecord[], sst: string[]): {
  rows: Map<number, Map<number, unknown>>;
  sheetIndex: number;
} {
  const rows = new Map<number, Map<number, unknown>>();
  let inWorksheet = false;
  let sheetIndex = -1;

  for (const record of records) {
    if (record.id === 0x0809) {
      const streamType = u16(record.data, 2);
      if (streamType === 0x0010) {
        inWorksheet = true;
        sheetIndex += 1;
      }
      continue;
    }

    if (!inWorksheet) {
      continue;
    }

    if (record.id === 0x000a) {
      break;
    }

    if (record.data.length < 6) {
      continue;
    }

    const row = u16(record.data, 0);
    const column = u16(record.data, 2);

    switch (record.id) {
      case 0x00fd: {
        const sstIndex = u32(record.data, 6);
        setCell(rows, row, column, sst[sstIndex] ?? '');
        break;
      }
      case 0x0204: {
        setCell(rows, row, column, parseInlineBiffString(record.data, 6));
        break;
      }
      case 0x0203: {
        if (record.data.length >= 14) {
          const view = new DataView(
            record.data.buffer,
            record.data.byteOffset + 6,
            8,
          );
          setCell(rows, row, column, view.getFloat64(0, true));
        }
        break;
      }
      case 0x027e: {
        if (record.data.length >= 10) {
          setCell(rows, row, column, decodeRk(u32(record.data, 6)));
        }
        break;
      }
      case 0x00bd: {
        if (record.data.length >= 10) {
          const firstColumn = u16(record.data, 2);
          const lastColumn = u16(record.data, record.data.length - 2);
          let offset = 4;
          for (let col = firstColumn; col <= lastColumn && offset + 6 <= record.data.length - 2; col += 1) {
            setCell(rows, row, col, decodeRk(u32(record.data, offset + 2)));
            offset += 6;
          }
        }
        break;
      }
      case 0x0205: {
        const value = record.data[6] ?? 0;
        const isError = (record.data[7] ?? 0) !== 0;
        setCell(rows, row, column, isError ? '#ERROR' : value !== 0 ? 'TRUE' : 'FALSE');
        break;
      }
      case 0x0006: {
        if (record.data.length >= 14) {
          const special1 = record.data[12] ?? 0;
          const special2 = record.data[13] ?? 0;
          if (!(special1 === 0xff && special2 === 0xff)) {
            const view = new DataView(
              record.data.buffer,
              record.data.byteOffset + 6,
              8,
            );
            setCell(rows, row, column, view.getFloat64(0, true));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return { rows, sheetIndex };
}

export function parseBinaryXlsPreview(
  bytes: Uint8Array,
  options: SpreadsheetPreviewOptions = {},
): SpreadsheetPreview {
  const workbook = extractWorkbookStream(bytes);
  const records = readBiffRecords(workbook.bytes);
  const sst = parseSst(records);
  const sheetNames = parseBoundSheetNames(records);
  const { rows, sheetIndex } = parseWorksheetCells(records, sst);

  return buildPreview(
    rows,
    sheetNames[sheetIndex] ?? workbook.sheetName ?? 'Лист 1',
    options,
  );
}
