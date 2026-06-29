import { api } from "./api";
import type { UserRole } from "./auth-api";
import type { TaskDetail, TaskStatus } from "./tasks-api";

/**
 * Действия смены Статуса и клиентское зеркало конечного автомата (Req 10).
 *
 * Сервер остаётся авторитетным источником истины: он повторно проверяет права
 * и допустимость перехода через `StatusMachine` (backend `status.machine.ts`).
 * Здесь логика переходов воспроизведена один-в-один, чтобы интерфейс предлагал
 * Пользователю только те действия, которые действительно допустимы из текущего
 * Статуса для его роли в контексте Задачи (Req 10.4–10.10, 10.14, 10.15). Это
 * убирает заведомо отклоняемые кнопки и делает UX предсказуемым.
 */

/** Роль действующего лица в контексте Задачи (зеркалит серверный `Actor`). */
export type Actor = "EXECUTOR" | "MANAGER" | "ADMIN";

/**
 * Явное действие смены Статуса (зеркалит серверный `StatusAction`).
 *
 * `ADMIN_SET` несёт выбранный Администратором целевой Статус из «Требует
 * администратора» (Req 10.9).
 */
export type StatusAction =
  | { type: "COMPLETE" } // Пометить «Выполнено» (Req 10.4)
  | { type: "START_WORK" } // Вернуть из «Ожидает» в «В работе»
  | { type: "REOPEN" } // Переоткрыть из «Выполнено» (Req 10.5)
  | { type: "CANCEL" } // Отменить (Req 10.6)
  | { type: "RETURN" } // Вернуть из «Отменено» (Req 10.7)
  | { type: "REQUEST_ADMIN" } // Запросить «Требует администратора» (Req 10.8)
  | { type: "ADMIN_SET"; target: TaskStatus } // Администратор выбирает Статус (Req 10.9)
  | { type: "CLEAR_ADMIN" }; // Менеджер снимает «Требует администратора» (Req 10.10)

/** Статусы, которые сообщение в Чат делает реактивными (Req 10.1, 10.2). */
const CHAT_REACTIVE_STATUSES: readonly TaskStatus[] = [
  "IN_PROGRESS",
  "WAITING",
];

/** Набор Статусов, выбираемых Администратором из «Требует администратора» (Req 10.9). */
export const ADMIN_SELECTABLE_TARGETS: readonly TaskStatus[] = [
  "IN_PROGRESS",
  "WAITING",
  "DONE",
  "CANCELLED",
];

/**
 * Определяет роль действующего лица для Задачи (Req 2.3, 2.4).
 *
 * - Администратор обладает надмножеством прав Менеджера (Req 2.3) — `ADMIN`.
 * - Менеджер Задачи действует как `MANAGER`.
 * - Менеджер, назначенный Исполнителем (присутствует в составе Исполнителей,
 *   но не Менеджеров), получает права Исполнителя (Req 2.4) — `EXECUTOR`.
 * - Прочие назначенные Исполнители — `EXECUTOR`.
 * - Если Пользователь не участвует в Задаче, действий смены Статуса нет (`null`).
 */
export function resolveActor(
  role: UserRole,
  userId: string,
  task: Pick<TaskDetail, "managerIds" | "executorIds">,
): Actor | null {
  if (role === "ADMIN") {
    return "ADMIN";
  }
  if (task.managerIds.includes(userId)) {
    return "MANAGER";
  }
  if (task.executorIds.includes(userId)) {
    return "EXECUTOR";
  }
  return null;
}

/** Проверяет право роли на действие (зеркалит `StatusMachine.hasPermission`, Req 10.14). */
function hasPermission(action: StatusAction, actor: Actor): boolean {
  if (actor === "EXECUTOR") {
    return false;
  }
  if (action.type === "ADMIN_SET" || action.type === "CANCEL") {
    return actor === "ADMIN";
  }
  if (action.type === "REQUEST_ADMIN") {
    return actor === "MANAGER";
  }
  return actor === "MANAGER" || actor === "ADMIN";
}

/**
 * Вычисляет целевой Статус для действия либо `null`, если переход недопустим из
 * текущего Статуса (зеркалит `StatusMachine.resolveTarget`, Req 10.4–10.10, 10.15).
 */
