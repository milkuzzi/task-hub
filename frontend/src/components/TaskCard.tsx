import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarBlank, ChatCircleText } from '@phosphor-icons/react';
import { formatMsk } from '@/lib/time';
import { TASK_STATUS_LABEL_KEYS, type TaskCard as TaskCardModel } from '@/lib/tasks-api';

/**
 * Карточка Задачи в списке (Req 2.8, 9.7, 9.8).
 *
 * Отображает Название, Статус, Дедлайн в MSK (`ДД.ММ.ГГГГ ЧЧ:ММ`, Req 1.2),
 * насыщенный счётчик Сообщений (0–9999, Req 9.7, 9.9) и маркер непрочитанных
 * Сообщений (Req 9.8). Карточка кликабельна: переход в Задачу (чат/журнал)
 * выполняется в задачах 20.5–20.6 через `onOpen`.
 */
export interface TaskCardProps {
  task: TaskCardModel;
  /** Открыть Задачу (детали/чат). */
  onOpen?: (taskId: string) => void;
}

/** Ключ перевода Статуса: `IN_PROGRESS` → `task.status.in_progress`. */
function statusKey(status: TaskCardModel['status']) {
  return TASK_STATUS_LABEL_KEYS[status];
}

export function TaskCard({ task, onOpen }: TaskCardProps): JSX.Element {
  const { t } = useTranslation();
  const isInteractive = onOpen !== undefined;

  const openTask = (): void => {
    onOpen?.(task.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    openTask();
  };

  return (
    <article
      className={`task-record task-record--${task.status.toLowerCase()}`}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? `${t('task.card.open')}: ${task.title}` : undefined}
      onClick={isInteractive ? openTask : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
    >
      <header className="task-record__head">
        <div className="task-record__statusline">
          <span className={`status-badge status-badge--${task.status.toLowerCase()}`}>
            {t(statusKey(task.status))}
          </span>
          {task.isOverdue && (
            <span className="status-badge status-badge--overdue">
              {t('task.card.overdue')}
            </span>
          )}
          {task.hasUnread && (
            <span
              className="unread-dot"
              role="status"
              aria-label={t('task.card.unread')}
              title={t('task.card.unread')}
            />
          )}
        </div>
        <span
          className="msg-counter"
          title={t('task.card.messages')}
          aria-label={`${t('task.card.messages')}: ${task.messageCount}`}
        >
          <ChatCircleText size={14} aria-hidden="true" />
          {task.messageCount}
        </span>
      </header>

      <div className="task-record__body">
        <h3 className="task-record__title">{task.title}</h3>
        {task.description !== null && task.description !== '' && (
          <p className="task-record__desc">{task.description}</p>
        )}
      </div>

      <footer className="task-record__foot">
        <p className="task-record__deadline">
          <CalendarBlank size={15} aria-hidden="true" />
          {formatMsk(task.deadline)}
        </p>
      </footer>
    </article>
  );
}
