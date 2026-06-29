import { Injectable } from '@nestjs/common';
import { AssignmentKind, NotificationType, ReminderThreshold, TaskStatus } from '@prisma/client';
import { ClockService } from '../clock';
import { NotificationsService } from './notifications.service';
import { DomainEvent } from './notifications.types';

/**
 * Машинные имена изменяемых параметров Задачи, изменение которых порождает
 * Уведомление Исполнителям и Менеджерам (Req 13.4).
 *
 * Соответствуют полям, отслеживаемым {@link import('../tasks/tasks.service').TasksService.update}:
 * «Название» (`title`), «Описание» (`description`) и «Дедлайн» (`deadline`).
 */
export const NOTIFIABLE_TASK_FIELDS: readonly string[] = ['title', 'description', 'deadline'];

/**
 * Маршрутизатор Уведомлений по событиям Задачи (Req 13.2–13.6, 13.11, 15.5, 15.6).
 *
 * Связывает доменные события Задачи с формированием Уведомлений
 * {@link NotificationsService.emit}: определяет тип Уведомления, состав
 * получателей и полезную нагрузку для каждого вида события и оставляет
 * фактическую постановку в очередь, идемпотентность и доставку по каналам
 * (сайт + MAX) обобщённому сервису.
 *
 * Правила маршрутизации:
 * - назначение/снятие участника — Уведомление затронутому Пользователю
 *   (Req 13.2, 13.3);
 * - изменение Названия/Описания/Дедлайна — Уведомление Исполнителям и
 *   Менеджерам Задачи (Req 13.4);
 * - смена Статуса — Уведомление Исполнителям и Менеджерам с указанием нового
 *   Статуса (Req 13.6);
 * - переоткрытие/отмена/возврат из «Отменено» — Уведомление Исполнителям и
 *   Менеджерам (Req 13.11);
 * - назначение/снятие роли Менеджера — Уведомление затронутому Пользователю
 *   (Req 15.5, 15.6).
 *
 * Исключённые события (изменение состава участников — Req 13.5; изменение
 * профиля Администратором — Req 15.9; удаление учётной записи — Req 15.10;
 * изменение/удаление Сообщения — Req 14.3) Уведомлений НЕ порождают: для них
 * предусмотрены явные методы-«заглушки», которые ничего не формируют. Они
 * задокументированы как точки вызова из соответствующих модулей, исключающие
 * ошибочную отправку Уведомления.
 *
 * Ключ идемпотентности каждого события строится из его идентичности и момента
 * наступления ({@link ClockService}); повторная отправка того же события с тем
 * же ключом не порождает дублирующих Уведомлений (Req 13.1).
 */
@Injectable()
export class TaskNotificationRouter {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Уведомляет Пользователя о его назначении Исполнителем или Менеджером Задачи
   * на сайт и через Бот MAX (Req 13.2).
   *
   * @param taskId Идентификатор Задачи.
   * @param userId Идентификатор назначенного Пользователя — единственного
   *   получателя.
   * @param kind Вид назначения (Исполнитель/Менеджер) — попадает в полезную
   *   нагрузку.
   */
  async notifyAssigned(
    taskId: string,
    userId: string,
    kind: AssignmentKind,
    taskTitle?: string,
  ): Promise<void> {
    await this.emit({
      type: NotificationType.TASK_ASSIGNED,
      recipientIds: [userId],
      taskId,
      payload: this.withTaskTitle({ kind }, taskTitle),
      eventKey: this.buildEventKey(['assigned', taskId, userId]),
    });
  }

