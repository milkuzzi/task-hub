import { ALL_QUEUE_NAMES, QueueName } from './queue.constants';

describe('QueueName', () => {
  it('содержит все четыре очереди предметной области', () => {
    expect(ALL_QUEUE_NAMES).toEqual([
      QueueName.Email,
      QueueName.MaxNotifications,
      QueueName.DeadlineReminders,
      QueueName.Backup,
    ]);
  });

  it('использует ожидаемые строковые идентификаторы очередей', () => {
    expect(QueueName.Email).toBe('email');
    expect(QueueName.MaxNotifications).toBe('max-notifications');
    expect(QueueName.DeadlineReminders).toBe('deadline-reminders');
    expect(QueueName.Backup).toBe('backup');
  });
});
