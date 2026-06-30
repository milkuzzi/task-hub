import { Injectable } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AuthService } from '../auth';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { UploadedMultipartFile } from '../common/http';
import { ClockService } from '../clock';
import { UserRepository, UserWithEmails, UserWithMaxLink } from '../repositories';
import { validateDisplayName } from './display-name';
import { validatePrimaryAdminEmail } from './email-validation';
import { UsersService } from './users.service';

/** MIME-тип Excel-файла Office Open XML. */
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Максимальное число непустых строк импорта без учёта заголовка. */
const MAX_IMPORT_ROWS = 1000;

const ACTIVE_SHEET_NAME = 'Активные';
const DELETED_SHEET_NAME = 'Удалённые';

/** Готовый к скачиванию Excel-файл Пользователей. */
export interface UsersExcelFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Ошибка обработки одной строки Excel-импорта. */
export interface UsersImportRowError {
  row: number;
  email?: string;
  message: string;
}

/** Итог частичного Excel-импорта Пользователей. */
export interface UsersImportResult {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  errors: UsersImportRowError[];
}

interface ImportRow {
  rowNumber: number;
  email: string;
  name: string;
}

/**
 * Excel-импорт/экспорт раздела администрирования Пользователей.
 *
 * Импорт не управляет удалениями и системными ролями: новые записи создаются
 * через стандартное приглашение, существующим активным Пользователям меняется
 * только отображаемое имя.
 */
