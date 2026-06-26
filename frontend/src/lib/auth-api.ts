import { api } from './api';

/**
 * Типы и REST-вызовы аутентификации и профиля «Системы поручений».
 *
 * Контракты соответствуют разделу AuthModule/UsersModule дизайна:
 * - `login(email, password)` → Сессия (Req 5.7).
 * - `loginWithMax(authCode)` → Сессия через OAuth MAX (Req 16.1, 16.3).
 * - `setPassword(token, password)` — установка пароля по одноразовой ссылке (Req 5.5, 6.7).
 * - `changePassword(current, next)` — смена собственного пароля (Req 6.1, 6.7).
 * - `setAvatar(file)` — собственный аватар (Req 6.4, 6.9).
 * - `linkMax(authCode)` — привязка собственного профиля MAX (Req 6.6, 16.2).
 */

/** Роль Пользователя в Системе. */
export type UserRole = 'ADMIN' | 'MANAGER' | 'EXECUTOR';

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

/** Вход по адресу электронной почты и паролю (Req 5.7, 5.8). */
export function login(email: string, password: string): Promise<AuthSession> {
  return api.post<AuthSession>('/auth/login', { email, password });
}

/** Вход через OAuth MAX по полученному authCode (Req 16.1, 16.3). */
export function loginWithMax(authCode: string): Promise<AuthSession> {
  return api.post<AuthSession>('/auth/max', { authCode });
}

/** Установка пароля по одноразовой ссылке (активация учётной записи, Req 5.5, 6.7). */
export function setPassword(token: string, password: string): Promise<void> {
  return api.post<void>('/auth/set-password', { token, password });
}

/** Смена собственного пароля при указании текущего (Req 6.1, 6.7). */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return api.post<void>('/auth/change-password', { currentPassword, newPassword });
}

/** Запрос профиля текущей Сессии (восстановление состояния после перезагрузки). */
export function fetchMe(): Promise<CurrentUser> {
  return api.get<CurrentUser>('/auth/me');
}

/** Завершение Сессии на сервере (Req 19.10). */
export function logout(): Promise<void> {
  return api.post<void>('/auth/logout');
}

/**
 * Продление действующей Сессии (скользящая сессия, Req 2.9). Возвращает новый
 * токен и профиль; прежний токен после вызова становится недействительным.
 * Доступно только при действующей Сессии (эндпоинт под SessionAuthGuard).
 */
export function refreshSession(): Promise<AuthSession> {
  return api.post<AuthSession>('/auth/refresh');
}

/**
 * Загрузка собственного аватара (Req 6.4, 6.9). Передаётся multipart/form-data;
 * заголовок Content-Type выставляется браузером автоматически (с boundary).
 */
export function setAvatar(file: File): Promise<CurrentUser> {
  const form = new FormData();
  form.append('avatar', file);
  return api.post<CurrentUser>('/profile/avatar', form);
}

/** Привязка собственного профиля MAX по authCode OAuth (Req 6.6, 16.2). */
export function linkMax(authCode: string): Promise<CurrentUser> {
  return api.post<CurrentUser>('/profile/max', { authCode });
}
