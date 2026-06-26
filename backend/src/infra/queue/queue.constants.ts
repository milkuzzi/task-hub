/**
 * Имена очередей фоновой обработки (BullMQ).
 * Перечисление фиксирует набор очередей предметной области и используется как
 * ключ фабрики в {@link QueueService}.
 */
export enum QueueName {
  /** Исходящая почта через SendPulse с ретраями (Req 1.7). */
  Email = 'email',
  /** Доставка и ретраи уведомлений в MAX (Req 13.13, 14.6). */
  MaxNotifications = 'max-notifications',
  /** Напоминания о приближении дедлайна (Req 13.7–13.10). */
  DeadlineReminders = 'deadline-reminders',
  /** Ежедневное резервное копирование (Req 21). */
  Backup = 'backup',
}

/** Полный список имён очередей для предварительной инициализации. */
export const ALL_QUEUE_NAMES: readonly QueueName[] = [
  QueueName.Email,
  QueueName.MaxNotifications,
  QueueName.DeadlineReminders,
  QueueName.Backup,
];
