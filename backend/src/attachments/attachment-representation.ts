/**
 * Чистый выбор представления Вложения по его типу и размеру (Req 12.6, 12.7).
 *
 * Эти функции детерминированы и не имеют побочных эффектов: они принимают лишь
 * метаданные Вложения (MIME-тип, размер) и общий лимит размера, а возвращают
 * решение о том, как Вложение должно отображаться в списке — сформированной
 * миниатюрой (для изображений в пределах лимита) либо обобщённым значком,
 * соответствующим типу файла (для всех прочих типов). Свойство 34 дизайна
 * проверяет именно этот выбор.
 */

/** Категория обобщённого значка, соответствующая типу файла (Req 12.7). */
export type GenericIconType =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'text'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'generic';

/** Вид представления Вложения. */
export type AttachmentRepresentation =
  | { readonly kind: 'thumbnail' }
  | { readonly kind: 'icon'; readonly icon: GenericIconType };

/**
 * Определяет, относится ли MIME-тип к изображениям, поддерживающим превью
 * (Req 12.6). Чистая, разрешимая проверка по префиксу `image/`.
 *
 * Векторный формат SVG исключён: он не растрируется генератором миниатюр и
 * представляется обобщённым значком изображения (Req 12.7).
 *
 * @param mimeType MIME-тип Вложения.
 * @returns `true`, если для типа формируется миниатюра.
 */
export function isPreviewableImage(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized.startsWith('image/') && normalized !== 'image/svg+xml';
}

/**
 * Сопоставляет MIME-типу обобщённый значок, соответствующий типу файла
 * (Req 12.7). Чистая функция; для нераспознанных типов возвращает `generic`.
 *
 * @param mimeType MIME-тип Вложения.
 * @returns Категория обобщённого значка.
 */
export function genericIconType(mimeType: string): GenericIconType {
  const normalized = normalizeMimeType(mimeType);

  if (normalized.startsWith('image/')) {
    return 'image';
  }
  if (normalized.startsWith('video/')) {
    return 'video';
  }
  if (normalized.startsWith('audio/')) {
    return 'audio';
  }
  if (normalized.startsWith('text/')) {
    return 'text';
  }
  if (normalized === 'application/pdf') {
    return 'pdf';
  }
  if (ARCHIVE_MIME_TYPES.has(normalized)) {
    return 'archive';
  }
  if (SPREADSHEET_MIME_TYPES.has(normalized)) {
    return 'spreadsheet';
  }
  if (PRESENTATION_MIME_TYPES.has(normalized)) {
    return 'presentation';
  }
  if (DOCUMENT_MIME_TYPES.has(normalized)) {
    return 'document';
  }
  return 'generic';
}

/**
 * Выбирает представление Вложения (Req 12.6, 12.7).
 *
 * Возвращает `{ kind: 'thumbnail' }` тогда и только тогда, когда Вложение —
 * изображение с поддержкой превью и его размер не превышает заданный лимит
 * (Req 12.6). Во всех остальных случаях (не изображение, неподдерживаемый для
 * превью тип или превышение лимита размера) выбирается обобщённый значок,
 * соответствующий типу файла (Req 12.7).
 *
 * @param input Метаданные Вложения: MIME-тип и размер исходного содержимого.
 * @param maxBytes Единый лимит размера изображения для миниатюры (Req 12.2,
 *   12.6).
 * @returns Решение о представлении Вложения.
 */
export function selectAttachmentRepresentation(
  input: { mimeType: string; sizeBytes: number },
  maxBytes: number,
): AttachmentRepresentation {
  if (isPreviewableImage(input.mimeType) && input.sizeBytes <= maxBytes) {
    return { kind: 'thumbnail' };
  }
  return { kind: 'icon', icon: genericIconType(input.mimeType) };
}

/** Приводит MIME-тип к нижнему регистру без параметров (`; charset=...`). */
function normalizeMimeType(mimeType: string): string {
  const semicolon = mimeType.indexOf(';');
  const base = semicolon === -1 ? mimeType : mimeType.slice(0, semicolon);
  return base.trim().toLowerCase();
}

const ARCHIVE_MIME_TYPES = new Set<string>([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-bzip2',
]);

const SPREADSHEET_MIME_TYPES = new Set<string>([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const PRESENTATION_MIME_TYPES = new Set<string>([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

const DOCUMENT_MIME_TYPES = new Set<string>([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
]);
