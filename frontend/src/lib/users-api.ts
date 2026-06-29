import { api, http } from "./api";
import type { UserRole } from "./auth-api";

/**
 * Типы и REST-вызовы администрирования Пользователей «Системы поручений».
 *
 * Все операции доступны только Администратору (Req 5.1, 6.2, 6.3, 8.1, 7.2, 3.1)
 * и проксируются на `UsersModule` backend. Контракты соответствуют разделу
 * UsersModule дизайна:
 * - `inviteUser(email)` — регистрация Пользователя по email (Req 5.1–5.3).
 * - `updateUser(id, { email?, name? })` — изменение email/имени (Req 6.2, 6.3).
 * - `uploadUserAvatar(id, file)` — изменение аватара Пользователя Администратором.
 * - `deleteUser(id, mode)` — удаление soft/hard с подтверждением (Req 8.1–8.3).
 * - `restoreUser(id, email)` — восстановление по сохранённому адресу (Req 7.2).
 * - `transferAdmin(id)` — передача роли администратора (Req 3.1).
 */

/** Режим удаления: `soft` — с сохранением записи, `hard` — без (Req 8.1–8.3). */
export type DeleteMode = "soft" | "hard";

/** Активный Пользователь в списке администрирования. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Относительный путь до аватара либо `null` (Req 2.4). */
  avatarPath?: string | null;
  /** Активирована ли учётная запись (установлен пароль, Req 5.5). */
  active: boolean;
  /** Временно заблокирован после неудачных попыток входа (Req 5.9). */
  locked: boolean;
  /** Привязан ли профиль MAX (Req 6.6, 16.2). */
  maxLinked: boolean;
}

/**
 * Удалённый Пользователь и его сохранённые адреса электронной почты.
 *
 * Поле `emails` содержит историю адресов (≥50, Req 7.1); Администратор выбирает
 * один из них для восстановления (Req 7.3). Пустой список означает отказ в
 * восстановлении (Req 7.6) — UI блокирует действие.
 */
export interface DeletedUser {
  id: string;
  name: string;
  /** Сохранённые адреса для выбора при восстановлении (Req 7.1, 7.3). */
  emails: string[];
  /** Момент удаления (ISO-8601, UTC) — для отображения в MSK. */
  deletedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireAdminUser(value: unknown): AdminUser {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.email !== "string" ||
    typeof value.name !== "string" ||
    !["ADMIN", "MANAGER", "EXECUTOR"].includes(String(value.role)) ||
    typeof value.active !== "boolean" ||
    typeof value.locked !== "boolean" ||
    typeof value.maxLinked !== "boolean" ||
    !(
      value.avatarPath === undefined ||
      value.avatarPath === null ||
      typeof value.avatarPath === "string"
    )
  ) {
    throw new TypeError("Некорректный ответ API: ожидался пользователь");
  }
  return value as unknown as AdminUser;
}

function requireDeletedUser(value: unknown): DeletedUser {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.emails) ||
    !value.emails.every((email) => typeof email === "string") ||
    typeof value.deletedAt !== "string" ||
    Number.isNaN(new Date(value.deletedAt).getTime())
  ) {
    throw new TypeError(
      "Некорректный ответ API: ожидался удалённый пользователь",
    );
  }
  return value as unknown as DeletedUser;
}

function requireArray<T>(
  value: unknown,
  validate: (item: unknown) => T,
  label: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Некорректный ответ API: ожидался ${label}`);
  }
  return value.map(validate);
}

/** Список активных Пользователей (Req 5.1 — раздел администрирования). */
export async function listUsers(): Promise<AdminUser[]> {
  return requireArray(
    await api.get<unknown>("/users"),
    requireAdminUser,
    "список пользователей",
  );
}

/** Список удалённых Пользователей с сохранёнными адресами (Req 7.3, 8.2). */
export async function listDeletedUsers(): Promise<DeletedUser[]> {
  return requireArray(
    await api.get<unknown>("/users/deleted"),
    requireDeletedUser,
    "список удалённых пользователей",
  );
}

/**
 * Приглашение нового Пользователя по адресу электронной почты (Req 5.1–5.3).
 * Backend отправляет письмо со ссылкой установки пароля (TTL 24ч).
 */
export async function inviteUser(email: string): Promise<AdminUser> {
  return requireAdminUser(await api.post<unknown>("/users/invite", { email }));
}

/** Изменение адреса электронной почты и/или имени Пользователя (Req 6.2, 6.3). */
export async function updateUser(
  userId: string,
  patch: { email?: string; name?: string },
): Promise<AdminUser> {
  return requireAdminUser(await api.patch<unknown>(`/users/${userId}`, patch));
}

/** Загрузка аватара выбранного Пользователя Администратором. */
export async function uploadUserAvatar(
  userId: string,
  file: File,
): Promise<AdminUser> {
  const form = new FormData();
  form.append("avatar", file);
  return requireAdminUser(
    await api.post<unknown>(`/users/${userId}/avatar`, form),
  );
}

/**
 * Удаление Пользователя в выбранном режиме (Req 8.1–8.3).
 * Подтверждение запрашивается в UI до вызова (Req 8.9).
 */
export function deleteUser(userId: string, mode: DeleteMode): Promise<void> {
  return http
    .delete<void>(`/users/${userId}`, { params: { mode } })
    .then((r) => r.data);
}

/**
 * Восстановление удалённого Пользователя по выбранному сохранённому адресу
 * (Req 7.2). Backend отклоняет операцию при занятом адресе (Req 7.5) или при
 * отсутствии сохранённых адресов (Req 7.6) — UI показывает сообщение об ошибке.
 */
export async function restoreUser(
  userId: string,
  email: string,
): Promise<AdminUser> {
  return requireAdminUser(
    await api.post<unknown>(`/users/${userId}/restore`, { email }),
  );
}

/**
 * Передача роли администратора активному Пользователю (Req 3.1).
 * Бывший Администратор становится Исполнителем, его сессии аннулируются (Req 3.3, 3.4).
 */
export function transferAdmin(userId: string): Promise<void> {
  return api.post<void>(`/users/${userId}/transfer-admin`);
}