function resolveTarget(
  current: TaskStatus,
  action: StatusAction,
  reviewedFlag: boolean,
): TaskStatus | null {
  switch (action.type) {
    case "COMPLETE":
      return current === "IN_PROGRESS" || current === "WAITING" ? "DONE" : null;
    case "START_WORK":
      return current === "WAITING" ? "IN_PROGRESS" : null;
    case "REOPEN":
      return current === "DONE" ? "IN_PROGRESS" : null;
    case "CANCEL":
      return current === "IN_PROGRESS" ||
        current === "WAITING" ||
        current === "DONE" ||
        current === "NEEDS_ADMIN"
        ? "CANCELLED"
        : null;
    case "RETURN":
      return current === "CANCELLED" ? "IN_PROGRESS" : null;
    case "REQUEST_ADMIN":
      return current === "IN_PROGRESS" || current === "WAITING"
        ? "NEEDS_ADMIN"
        : null;
    case "ADMIN_SET":
      return current === "NEEDS_ADMIN" &&
        ADMIN_SELECTABLE_TARGETS.includes(action.target)
        ? action.target
        : null;
    case "CLEAR_ADMIN":
      return current === "NEEDS_ADMIN" && !reviewedFlag ? "IN_PROGRESS" : null;
    default:
      return null;
  }
}

/**
 * Чистый предикат: допустимо ли действие из текущего Статуса для роли
 * (Req 10.4–10.10, 10.14, 10.15). Используется и для рендера кнопок, и в тестах.
 */
export function canTransition(
  current: TaskStatus,
  action: StatusAction,
  actor: Actor,
  reviewedFlag = false,
): boolean {
  return (
    hasPermission(action, actor) &&
    resolveTarget(current, action, reviewedFlag) !== null
  );
}

/** Кандидаты действий, не несущие параметров (без `ADMIN_SET`). */
const SIMPLE_ACTIONS: readonly StatusAction[] = [
  { type: "COMPLETE" },
  { type: "START_WORK" },
  { type: "REOPEN" },
  { type: "CANCEL" },
  { type: "RETURN" },
  { type: "REQUEST_ADMIN" },
  { type: "CLEAR_ADMIN" },
];

/**
 * Возвращает все допустимые из текущего Статуса действия для роли
 * (Req 10.4–10.10). Для «Требует администратора» Администратор получает по
 * одному действию `ADMIN_SET` на каждый выбираемый целевой Статус (Req 10.9).
 *
 * @param current Текущий Статус Задачи.
 * @param actor Роль действующего лица в контексте Задачи.
 * @param reviewedFlag Признак проверки Администратором (Req 10.10).
 */
export function availableStatusActions(
  current: TaskStatus,
  actor: Actor,
  reviewedFlag = false,
): StatusAction[] {
  const actions: StatusAction[] = [];
  for (const action of SIMPLE_ACTIONS) {
    if (canTransition(current, action, actor, reviewedFlag)) {
      actions.push(action);
    }
  }
  if (current === "NEEDS_ADMIN" && actor === "ADMIN") {
    for (const target of ADMIN_SELECTABLE_TARGETS) {
      actions.push({ type: "ADMIN_SET", target });
    }
  }
  return actions;
}

/** Тело команды смены Статуса (передаётся на backend, Req 10.4–10.10). */
export interface ChangeStatusBody {
  action: StatusAction;
}

/**
 * Команда смены Статуса Задачи по правилам автомата (Req 10.4–10.10).
 *
 * Сервер повторно проверяет права и допустимость перехода; при отказе вернёт
 * ошибку `NO_PERMISSION`/`INVALID_TRANSITION` (Req 10.14, 10.15), а Статус не
 * изменится. Возвращается актуальная Задача с новым Статусом.
 */
export function changeStatus(
  taskId: string,
  action: StatusAction,
): Promise<TaskDetail> {
  return api.post<TaskDetail>(`/tasks/${taskId}/status`, {
    action,
  } satisfies ChangeStatusBody);
}

/**
 * Признак реактивности Статуса к сообщениям Чата (Req 10.1, 10.2). Полезно для
 * подсказок интерфейса: в реактивных Статусах сообщение участников меняет Статус.
 */
export function isChatReactiveStatus(status: TaskStatus): boolean {
  return CHAT_REACTIVE_STATUSES.includes(status);
}
