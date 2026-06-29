import { DocumentPreviewService, libreOfficePdfTarget } from './document-preview.service';

describe('DocumentPreviewService.supports', () => {
  const service = new DocumentPreviewService();

  it('поддерживает Word-документы по MIME-типу', () => {
    expect(
      service.supports(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'file.bin',
      ),
    ).toBe(true);
    expect(service.supports('application/msword', 'file.bin')).toBe(true);
    expect(service.supports('application/vnd.oasis.opendocument.text', 'file.bin')).toBe(true);
  });

  it('поддерживает Word-документы по расширению при application/octet-stream', () => {
    expect(service.supports('application/octet-stream', 'brief.docx')).toBe(true);
    expect(service.supports('application/octet-stream', 'legacy.doc')).toBe(true);
    expect(service.supports('application/octet-stream', 'notes.rtf')).toBe(true);
  });

  it('сохраняет поддержку табличных документов', () => {
    expect(service.supports('application/octet-stream', 'report.xlsx')).toBe(true);
    expect(service.supports('text/csv', 'report.bin')).toBe(true);
  });

  it('поддерживает PDF как готовый формат предпросмотра', () => {
    expect(service.supports('application/pdf', 'file.bin')).toBe(true);
    expect(service.supports('application/octet-stream', 'scan.pdf')).toBe(true);
  });

  it.each([
    ['application/vnd.ms-powerpoint', 'file.bin'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file.bin'],
    ['application/vnd.oasis.opendocument.presentation', 'file.bin'],
    ['application/octet-stream', 'roadmap.ppt'],
    ['application/octet-stream', 'roadmap.pptx'],
    ['application/octet-stream', 'roadmap.odp'],
    ['application/octet-stream', 'roadmap.ppsx'],
    ['application/octet-stream', 'roadmap.pptm'],
  ])('поддерживает презентацию %s / %s', (mimeType, originalName) => {
    expect(service.supports(mimeType, originalName)).toBe(true);
  });

  it('отклоняет неподдержанные форматы', () => {
    expect(service.supports('application/zip', 'archive.zip')).toBe(false);
  });
});

describe('DocumentPreviewService.convertToPdf', () => {
  const service = new DocumentPreviewService();

  it('возвращает PDF без запуска LibreOffice-конвертации', async () => {
    const content = Buffer.from('%PDF-1.7\n');

    await expect(
      service.convertToPdf({
        content,
        mimeType: 'application/pdf',
        originalName: 'scan.pdf',
      }),
    ).resolves.toEqual({ content, mimeType: 'application/pdf' });
  });
});

describe('libreOfficePdfTarget', () => {
  it.each([
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file.bin'],
    ['application/vnd.ms-excel', 'file.bin'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'file.bin'],
    ['application/octet-stream', 'wide.xlsx'],
    ['application/octet-stream', 'wide.ods'],
    ['text/csv; charset=utf-8', 'file.bin'],
  ])('экспортирует таблицу %s / %s без горизонтальных разрывов', (mimeType, originalName) => {
    expect(libreOfficePdfTarget(mimeType, originalName)).toBe(
      'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}',
    );
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'brief.docx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'roadmap.pptx'],
  ])('не применяет настройки Calc к %s', (mimeType, originalName) => {
    expect(libreOfficePdfTarget(mimeType, originalName)).toBe('pdf');
  });
});
