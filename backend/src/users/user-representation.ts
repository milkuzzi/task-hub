import { Role } from '@prisma/client';
import { UserWithEmails, UserWithMaxLink } from '../repositories';

/**
 * HTTP-представления Пользователя для REST-слоя (контракты frontend).
 *
 * Сопоставляют доменную сущность {@link import('@prisma/client').User} (вместе
 * с подгруженной привязкой MAX, см. {@link UserWithMaxLink}) с формами,
 * ожидаемыми клиентом:
 * - {@link CurrentUserView} — профиль аутентифицированного Пользователя
 *   (`/auth/me`, ответ входа);
 * - {@link AdminUserView} — запись в разделе администрирования Пользователей
 *   (`GET /users`, `POST /users/invite`, Req 5.1).
 *
 * Признак привязки профиля MAX (`maxLinked`) вычисляется по наличию связанной
 * записи {@link import('@prisma/client').MaxLink} (Req 6.6, 16.2).
 */

/** Профиль аутентифицированного Пользователя (контракт `auth-api.ts`). */
export interface CurrentUserView {
  /** Идентификатор Пользователя. */
  id: string;
  /** Адрес электронной почты. */
  email: string;
  /** Отображаемое имя. */
  name: string;
  /** Роль в Системе. */
  role: Role;
  /** Относительный путь до аватара либо `null`. */
  avatarPath: string | null;
  /** Привязан ли профиль MAX (Req 6.6, 16.2). */
  maxLinked: boolean;
}

/** Активный Пользователь в разделе администрирования (контракт `users-api.ts`). */
export interface AdminUserView {
  /** Идентификатор Пользователя. */
  id: string;
  /** Адрес электронной почты. */
  email: string;
  /** Отображаемое имя. */
  name: string;
  /** Роль в Системе. */
  role: Role;
  /** Относительный путь до аватара либо `null` (дефект 4, Req 2.4). */
  avatarPath: string | null;
  /** Активирована ли учётная запись (установлен пароль, Req 5.5). */
  active: boolean;
  /** Временно заблокирован после неудачных попыток входа (Req 5.9, 5.10). */
  locked: boolean;
  /** Привязан ли профиль MAX (Req 6.6, 16.2). */
  maxLinked: boolean;
}

/** Удалённый Пользователь и его сохранённые адреса (контракт `users-api.ts`). */
export interface DeletedUserView {
  /** Идентификатор Пользователя. */
  id: string;
  /** Отображаемое имя на момент удаления (Req 8.4). */
  name: string;
  /** Сохранённые адреса для выбора при восстановлении (Req 7.1, 7.3). */
  emails: string[];
  /** Момент удаления (ISO-8601, UTC). */
  deletedAt: string;
}

/** Запись справочника Пользователей для выбора участников (контракт `tasks-api.ts`). */
export interface DirectoryUserView {
  /** Идентификатор Пользователя. */
  id: string;
  /** Отображаемое имя. */
  name: string;
  /** Роль в Системе. */
  role: Role;
}

/**
 * Преобразует Пользователя в профиль текущей Сессии (`CurrentUser`).
 *
 * @param user Пользователь с подгруженной привязкой MAX.
 * @returns Профиль для ответа `/auth/me` и успешного входа.
 */
export function toCurrentUser(user: UserWithMaxLink): CurrentUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.displayName,
    role: user.role,
    avatarPath: user.avatarPath,
    maxLinked: user.maxLink !== null,
  };
}

/**
 * Преобразует Пользователя в запись администрирования (`AdminUser`).
 *
 * Признак `locked` вычисляется относительно переданного момента `now`:
 * учётная запись считается временно заблокированной, если `lockedUntil`
 * установлен и ещё не наступил (Req 5.9, 5.10).
 *
 * @param user Пользователь с подгруженной привязкой MAX.
 * @param now Текущий момент времени (источник — {@link import('../clock').ClockService}).
 * @returns Запись для списка администрирования Пользователей.
 */
export function toAdminUser(user: UserWithMaxLink, now: Date): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.displayName,
    role: user.role,
    avatarPath: user.avatarPath,
    active: user.isActive,
    locked: user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime(),
    maxLinked: user.maxLink !== null,
  };
}

/**
 * Преобразует удалённого Пользователя с историей адресов в запись списка
 * удалённых (`DeletedUser`) для выбора адреса при восстановлении (Req 7.1, 7.3).
 *
 * @param user Удалённый Пользователь с подгруженной историей адресов.
 * @returns Запись для списка удалённых Пользователей.
 */
export function toDeletedUser(user: UserWithEmails): DeletedUserView {
  return {
    id: user.id,
    name: user.displayName,
    emails: user.emails.map((e) => e.email),
    deletedAt: (user.deletedAt ?? user.updatedAt).toISOString(),
  };
}

/**
 * Преобразует Пользователя в запись справочника (`DirectoryUser`) для выбора
 * Исполнителей/Менеджеров при создании и назначении Задач.
 *
 * @param user Активный Пользователь.
 * @returns Минимальная запись справочника.
 */
export function toDirectoryUser(user: {
  id: string;
  displayName: string;
  role: Role;
}): DirectoryUserView {
  return { id: user.id, name: user.displayName, role: user.role };
}
