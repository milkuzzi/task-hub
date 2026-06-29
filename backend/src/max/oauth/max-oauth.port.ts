/**
 * Порт обмена кода авторизации OAuth MAX на идентификатор профиля MAX
 * (Req 16.1, 16.3).
 *
 * Абстрагирует сетевое взаимодействие с сервисом OAuth MAX от прикладной логики
 * входа ({@link import('../../auth').AuthService.loginWithMax}). Благодаря этому
 * вход через MAX тестируется без обращения к реальному сервису MAX и без
 * настоящих учётных данных: в тестах к токену {@link MAX_OAUTH_PORT}
 * привязывается мок, а в среде исполнения — HTTP-адаптер
 * {@link import('./max-oauth.client').MaxOAuthHttpClient}.
 */
export interface MaxOAuthPort {
  /**
   * Обменивает одноразовый код авторизации (`authCode`), полученный после
   * редиректа со стороны MAX, на стабильный идентификатор профиля MAX
   * (`maxUserId`) (Req 16.1).
   *
   * Метод выполняет только обмен и идентификацию профиля MAX; он не проверяет
   * привязку профиля к учётной записи Системы и не выпускает Сессию — это
   * ответственность прикладного слоя ({@link import('../../auth').AuthService}).
   *
   * @param authCode Одноразовый код авторизации, выданный MAX.
   * @param redirectUri Redirect URI, использованный при авторизации. Должен
   *   совпадать с переданным MAX на шаге выдачи кода.
   * @returns Идентификатор профиля MAX (`maxUserId`).
   * @throws MaxOAuthExchangeError Если авторизация на стороне MAX отклонена,
   *   код недействителен, сервис недоступен либо ответ некорректен (Req 16.3).
   */
  exchangeAuthCode(authCode: string, redirectUri?: string): Promise<string>;
}

/**
 * Ошибка обмена кода авторизации OAuth MAX (Req 16.3).
 *
 * Сигнализирует о любом неуспехе на стороне MAX: отклонённой авторизации,
 * недействительном коде, недоступности сервиса или некорректном ответе.
 * Прикладной слой перехватывает её и отклоняет вход, оставляя Пользователя
 * неаутентифицированным (Req 16.3), не раскрывая детали наружу.
 */
export class MaxOAuthExchangeError extends Error {
  /** Необязательная исходная причина ошибки (для диагностики/логирования). */
  readonly reason?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'MaxOAuthExchangeError';
    this.reason = options?.cause;
  }
}

/**
 * DI-токен порта {@link MaxOAuthPort}.
 *
 * В {@link import('../max.module').MaxIntegrationModule} по умолчанию связан с
 * HTTP-адаптером {@link import('./max-oauth.client').MaxOAuthHttpClient}. В
 * модульных тестах к токену привязывается мок, что исключает сетевые вызовы и
 * необходимость реальных учётных данных MAX.
 */
export const MAX_OAUTH_PORT = Symbol('MAX_OAUTH_PORT');
