import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMsk } from '@/lib/time';
import type { AppNotification } from '@/lib/notifications-api';

/**
 * Карточка одного уведомления в Центре уведомлений (Req 13, 14).
 *
 * Для уведомлений о Сообщениях Чата (`isMessageNotification`) реализована
 * автоочистка по факту просмотра: как только карточка непрерывно находится в
 * видимой области не менее 3 секунд, вызывается {@link NotificationItemProps.onSeen}
 * с идентификатором Сообщения, и сервер удаляет уведомление на сайте и в Боте
 * MAX (Req 14.4). Если карточка покидает видимую область раньше, таймер
 * сбрасывается. Прочие типы уведомлений по просмотру не удаляются (Req 14.5).
 *
 * Видимость отслеживается через `IntersectionObserver`; при его отсутствии в
 * среде (например, в тестовом окружении) автоочистка деградирует безопасно —
 * уведомление остаётся и может быть снято вручную.
 */

/** Окно подтверждения просмотра уведомления о Сообщении — 3 секунды (Req 14.4). */
export const SEEN_DELAY_MS = 3000;

interface NotificationItemProps {
  notification: AppNotification;
  /** Просмотр уведомления о Сообщении ≤3с (Req 14.4): аргумент — `messageId`. */
  onSeen: (messageId: string) => void;
  /** Ручное снятие уведомления Пользователем. */
  onDismiss: (notificationId: string) => void;
}

export function NotificationItem({
  notification,
  onSeen,
  onDismiss,
}: NotificationItemProps): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement | null>(null);

  const isMessage = notification.isMessageNotification;
  const messageId = notification.messageId;

  useEffect(() => {
    // Автоочистка применима только к уведомлениям о Сообщениях с messageId
    // (Req 14.4). Прочие типы не удаляются по просмотру (Req 14.5).
    if (!isMessage || messageId === null) {
      return;
    }
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry !== undefined && entry.isIntersecting) {
          // Сообщение в видимой области — запускаем 3-секундный отсчёт (Req 14.4).
          if (timer === null) {
            timer = setTimeout(() => {
              onSeen(messageId);
            }, SEEN_DELAY_MS);
          }
        } else {
          // Покинуло область до истечения 3с — сбрасываем отсчёт.
          clearTimer();
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(element);
    return () => {
      clearTimer();
      observer.disconnect();
    };
  }, [isMessage, messageId, onSeen]);

  return (
    <li ref={ref} className="notif-item" data-message={isMessage ? 'true' : 'false'}>
      <div className="notif-item__main">
        <span className="notif-item__title">{notification.title}</span>
        {notification.body !== '' && (
          <p className="notif-item__body">{notification.body}</p>
        )}
        <span className="notif-item__time">{formatMsk(notification.createdAt)}</span>
      </div>
      <div className="notif-item__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onDismiss(notification.id)}
          aria-label={t('notifications.dismiss')}
        >
          {t('notifications.dismiss')}
        </button>
      </div>
    </li>
  );
}
