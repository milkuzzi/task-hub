import { Injectable, Logger } from '@nestjs/common';
import { AssignmentKind, ReminderThreshold } from '@prisma/client';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { TaskRepository, TaskWithAssignments } from '../repositories';
import { DeadlineReminderRepository } from './deadline-reminder.repository';
import {
  ReminderDecisionInput,
  ReminderThresholds,
  ReminderTrigger,
  decideDueReminders,
} from './deadline-reminder.logic';
import { TaskNotificationRouter } from './task-notification-router';

/** Число миллисекунд в секунде. */
const MS_PER_SECOND = 1000;

/**
 * Сервис напоминаний о приближении Дедлайна (Req 13.7–13.10).
 *
 * Опирается на чистую функцию принятия решения {@link decideDueReminders}
 * (ключевой тестируемый модуль, свойство 39) и инкапсулирует побочные эффекты:
 * чтение настраиваемых порогов из {@link AppConfigService}, состояния отправки
 * из {@link DeadlineReminderRepository}, фактическую отправку Уведомлений
 * Исполнителям и Менеджерам через {@link TaskNotificationRouter} и фиксацию
 * факта отправки порога (защита от повтора).
 *
 * Два сценария:
 * - {@link scheduleDeadlineReminders} — при создании Задачи или изменении её
 *   Дедлайна немедленно отправляет нужный порог (Req 13.9, 13.10);
 * - {@link scanDueReminders} — периодическая проверка окна порогов
 *   (Req 13.7, 13.8): вызывается фоновым воркером очереди
 *   {@link QueueName.DeadlineReminders}.
 */
@Injectable()
export class DeadlineReminderService {
  private readonly logger = new Logger(DeadlineReminderService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly tasks: TaskRepository,
    private readonly reminders: DeadlineReminderRepository,
    private readonly router: TaskNotificationRouter,
  ) {}

  /**
   * Немедленно отправляет нужный порог напоминания при создании Задачи или
   * изменении её Дедлайна (Req 13.9, 13.10).
   *
   * Решение принимается чистой функцией {@link decideDueReminders} в режиме
   * {@link ReminderTrigger.Immediate}: если остаток до Дедлайна между порогами —
   * отправляется только дальний порог; если остаток меньше ближнего — только
   * ближний. Уже отправленные пороги повторно не отправляются.
   *
   * @param task Задача (с актуальным составом назначений) после создания/правки
   *   Дедлайна.
   */
  async scheduleDeadlineReminders(task: TaskWithAssignments): Promise<void> {
    await this.evaluateAndSend(task, ReminderTrigger.Immediate);
  }

  /**
   * Периодическая проверка приближения Дедлайна по окну порогов
   * (Req 13.7, 13.8).
   *
   * Точка входа фонового воркера: отбирает Задачи, остаток до Дедлайна которых
   * может попадать в окно дальнего/ближнего порога, и для каждой отправляет
   * пороги, чьё окно наступило и которые ещё не отправлялись. Терминальные
   * статусы исключаются на уровне выборки.
   */
  async scanDueReminders(): Promise<void> {
    const now = this.clock.now();
    const thresholds = this.resolveThresholds();
    // Кандидаты — Задачи, чей Дедлайн отстоит от «сейчас» не дальше дальнего
    // порога и не ближе нижней границы окна ближнего порога. Расширяем границы
    // на окно проверки, чтобы гарантированно охватить оба окна.
    const fromOffsetMs = Math.max(0, thresholds.near - thresholds.window) * MS_PER_SECOND;
    const toOffsetMs = (thresholds.far + thresholds.window) * MS_PER_SECOND;
    const from = new Date(now.getTime() + fromOffsetMs);
    const to = new Date(now.getTime() + toOffsetMs);

    const candidates = await this.tasks.findManyWithAssignmentsByDeadlineRange(from, to);
    for (const task of candidates) {
      await this.evaluateAndSend(task, ReminderTrigger.Periodic, now, thresholds);
    }
  }

  /**
   * Принимает решение о порогах к отправке для Задачи и отправляет их,
   * фиксируя факт отправки (защита от повтора, Req 13.7–13.10).
   */
  private async evaluateAndSend(
    task: TaskWithAssignments,
    trigger: ReminderTrigger,
    now: Date = this.clock.now(),
    thresholds: ReminderThresholds = this.resolveThresholds(),
  ): Promise<void> {
    const sentState = await this.reminders.getSentState(task.id);
    const input: ReminderDecisionInput = {
      now,
      deadline: task.deadline,
      thresholds,
      trigger,
      farSent: sentState.far,
      nearSent: sentState.near,
    };

    const due = decideDueReminders(input);
    if (due.length === 0) {
      return;
    }

    const executorIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.EXECUTOR)
      .map((a) => a.userId);
    const managerIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);

    for (const threshold of due) {
      await this.sendThreshold(task.id, task.title, threshold, executorIds, managerIds);
    }
  }

  /**
   * Отправляет один порог напоминания и фиксирует факт отправки.
   *
   * Состояние «отправлено» фиксируется ДО постановки Уведомления в очередь,
   * чтобы исключить повторную отправку того же порога при гонке периодических
   * проверок (Req 13.7–13.10). Уникальное ограничение `@@unique([taskId,
   * threshold])` делает фиксацию идемпотентной.
   */
  private async sendThreshold(
    taskId: string,
    taskTitle: string,
    threshold: ReminderThreshold,
    executorIds: string[],
    managerIds: string[],
  ): Promise<void> {
    await this.reminders.markSent(taskId, threshold);
    await this.router.notifyDeadlineReminder(taskId, threshold, executorIds, managerIds, taskTitle);
    this.logger.debug(`Напоминание о Дедлайне «${threshold}» отправлено по Задаче «${taskId}».`);
  }

  /** Считывает настраиваемые пороги и окно проверки из конфигурации. */
  private resolveThresholds(): ReminderThresholds {
    const { farSeconds, nearSeconds, checkWindowSeconds } = this.config.reminders;
    return { far: farSeconds, near: nearSeconds, window: checkWindowSeconds };
  }
}
