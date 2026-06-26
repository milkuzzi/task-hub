import { describe, expect, it } from 'vitest';
import { parseBinaryXlsPreview } from './xls-preview';

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function le32(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
}

function record(id: number, data: number[]): number[] {
  return [...le16(id), ...le16(data.length), ...data];
}

function biffString(text: string): number[] {
  return [...le16(text.length), 0, ...Array.from(text, (char) => char.charCodeAt(0))];
}

function bof(streamType: number): number[] {
  return record(0x0809, [...le16(0x0600), ...le16(streamType), ...le16(0), ...le16(0)]);
}

function eof(): number[] {
  return record(0x000a, []);
}

function boundSheet(name: string): number[] {
  return record(0x0085, [...le32(0), 0, 0, name.length, 0, ...Array.from(name, (c) => c.charCodeAt(0))]);
}

function sst(strings: string[]): number[] {
  return record(0x00fc, [
    ...le32(strings.length),
    ...le32(strings.length),
    ...strings.flatMap((value) => biffString(value)),
  ]);
}

function labelSst(row: number, column: number, sstIndex: number): number[] {
  return record(0x00fd, [...le16(row), ...le16(column), ...le16(0), ...le32(sstIndex)]);
}

function numberCell(row: number, column: number, value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return record(0x0203, [
    ...le16(row),
    ...le16(column),
    ...le16(0),
    ...Array.from(new Uint8Array(buffer)),
  ]);
}

function boolCell(row: number, column: number, value: boolean): number[] {
  return record(0x0205, [...le16(row), ...le16(column), ...le16(0), value ? 1 : 0, 0]);
}

describe('parseBinaryXlsPreview', () => {
  it('строит предпросмотр старого BIFF .xls с shared strings и числами', () => {
    const workbook = new Uint8Array([
      ...bof(0x0005),
      ...boundSheet('Data'),
      ...sst(['Name', 'Count', 'Alpha']),
      ...eof(),
      ...bof(0x0010),
      ...labelSst(0, 0, 0),
      ...labelSst(0, 1, 1),
      ...labelSst(1, 0, 2),
      ...numberCell(1, 1, 42),
      ...boolCell(2, 0, true),
      ...eof(),
    ]);

    const preview = parseBinaryXlsPreview(workbook, { maxRows: 3, maxColumns: 2 });

    expect(preview.sheetName).toBe('Data');
    expect(preview.rows).toEqual([
      ['Name', 'Count'],
      ['Alpha', '42'],
      ['TRUE', ''],
    ]);
    expect(preview.totalRows).toBe(3);
    expect(preview.totalColumns).toBe(2);
  });
});
