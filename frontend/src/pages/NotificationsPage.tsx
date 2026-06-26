import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveErrorMessage } from '@/lib/error-message';
import { connectSocket, ChatEvents } from '@/lib/socket';
import {
  dismissNotification,
  listNotifications,
  markNotificationSeen,
  type AppNotification,
} from '@/lib/notifications-api';
import { NotificationItem } from '@/components/NotificationItem';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';

/**
 * Центр уведомлений (задача 20.6, Req 13, 14).
 *
 * Отображает уведомления текущего Пользователя (новые → старые) и подписывается
 * на живые уведомления по Socket.IO (`ChatEvents.Notification`,
 * синхронизировано с серверным `chat.events.ts`). Уведомления о Сообщениях Чата
 * автоматически очищаются по факту просмотра в видимой области ≤3с (Req 14.4),
 * что реализовано в {@link NotificationItem}; прочие типы по просмотру не
 * удаляются (Req 14.5). Время отображается в MSK (Req 1.2), текст — на русском
 * (Req 1.1).
 */

/** Сортировка уведомлений: новые → старые. */
function byCreatedDesc(a: AppNotification, b: AppNotification): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function NotificationsPage(): JSX.Element {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Удаляет уведомление из локального списка по идентификатору. */
  const removeLocal = useCallback((notificationId: string): void => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  }, []);

  /** Вставляет/заменяет уведомление, сохраняя порядок «новые → старые». */
  const upsertLocal = useCallback((incoming: AppNotification): void => {
    setNotifications((prev) => {
      const without = prev.filter((n) => n.id !== incoming.id);
      return [incoming, ...without].sort(byCreatedDesc);
    });
  }, []);

  // Первичная загрузка уведомлений.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listNotifications()
      .then((items) => {
        if (!cancelled) {
          setNotifications([...items].sort(byCreatedDesc));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(resolveErrorMessage(err, t, t('errors.generic')));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Живые уведомления по Socket.IO (Req 13.1).
  useEffect(() => {
    const socket = connectSocket();
    const onNotification = (payload: AppNotification): void => {
      upsertLocal(payload);
    };
    socket.on(ChatEvents.Notification, onNotification);
    return () => {
      socket.off(ChatEvents.Notification, onNotification);
    };
  }, [upsertLocal]);

  /**
   * Просмотр уведомления о Сообщении ≤3с (Req 14.4): сообщаем серверу и
   * убираем уведомление из списка. Сервер очищает его на сайте и в Боте MAX.
   */
  const handleSeen = useCallback(
    (messageId: string): void => {
      // Оптимистично снимаем уведомления о данном Сообщении из списка.
      setNotifications((prev) =>
        prev.filter((n) => !(n.isMessageNotification && n.messageId === messageId)),
      );
      void markNotificationSeen(messageId).catch(() => {
        /* best-effort: при сбое сервер не очистит — перезагрузка вернёт */
      });
    },
    [],
  );

  /** Ручное снятие уведомления Пользователем. */
  const handleDismiss = useCallback(
    (notificationId: string): void => {
      removeLocal(notificationId);
      void dismissNotification(notificationId).catch(() => {
        /* best-effort */
      });
    },
    [removeLocal],
  );

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t('notifications.heading')}</h1>
        </div>
      </div>

      {loading ? (
        <LoadingState label={t('common.loading')} />
      ) : error !== null ? (
        <ErrorState message={error} />
      ) : notifications.length === 0 ? (
        <EmptyState message={t('notifications.empty')} />
      ) : (
        <ul className="notif-list">
          {notifications.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              onSeen={handleSeen}
              onDismiss={handleDismiss}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