@Injectable()
export class UsersExcelService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly auth: AuthService,
    private readonly usersService: UsersService,
    private readonly clock: ClockService,
  ) {}

  /** Формирует Excel-файл с активными и soft-deleted Пользователями. */
  async exportUsers(adminId: string): Promise<UsersExcelFile> {
    await this.assertAdmin(adminId);
    const [active, deleted] = await Promise.all([
      this.userRepository.listActiveWithMaxLink(),
      this.userRepository.listDeletedWithEmails(),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Task Hub';
    workbook.created = this.clock.now();
    this.addActiveSheet(workbook, active);
    this.addDeletedSheet(workbook, deleted);

    const content = await workbook.xlsx.writeBuffer();
    return {
      filename: 'users.xlsx',
      mimeType: XLSX_MIME_TYPE,
      content: Buffer.from(content as unknown as ArrayBuffer),
    };
  }

  /** Импортирует новые приглашения и изменения имени из Excel-файла. */
  async importUsers(adminId: string, file: UploadedMultipartFile): Promise<UsersImportResult> {
    await this.assertAdmin(adminId);
    this.assertXlsx(file);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new ValidationException(
        'Не удалось прочитать Excel-файл. Загрузите файл формата .xlsx.',
      );
    }

    const worksheet = workbook.getWorksheet(ACTIVE_SHEET_NAME) ?? workbook.worksheets[0];
    if (worksheet === undefined) {
      throw new ValidationException('Excel-файл не содержит листов для импорта.');
    }

    const rows = this.parseImportRows(worksheet);
    const seenEmails = new Set<string>();
    const result: UsersImportResult = {
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      errors: [],
    };

    for (const rawRow of rows) {
      let row: ImportRow;
      try {
        row = {
          rowNumber: rawRow.rowNumber,
          email: validateImportEmail(rawRow.email),
          name: validateImportName(rawRow.name),
        };
      } catch (error) {
        const rowError: UsersImportRowError = {
          row: rawRow.rowNumber,
          message: error instanceof Error ? error.message : 'Не удалось обработать строку.',
        };
        const email = rawRow.email.trim();
        if (email !== '') {
          rowError.email = email;
        }
        result.errors.push(rowError);
        continue;
      }

      const dedupeKey = row.email.toLocaleLowerCase('ru-RU');
      if (seenEmails.has(dedupeKey)) {
        result.errors.push({
          row: row.rowNumber,
          email: row.email,
          message: 'Адрес электронной почты повторяется в файле.',
        });
        continue;
      }
      seenEmails.add(dedupeKey);

      try {
        const existing = await this.userRepository.findByEmail(row.email);
        if (existing === null) {
          await this.auth.invite(adminId, row.email, row.name);
          result.created += 1;
          continue;
        }
        if (existing.deletedAt !== null) {
          result.errors.push({
            row: row.rowNumber,
            email: row.email,
            message: 'Пользователь с этим адресом удалён. Восстановите его вручную.',
          });
          continue;
        }
        if (existing.displayName === row.name) {
          result.unchanged += 1;
          continue;
        }
        await this.usersService.updateProfile(adminId, existing.id, { displayName: row.name });
        result.updated += 1;
      } catch (error) {
        result.errors.push({
          row: row.rowNumber,
          email: row.email,
          message: error instanceof Error ? error.message : 'Не удалось обработать строку.',
        });
      }
    }

    result.failed = result.errors.length;
    return result;
  }

  private addActiveSheet(workbook: ExcelJS.Workbook, users: UserWithMaxLink[]): void {
    const sheet = workbook.addWorksheet(ACTIVE_SHEET_NAME);
    sheet.columns = [
      { header: 'Имя', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 34 },
      { header: 'Состояние', key: 'status', width: 20 },
      { header: 'Роль', key: 'role', width: 18 },
      { header: 'MAX', key: 'max', width: 12 },
      { header: 'ID', key: 'id', width: 38 },
    ];
    for (const user of users) {
      sheet.addRow({
        name: user.displayName,
        email: user.email,
        status: activeStatusLabel(user, this.clock.now()),
        role: roleLabel(user.role),
        max: user.maxLink === null ? 'Нет' : 'Да',
        id: user.id,
      });
    }
    styleHeader(sheet);
  }

  private addDeletedSheet(workbook: ExcelJS.Workbook, users: UserWithEmails[]): void {
    const sheet = workbook.addWorksheet(DELETED_SHEET_NAME);
    sheet.columns = [
      { header: 'Имя', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 34 },
      { header: 'Удалён', key: 'deletedAt', width: 28 },
      { header: 'ID', key: 'id', width: 38 },
    ];
    for (const user of users) {
      const emails = user.emails.length > 0 ? user.emails : [{ email: '' }];
      for (const email of emails) {
        sheet.addRow({
          name: user.displayName,
          email: email.email,
          deletedAt: (user.deletedAt ?? user.updatedAt).toISOString(),
          id: user.id,
        });
      }
    }
    styleHeader(sheet);
  }

  private parseImportRows(worksheet: ExcelJS.Worksheet): ImportRow[] {
    const headerRow = worksheet.getRow(1);
    const headers = new Map<string, number>();
    headerRow.eachCell((cell, columnNumber) => {
      const value = normalizeHeader(cellText(cell));
      if (value !== '') {
        headers.set(value, columnNumber);
      }
    });

    const nameColumn = requireHeader(headers, ['имя', 'name'], 'Имя');
    const emailColumn = requireHeader(
      headers,
      ['email', 'e-mail', 'электронная почта', 'почта'],
      'Email',
    );

    const rows: ImportRow[] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const rawName = cellText(row.getCell(nameColumn)).trim();
      const rawEmail = cellText(row.getCell(emailColumn)).trim();
      if (rawName === '' && rawEmail === '') {
        continue;
      }
      if (rows.length >= MAX_IMPORT_ROWS) {
        throw new ValidationException(
          `Excel-импорт поддерживает не более ${MAX_IMPORT_ROWS} строк.`,
        );
      }

      rows.push({
        rowNumber,
        email: rawEmail,
        name: rawName,
      });
    }

    return rows;
  }

  private async assertAdmin(adminId: string): Promise<void> {
    const actor = await this.userRepository.findActiveById(adminId);
    if (actor === null || actor.role !== Role.ADMIN) {
      throw new AccessDeniedException('Операция доступна только Администратору.');
    }
  }

  private assertXlsx(file: UploadedMultipartFile): void {
    const normalizedName = file.originalName.toLocaleLowerCase('ru-RU');
    if (!normalizedName.endsWith('.xlsx')) {
      throw new ValidationException('Загрузите файл Excel в формате .xlsx.');
    }
  }
}

function validateImportName(name: string): string {
  return validateDisplayName(name);
}

function validateImportEmail(email: string): string {
  const normalized = email.trim();
  const validation = validatePrimaryAdminEmail(normalized);
  if (!validation.valid) {
    throw new ValidationException(validation.reason);
  }
  return normalized;
}

function requireHeader(headers: Map<string, number>, aliases: string[], label: string): number {
  for (const alias of aliases) {
    const value = headers.get(alias);
    if (value !== undefined) {
      return value;
    }
  }
  throw new ValidationException(`В Excel-файле отсутствует обязательная колонка «${label}».`);
}

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

function cellText(cell: ExcelJS.Cell): string {
  return stringifyCellValue(cell.value);
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : '',
      )
      .join('');
  }
  if ('result' in record) {
    return stringifyCellValue(record.result);
  }

  return String(value);
}

function activeStatusLabel(user: User, now: Date): string {
  if (!user.isActive) {
    return 'Ожидает активации';
  }
  if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
    return 'Заблокирован';
  }
  return 'Активен';
}

function roleLabel(role: Role): string {
  switch (role) {
    case Role.ADMIN:
      return 'Администратор';
    case Role.MANAGER:
      return 'Менеджер';
    case Role.EXECUTOR:
      return 'Исполнитель';
  }
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const row = sheet.getRow(1);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.alignment = { vertical: 'middle' };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}
