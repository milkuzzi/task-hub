import { Injectable, Logger } from '@nestjs/common';

export type TaskRealtimeReason = 'created' | 'updated' | 'assigned' | 'status' | 'message';

export interface TaskRealtimeUpdate {
  taskId: string;
  reason: TaskRealtimeReason;
}

export type TaskRealtimeNotifier = (
  taskId: string,
  payload: TaskRealtimeUpdate,
  recipientUserIds: readonly string[],
) => void;

/**
 * Порт realtime-доставки изменений Задач.
 *
 * TasksModule не зависит от ChatModule: Gateway регистрирует фактическую
 * Socket.IO-доставку через {@link bind}, а сервисы Задач/Чата вызывают
 * {@link pushTaskUpdated}. Если Gateway ещё не инициализирован, событие
 * пропускается: REST-ответ остаётся источником истины, а клиенты догонятся
 * следующей загрузкой.
 */
@Injectable()
export class TaskRealtimeDispatcher {
  private readonly logger = new Logger(TaskRealtimeDispatcher.name);

  private notifier: TaskRealtimeNotifier | null = null;

  bind(notifier: TaskRealtimeNotifier): void {
    this.notifier = notifier;
  }

  pushTaskUpdated(
    taskId: string,
    reason: TaskRealtimeReason,
    recipientUserIds: readonly string[],
  ): boolean {
    if (this.notifier === null) {
      this.logger.debug(
        `Realtime-событие Задачи «${taskId}» пропущено: Gateway ещё не зарегистрирован.`,
      );
      return false;
    }

    const payload: TaskRealtimeUpdate = { taskId, reason };
    try {
      this.notifier(taskId, payload, recipientUserIds);
      return true;
    } catch (error) {
      this.logger.warn(
        `Не удалось доставить realtime-событие Задачи «${taskId}»: ${String(error)}`,
      );
      return false;
    }
  }
}
