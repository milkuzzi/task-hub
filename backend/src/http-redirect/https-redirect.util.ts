/**
 * Чистые функции для перенаправления HTTP→HTTPS (Req 1.3, 1.4).
 *
 * Логика построения целевого адреса вынесена из middleware в отдельные
 * чистые функции, чтобы её можно было детерминированно протестировать
 * (в том числе property-based-тестом, см. Property 2) и переиспользовать
 * в конфигурации/прокси при необходимости.
 */

/** Стандартный порт незащищённого HTTP. */
const DEFAULT_HTTP_PORT = '80';

/** Части входящего запроса, необходимые для построения redirect-URL. */
export interface HttpRequestParts {
  /**
   * Значение заголовка `Host`, например `example.com` или
   * `example.com:8080`. Может содержать порт.
   */
  host: string;
  /**
   * Исходный URI запроса — путь и query-строка ровно так, как их прислал
   * клиент, например `/a/b?x=1&y=2`. Соответствует `req.originalUrl` Express.
   */
  originalUrl: string;
}

/** Признаки протокола запроса для решения о необходимости перенаправления. */
export interface ProtocolParts {
  /**
   * Протокол, определённый сервером приложения (`req.protocol`).
   * За обратным прокси (Nginx) это, как правило, `http`.
   */
  protocol?: string | undefined;
  /**
   * Значение заголовка `X-Forwarded-Proto`, выставляемого обратным прокси,
   * терминирующим TLS. Если равно `https`, исходный запрос пришёл по HTTPS.
   */
  forwardedProto?: string | undefined;
}

/**
 * Нормализует значение `Host`, убирая стандартный HTTP-порт `:80`.
 *
 * При переходе на HTTPS порт `80` не имеет смысла (HTTPS по умолчанию `443`),
 * поэтому он отбрасывается. Любой другой явно указанный порт сохраняется,
 * так как может быть значимым в нестандартных развёртываниях.
 */
function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.endsWith(`:${DEFAULT_HTTP_PORT}`)) {
    return trimmed.slice(0, -(DEFAULT_HTTP_PORT.length + 1));
  }
  return trimmed;
}

/**
 * Гарантирует, что путь начинается с `/`, не изменяя query-строку.
 * Express всегда отдаёт `originalUrl` с ведущим слешем, но функция остаётся
 * корректной и для входа без него.
 */
function normalizeOriginalUrl(originalUrl: string): string {
  if (originalUrl.length === 0) {
    return '/';
  }
  return originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
}

/**
 * Строит эквивалентный адрес по протоколу HTTPS, сохраняя исходные путь и
 * параметры запроса (Req 1.4).
 *
 * @param parts Хост и исходный URI запроса.
 * @returns Абсолютный HTTPS-URL вида `https://<host><path>?<query>`.
 * @throws {Error} Если `host` пуст или состоит только из пробелов.
 */
export function buildHttpsRedirectUrl(parts: HttpRequestParts): string {
  const host = normalizeHost(parts.host);
  if (host.length === 0) {
    throw new Error('Невозможно построить redirect-URL: отсутствует заголовок Host.');
  }
  const path = normalizeOriginalUrl(parts.originalUrl);
  return `https://${host}${path}`;
}

/**
 * Определяет, пришёл ли запрос по защищённому протоколу (HTTPS).
 *
 * Учитывает заголовок `X-Forwarded-Proto`, так как в целевом развёртывании
 * TLS терминирует обратный прокси (Nginx), а приложение получает запрос по
 * HTTP с этим заголовком. Если прокси отсутствует, используется собственный
 * протокол сервера.
 */
export function isSecureRequest(parts: ProtocolParts): boolean {
  const forwarded = parts.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded.length > 0) {
    return forwarded === 'https';
  }
  return parts.protocol?.toLowerCase() === 'https';
}
