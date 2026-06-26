import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, X } from '@phosphor-icons/react';
import { formatMsk } from '@/lib/time';
import { resolveErrorMessage } from '@/lib/error-message';
import { connectSocket, ChatEvents } from '@/lib/socket';
import {
  dismissNotification,
  listNotifications,
  markNotificationSeen,
  type AppNotification,
} from '@/lib/notifications-api';

function byCreatedDesc(a: AppNotification, b: AppNotification): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function NotificationsPopover(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const removeLocal = useCallback((notificationId: string): void => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  }, []);

  const upsertLocal = useCallback((incoming: AppNotification): void => {
    setNotifications((prev) => {
      const without = prev.filter((n) => n.id !== incoming.id);
      return [incoming, ...without].sort(byCreatedDesc);
    });
  }, []);

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

  useEffect(() => {
    const socket = connectSocket();
    const onNotification = (payload: AppNotification): void => upsertLocal(payload);
    socket.on(ChatEvents.Notification, onNotification);
    return () => {
      socket.off(ChatEvents.Notification, onNotification);
    };
  }, [upsertLocal]);

  const closePopover = useCallback((returnFocus = false): void => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopover(true);
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closePopover(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [closePopover, open]);

  const handleSeen = useCallback((messageId: string): void => {
    setNotifications((prev) =>
      prev.filter((n) => !(n.isMessageNotification && n.messageId === messageId)),
    );
    void markNotificationSeen(messageId).catch(() => {
      /* best-effort */
    });
  }, []);

  const handleDismiss = useCallback(
    (notificationId: string): void => {
      removeLocal(notificationId);
      void dismissNotification(notificationId).catch(() => {
        /* best-effort */
      });
    },
    [removeLocal],
  );

  const handleHideAll = useCallback((): void => {
    const snapshot = notifications;
    setNotifications([]);
    closePopover(false);
    void Promise.allSettled(snapshot.map((n) => dismissNotification(n.id)));
  }, [closePopover, notifications]);

  function handleOpenNotification(notification: AppNotification): void {
    if (notification.isMessageNotification && notification.messageId !== null) {
      handleSeen(notification.messageId);
    }
    if (notification.taskId !== null) {
      navigate(`/tasks/${notification.taskId}`);
      closePopover(false);
    }
  }

  return (
    <div className="notifications-popover" ref={rootRef}>
      <button
        ref={triggerRef}
        className="btn btn--sm notification-bell"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('notifications.open')}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} aria-hidden="true" />
        <span>{notifications.length}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="notifications-popover__panel panel"
          role="dialog"
          aria-label={t('notifications.heading')}
          tabIndex={-1}
        >
          <header className="notifications-popover__head">
            <strong>{t('notifications.heading')}</strong>
            <button
              className="btn btn--sm"
              type="button"
              disabled={notifications.length === 0}
              onClick={handleHideAll}
            >
              {t('notifications.hideAll')}
            </button>
          </header>

          {loading ? (
            <p className="text-muted">{t('common.loading')}</p>
          ) : error !== null ? (
            <p className="form-error" role="alert">{error}</p>
          ) : notifications.length === 0 ? (
            <p className="text-muted">{t('notifications.empty')}</p>
          ) : (
            <ul className="notifications-popover__list">
              {notifications.map((notification) => (
                <li key={notification.id} className="notifications-popover__item">
                  <button type="button" onClick={() => handleOpenNotification(notification)}>
                    <strong>{notification.title}</strong>
                    {notification.body !== '' && <span>{notification.body}</span>}
                    <time dateTime={notification.createdAt}>{formatMsk(notification.createdAt)}</time>
                  </button>
                  <button
                    className="notification-dismiss"
                    type="button"
                    aria-label={t('notifications.dismiss')}
                    onClick={() => handleDismiss(notification.id)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
