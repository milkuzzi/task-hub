import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listNotifications, markNotificationSeen } from '@/lib/notifications-api';
import { connectSocket } from '@/lib/socket';
import { NotificationsPage } from './NotificationsPage';

vi.mock('@/lib/notifications-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications-api')>(
    '@/lib/notifications-api',
  );
  return {
    ...actual,
    listNotifications: vi.fn(),
    dismissNotification: vi.fn(),
    markNotificationSeen: vi.fn(),
  };
});

vi.mock('@/lib/socket', () => ({
  ChatEvents: { Notification: 'notification' },
  connectSocket: vi.fn(),
}));

const originalIntersectionObserver = globalThis.IntersectionObserver;

let observerCallbacks: IntersectionObserverCallback[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  observerCallbacks = [];
  vi.mocked(connectSocket).mockReturnValue({
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
  } as never);
  vi.mocked(markNotificationSeen).mockResolvedValue();
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) {
      observerCallbacks.push(callback);
    }

    observe(): void {
      // no-op
    }

    disconnect(): void {
      // no-op
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    unobserve(): void {
      // no-op
    }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalIntersectionObserver === undefined) {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
    return;
  }
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

describe('NotificationsPage message cleanup', () => {
  it('removes only message notifications with the seen message id', async () => {
    vi.mocked(listNotifications).mockResolvedValue([
      {
        id: 'message-notification-1',
        type: 'NEW_MESSAGE',
        isMessageNotification: true,
        taskId: 'task-1',
        messageId: 'message-1',
        title: 'В чате новое сообщение',
        body: 'Первое сообщение',
        createdAt: '2026-06-24T12:02:00.000Z',
        siteStatus: 'DELIVERED',
        maxStatus: 'PENDING',
      },
      {
        id: 'message-notification-2',
        type: 'NEW_MESSAGE',
        isMessageNotification: true,
        taskId: 'task-2',
        messageId: 'message-2',
        title: 'В чате новое сообщение',
        body: 'Второе сообщение',
        createdAt: '2026-06-24T12:01:00.000Z',
        siteStatus: 'DELIVERED',
        maxStatus: 'PENDING',
      },
      {
        id: 'task-notification-1',
        type: 'TASK_ASSIGNED',
        isMessageNotification: false,
        taskId: 'task-3',
        messageId: null,
        title: 'Назначение на задачу',
        body: 'Вас назначили на задачу.',
        createdAt: '2026-06-24T12:00:00.000Z',
        siteStatus: 'DELIVERED',
        maxStatus: 'PENDING',
      },
    ]);

    render(<NotificationsPage />);

    expect(await screen.findByText('Первое сообщение')).toBeInTheDocument();
    expect(screen.getByText('Второе сообщение')).toBeInTheDocument();
    expect(screen.getByText('Назначение на задачу')).toBeInTheDocument();
    await waitFor(() => expect(observerCallbacks).toHaveLength(2));

    vi.useFakeTimers();
    await act(async () => {
      observerCallbacks[0]?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(markNotificationSeen).toHaveBeenCalledWith('message-1');
    expect(screen.queryByText('Первое сообщение')).not.toBeInTheDocument();
    expect(screen.getByText('Второе сообщение')).toBeInTheDocument();
    expect(screen.getByText('Назначение на задачу')).toBeInTheDocument();
  });
});
