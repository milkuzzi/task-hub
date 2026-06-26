import { Injectable, Logger } from '@nestjs/common';
import { AssignmentKind, TaskStatus } from '@prisma/client';

/**
 * Событие правки параметров Задачи для уведомления Исполнителей (Req 10.13).
 *
 * Передаётся порту {@link TaskNotifier} при изменении параметров Задачи. Содержит
 * идентификатор Задачи, инициатора правки, получателей (Исполнителей Задачи) и
 * перечень машинных имён изменённых параметров (`title`, `description`,
 * `deadline`).
 */
export interface TaskUpdatedEvent {
  /** Идентификатор изменённой Задачи. */
  taskId: string;
  /** Идентификатор инициатора правки. */
  actorId: string;
  /** Идентификаторы Исполнителей Задачи — получателей уведомления (Req 10.13). */
  executorIds: string[];
  /** Машинные имена изменённых параметров Задачи. */
  changedFields: string[];
}

/** Событие успешной ручной смены Статуса Задачи (Req 13.6). */
export interface TaskStatusChangedEvent {
  taskId: string;
  actorId: string;
  newStatus: TaskStatus;
  taskTitle?: string;
  executorIds: string[];
  managerIds: string[];
}

/** Событие назначения Пользователя на Задачу (Req 13.2). */
export interface TaskAssignedEvent {
  taskId: string;
  userId: string;
  kind: AssignmentKind;
  taskTitle?: string;
}

/** Событие снятия Пользователя с Задачи (Req 13.3). */
export interface TaskUnassignedEvent {
  taskId: string;
  userId: string;
  taskTitle?: string;
}

/**
 * Порт постановки уведомлений Исполнителям о правках Задачи (Req 10.13).
 *
 * Абстрагирует доставку уведомлений от прикладной логики Задач. Прикладной код
 * {@link TasksService} вызывает {@link enqueueTaskUpdated} при изменении
 * параметров Задачи; метод обязан лишь поставить уведомление в очередь
 * (немедленно/асинхронно), а не дожидаться доставки — требование «в течение
 * 5 секунд» (Req 10.13) выполняется за счёт асинхронной постановки в очередь.
 *
 * Реальная реализация (формирование отдельных уведомлений получателям, очередь,
 * ретраи, каналы сайт/MAX) появится в `NotificationsModule` (задачи 12.x) и
 * будет привязана к токену {@link TASK_NOTIFIER} вместо реализации по умолчанию
 * {@link NoopTaskNotifier}.
 */
export interface TaskNotifier {
  /**
   * Ставит в очередь уведомление Исполнителям Задачи о правках её параметров
   * (Req 10.13). Метод возвращает управление сразу после постановки в очередь.
   *
   * @param event Событие правки Задачи с получателями и изменёнными параметрами.
   */
  enqueueTaskUpdated(event: TaskUpdatedEvent): Promise<void>;

  /** Ставит в очередь уведомление о новом Статусе Исполнителям и Менеджерам. */
  enqueueStatusChanged?(event: TaskStatusChangedEvent): Promise<void>;

  /** Ставит в очередь уведомление о назначении Пользователя на Задачу. */
  enqueueTaskAssigned?(event: TaskAssignedEvent): Promise<void>;

  /** Ставит в очередь уведомление о снятии Пользователя с Задачи. */
  enqueueTaskUnassigned?(event: TaskUnassignedEvent): Promise<void>;
}

/**
 * DI-токен порта {@link TaskNotifier}.
 *
 * Используется для инъекции реализации в {@link TasksService}. До готовности
 * `NotificationsModule` (задачи 12.x) к токену привязана безопасная
 * реализация-заглушка {@link NoopTaskNotifier}.
 */
export const TASK_NOTIFIER = Symbol('TASK_NOTIFIER');

/**
 * Реализация порта {@link TaskNotifier} по умолчанию — безопасная заглушка.
 *
 * Не доставляет и не ставит в очередь реальные уведомления, не имеет побочных
 * эффектов, помимо отладочного лога. Позволяет {@link TasksService} вызывать
 * постановку уведомлений уже сейчас, не дожидаясь `NotificationsModule`
 * (задачи 12.x). После реализации уведомлений эта заглушка будет заменена
 * реальной привязкой токена {@link TASK_NOTIFIER}.
 */
@Injectable()
export class NoopTaskNotifier implements TaskNotifier {
  private readonly logger = new Logger(NoopTaskNotifier.name);

  async enqueueTaskUpdated(event: TaskUpdatedEvent): Promise<void> {
    // Заглушка до реализации NotificationsModule (задачи 12.x): фиксируем только
    // в отладочном логе, чтобы не терять трассируемость при отладке.
    this.logger.debug(
      `Уведомление о правках (заглушка): задача «${event.taskId}», ` +
        `${event.executorIds.length} получатель(ей), параметры [${event.changedFields.join(', ')}].`,
    );
  }

  async enqueueStatusChanged(event: TaskStatusChangedEvent): Promise<void> {
    this.logger.debug(
      `Уведомление о статусе (заглушка): задача «${event.taskId}», статус «${event.newStatus}», ` +
        `${new Set([...event.executorIds, ...event.managerIds]).size} получатель(ей).`,
    );
  }

  async enqueueTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    this.logger.debug(
      `Уведомление о назначении (заглушка): задача «${event.taskId}», ` +
        `пользователь «${event.userId}», вид «${event.kind}».`,
    );
  }

  async enqueueTaskUnassigned(event: TaskUnassignedEvent): Promise<void> {
    this.logger.debug(
      `Уведомление о снятии (заглушка): задача «${event.taskId}», пользователь «${event.userId}».`,
    );
  }
}
