import { Injectable } from '@nestjs/common';
import { Actor, Status, StatusAction, TransitionResult } from './status.types';

/**
 * Статусы, в которых сообщение в Чат меняет статус Задачи (Req 10.1, 10.2).
 * В прочих статусах («Выполнено», «Отменено», «Требует администратора»)
 * сообщение статус не меняет (Req 10.3).
 */
const CHAT_REACTIVE_STATUSES: ReadonlySet<Status> = new Set<Status>(['IN_PROGRESS', 'WAITING']);

/**
 * Статусы, которые Администратор вправе выбрать из «Требует администратора»
 * (Req 10.9). «Требует администратора» в набор не входит.
 */
const ADMIN_SELECTABLE_TARGETS: ReadonlySet<Status> = new Set<Status>([
  'IN_PROGRESS',
  'WAITING',
  'DONE',
  'CANCELLED',
]);

/**
 * Чистый, не имеющий зависимостей конечный автомат статусов Задачи (Req 10).
 *
 * Автомат не обращается к базе данных, времени или другим сервисам: он
 * принимает текущий статус и событие, а возвращает результат перехода. Это
 * делает его детерминированным и пригодным для property-based-тестирования.
 *
 * Решение о правах действующего лица (например, является ли Менеджер
 * Исполнителем данной Задачи, Req 2.4) принимает вызывающая сторона и передаёт
 * уже разрешённую роль {@link Actor}.
 */
@Injectable()
export class StatusMachine {
  /**
   * Авто-переход статуса по сообщению в Чат (Req 10.1–10.3).
   *
   * - В статусе «В работе» или «Ожидает» сообщение Исполнителя переводит
   *   Задачу в «Ожидает» (Req 10.1), а сообщение Менеджера или Администратора —
   *   в «В работе» (Req 10.2).
   * - В статусах «Выполнено», «Отменено» и «Требует администратора» сообщение
   *   любого Участника чата статус не меняет (Req 10.3).
   *
   * @param current Текущий статус Задачи.
   * @param sender Роль отправителя сообщения в контексте Задачи.
   * @returns Новый (или неизменённый) статус Задачи.
   */
  onChatMessage(current: Status, sender: Actor): Status {
    if (!CHAT_REACTIVE_STATUSES.has(current)) {
      // «Выполнено», «Отменено», «Требует администратора» — статус стабилен (Req 10.3).
      return current;
    }

    // В реактивных статусах исход зависит только от роли отправителя.
    return sender === 'EXECUTOR' ? 'WAITING' : 'IN_PROGRESS';
  }

  /**
   * Реакция автомата на нейтральное событие, не относящееся к смене статуса
   * (Req 10.11 — наступление Дедлайна; Req 10.12 — изменение параметров Задачи).
   *
   * Такие события статус не меняют: метод всегда возвращает текущий статус
   * без изменения. Метод выделен явно, чтобы стабильность при нейтральных
   * событиях была частью контракта автомата и проверялась тестами.
   *
   * @param current Текущий статус Задачи.
   * @returns Тот же статус без изменения.
   */
  onNeutralEvent(current: Status): Status {
    return current;
  }

  /**
   * Явный переход статуса, инициированный Пользователем (Req 10.4–10.10).
   *
   * Порядок проверок:
   * 1. Право на действие по роли — иначе `NO_PERMISSION` (Req 10.14).
   * 2. Допустимость перехода из текущего статуса — иначе `INVALID_TRANSITION`
   *    (Req 10.15).
   *
   * При любом отказе текущий статус сохраняется без изменения (Req 10.14, 10.15).
   *
   * @param current Текущий статус Задачи.
   * @param action Действие смены статуса.
   * @param actor Роль действующего лица в контексте Задачи.
   * @param reviewedFlag Признак проверки Администратором (используется в Req 10.10).
   * @returns Новый статус либо причину отказа.
   */
  transition(
    current: Status,
    action: StatusAction,
    actor: Actor,
    reviewedFlag: boolean,
  ): TransitionResult {
    if (!this.hasPermission(action, actor)) {
      // Нет прав на изменение статуса — статус не меняется (Req 10.14).
      return { error: 'NO_PERMISSION' };
    }

    const next = this.resolveTarget(current, action, reviewedFlag);
    if (next === null) {
      // Переход недопустим из текущего статуса — статус не меняется (Req 10.15).
      return { error: 'INVALID_TRANSITION' };
    }

    return { status: next };
  }

  /**
   * Проверяет право роли на выполнение действия (Req 10.14).
   *
   * - Исполнитель не имеет прав на ручную смену статуса — любое действие
   *   отклоняется.
   * - `ADMIN_SET` и отмена Задачи доступны только Администратору.
   * - `REQUEST_ADMIN` доступен только Менеджеру: Администратор не назначает
   *   вручную статус «Требует администратора».
   * - Прочие действия доступны Менеджеру и Администратору.
   */
  private hasPermission(action: StatusAction, actor: Actor): boolean {
    if (actor === 'EXECUTOR') {
      return false;
    }
    if (action.type === 'ADMIN_SET' || action.type === 'CANCEL') {
      return actor === 'ADMIN';
    }
    if (action.type === 'REQUEST_ADMIN') {
      return actor === 'MANAGER';
    }
    return actor === 'MANAGER' || actor === 'ADMIN';
  }

  /**
   * Вычисляет целевой статус для разрешённого по правам действия либо `null`,
   * если переход недопустим из текущего статуса (Req 10.4–10.10, 10.15).
   */
  private resolveTarget(
    current: Status,
    action: StatusAction,
    reviewedFlag: boolean,
  ): Status | null {
    switch (action.type) {
      case 'COMPLETE':
        // «Выполнено» допустимо из «В работе» или «Ожидает» (Req 10.4).
        return current === 'IN_PROGRESS' || current === 'WAITING' ? 'DONE' : null;

      case 'START_WORK':
        // Ручной перевод из «Ожидает» обратно в «В работе».
        return current === 'WAITING' ? 'IN_PROGRESS' : null;

      case 'REOPEN':
        // Переоткрытие допустимо только из «Выполнено» (Req 10.5).
        return current === 'DONE' ? 'IN_PROGRESS' : null;

      case 'CANCEL':
        // Отмена допустима из «В работе», «Ожидает», «Выполнено», «Требует администратора» (Req 10.6).
        return current === 'IN_PROGRESS' ||
          current === 'WAITING' ||
          current === 'DONE' ||
          current === 'NEEDS_ADMIN'
          ? 'CANCELLED'
          : null;

      case 'RETURN':
        // Возврат допустим только из «Отменено» (Req 10.7).
        return current === 'CANCELLED' ? 'IN_PROGRESS' : null;

      case 'REQUEST_ADMIN':
        // «Требует администратора» запрашивается из «В работе» или «Ожидает» (Req 10.8).
        return current === 'IN_PROGRESS' || current === 'WAITING' ? 'NEEDS_ADMIN' : null;

      case 'ADMIN_SET':
        // Из «Требует администратора» Администратор выбирает статус из набора (Req 10.9).
        return current === 'NEEDS_ADMIN' && ADMIN_SELECTABLE_TARGETS.has(action.target)
          ? action.target
          : null;

      case 'CLEAR_ADMIN':
        // Менеджер снимает «Требует администратора» только при неустановленном
        // признаке проверки Администратором (Req 10.10).
        return current === 'NEEDS_ADMIN' && !reviewedFlag ? 'IN_PROGRESS' : null;

      default:
        // Недостижимо при корректной типизации; защита от расширения union.
        return null;
    }
  }
}
