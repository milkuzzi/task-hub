import { buildHttpsRedirectUrl, isSecureRequest } from './https-redirect.util';

describe('buildHttpsRedirectUrl()', () => {
  it('строит HTTPS-URL, сохраняя путь и query-параметры', () => {
    const url = buildHttpsRedirectUrl({
      host: 'example.com',
      originalUrl: '/tasks/42?filter=open&sort=deadline',
    });
    expect(url).toBe('https://example.com/tasks/42?filter=open&sort=deadline');
  });

  it('сохраняет корневой путь без query', () => {
    expect(buildHttpsRedirectUrl({ host: 'example.com', originalUrl: '/' })).toBe(
      'https://example.com/',
    );
  });

  it('отбрасывает стандартный HTTP-порт :80', () => {
    expect(buildHttpsRedirectUrl({ host: 'example.com:80', originalUrl: '/a' })).toBe(
      'https://example.com/a',
    );
  });

  it('сохраняет нестандартный порт', () => {
    expect(buildHttpsRedirectUrl({ host: 'example.com:8080', originalUrl: '/a' })).toBe(
      'https://example.com:8080/a',
    );
  });

  it('подставляет ведущий слеш для пустого originalUrl', () => {
    expect(buildHttpsRedirectUrl({ host: 'example.com', originalUrl: '' })).toBe(
      'https://example.com/',
    );
  });

  it('кодированные символы пути и query сохраняются без изменений', () => {
    const original = '/поиск/%D1%84?q=%20a%26b';
    expect(buildHttpsRedirectUrl({ host: 'example.com', originalUrl: original })).toBe(
      `https://example.com${original}`,
    );
  });

  it('бросает ошибку при пустом заголовке Host', () => {
    expect(() => buildHttpsRedirectUrl({ host: '   ', originalUrl: '/a' })).toThrow();
  });
});

describe('isSecureRequest()', () => {
  it('распознаёт HTTPS по заголовку X-Forwarded-Proto', () => {
    expect(isSecureRequest({ protocol: 'http', forwardedProto: 'https' })).toBe(true);
  });

  it('считает запрос незащищённым при X-Forwarded-Proto=http', () => {
    expect(isSecureRequest({ protocol: 'http', forwardedProto: 'http' })).toBe(false);
  });

  it('использует собственный протокол при отсутствии прокси-заголовка', () => {
    expect(isSecureRequest({ protocol: 'https' })).toBe(true);
    expect(isSecureRequest({ protocol: 'http' })).toBe(false);
  });

  it('берёт первый протокол из списка X-Forwarded-Proto', () => {
    expect(isSecureRequest({ protocol: 'http', forwardedProto: 'https, http' })).toBe(true);
  });
});
