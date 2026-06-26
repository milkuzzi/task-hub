import { Injectable, Logger } from '@nestjs/common';
import { AssignmentKind } from '@prisma/client';
import { TaskRepository } from '../repositories';
import {
  TaskAssignedEvent,
  TaskNotifier,
  TaskStatusChangedEvent,
  TaskUnassignedEvent,
  TaskUpdatedEvent,
} from '../tasks/ports';
import { NOTIFIABLE_TASK_FIELDS, TaskNotificationRouter } from './task-notification-router';

/**
 * Реальная реализация порта {@link TaskNotifier}, привязываемая к токену
 * `TASK_NOTIFIER` (Req 10.13, 13.4).
 *
 * Заменяет реализацию-заглушку `NoopTaskNotifier`: при изменении параметров
 * Задачи {@link import('../tasks/tasks.service').TasksService.update} вызывает
 * {@link enqueueTaskUpdated}, а адаптер формирует Уведомление об изменении
 * Названия/Описания/Дедлайна Исполнителям и Менеджерам Задачи на сайт и через
 * Бот MAX через {@link TaskNotificationRouter} (Req 13.4).
 *
 * Порт-событие {@link TaskUpdatedEvent} несёт лишь Исполнителей (Req 10.13);
 * чтобы охватить и Менеджеров (Req 13.4), адаптер дочитывает актуальный состав
 * назначений Задачи из {@link TaskRepository}. Изменение параметров не меняет
 * состав, поэтому повторное чтение безопасно. Если Задача недоступна (например,
 * удалена в гонке), Уведомление не формируется.
 */
@Injectable()
export class TaskNotifierAdapter implements TaskNotifier {
  private readonly logger = new Logger(TaskNotifierAdapter.name);

  constructor(
    private readonly router: TaskNotificationRouter,
    private readonly taskRepository: TaskRepository,
  ) {}

  /**
   * Ставит в очередь Уведомление об изменении параметров Задачи Исполнителям и
   * Менеджерам (Req 10.13, 13.4).
   *
   * Учитываются только параметры, изменение которых порождает Уведомление
   * ({@link NOTIFIABLE_TASK_FIELDS}: Название, Описание, Дедлайн). Получатели —
   * Исполнители и Менеджеры Задачи. Метод возвращает управление сразу после
   * постановки в очередь.
   *
   * @param event Событие правки Задачи с получателями и изменёнными параметрами.
   */
  async enqueueTaskUpdated(event: TaskUpdatedEvent): Promise<void> {
    const changedFields = event.changedFields.filter((field) =>
      NOTIFIABLE_TASK_FIELDS.includes(field),
    );
    if (changedFields.length === 0) {
      // Изменены только параметры, не требующие Уведомления, — ничего не делаем.
      return;
    }

    const task = await this.taskRepository.findByIdWithAssignments(event.taskId);
    if (task === null) {
      // Задача недоступна (например, удалена в гонке): Уведомление не формируем.
      this.logger.debug(`Пропуск уведомления о правках: задача «${event.taskId}» не найдена.`);
      return;
    }

    const executorIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.EXECUTOR)
      .map((a) => a.userId);
    const managerIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);

    await this.router.notifyFieldsChanged(
      event.taskId,
      changedFields,
      executorIds,
      managerIds,
      task.title,
    );
  }

  async enqueueStatusChanged(event: TaskStatusChangedEvent): Promise<void> {
    await this.router.notifyStatusChanged(
      event.taskId,
      event.newStatus,
      event.executorIds,
      event.managerIds,
      event.taskTitle,
    );
  }

  async enqueueTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    await this.router.notifyAssigned(event.taskId, event.userId, event.kind, event.taskTitle);
  }

  async enqueueTaskUnassigned(event: TaskUnassignedEvent): Promise<void> {
    await this.router.notifyUnassigned(event.taskId, event.userId, event.taskTitle);
  }
}
