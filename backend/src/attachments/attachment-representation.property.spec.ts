import fc from 'fast-check';

import {
  isPreviewableImage,
  genericIconType,
  selectAttachmentRepresentation,
} from './attachment-representation';

/**
 * **Feature: task-assignment-system, Property 34: Выбор представления вложения по типу**
 *
 * Property 34 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 12.5, 12.6, 12.7**:
 *
 * Для любого Вложения (любой MIME-тип — Req 12.5; любой размер) представление
 * является сформированной миниатюрой тогда и только тогда, когда Вложение —
 * изображение с поддержкой превью И его размер не превышает единый лимит
 * 25 МБ (Req 12.6). Во всех остальных случаях (не изображение, неподдерживаемый
 * для превью тип, либо превышение лимита размера) выбирается обобщённый значок,
 * соответствующий типу файла (Req 12.7).
 *
 * Тест проверяет чистый селектор {@link selectAttachmentRepresentation} в полной
 * изоляции (без БД и без сервиса). Реализует ровно ОДНО свойство. Минимум 100
 * итераций fast-check (здесь — 300).
 */
describe('Property 34: Выбор представления вложения по типу (Req 12.5, 12.6, 12.7)', () => {
  /** Единый лимит размера для миниатюры — 25 МБ (Req 12.2, 12.6). */
  const MAX_BYTES = 25 * 1024 * 1024;

  /** Растровые изображения с поддержкой превью (Req 12.6). */
  const previewableImageMime = fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'IMAGE/PNG',
    'image/jpeg; charset=binary',
  );

  /** Не относящиеся к превью типы, включая векторный SVG (Req 12.7). */
  const nonPreviewableMime = fc.constantFrom(
    'image/svg+xml',
    'video/mp4',
    'audio/mpeg',
    'text/plain',
    'application/pdf',
    'application/zip',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/octet-stream',
    'application/x-unknown-binary',
  );

  /** MIME-тип: известные семейства + произвольные строки (Req 12.5). */
  const mimeTypeArb = fc.oneof(
    previewableImageMime,
    nonPreviewableMime,
    fc.string(),
    // Произвольный «type/subtype», в т.ч. случайно начинающийся с image/.
    fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 })).map(([t, s]) => `${t}/${s}`),
  );

  /**
   * Размер: значения вокруг границы лимита (включая ровно лимит и лимит±1),
   * заведомо маленькие и заведомо превышающие лимит.
   */
  const sizeBytesArb = fc.oneof(
    fc.integer({ min: 0, max: 64 }),
    fc.integer({ min: MAX_BYTES - 2, max: MAX_BYTES + 2 }),
    fc.integer({ min: MAX_BYTES + 1, max: MAX_BYTES * 4 }),
    fc.integer({ min: 0, max: MAX_BYTES * 4 }),
  );

  it('миниатюра ⇔ (превью-изображение И размер ≤ лимит); иначе обобщённый значок по типу', () => {
    fc.assert(
      fc.property(mimeTypeArb, sizeBytesArb, (mimeType, sizeBytes) => {
        const representation = selectAttachmentRepresentation({ mimeType, sizeBytes }, MAX_BYTES);

        const shouldThumbnail = isPreviewableImage(mimeType) && sizeBytes <= MAX_BYTES;

        if (shouldThumbnail) {
          // Req 12.6: изображение в пределах лимита — формируется миниатюра.
          expect(representation).toEqual({ kind: 'thumbnail' });
        } else {
          // Req 12.7: иначе — обобщённый значок, соответствующий типу файла.
          expect(representation).toEqual({
            kind: 'icon',
            icon: genericIconType(mimeType),
          });
        }
      }),
      { numRuns: 300 },
    );
  });
});
