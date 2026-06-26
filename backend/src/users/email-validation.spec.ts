import { EMAIL_MAX_LENGTH, EMAIL_MIN_LENGTH, validatePrimaryAdminEmail } from './email-validation';

describe('validatePrimaryAdminEmail (Req 4.1, 4.3)', () => {
  it('принимает корректный адрес электронной почты', () => {
    expect(validatePrimaryAdminEmail('admin@example.com')).toEqual({ valid: true });
  });

  it('принимает адрес минимально допустимой длины (6 символов)', () => {
    const email = 'a@b.cd';
    expect(email).toHaveLength(EMAIL_MIN_LENGTH);
    expect(validatePrimaryAdminEmail(email)).toEqual({ valid: true });
  });

  it('отклоняет отсутствующий параметр', () => {
    const result = validatePrimaryAdminEmail(undefined);
    expect(result.valid).toBe(false);
  });

  it('отклоняет пустую строку', () => {
    const result = validatePrimaryAdminEmail('');
    expect(result.valid).toBe(false);
  });

  it('отклоняет адрес короче минимальной длины', () => {
    // 5 символов, формально похоже на email, но короче 6.
    const result = validatePrimaryAdminEmail('a@b.c');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain(`${EMAIL_MIN_LENGTH}`);
    }
  });

  it('отклоняет адрес длиннее максимальной длины', () => {
    const local = 'a'.repeat(EMAIL_MAX_LENGTH); // итоговая длина > 254
    const result = validatePrimaryAdminEmail(`${local}@example.com`);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain(`${EMAIL_MAX_LENGTH}`);
    }
  });

  it('отклоняет строку нужной длины, но не являющуюся адресом', () => {
    const result = validatePrimaryAdminEmail('not-an-email-value');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('формат');
    }
  });
});
