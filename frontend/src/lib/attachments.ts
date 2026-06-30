import { decompress as zstdDecompress } from "fzstd";
import { http } from "./api";
import type { AttachmentMeta } from "./chat-api";

/**
 * Клиентское представление и распаковка Вложений (Req 12.6, 12.7, 12.9).
 *
 * Модуль решает три задачи целиком на стороне клиента:
 * 1. выбор представления Вложения (миниатюра для изображений в пределах лимита
 *    либо обобщённый значок по типу файла) — зеркалит серверный
 *    `attachment-representation.ts` (Req 12.6, 12.7);
 * 2. распаковка без потерь сжатого потока, отдаваемого сервером, для
 *    полноэкранного просмотра изображения (Req 12.9) — поддержаны кодеки `zstd`
 *    (через `fzstd`) и `gzip` (через нативный `DecompressionStream`);
 * 3. проверка целостности распакованного содержимого по контрольной сумме
 *    (sha256), вычисленной сервером до сжатия (Req 12.9 — «без потери данных»).
 *
 * Сервер хранит Вложения сжатыми вне веб-корня и отдаёт сжатый поток с
 * контролируемой отдачей (Req 12.8, 19.8); распаковка выполняется здесь.
 */

/** Единый лимит размера для формирования миниатюры изображения (Req 12.2, 12.6). */
const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;
const PDF_MIME_TYPE = "application/pdf";
const DOCUMENT_PREVIEW_TIMEOUT_MS = 120_000;

/** Категория обобщённого значка, соответствующая типу файла (Req 12.7). */
export type GenericIconType =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "archive"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "generic";

/** Вид представления Вложения: миниатюра либо обобщённый значок. */
export type AttachmentRepresentation =
  | { readonly kind: "thumbnail" }
  | { readonly kind: "icon"; readonly icon: GenericIconType };

const ARCHIVE_MIME_TYPES = new Set<string>([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip2",
]);

