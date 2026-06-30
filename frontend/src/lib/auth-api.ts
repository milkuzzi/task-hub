import { api } from "./api";

/**
 * Типы и REST-вызовы аутентификации и профиля «Системы поручений».
 *
 * Контракты соответствуют разделу AuthModule/UsersModule дизайна:
 * - `login(email, password)` → Сессия (Req 5.7).
 * - `loginWithMax(authCode, redirectUri)` → legacy-сессия через OAuth MAX (Req 16.1, 16.3).
 * - `startMaxBotLogin()`/`pollMaxBotLogin(state)` → вход через Бота MAX.
 * - `setPassword(token, password)` — установка пароля по одноразовой ссылке (Req 5.5, 6.7).
 * - `requestPasswordReset(email)` — запрос одноразовой ссылки восстановления пароля.
 * - `changePassword(current, next)` — смена собственного пароля (Req 6.1, 6.7).
 * - `updateProfileName(name)` — изменение собственного отображаемого имени.
 * - `setAvatar(file)` — собственный аватар (Req 6.4, 6.9).
 * - `linkMax(authCode, redirectUri)` — legacy-привязка собственного профиля MAX (Req 6.6, 16.2).
 * - `unlinkMax()` — отвязка собственного профиля MAX.
 * - `startMaxBotLink()`/`pollMaxBotLink(state)` — привязка через Бота MAX.
 */

/** Роль Пользователя в Системе. */
export type UserRole = "ADMIN" | "MANAGER" | "EXECUTOR";

/** Профиль аутентифицированного Пользователя. */
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Относительный путь до аватара (отдаётся backend), либо null. */
  avatarPath: string | null;
  /** Привязан ли профиль MAX (Req 6.6, 16.2). */
  maxLinked: boolean;
}

/** Ответ успешной аутентификации: токен Сессии и профиль. */
export interface AuthSession {
  token: string;
  user: CurrentUser;
}

/** Начало входа/привязки через Бота MAX. */
export interface MaxBotAuthStart {
  state: string;
  link: string;
  expiresAt: string;
}

export type MaxMiniAppSession = AuthSession;

/** Статус входа через Бота MAX. */
export type MaxBotLoginStatus =
  | { status: "pending" | "expired" }
  | { status: "failed"; reason: string }
  | ({ status: "confirmed" } & AuthSession);

/** Статус привязки профиля через Бота MAX. */
export type MaxBotLinkStatus =
  | { status: "pending" | "expired" }
  | { status: "failed"; reason: string }
  | { status: "confirmed"; user: CurrentUser };

/** Вход по адресу электронной почты и паролю (Req 5.7, 5.8). */
export function login(email: string, password: string): Promise<AuthSession> {
  return api.post<AuthSession>("/auth/login", { email, password });
}

/** Вход через OAuth MAX по полученному authCode (Req 16.1, 16.3). */
export function loginWithMax(
  authCode: string,
  redirectUri?: string,
): Promise<AuthSession> {
  return api.post<AuthSession>("/auth/max", { authCode, redirectUri });
}

export function loginWithMaxMiniApp(initData: string): Promise<MaxMiniAppSession> {
  return api.post<MaxMiniAppSession>("/auth/max/mini-app", { initData });
}

export function linkAndLoginWithMaxMiniApp(
  initData: string,
  email: string,
  password: string,
): Promise<MaxMiniAppSession> {
  return api.post<MaxMiniAppSession>("/auth/max/mini-app/link", {
    initData,
    email,
    password,
  });
}

export interface MaxNotificationSettings {
  linked: boolean;
  muted: boolean;
}

export function getMaxNotificationSettings(): Promise<MaxNotificationSettings> {
  return api.get<MaxNotificationSettings>("/profile/max/notifications");
}

export function updateMaxNotificationSettings(muted: boolean): Promise<MaxNotificationSettings> {
  return api.patch<MaxNotificationSettings>("/profile/max/notifications", { muted });
}

/** Начать вход через Бота MAX: backend создаёт одноразовый state и deep link. */
export function startMaxBotLogin(): Promise<MaxBotAuthStart> {
  return api.post<MaxBotAuthStart>("/max/bot/auth/login/start");
}

/** Проверить, подтвердил ли пользователь вход в Боте MAX. */
export function pollMaxBotLogin(state: string): Promise<MaxBotLoginStatus> {
  return api.get<MaxBotLoginStatus>("/max/bot/auth/login/status", { state });
}

/** Установка пароля по одноразовой ссылке (активация учётной записи, Req 5.5, 6.7). */
export function setPassword(token: string, password: string): Promise<void> {
  return api.post<void>("/auth/set-password", { token, password });
}

/** Запросить ссылку восстановления пароля без раскрытия наличия учётной записи. */
export function requestPasswordReset(email: string): Promise<void> {
  return api.post<void>("/auth/password-reset/request", { email });
}

/** Смена собственного пароля при указании текущего (Req 6.1, 6.7). */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return api.post<void>("/auth/change-password", {
    currentPassword,
    newPassword,
  });
}

/** Запрос профиля текущей Сессии (восстановление состояния после перезагрузки). */
export function fetchMe(): Promise<CurrentUser> {
  return api.get<CurrentUser>("/auth/me");
}

/** Завершение Сессии на сервере (Req 19.10). */
export function logout(): Promise<void> {
  return api.post<void>("/auth/logout");
}

/**
 * Продление действующей Сессии (скользящая сессия, Req 2.9). Возвращает новый
 * токен и профиль; прежний токен после вызова становится недействительным.
 * Доступно только при действующей Сессии (эндпоинт под SessionAuthGuard).
 */
export function refreshSession(): Promise<AuthSession> {
  return api.post<AuthSession>("/auth/refresh");
}

/** Изменение собственного отображаемого имени. */
export function updateProfileName(name: string): Promise<CurrentUser> {
  return api.patch<CurrentUser>("/profile", { name });
}

/**
 * Загрузка собственного аватара (Req 6.4, 6.9). Передаётся multipart/form-data;
 * заголовок Content-Type выставляется браузером автоматически (с boundary).
 */
export function setAvatar(file: File): Promise<CurrentUser> {
  const form = new FormData();
  form.append("avatar", file);
  return api.post<CurrentUser>("/profile/avatar", form);
}

/** Привязка собственного профиля MAX по authCode OAuth (Req 6.6, 16.2). */
export function linkMax(
  authCode: string,
  redirectUri?: string,
): Promise<CurrentUser> {
  return api.post<CurrentUser>("/profile/max", { authCode, redirectUri });
}

/** Отвязка собственного профиля MAX. */
export function unlinkMax(): Promise<CurrentUser> {
  return api.delete<CurrentUser>("/profile/max");
}

/** Начать привязку MAX через Бота: backend создаёт одноразовый state и deep link. */
export function startMaxBotLink(): Promise<MaxBotAuthStart> {
  return api.post<MaxBotAuthStart>("/max/bot/auth/link/start");
}

/** Проверить, завершилась ли привязка MAX через Бота. */
export function pollMaxBotLink(state: string): Promise<MaxBotLinkStatus> {
  return api.get<MaxBotLinkStatus>("/max/bot/auth/link/status", { state });
}
