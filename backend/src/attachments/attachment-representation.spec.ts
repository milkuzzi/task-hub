import {
  genericIconType,
  isPreviewableImage,
  selectAttachmentRepresentation,
} from './attachment-representation';

/**
 * Модульные тесты чистого выбора представления Вложения (Req 12.6, 12.7).
 *
 * Проверяют: распознавание изображений с поддержкой превью; сопоставление
 * обобщённого значка типу файла; выбор миниатюры только для изображений в
 * пределах лимита и обобщённого значка во всех прочих случаях. Функции чистые —
 * без обращения к базе/хранилищу.
 */

const MAX_BYTES = 25 * 1024 * 1024; // Req 12.2

describe('isPreviewableImage', () => {
  it('распознаёт растровые изображения (Req 12.6)', () => {
    expect(isPreviewableImage('image/png')).toBe(true);
    expect(isPreviewableImage('image/jpeg')).toBe(true);
    expect(isPreviewableImage('image/webp')).toBe(true);
  });

  it('нечувствителен к регистру и параметрам MIME-типа', () => {
    expect(isPreviewableImage('IMAGE/PNG')).toBe(true);
    expect(isPreviewableImage('image/jpeg; charset=binary')).toBe(true);
  });

  it('исключает SVG и неизображения (Req 12.7)', () => {
    expect(isPreviewableImage('image/svg+xml')).toBe(false);
    expect(isPreviewableImage('application/pdf')).toBe(false);
    expect(isPreviewableImage('text/plain')).toBe(false);
    expect(isPreviewableImage('')).toBe(false);
  });
});

describe('genericIconType', () => {
  it('сопоставляет обобщённый значок типу файла (Req 12.7)', () => {
    expect(genericIconType('image/svg+xml')).toBe('image');
    expect(genericIconType('video/mp4')).toBe('video');
    expect(genericIconType('audio/mpeg')).toBe('audio');
    expect(genericIconType('text/plain')).toBe('text');
    expect(genericIconType('application/pdf')).toBe('pdf');
    expect(genericIconType('application/zip')).toBe('archive');
    expect(genericIconType('application/vnd.ms-excel')).toBe('spreadsheet');
    expect(
      genericIconType('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe('presentation');
    expect(genericIconType('application/vnd.ms-powerpoint.presentation.macroenabled.12')).toBe(
      'presentation',
    );
    expect(genericIconType('application/msword')).toBe('document');
  });

  it('возвращает обобщённый значок для нераспознанных типов (Req 12.7)', () => {
    expect(genericIconType('application/x-custom')).toBe('generic');
    expect(genericIconType('application/octet-stream')).toBe('generic');
  });
});

describe('selectAttachmentRepresentation', () => {
  it('выбирает миниатюру для изображения в пределах лимита (Req 12.6)', () => {
    expect(
      selectAttachmentRepresentation({ mimeType: 'image/png', sizeBytes: 1024 }, MAX_BYTES),
    ).toEqual({ kind: 'thumbnail' });
  });

  it('выбирает миниатюру на границе лимита (Req 12.6)', () => {
    expect(
      selectAttachmentRepresentation({ mimeType: 'image/png', sizeBytes: MAX_BYTES }, MAX_BYTES),
    ).toEqual({ kind: 'thumbnail' });
  });

  it('выбирает обобщённый значок изображения при превышении лимита (Req 12.6, 12.7)', () => {
    expect(
      selectAttachmentRepresentation(
        { mimeType: 'image/png', sizeBytes: MAX_BYTES + 1 },
        MAX_BYTES,
      ),
    ).toEqual({ kind: 'icon', icon: 'image' });
  });

  it('выбирает обобщённый значок для неизображений (Req 12.7)', () => {
    expect(
      selectAttachmentRepresentation({ mimeType: 'application/pdf', sizeBytes: 10 }, MAX_BYTES),
    ).toEqual({ kind: 'icon', icon: 'pdf' });
    expect(
      selectAttachmentRepresentation(
        { mimeType: 'application/x-custom', sizeBytes: 10 },
        MAX_BYTES,
      ),
    ).toEqual({ kind: 'icon', icon: 'generic' });
  });
});
