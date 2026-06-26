import fc from 'fast-check';

import { buildHttpsRedirectUrl } from './https-redirect.util';

/**
 * **Feature: task-assignment-system, Property 2: HTTP→HTTPS сохраняет путь и параметры**
 *
 * Validates: Requirements 1.3, 1.4
 *
 * Для любого входного URL по HTTP с произвольными путём и query-параметрами
 * построенный redirect-URL использует HTTPS и сохраняет тот же путь и те же
 * query-параметры.
 *
 * Тест реализует ровно одно свойство (Property 2) и проверяет его на ≥100
 * итерациях через fast-check.
 */
describe('Property 2: HTTP→HTTPS сохраняет путь и параметры', () => {
  // Сегмент пути: безопасные символы без слешей и без символов query/fragment.
  const pathSegment = fc.stringMatching(/^[A-Za-z0-9\-._~%]+$/);

  // Путь: ведущий слеш и произвольное число сегментов (включая корень "/").
  const arbitraryPath = fc
    .array(pathSegment, { minLength: 0, maxLength: 6 })
    .map((segments) => `/${segments.join('/')}`);

  // Ключи и значения query-параметров без разделителей, чтобы строка query
  // имела однозначную сериализацию.
  const queryToken = fc.stringMatching(/^[A-Za-z0-9\-._~%]+$/);

  // Query-строка: либо отсутствует, либо набор пар key=value через "&".
  const arbitraryQuery = fc
    .array(fc.tuple(queryToken, queryToken), { minLength: 0, maxLength: 6 })
    .map((pairs) => (pairs.length === 0 ? '' : `?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}`));

  // Хост: метка(и) домена через точку, опционально с нестандартным портом.
  // Метка начинается с буквы, чтобы независимый разбор через WHATWG `URL`
  // не интерпретировал последнюю метку как (некорректный) IPv4-адрес.
  const hostLabel = fc.stringMatching(/^[a-z]([a-z0-9-]{0,20}[a-z0-9])?$/);
  const arbitraryHost = fc
    .tuple(
      fc.array(hostLabel, { minLength: 1, maxLength: 4 }),
      fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    )
    .map(([labels, port]) => {
      const domain = labels.join('.');
      return port === undefined ? domain : `${domain}:${port}`;
    });

  it('перенаправляет на HTTPS, сохраняя путь и query (≥100 итераций)', () => {
    fc.assert(
      fc.property(arbitraryHost, arbitraryPath, arbitraryQuery, (host, path, query) => {
        const originalUrl = `${path}${query}`;

        const redirectUrl = buildHttpsRedirectUrl({ host, originalUrl });

        // 1. Схема всегда HTTPS (Req 1.3).
        expect(redirectUrl.startsWith('https://')).toBe(true);

        // Отделяем authority (host[:port]) от пути+query, не прибегая к
        // нормализующему разбору URL: путь начинается с "/", поэтому
        // authority — это всё до первого слеша после схемы.
        const afterScheme = redirectUrl.slice('https://'.length);
        const firstSlash = afterScheme.indexOf('/');
        expect(firstSlash).toBeGreaterThanOrEqual(0);

        const authority = afterScheme.slice(0, firstSlash);
        const pathAndQuery = afterScheme.slice(firstSlash);

        // 2. Authority не содержит путь/query — это только host[:port].
        expect(authority.includes('?')).toBe(false);

        // 3. Путь и query сохранены дословно, без нормализации (Req 1.4):
        //    «путь + query» результата точно равен исходному URI.
        expect(pathAndQuery).toBe(originalUrl);
      }),
      { numRuns: 200 },
    );
  });
});
