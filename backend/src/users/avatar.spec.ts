import { SUPPORTED_AVATAR_MIME_TYPES, validateAvatar } from './avatar';
import { UploadedFile } from './profile.types';

/**
 * Модульные тесты чистой функции {@link validateAvatar} (Req 6.4, 6.5, 6.9):
 * проверка поддерживаемых растровых форматов и лимита размера 5 МБ.
 */
describe('validateAvatar (Req 6.4, 6.5, 6.9)', () => {
  const FIVE_MB = 5 * 1024 * 1024;

  const file = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
    originalName: 'avatar.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    ...overrides,
  });

  it('принимает поддерживаемое растровое изображение в пределах лимита', () => {
    expect(validateAvatar(file(), FIVE_MB).valid).toBe(true);
  });

  it.each(SUPPORTED_AVATAR_MIME_TYPES)('принимает поддерживаемый формат %s', (mimeType) => {
    expect(validateAvatar(file({ mimeType }), FIVE_MB).valid).toBe(true);
  });

  it('принимает файл ровно на границе 5 МБ', () => {
    expect(validateAvatar(file({ sizeBytes: FIVE_MB }), FIVE_MB).valid).toBe(true);
  });

  it('отклоняет отсутствующий файл', () => {
    expect(validateAvatar(undefined, FIVE_MB).valid).toBe(false);
  });

  it('отклоняет неподдерживаемый формат (Req 6.9)', () => {
    const result = validateAvatar(file({ mimeType: 'image/svg+xml' }), FIVE_MB);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('формат');
    }
  });

  it('отклоняет нерастровый тип (Req 6.9)', () => {
    expect(validateAvatar(file({ mimeType: 'application/pdf' }), FIVE_MB).valid).toBe(false);
  });

  it('отклоняет файл, превышающий 5 МБ (Req 6.9)', () => {
    const result = validateAvatar(file({ sizeBytes: FIVE_MB + 1 }), FIVE_MB);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('МБ');
    }
  });

  it('отклоняет отрицательный размер', () => {
    expect(validateAvatar(file({ sizeBytes: -1 }), FIVE_MB).valid).toBe(false);
  });
});
