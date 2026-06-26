import { validatePasswordLength } from './password';

/**
 * Модульные тесты чистой валидации длины пароля (Req 6.7, 5.5).
 */
describe('validatePasswordLength (Req 6.7)', () => {
  const MIN = 8;
  const MAX = 128;

  it('принимает пароль на нижней границе диапазона', () => {
    expect(validatePasswordLength('a'.repeat(MIN), MIN, MAX)).toEqual({ valid: true });
  });

  it('принимает пароль на верхней границе диапазона', () => {
    expect(validatePasswordLength('a'.repeat(MAX), MIN, MAX)).toEqual({ valid: true });
  });

  it('отклоняет слишком короткий пароль', () => {
    const result = validatePasswordLength('a'.repeat(MIN - 1), MIN, MAX);
    expect(result.valid).toBe(false);
  });

  it('отклоняет слишком длинный пароль', () => {
    const result = validatePasswordLength('a'.repeat(MAX + 1), MIN, MAX);
    expect(result.valid).toBe(false);
  });

  it('отклоняет отсутствующий пароль', () => {
    expect(validatePasswordLength(undefined, MIN, MAX).valid).toBe(false);
    expect(validatePasswordLength('', MIN, MAX).valid).toBe(false);
  });
});
