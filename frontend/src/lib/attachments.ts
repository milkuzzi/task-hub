import { decompress as zstdDecompress } from "fzstd";
import { http } from "./api";
import { parseBinaryXlsPreview } from "./xls-preview";
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

/** Лимиты табличного предпросмотра, чтобы модалка оставалась быстрой и читаемой. */
const DEFAULT_SPREADSHEET_PREVIEW_ROWS = 80;
const DEFAULT_SPREADSHEET_PREVIEW_COLUMNS = 16;

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
const PREVIEWABLE_SPREADSHEET_MIME_TYPES = new Set<string>([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const PREVIEWABLE_SPREADSHEET_EXTENSIONS = new Set<string>([
  ".csv",
  ".xls",
  ".xlsx",
]);

const PRESENTATION_MIME_TYPES = new Set<string>([
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);

const DOCUMENT_MIME_TYPES = new Set<string>([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
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
export function isPreviewableVideo(mimeType: string): boolean {
  return normalizeMimeType(mimeType).startsWith("video/");
}

/** Определяет, относится ли Вложение к таблицам Excel/CSV по MIME-типу или расширению. */
export function isSpreadsheetFile(mimeType: string, fileName = ""): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    SPREADSHEET_MIME_TYPES.has(normalized) ||
    SPREADSHEET_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

/**
 * Поддержанный табличный предпросмотр.
 *
 * `.xlsx` читается безопасным браузерным парсером, CSV — локальным разбором,
 * старый бинарный `.xls` — ограниченным BIFF-парсером для предпросмотра.
 */
export function isPreviewableSpreadsheet(
  mimeType: string,
  fileName = "",
): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    PREVIEWABLE_SPREADSHEET_MIME_TYPES.has(normalized) ||
    PREVIEWABLE_SPREADSHEET_EXTENSIONS.has(normalizedFileExtension(fileName))
  );
}

export type AttachmentPreviewKind =
  | "image"
  | "video"
  | "spreadsheet"
  | "download";

/** Определяет режим полноэкранного предпросмотра Вложения. */
export function attachmentPreviewKind(
  attachment: AttachmentMeta,
): AttachmentPreviewKind {
  if (isPreviewableImage(attachment.mimeType)) {
    return "image";
  }
  if (isPreviewableVideo(attachment.mimeType)) {
    return "video";
  }
  if (isPreviewableSpreadsheet(attachment.mimeType, attachment.originalName)) {
    return "spreadsheet";
  }
  return "download";
}

/** Сопоставляет MIME-типу обобщённый значок (Req 12.7). */
export function genericIconType(mimeType: string): GenericIconType {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized === "application/pdf") {
    return "pdf";
  }
  if (ARCHIVE_MIME_TYPES.has(normalized)) {
    return "archive";
  }
  if (SPREADSHEET_MIME_TYPES.has(normalized)) {
    return "spreadsheet";
  }
  if (normalized.startsWith("text/")) {
    return "text";
  }
  if (PRESENTATION_MIME_TYPES.has(normalized)) {
    return "presentation";
  }
  if (DOCUMENT_MIME_TYPES.has(normalized)) {
    return "document";
  }
  return "generic";
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
  return { kind: "icon", icon: genericIconType(attachment.mimeType) };
}

/** Обобщённый значок (emoji) по категории типа файла (Req 12.7). */
export function iconGlyph(icon: GenericIconType): string {
  switch (icon) {
    case "image":
      return "🖼️";
    case "video":
      return "🎞️";
    case "audio":
      return "🎵";
    case "pdf":
      return "📕";
    case "archive":
      return "🗜️";
    case "text":
      return "📄";
    case "document":
      return "📝";
    case "spreadsheet":
      return "📊";
    case "presentation":
      return "📽️";
    default:
      return "📎";
  }
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
 * Загружает документный PDF-предпросмотр Вложения.
 *
 * Табличные файлы рендерятся на сервере через LibreOffice и возвращаются как
 * PDF, поэтому в модалке сохраняется реальный вид документа, а не пересобранная
 * HTML-таблица из значений ячеек.
 */
export function fetchDocumentPreviewBlob(attachmentId: string): Promise<Blob> {
  return http
    .get<Blob>(`/attachments/${attachmentId}/preview`, { responseType: "blob" })
    .then((response) => response.data);
}

export interface SpreadsheetPreview {
  sheetName: string | null;
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  visibleRows: number;
  visibleColumns: number;
}

export interface SpreadsheetPreviewOptions {
  maxRows?: number;
  maxColumns?: number;
}

function isCsvAttachment(mimeType: string, fileName: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === "text/csv" ||
    normalized === "application/csv" ||
    normalizedFileExtension(fileName) === ".csv"
  );
}

function isBinaryXlsAttachment(mimeType: string, fileName: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === "application/vnd.ms-excel" ||
    normalizedFileExtension(fileName) === ".xls"
  );
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return new Intl.DateTimeFormat("ru-RU").format(value);
  }
  return String(value);
}

function selectCsvDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const delimiters = [",", ";", "\t"];
  return delimiters.reduce((best, delimiter) => {
    const currentCount = firstLine.split(delimiter).length;
    const bestCount = firstLine.split(best).length;
    return currentCount > bestCount ? delimiter : best;
  }, ",");
}

function parseCsv(text: string): string[][] {
  const delimiter = selectCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    pushRow();
  }

  return rows;
}

function blobToText(blob: Blob): Promise<string> {
  const maybeText = (blob as Blob & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    return maybeText.call(blob);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () =>
      reject(reader.error ?? new Error("Не удалось прочитать текстовый файл."));
    reader.readAsText(blob);
  });
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const maybeArrayBuffer = (
    blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  ).arrayBuffer;
  if (typeof maybeArrayBuffer === "function") {
    return maybeArrayBuffer.call(blob);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Не удалось прочитать бинарный файл."));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Не удалось прочитать бинарный файл."));
    reader.readAsArrayBuffer(blob);
  });
}

function buildSpreadsheetPreview(
  rows: unknown[][],
  sheetName: string | null,
  options: SpreadsheetPreviewOptions = {},
): SpreadsheetPreview {
  const maxRows = options.maxRows ?? DEFAULT_SPREADSHEET_PREVIEW_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_SPREADSHEET_PREVIEW_COLUMNS;
  const totalRows = rows.length;
  const totalColumns = Math.max(0, ...rows.map((row) => row.length));
  const visibleRows = Math.min(totalRows, maxRows);
  const visibleColumns = Math.min(totalColumns, maxColumns);
  const previewRows = rows
    .slice(0, visibleRows)
    .map((row) =>
      Array.from({ length: visibleColumns }, (_, columnIndex) =>
        stringifyCell(row[columnIndex]),
      ),
    );

  return {
    sheetName,
    rows: previewRows,
    totalRows,
    totalColumns,
    visibleRows,
    visibleColumns,
  };
}

/** Загружает компактное представление `.xlsx`/CSV для миниатюры или модалки. */
export async function loadSpreadsheetPreview(
  blob: Blob,
  attachment: Pick<AttachmentMeta, "mimeType" | "originalName">,
  options: SpreadsheetPreviewOptions = {},
): Promise<SpreadsheetPreview> {
  if (isCsvAttachment(attachment.mimeType, attachment.originalName)) {
    const text = await blobToText(blob);
    return buildSpreadsheetPreview(parseCsv(text), null, options);
  }

  if (isBinaryXlsAttachment(attachment.mimeType, attachment.originalName)) {
    const buffer = await blobToArrayBuffer(blob);
    return parseBinaryXlsPreview(new Uint8Array(buffer), options);
  }

  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const sheets = await readXlsxFile(blob);
  const firstSheet = sheets[0];
  return buildSpreadsheetPreview(
    firstSheet?.data ?? [],
    firstSheet?.sheet ?? null,
    options,
  );
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
  const mimeType =
    typeof response.headers["content-type"] === "string" &&
    response.headers["content-type"] !== "application/octet-stream"
      ? response.headers["content-type"]
      : attachment.mimeType;

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