const SPREADSHEET_MIME_TYPES = new Set<string>([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

const SPREADSHEET_EXTENSIONS = new Set<string>([
  ".csv",
  ".xls",
  ".xlsx",
  ".ods",
]);
const PDF_EXTENSIONS = new Set<string>([".pdf"]);
const AUDIO_MIME_BY_EXTENSION = new Map<string, string>([
  [".3gp", "audio/3gpp"],
  [".3gpp", "audio/3gpp"],
  [".aac", "audio/aac"],
  [".amr", "audio/amr"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".wave", "audio/wav"],
  [".weba", "audio/webm"],
  [".webm", "audio/webm"],
]);
const VIDEO_MIME_BY_EXTENSION = new Map<string, string>([
  [".3g2", "video/3gpp2"],
  [".3gp", "video/3gpp"],
  [".3gpp", "video/3gpp"],
  [".avi", "video/x-msvideo"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

const PRESENTATION_MIME_TYPES = new Set<string>([
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  "application/vnd.ms-powerpoint.template.macroenabled.12",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.presentation-template",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
]);

const PRESENTATION_EXTENSIONS = new Set<string>([
  ".odp",
  ".otp",
  ".pot",
  ".potm",
  ".potx",
  ".pps",
  ".ppsm",
  ".ppsx",
  ".ppt",
  ".pptm",
  ".pptx",
]);

const DOCUMENT_MIME_TYPES = new Set<string>([
  "application/msword",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf",
]);

const DOCUMENT_EXTENSIONS = new Set<string>([
  ".doc",
  ".docm",
  ".docx",
  ".odt",
  ".rtf",
]);

/** Приводит MIME-тип к нижнему регистру без параметров (`; charset=...`). */
function normalizeMimeType(mimeType: string): string {
  const semicolon = mimeType.indexOf(";");
  const base = semicolon === -1 ? mimeType : mimeType.slice(0, semicolon);
  return base.trim().toLowerCase();
}

function normalizedFileExtension(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot === -1 ? "" : trimmed.slice(dot);
}

function audioMimeTypeByExtension(fileName: string): string | null {
  return AUDIO_MIME_BY_EXTENSION.get(normalizedFileExtension(fileName)) ?? null;
}

function videoMimeTypeByExtension(fileName: string): string | null {
  return VIDEO_MIME_BY_EXTENSION.get(normalizedFileExtension(fileName)) ?? null;
}

/** Форматирует размер файла в человекочитаемый вид (Б/КБ/МБ). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Определяет, относится ли тип к изображениям с поддержкой превью (Req 12.6).
 * Векторный SVG исключён (растеризатор миниатюр его не обрабатывает).
 */
export function isPreviewableImage(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized.startsWith("image/") && normalized !== "image/svg+xml";
}

/** Определяет, можно ли показать Вложение как видео через нативный браузерный плеер. */
export function isPreviewableVideo(mimeType: string, fileName = ""): boolean {
  return (
    normalizeMimeType(mimeType).startsWith("video/") ||
    videoMimeTypeByExtension(fileName) !== null
  );
}

/** Определяет, можно ли показать Вложение как аудио через нативный браузерный плеер. */
export function isPreviewableAudio(mimeType: string, fileName = ""): boolean {
  return (
    normalizeMimeType(mimeType).startsWith("audio/") ||
    audioMimeTypeByExtension(fileName) !== null
  );
}

/** Определяет, относится ли Вложение к PDF по MIME-типу или расширению. */
export function isPdfFile(mimeType: string, fileName = ""): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === PDF_MIME_TYPE ||
    PDF_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

/** Определяет, относится ли Вложение к таблицам Excel/CSV по MIME-типу или расширению. */
export function isSpreadsheetFile(mimeType: string, fileName = ""): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    SPREADSHEET_MIME_TYPES.has(normalized) ||
    SPREADSHEET_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

/** Определяет, относится ли Вложение к Word/Writer-документам по MIME-типу или расширению. */
export function isDocumentFile(mimeType: string, fileName = ""): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    DOCUMENT_MIME_TYPES.has(normalized) ||
    DOCUMENT_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

/** Определяет, относится ли Вложение к презентациям PowerPoint/Impress. */
export function isPresentationFile(mimeType: string, fileName = ""): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    PRESENTATION_MIME_TYPES.has(normalized) ||
    PRESENTATION_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

/** Поддержанный PDF-предпросмотр Word/Writer-документов через серверный LibreOffice. */
export function isPreviewableDocument(
  mimeType: string,
  fileName = "",
): boolean {
  return isDocumentFile(mimeType, fileName);
}

/** Поддержанный PDF-предпросмотр презентаций через серверный LibreOffice Impress. */
export function isPreviewablePresentation(
  mimeType: string,
  fileName = "",
): boolean {
  return isPresentationFile(mimeType, fileName);
}

export type AttachmentPreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "download";

export interface DocumentExternalLinks {
  preview: {
    url: string;
    fileName: string;
  };
  original: {
    url: string;
    fileName: string;
  };
  expiresAt: string;
}

/** Определяет режим полноэкранного предпросмотра Вложения. */
export function attachmentPreviewKind(
  attachment: AttachmentMeta,
): AttachmentPreviewKind {
  if (isPreviewableImage(attachment.mimeType)) {
    return "image";
  }
  if (isPreviewableVideo(attachment.mimeType, attachment.originalName)) {
    return "video";
  }
  if (isPreviewableAudio(attachment.mimeType, attachment.originalName)) {
    return "audio";
  }
  if (isPdfFile(attachment.mimeType, attachment.originalName)) {
    return "pdf";
  }
  if (isSpreadsheetFile(attachment.mimeType, attachment.originalName)) {
    return "spreadsheet";
  }
  if (isPreviewableDocument(attachment.mimeType, attachment.originalName)) {
    return "document";
  }
  if (isPreviewablePresentation(attachment.mimeType, attachment.originalName)) {
    return "presentation";
  }
  return "download";
}

/** Сопоставляет MIME-типу обобщённый значок (Req 12.7). */
export function genericIconType(
  mimeType: string,
  fileName = "",
): GenericIconType {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (isPreviewableVideo(mimeType, fileName)) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (isPdfFile(mimeType, fileName)) {
    return "pdf";
  }
  if (ARCHIVE_MIME_TYPES.has(normalized)) {
    return "archive";
  }
  if (isSpreadsheetFile(mimeType, fileName)) {
    return "spreadsheet";
  }
  if (normalized.startsWith("text/")) {
    return "text";
  }
  if (isPresentationFile(mimeType, fileName)) {
    return "presentation";
  }
  if (isDocumentFile(mimeType, fileName)) {
    return "document";
  }
  return "generic";
}

function resolveContentMimeType(
  attachment: AttachmentMeta,
  responseContentType: unknown,
): string {
  const headerMimeType =
    typeof responseContentType === "string"
      ? normalizeMimeType(responseContentType)
      : "";
  if (headerMimeType !== "" && headerMimeType !== "application/octet-stream") {
    return headerMimeType;
  }

  const attachmentMimeType = normalizeMimeType(attachment.mimeType);
  if (
    attachmentMimeType !== "" &&
    attachmentMimeType !== "application/octet-stream"
  ) {
    return attachmentMimeType;
  }

  return (
    videoMimeTypeByExtension(attachment.originalName) ??
    audioMimeTypeByExtension(attachment.originalName) ??
    "application/octet-stream"
  );
}

/**
 * Выбирает представление Вложения (Req 12.6, 12.7), зеркаля серверную логику.
 *
 * Возвращает миниатюру тогда и только тогда, когда Вложение — изображение с
 * поддержкой превью, его размер в пределах лимита и сервер сформировал
 * миниатюру (`hasThumbnail`). Иначе — обобщённый значок по типу файла.
 */
export function selectRepresentation(
  attachment: AttachmentMeta,
): AttachmentRepresentation {
  if (
    attachment.hasThumbnail &&
    isPreviewableImage(attachment.mimeType) &&
    attachment.sizeBytes <= THUMBNAIL_MAX_BYTES
  ) {
    return { kind: "thumbnail" };
  }
  return {
    kind: "icon",
    icon: genericIconType(attachment.mimeType, attachment.originalName),
  };
}

/**
 * Загружает байты миниатюры Вложения с авторизацией (Req 12.6, 5.7).
 *
 * Миниатюра отдаётся по защищённому эндпоинту `GET /api/attachments/:id/thumbnail`,
 * поэтому байты запрашиваются общим клиентом `http` (он добавляет Bearer-токен)
 * как `Blob` для показа через Object URL ({@link useAuthedImage}). Для Вложений
 * без миниатюры (не-изображения и т. п.) сервер отвечает 404 — вызывающий
 * обрабатывает это как отсутствие превью и показывает обобщённый значок.
 */
export function fetchThumbnailBlob(attachmentId: string): Promise<Blob> {
  return http
    .get<Blob>(`/attachments/${attachmentId}/thumbnail`, {
      responseType: "blob",
    })
    .then((response) => response.data);
}

/**
 * Загружает PDF-предпросмотр офисного Вложения.
 *
 * Таблицы, Word/Writer-документы и презентации рендерятся на сервере через
 * LibreOffice и возвращаются как PDF, сохраняя исходное оформление.
 */
export function fetchDocumentPreviewBlob(attachmentId: string): Promise<Blob> {
  return http
    .get<Blob>(`/attachments/${attachmentId}/preview`, {
      responseType: "blob",
      timeout: DOCUMENT_PREVIEW_TIMEOUT_MS,
    })
    .then((response) => response.data);
}

/**
 * Получает короткоживущие ссылки на PDF-предпросмотр и оригинал документа.
 *
 * Используется MAX mini-app: внешнее открытие через MAX Bridge не может
 * передать Bearer-токен и выполнить клиентскую распаковку, поэтому backend
 * выдаёт временные ticket-ссылки.
 */
export function fetchDocumentExternalLinks(
  attachmentId: string,
): Promise<DocumentExternalLinks> {
  return http
    .post<DocumentExternalLinks>(`/attachments/${attachmentId}/document-links`, {})
    .then((response) => response.data);
}

/**
 * Распаковывает сжатый поток без потерь по указанному кодеку (Req 12.8, 12.9).
 *
 * Поддержаны `zstd` (через `fzstd`) и `gzip`/`deflate` (через нативный
 * `DecompressionStream`, если доступен). Для пустого/неизвестного кодека
 * содержимое считается несжатым и возвращается без изменений.
 *
 * @throws Error если кодек не поддерживается средой выполнения.
 */
export async function decompress(
  compressed: Uint8Array,
  compression: string,
): Promise<Uint8Array> {
  const codec = compression.trim().toLowerCase();

  if (
    codec === "" ||
    codec === "none" ||
    codec === "identity" ||
    codec === "store"
  ) {
    return compressed;
  }

  if (codec === "zstd" || codec === "zst") {
    // fzstd выполняет распаковку синхронно и без потерь (Req 12.9).
    return zstdDecompress(compressed);
  }

  if (codec === "gzip" || codec === "deflate" || codec === "deflate-raw") {
    if (typeof DecompressionStream === "undefined") {
      throw new Error(`Среда не поддерживает распаковку «${codec}».`);
    }
    const format = codec === "deflate-raw" ? "deflate-raw" : codec;
    const stream = new Blob([compressed as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream(format as CompressionFormat));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  throw new Error(`Неизвестный кодек сжатия: «${compression}».`);
}

/** Вычисляет sha256 (hex) содержимого через Web Crypto (Req 12.9 — целостность). */
async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    return null; // Среда без SubtleCrypto — проверку пропускаем.
  }
  const view = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const digest = await crypto.subtle.digest("SHA-256", view as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Результат загрузки и распаковки Вложения для полноэкранного просмотра. */
export interface DecompressedAttachment {
  /** Object URL распакованного содержимого (освобождается через {@link revoke}). */
  url: string;
  /** Распакованный Blob исходного содержимого. */
  blob: Blob;
  /** MIME-тип исходного содержимого. */
  mimeType: string;
  /** Прошла ли проверка целостности по контрольной сумме (sha256). */
  integrityOk: boolean;
  /** Освобождает связанный Object URL. */
  revoke(): void;
}

/**
 * Загружает сжатый поток Вложения, распаковывает его на клиенте без потерь и
 * формирует Object URL для полноэкранного просмотра изображения (Req 12.9).
 *
 * Сервер отдаёт сжатые байты и сопутствующие метаданные в заголовках ответа
 * (`X-Compression`, `X-Checksum`, `Content-Type`). После распаковки содержимое
 * сверяется с контрольной суммой исходного файла (Req 12.9 — «без потери
 * данных»); несовпадение отражается в `integrityOk`, но URL всё равно
 * формируется, чтобы Участник увидел доступное изображение.
 *
 * @param attachment Метаданные Вложения (источник кодека и контрольной суммы).
 * @returns Object URL и сведения о распаковке; вызывающий обязан вызвать
 *   `revoke()` после использования, чтобы освободить память.
 */
export async function openAttachment(
  attachment: AttachmentMeta,
): Promise<DecompressedAttachment> {
  const response = await http.get<ArrayBuffer>(
    `/attachments/${attachment.id}/content`,
    {
      responseType: "arraybuffer",
    },
  );

  const compressed = new Uint8Array(response.data);
  // Кодек и контрольную сумму берём из заголовков ответа, если они заданы;
  // иначе — из метаданных Вложения (контракт ChatService/StorageService).
  const headerCompression =
    typeof response.headers["x-compression"] === "string"
      ? response.headers["x-compression"]
      : attachment.compression;
  const expectedChecksum =
    typeof response.headers["x-checksum"] === "string"
      ? response.headers["x-checksum"]
      : attachment.checksum;
  const mimeType = resolveContentMimeType(
    attachment,
    response.headers["content-type"],
  );

  const raw = await decompress(compressed, headerCompression);

  let integrityOk = true;
  if (expectedChecksum !== undefined && expectedChecksum !== "") {
    const actual = await sha256Hex(raw);
    integrityOk =
      actual === null ? true : actual === expectedChecksum.toLowerCase();
  }

  const blob = new Blob([raw as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  return {
    url,
    blob,
    mimeType,
    integrityOk,
    revoke: () => URL.revokeObjectURL(url),
  };
}