  /**
   * Уведомляет Пользователя о снятии с Задачи на сайт и через Бот MAX
   * (Req 13.3).
   *
   * @param taskId Идентификатор Задачи.
   * @param userId Идентификатор снятого Пользователя — единственного получателя.
   */
  async notifyUnassigned(taskId: string, userId: string, taskTitle?: string): Promise<void> {
    await this.emit({
      type: NotificationType.TASK_UNASSIGNED,
      recipientIds: [userId],
      taskId,
      payload: this.withTaskTitle({}, taskTitle),
      eventKey: this.buildEventKey(['unassigned', taskId, userId]),
    });
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи об изменении её Названия,
   * Описания или Дедлайна на сайт и через Бот MAX (Req 13.4, Req 10.13).
   *
   * Получатели — объединение Исполнителей и Менеджеров (без повторов); если
   * получателей нет, Уведомление не формируется. Перечень изменённых параметров
   * передаётся в полезной нагрузке.
   *
   * @param taskId Идентификатор Задачи.
   * @param changedFields Машинные имена изменённых параметров.
   * @param executorIds Идентификаторы Исполнителей Задачи.
   * @param managerIds Идентификаторы Менеджеров Задачи.
   */
  async notifyFieldsChanged(
    taskId: string,
    changedFields: readonly string[],
    executorIds: readonly string[],
    managerIds: readonly string[],
    taskTitle?: string,
  ): Promise<void> {
    const recipientIds = this.mergeRecipients(executorIds, managerIds);
    if (recipientIds.length === 0 || changedFields.length === 0) {
      return;
    }
    await this.emit({
      type: NotificationType.TASK_FIELD_CHANGED,
      recipientIds,
      taskId,
      payload: this.withTaskTitle({ changedFields: [...changedFields] }, taskTitle),
      eventKey: this.buildEventKey(['fields-changed', taskId, [...changedFields].sort().join('+')]),
    });
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи о смене её Статуса с указанием
   * нового Статуса на сайт и через Бот MAX (Req 13.6).
   *
   * @param taskId Идентификатор Задачи.
   * @param newStatus Новый Статус Задачи (помещается в полезную нагрузку).
   * @param executorIds Идентификаторы Исполнителей Задачи.
   * @param managerIds Идентификаторы Менеджеров Задачи.
   */
  async notifyStatusChanged(
    taskId: string,
    newStatus: TaskStatus,
    executorIds: readonly string[],
    managerIds: readonly string[],
    taskTitle?: string,
  ): Promise<void> {
    const recipientIds = this.mergeRecipients(executorIds, managerIds);
    if (recipientIds.length === 0) {
      return;
    }
    await this.emit({
      type: NotificationType.TASK_STATUS_CHANGED,
      recipientIds,
      taskId,
      payload: this.withTaskTitle({ status: newStatus }, taskTitle),
      eventKey: this.buildEventKey(['status-changed', taskId, newStatus]),
    });
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи о её переоткрытии на сайт и
   * через Бот MAX (Req 13.11).
   */
  async notifyReopened(
    taskId: string,
    executorIds: readonly string[],
    managerIds: readonly string[],
  ): Promise<void> {
    await this.notifyLifecycle(
      NotificationType.TASK_REOPENED,
      'reopened',
      taskId,
      executorIds,
      managerIds,
    );
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи об её отмене на сайт и через
   * Бот MAX (Req 13.11).
   */
  async notifyCancelled(
    taskId: string,
    executorIds: readonly string[],
    managerIds: readonly string[],
  ): Promise<void> {
    await this.notifyLifecycle(
      NotificationType.TASK_CANCELLED,
      'cancelled',
      taskId,
      executorIds,
      managerIds,
    );
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи о её возврате из Статуса
   * «Отменено» на сайт и через Бот MAX (Req 13.11).
   */
  async notifyReturned(
    taskId: string,
    executorIds: readonly string[],
    managerIds: readonly string[],
  ): Promise<void> {
    await this.notifyLifecycle(
      NotificationType.TASK_RETURNED,
      'returned',
      taskId,
      executorIds,
      managerIds,
    );
  }

  /**
   * Уведомляет Пользователя о назначении или снятии роли Менеджера на сайт и
   * через Бот MAX (Req 15.5, 15.6).
   *
   * @param userId Идентификатор затронутого Пользователя — единственного
   *   получателя.
   * @param assigned `true` — роль Менеджера назначена; `false` — снята.
   */
  async notifyManagerRoleChanged(userId: string, assigned: boolean): Promise<void> {
    await this.emit({
      type: NotificationType.MANAGER_ROLE_CHANGED,
      recipientIds: [userId],
      taskId: null,
      payload: { assigned },
      eventKey: this.buildEventKey(['manager-role-changed', userId, assigned ? 'on' : 'off']),
    });
  }

  /**
   * Уведомляет Исполнителей и Менеджеров Задачи о приближении Дедлайна по
   * указанному порогу на сайт и через Бот MAX (Req 13.7–13.10).
   *
   * Тип Уведомления определяется порогом: дальний → {@link
   * NotificationType.DEADLINE_REMINDER_FAR}, ближний → {@link
   * NotificationType.DEADLINE_REMINDER_NEAR}. Ключ идемпотентности СТАБИЛЕН и не
   * включает момент времени (в отличие от событий Задачи): он зависит только от
   * Задачи и порога, поэтому повторная периодическая проверка в пределах окна не
   * порождает дублирующих Уведомлений (Req 13.1). Дополнительная защита от
   * повторной отправки порога обеспечивается флагом `sent` модели
   * `DeadlineReminder` на стороне {@link
   * import('./deadline-reminder.service').DeadlineReminderService}.
   *
   * Если у Задачи нет ни Исполнителей, ни Менеджеров, Уведомление не формируется.
   *
   * @param taskId Идентификатор Задачи.
   * @param threshold Порог напоминания (дальний/ближний).
   * @param executorIds Идентификаторы Исполнителей Задачи.
   * @param managerIds Идентификаторы Менеджеров Задачи.
   */
  async notifyDeadlineReminder(
    taskId: string,
    threshold: ReminderThreshold,
    executorIds: readonly string[],
    managerIds: readonly string[],
    taskTitle?: string,
  ): Promise<void> {
    const recipientIds = this.mergeRecipients(executorIds, managerIds);
    if (recipientIds.length === 0) {
      return;
    }
    const type =
      threshold === ReminderThreshold.FAR
        ? NotificationType.DEADLINE_REMINDER_FAR
        : NotificationType.DEADLINE_REMINDER_NEAR;
    await this.emit({
      type,
      recipientIds,
      taskId,
      payload: this.withTaskTitle({ threshold }, taskTitle),
      // Стабильный ключ без момента времени: один порог одной Задачи —
      // одно событие (Req 13.1, защита от повторной отправки порога).
      eventKey: ['task-evt', 'deadline-reminder', taskId, threshold].join(':'),
    });
  }

  // ---------------------------------------------------------------------------
  // Исключённые события — Уведомления НЕ формируются (Req 13.5, 14.3, 15.9, 15.10)
  // ---------------------------------------------------------------------------

  /**
   * Точка обработки изменения состава Исполнителей или Менеджеров Задачи.
   *
   * Согласно Req 13.5 Уведомление об изменении состава участников НЕ
   * отправляется ни по одному каналу: метод намеренно ничего не формирует.
   * Существует как явная, задокументированная точка вызова, исключающая
   * ошибочную отправку Уведомления при изменении состава.
   */
  async onParticipantsChanged(): Promise<void> {
    // Req 13.5: уведомление об изменении состава участников не отправляется.
  }

  /**
   * Точка обработки изменения профиля Пользователя Администратором.
   *
   * Согласно Req 15.9 Уведомление об изменении профиля Администратором НЕ
   * отправляется ни по одному каналу: метод намеренно ничего не формирует.
   */
  async onAdminProfileChanged(): Promise<void> {
    // Req 15.9: уведомление об изменении профиля администратором не отправляется.
  }

  /**
   * Точка обработки удаления учётной записи Пользователя.
   *
   * Согласно Req 15.10 Уведомление об удалении аккаунта НЕ отправляется ни по
   * одному каналу: метод намеренно ничего не формирует.
   */
  async onAccountDeleted(): Promise<void> {
    // Req 15.10: уведомление об удалении аккаунта не отправляется.
  }

  /**
   * Точка обработки изменения или удаления Сообщения Чата.
   *
   * Согласно Req 14.3 Уведомления об изменении и удалении Сообщений НЕ
   * отправляются: метод намеренно ничего не формирует.
   */
  async onMessageEditedOrDeleted(): Promise<void> {
    // Req 14.3: уведомления об изменении и удалении сообщений не отправляются.
  }

  /**
   * Общая маршрутизация событий жизненного цикла Задачи (переоткрытие/отмена/
   * возврат) Исполнителям и Менеджерам (Req 13.11).
   */
  private async notifyLifecycle(
    type: NotificationType,
    keyPart: string,
    taskId: string,
    executorIds: readonly string[],
    managerIds: readonly string[],
    taskTitle?: string,
  ): Promise<void> {
    const recipientIds = this.mergeRecipients(executorIds, managerIds);
    if (recipientIds.length === 0) {
      return;
    }
    await this.emit({
      type,
      recipientIds,
      taskId,
      payload: this.withTaskTitle({}, taskTitle),
      eventKey: this.buildEventKey([keyPart, taskId]),
    });
  }

  /** Добавляет название Задачи в payload, если вызывающий модуль его знает. */
  private withTaskTitle<T extends Record<string, unknown>>(payload: T, taskTitle?: string): T {
    if (taskTitle === undefined || taskTitle.trim() === '') {
      return payload;
    }
    return { ...payload, taskTitle } as T;
  }

  /**
   * Объединяет Исполнителей и Менеджеров в единый список получателей без
   * повторов (Req 13.4, 13.6, 13.11). Дедупликация на стороне
   * {@link NotificationsService.emit} также гарантирует одно Уведомление на
   * получателя.
   */
  private mergeRecipients(executorIds: readonly string[], managerIds: readonly string[]): string[] {
    return [...new Set([...executorIds, ...managerIds])];
  }

  /**
   * Делегирует формирование Уведомлений обобщённому сервису (Req 13.1, 13.12).
   */
  private async emit(event: DomainEvent): Promise<void> {
    await this.notifications.emit(event);
  }

  /**
   * Строит стабильный ключ идемпотентности события из его идентичности и
   * момента наступления (Req 13.1).
   *
   * Момент наступления ({@link ClockService.now}) включается в ключ, поэтому
   * различные наступления одного и того же логического события (например,
   * повторная смена Статуса на то же значение) считаются разными событиями и
   * каждое порождает Уведомление, а повторная обработка одного наступления с
   * тем же ключом — нет.
   */
  private buildEventKey(parts: readonly string[]): string {
    return ['task-evt', ...parts, this.clock.now().getTime()].join(':');
  }
}
