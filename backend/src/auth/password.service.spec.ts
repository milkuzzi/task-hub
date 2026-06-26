import { PasswordService } from './password.service';

/**
 * Модульные тесты {@link PasswordService}: хеш необратим, соль уникальна,
 * проверка корректна (Req 5.5, 6.7). Использует реальный bcrypt без моков.
 */
describe('PasswordService (Req 5.5, 6.7)', () => {
  const service = new PasswordService();

  it('возвращает хеш, отличный от открытого пароля', async () => {
    const hash = await service.hash('correct horse');
    expect(hash).not.toContain('correct horse');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('подтверждает совпадающий пароль', async () => {
    const hash = await service.hash('s3cret-pass');
    await expect(service.verify('s3cret-pass', hash)).resolves.toBe(true);
  });

  it('отклоняет несовпадающий пароль', async () => {
    const hash = await service.hash('s3cret-pass');
    await expect(service.verify('wrong-pass', hash)).resolves.toBe(false);
  });

  it('использует уникальную соль для одинаковых паролей', async () => {
    const [a, b] = await Promise.all([service.hash('same-pass'), service.hash('same-pass')]);
    expect(a).not.toEqual(b);
  });
});
