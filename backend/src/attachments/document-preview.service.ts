import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ValidationException } from '../common/errors';

const PDF_MIME_TYPE = 'application/pdf';
const CONVERSION_TIMEOUT_MS = 90_000;
const CONVERSION_CONCURRENCY = 1;
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX_ENTRIES = 32;
const MAX_PROCESS_OUTPUT_CHARS = 6_000;
const CALC_PDF_EXPORT_TARGET =
  'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';

const OFFICE_MIME_TYPES = new Set<string>([
  PDF_MIME_TYPE,
  'text/csv',
  'application/csv',
  'application/msword',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.presentation-template',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/rtf',
]);

const OFFICE_EXTENSIONS = new Set<string>([
  '.csv',
  '.doc',
  '.docm',
  '.docx',
  '.odp',
  '.ods',
  '.odt',
  '.otp',
  '.pot',
  '.potm',
  '.potx',
  '.pps',
  '.ppsm',
  '.ppsx',
  '.ppt',
  '.pptm',
  '.pptx',
  '.pdf',
  '.rtf',
  '.xls',
  '.xlsx',
]);

const MIME_EXTENSION_FALLBACKS = new Map<string, string>([
  [PDF_MIME_TYPE, '.pdf'],
  ['text/csv', '.csv'],
  ['application/csv', '.csv'],
  ['application/msword', '.doc'],
  ['application/rtf', '.rtf'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', '.pptm'],
  ['application/vnd.ms-powerpoint.slideshow.macroenabled.12', '.ppsm'],
  ['application/vnd.ms-powerpoint.template.macroenabled.12', '.potm'],
  ['application/vnd.ms-word.document.macroenabled.12', '.docm'],
  ['application/vnd.oasis.opendocument.presentation', '.odp'],
  ['application/vnd.oasis.opendocument.presentation-template', '.otp'],
  ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
  ['application/vnd.oasis.opendocument.text', '.odt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', '.ppsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.template', '.potx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['text/rtf', '.rtf'],
]);

const SPREADSHEET_MIME_TYPES = new Set<string>([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const SPREADSHEET_EXTENSIONS = new Set<string>(['.csv', '.ods', '.xls', '.xlsx']);

interface DocumentPreviewInput {
  content: Buffer;
  mimeType: string;
  originalName: string;
}

export interface DocumentPdfPreview {
  content: Buffer;
  mimeType: typeof PDF_MIME_TYPE;
}

/**
 * Рендерит офисные Вложения в PDF через LibreOffice.
 *
 * Поддерживаются PDF, таблицы, Word/Writer-документы и презентации
 * PowerPoint/Impress. Конвертация выполняется в одноразовом временном каталоге
 * без shell-строк, чтобы исходное имя файла не участвовало в командной строке.
 * PDF уже является целевым форматом предпросмотра, поэтому отдаётся без
 * повторной конвертации.
 */
@Injectable()
export class DocumentPreviewService {
  private readonly logger = new Logger(DocumentPreviewService.name);
  private readonly libreOfficeBin = process.env.LIBREOFFICE_BIN ?? 'soffice';
  private readonly cache = new Map<string, { expiresAt: number; preview: DocumentPdfPreview }>();
  private activeConversions = 0;
  private readonly waiters: Array<() => void> = [];

  supports(mimeType: string, originalName: string): boolean {
    const normalized = normalizeMimeType(mimeType);
    return (
      OFFICE_MIME_TYPES.has(normalized) || OFFICE_EXTENSIONS.has(normalizedExtension(originalName))
    );
  }

  async convertToPdf(input: DocumentPreviewInput): Promise<DocumentPdfPreview> {
    if (!this.supports(input.mimeType, input.originalName)) {
      throw new ValidationException('Предпросмотр доступен только для офисных документов.');
    }

    if (isPdfInput(input.mimeType, input.originalName)) {
      return { content: input.content, mimeType: PDF_MIME_TYPE };
    }

    const cacheKey = this.cacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.preview;
    }

    const preview = await this.withConversionSlot(() => this.convertToPdfUncached(input));
    this.remember(cacheKey, preview);
    return preview;
  }

  private async convertToPdfUncached(input: DocumentPreviewInput): Promise<DocumentPdfPreview> {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'taskhub-document-preview-'));

    try {
      const extension = this.inputExtension(input.mimeType, input.originalName);
      const inputPath = path.join(tempDir, `source${extension}`);
      const outputPath = path.join(tempDir, 'source.pdf');
      await writeFile(inputPath, input.content);

      await this.runLibreOffice(tempDir, [
        '--headless',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--nolockcheck',
        '--convert-to',
        libreOfficePdfTarget(input.mimeType, input.originalName),
        '--outdir',
        tempDir,
        inputPath,
      ]);

      const content = await readFile(outputPath);
      return { content, mimeType: PDF_MIME_TYPE };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Не удалось подготовить PDF-предпросмотр «${input.originalName}»: ${reason}`,
      );
      throw new ValidationException(
        'Не удалось подготовить предпросмотр документа. Скачайте вложение.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async withConversionSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeConversions >= CONVERSION_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeConversions += 1;
    try {
      return await fn();
    } finally {
      this.activeConversions -= 1;
      this.waiters.shift()?.();
    }
  }

  private cacheKey(input: DocumentPreviewInput): string {
    const hash = createHash('sha256');
    hash.update(input.mimeType);
    hash.update('\0');
    hash.update(input.originalName);
    hash.update('\0');
    hash.update(input.content);
    return hash.digest('hex');
  }

  private remember(cacheKey: string, preview: DocumentPdfPreview): void {
    this.cache.set(cacheKey, { expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS, preview });
    while (this.cache.size > PREVIEW_CACHE_MAX_ENTRIES) {
      const first = this.cache.keys().next().value;
      if (first === undefined) {
        break;
      }
      this.cache.delete(first);
    }
  }

  private inputExtension(mimeType: string, originalName: string): string {
    const extension = normalizedExtension(originalName);
    if (OFFICE_EXTENSIONS.has(extension)) {
      return extension;
    }
    return MIME_EXTENSION_FALLBACKS.get(normalizeMimeType(mimeType)) ?? '.docx';
  }

  private runLibreOffice(workDir: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        HOME: workDir,
        TMPDIR: workDir,
        XDG_CONFIG_HOME: path.join(workDir, 'config'),
      };
      const child = spawn(this.libreOfficeBin, args, {
        cwd: workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const appendOutput = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
      };
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      };
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, CONVERSION_TIMEOUT_MS);

      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);
      child.on('error', (error) => finish(error));
      child.on('close', (code, signal) => {
        if (timedOut) {
          finish(new Error('LibreOffice conversion timed out.'));
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        finish(
          new Error(
            `LibreOffice exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}: ${output.trim()}`,
          ),
        );
      });
    });
  }
}

export function libreOfficePdfTarget(mimeType: string, originalName: string): string {
  const normalizedMime = normalizeMimeType(mimeType);
  const extension = normalizedExtension(originalName);
  return SPREADSHEET_MIME_TYPES.has(normalizedMime) || SPREADSHEET_EXTENSIONS.has(extension)
    ? CALC_PDF_EXPORT_TARGET
    : 'pdf';
}

function normalizeMimeType(mimeType: string): string {
  const semicolon = mimeType.indexOf(';');
  const base = semicolon === -1 ? mimeType : mimeType.slice(0, semicolon);
  return base.trim().toLowerCase();
}

function normalizedExtension(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  const dot = trimmed.lastIndexOf('.');
  return dot === -1 ? '' : trimmed.slice(dot);
}

function isPdfInput(mimeType: string, originalName: string): boolean {
  return (
    normalizeMimeType(mimeType) === PDF_MIME_TYPE || normalizedExtension(originalName) === '.pdf'
  );
}
