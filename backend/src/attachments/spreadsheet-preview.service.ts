import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ValidationException } from '../common/errors';

const PDF_MIME_TYPE = 'application/pdf';
const CONVERSION_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_CHARS = 6_000;

const SPREADSHEET_MIME_TYPES = new Set<string>([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const SPREADSHEET_EXTENSIONS = new Set<string>(['.csv', '.ods', '.xls', '.xlsx']);

const MIME_EXTENSION_FALLBACKS = new Map<string, string>([
  ['text/csv', '.csv'],
  ['application/csv', '.csv'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
]);

interface SpreadsheetPreviewInput {
  content: Buffer;
  mimeType: string;
  originalName: string;
}

export interface SpreadsheetPdfPreview {
  content: Buffer;
  mimeType: typeof PDF_MIME_TYPE;
}

/**
 * Рендерит табличные Вложения в PDF через LibreOffice Calc.
 *
 * Это сохраняет фактическое форматирование документа (ширины колонок,
 * шрифты, заливки, границы, листовую раскладку) лучше, чем клиентский разбор
 * ячеек в HTML. Конвертация выполняется в одноразовом временном каталоге без
 * shell-строк, чтобы исходное имя файла не участвовало в командной строке.
 */
@Injectable()
export class SpreadsheetPreviewService {
  private readonly logger = new Logger(SpreadsheetPreviewService.name);
  private readonly libreOfficeBin = process.env.LIBREOFFICE_BIN ?? 'soffice';

  supports(mimeType: string, originalName: string): boolean {
    const normalized = normalizeMimeType(mimeType);
    return (
      SPREADSHEET_MIME_TYPES.has(normalized) ||
      SPREADSHEET_EXTENSIONS.has(normalizedExtension(originalName))
    );
  }

  async convertToPdf(input: SpreadsheetPreviewInput): Promise<SpreadsheetPdfPreview> {
    if (!this.supports(input.mimeType, input.originalName)) {
      throw new ValidationException('Предпросмотр доступен только для табличных файлов.');
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), 'taskhub-sheet-preview-'));

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
        'pdf',
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
        'Не удалось подготовить предпросмотр таблицы. Скачайте вложение.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private inputExtension(mimeType: string, originalName: string): string {
    const extension = normalizedExtension(originalName);
    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      return extension;
    }
    return MIME_EXTENSION_FALLBACKS.get(normalizeMimeType(mimeType)) ?? '.xlsx';
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
