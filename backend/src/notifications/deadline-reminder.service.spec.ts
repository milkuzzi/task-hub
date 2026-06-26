import { AssignmentKind, ReminderThreshold } from '@prisma/client';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { TaskRepository, TaskWithAssignments } from '../repositories';
import { DeadlineReminderRepository, ReminderSentState } from './deadline-reminder.repository';
import { DeadlineReminderService } from './deadline-reminder.service';
import { TaskNotificationRouter } from './task-notification-router';

const NOW = new Date('2024-01-01T00:00:00.000Z');

/** Создаёт Задачу с назначениями и Дедлайном через `seconds` секунд от NOW. */
function taskStub(seconds: number): TaskWithAssignments {
  return {
    id: 'task-1',
    deadline: new Date(NOW.getTime() + seconds * 1000),
    assignments: [
      { id: 'a1', taskId: 'task-1', userId: 'exec-1', kind: AssignmentKind.EXECUTOR },
      { id: 'a2', taskId: 'task-1', userId: 'mgr-1', kind: AssignmentKind.MANAGER },
    ],
  } as unknown as TaskWithAssignments;
}

interface Mocks {
  service: DeadlineReminderService;
  markSent: jest.Mock;
  notify: jest.Mock;
  findRange: jest.Mock;
  getSentState: jest.Mock;
}

function createService(sentState: ReminderSentState = { far: false, near: false }): Mocks {
  const config = {
    reminders: { farSeconds: 86_400, nearSeconds: 7_200, checkWindowSeconds: 300 },
  } as unknown as AppConfigService;
  const clock = { now: () => NOW } as unknown as ClockService;

  const findRange = jest.fn().mockResolvedValue([]);
  const tasks = {
    findManyWithAssignmentsByDeadlineRange: findRange,
  } as unknown as TaskRepository;

  const getSentState = jest.fn().mockResolvedValue(sentState);
  const markSent = jest.fn().mockResolvedValue(undefined);
  const reminders = { getSentState, markSent } as unknown as DeadlineReminderRepository;

  const notify = jest.fn().mockResolvedValue(undefined);
  const router = { notifyDeadlineReminder: notify } as unknown as TaskNotificationRouter;

  return {
    service: new DeadlineReminderService(config, clock, tasks, reminders, router),
    markSent,
    notify,
    findRange,
    getSentState,
  };
}

describe('DeadlineReminderService', () => {
  describe('scheduleDeadlineReminders (Req 13.9, 13.10)', () => {
    it('отправляет только дальний порог, когда остаток между порогами', async () => {
      const { service, markSent, notify } = createService();

      await service.scheduleDeadlineReminders(taskStub(10 * 3_600));

      expect(markSent).toHaveBeenCalledTimes(1);
      expect(markSent).toHaveBeenCalledWith('task-1', ReminderThreshold.FAR);
      expect(notify).toHaveBeenCalledWith('task-1', ReminderThreshold.FAR, ['exec-1'], ['mgr-1']);
    });

    it('отправляет только ближний порог, когда остаток меньше ближнего', async () => {
      const { service, markSent, notify } = createService();

      await service.scheduleDeadlineReminders(taskStub(3_600));

      expect(markSent).toHaveBeenCalledWith('task-1', ReminderThreshold.NEAR);
      expect(notify).toHaveBeenCalledWith('task-1', ReminderThreshold.NEAR, ['exec-1'], ['mgr-1']);
    });

    it('ничего не отправляет, когда остаток больше дальнего порога', async () => {
      const { service, markSent, notify } = createService();

      await service.scheduleDeadlineReminders(taskStub(40 * 3_600));

      expect(markSent).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('не отправляет уже отправленный порог (защита от повтора)', async () => {
      const { service, markSent, notify } = createService({ far: true, near: false });

      await service.scheduleDeadlineReminders(taskStub(10 * 3_600));

      expect(markSent).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('scanDueReminders (Req 13.7, 13.8)', () => {
    it('отбирает задачи в окне порогов и отправляет наступивший порог', async () => {
      const { service, findRange, notify, markSent } = createService();
      findRange.mockResolvedValue([taskStub(86_400)]);

      await service.scanDueReminders();

      expect(findRange).toHaveBeenCalledTimes(1);
      expect(markSent).toHaveBeenCalledWith('task-1', ReminderThreshold.FAR);
      expect(notify).toHaveBeenCalledWith('task-1', ReminderThreshold.FAR, ['exec-1'], ['mgr-1']);
    });

    it('фиксирует факт отправки до постановки уведомления (защита от гонки)', async () => {
      const { service, findRange, notify, markSent } = createService();
      findRange.mockResolvedValue([taskStub(7_200)]);
      const order: string[] = [];
      markSent.mockImplementation(() => {
        order.push('mark');
        return Promise.resolve();
      });
      notify.mockImplementation(() => {
        order.push('notify');
        return Promise.resolve();
      });

      await service.scanDueReminders();

      expect(order).toEqual(['mark', 'notify']);
    });

    it('ничего не отправляет, если в окне нет задач', async () => {
      const { service, notify, markSent } = createService();

      await service.scanDueReminders();

      expect(markSent).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
