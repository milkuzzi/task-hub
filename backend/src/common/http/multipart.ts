import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { ValidationException } from '../errors';

export interface UploadedMultipartFile {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

export interface MultipartFileOptions {
  fieldName: string;
  maxBytes: number;
}

const MULTIPART_FIELD_NAME_MAX_BYTES = 100;
const MULTIPART_HEADER_PAIR_LIMIT = 20;

export async function readSingleMultipartFile(
  request: FastifyRequest,
  options: MultipartFileOptions,
): Promise<UploadedMultipartFile> {
  if (!request.isMultipart()) {
    throw new ValidationException('Ожидается multipart/form-data с файлом.');
  }

  let part: MultipartFile | undefined;
  try {
    part = await request.file({
      limits: {
        fieldNameSize: MULTIPART_FIELD_NAME_MAX_BYTES,
        fieldSize: 0,
        fields: 0,
        files: 1,
        fileSize: options.maxBytes,
        parts: 1,
        headerPairs: MULTIPART_HEADER_PAIR_LIMIT,
      },
      throwFileSizeLimit: true,
    });
  } catch (error) {
    throw new ValidationException(resolveMultipartErrorMessage(error, options.maxBytes));
  }

  if (part === undefined) {
    throw new ValidationException(`Файл не передан: ожидается поле «${options.fieldName}».`);
  }
  if (part.fieldname !== options.fieldName) {
    await drainMultipartFile(part);
    throw new ValidationException(`Недопустимое поле файла: ожидается «${options.fieldName}».`);
  }

  const buffer = await readMultipartBuffer(part, options.maxBytes);
  return {
    originalName: part.filename,
    mimeType: part.mimetype || 'application/octet-stream',
    size: buffer.length,
    buffer,
  };
}

async function readMultipartBuffer(part: MultipartFile, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of part.file) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new ValidationException('Файл превышает допустимый размер.');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ValidationException) {
      throw error;
    }
    throw new ValidationException(resolveMultipartErrorMessage(error, maxBytes));
  }

  if (part.file.truncated) {
    throw new ValidationException('Файл превышает допустимый размер.');
  }

  return Buffer.concat(chunks, total);
}

async function drainMultipartFile(part: MultipartFile): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    part.file.once('error', reject);
    part.file.once('end', resolve);
    part.file.resume();
  });
}

function resolveMultipartErrorMessage(error: unknown, maxBytes: number): string {
  if (isFastifyMultipartError(error, 'FST_REQ_FILE_TOO_LARGE')) {
    return `Файл превышает допустимый размер ${formatBytes(maxBytes)}.`;
  }
  if (
    isFastifyMultipartError(error, 'FST_FILES_LIMIT') ||
    isFastifyMultipartError(error, 'FST_PARTS_LIMIT') ||
    isFastifyMultipartError(error, 'FST_FIELDS_LIMIT')
  ) {
    return 'Ожидается ровно один файл без дополнительных полей.';
  }
  return 'Не удалось прочитать multipart/form-data.';
}

function isFastifyMultipartError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return Number.isInteger(megabytes) ? `${megabytes} МБ` : `${bytes} байт`;
}
