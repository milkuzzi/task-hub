import { Role, User } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AuthService } from '../auth';
import { ValidationException } from '../common/errors';
import { UploadedMultipartFile } from '../common/http';
import { ClockService } from '../clock';
import { UserRepository, UserWithEmails, UserWithMaxLink } from '../repositories';
import { UsersExcelService } from './users-excel.service';
import { UsersService } from './users.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function makeUser(partial: Partial<User> & { id: string; email: string; role: Role }): User {
  return {
    displayName: partial.id,
    passwordHash: null,
    avatarPath: null,
    isActive: true,
    deletedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...partial,
  } as User;
}

function toBuffer(value: ExcelJS.Buffer): Buffer {
  return Buffer.from(value as unknown as ArrayBuffer);
}

async function buildFile(rows: string[][]): Promise<UploadedMultipartFile> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Активные');
  sheet.addRow(['Имя', 'Email']);
  for (const row of rows) {
    sheet.addRow(row);
  }
  const buffer = toBuffer(await workbook.xlsx.writeBuffer());
  return {
    originalName: 'users.xlsx',
    mimeType: XLSX_MIME,
    size: buffer.length,
    buffer,
  };
}

function buildService(opts: {
  active?: UserWithMaxLink[];
  deleted?: UserWithEmails[];
  byEmail?: Record<string, User | null>;
}) {
  const admin = makeUser({ id: 'admin', email: 'admin@example.com', role: Role.ADMIN });
  const findActiveById = jest.fn(async (id: string) => (id === 'admin' ? admin : null));
  const listActiveWithMaxLink = jest.fn(async () => opts.active ?? []);
  const listDeletedWithEmails = jest.fn(async () => opts.deleted ?? []);
  const findByEmail = jest.fn(async (email: string) => opts.byEmail?.[email] ?? null);
  const userRepository = {
    findActiveById,
    listActiveWithMaxLink,
    listDeletedWithEmails,
    findByEmail,
  } as unknown as UserRepository;
  const invite = jest.fn(async (_adminId: string, email: string, name: string) =>
    makeUser({ id: `new-${email}`, email, role: Role.EXECUTOR, displayName: name }),
  );
  const auth = { invite } as unknown as AuthService;
  const updateProfile = jest.fn(
    async (_adminId: string, id: string, patch: { displayName?: string }) =>
      makeUser({
        id,
        email: `${id}@example.com`,
        role: Role.EXECUTOR,
        displayName: patch.displayName ?? id,
      }),
  );
  const usersService = { updateProfile } as unknown as UsersService;
  const clock = { now: () => new Date('2026-06-30T00:00:00.000Z') } as unknown as ClockService;
  const service = new UsersExcelService(userRepository, auth, usersService, clock);
  return {
    service,
    findActiveById,
    listActiveWithMaxLink,
    listDeletedWithEmails,
    invite,
    updateProfile,
  };
}

describe('UsersExcelService', () => {
  it('экспортирует активных и удалённых пользователей на отдельных листах', async () => {
    const active = makeUser({
      id: 'u1',
      email: 'active@example.com',
      role: Role.EXECUTOR,
      displayName: 'Активный',
    }) as UserWithMaxLink;
    active.maxLink = null;
    const deleted = makeUser({
      id: 'd1',
      email: 'deleted@example.com',
      role: Role.EXECUTOR,
      displayName: 'Удалённый',
      deletedAt: new Date('2026-06-10T00:00:00.000Z'),
    }) as UserWithEmails;
    deleted.emails = [{ email: 'deleted@example.com' }] as UserWithEmails['emails'];
    const { service } = buildService({ active: [active], deleted: [deleted] });

    const file = await service.exportUsers('admin');

    expect(file.filename).toBe('users.xlsx');
    expect(file.mimeType).toBe(XLSX_MIME);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content as unknown as ExcelJS.Buffer);
    expect(workbook.getWorksheet('Активные')?.getRow(2).getCell(1).value).toBe('Активный');
    expect(workbook.getWorksheet('Удалённые')?.getRow(2).getCell(2).value).toBe(
      'deleted@example.com',
    );
  });

  it('импортирует валидные строки и возвращает ошибки по некорректным', async () => {
    const existing = makeUser({
      id: 'u1',
      email: 'existing@example.com',
      role: Role.EXECUTOR,
      displayName: 'Старое имя',
    });
    const same = makeUser({
      id: 'u2',
      email: 'same@example.com',
      role: Role.EXECUTOR,
      displayName: 'Без изменений',
    });
    const deleted = makeUser({
      id: 'd1',
      email: 'deleted@example.com',
      role: Role.EXECUTOR,
      deletedAt: new Date('2026-06-10T00:00:00.000Z'),
    });
    const { service, invite, updateProfile } = buildService({
      byEmail: {
        'new@example.com': null,
        'existing@example.com': existing,
        'same@example.com': same,
        'deleted@example.com': deleted,
      },
    });
    const file = await buildFile([
      ['Новый', 'new@example.com'],
      ['Новое имя', 'existing@example.com'],
      ['Без изменений', 'same@example.com'],
      ['Удалённый', 'deleted@example.com'],
      ['Плохой', 'bad'],
      ['', 'empty-name@example.com'],
    ]);

    const result = await service.importUsers('admin', file);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.failed).toBe(3);
    expect(invite).toHaveBeenCalledWith('admin', 'new@example.com', 'Новый');
    expect(updateProfile).toHaveBeenCalledWith('admin', 'u1', { displayName: 'Новое имя' });
    expect(result.errors.map((error) => error.row)).toEqual([5, 6, 7]);
  });

  it('отклоняет файл не в формате .xlsx', async () => {
    const { service } = buildService({});
    await expect(
      service.importUsers('admin', {
        originalName: 'users.xls',
        mimeType: 'application/vnd.ms-excel',
        size: 4,
        buffer: Buffer.from('test'),
      }),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});
