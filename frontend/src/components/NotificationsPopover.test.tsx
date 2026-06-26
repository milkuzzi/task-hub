import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissNotification,
  listNotifications,
  markNotificationSeen,
} from '@/lib/notifications-api';
import { connectSocket } from '@/lib/socket';
import { NotificationsPopover } from './NotificationsPopover';

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

function LocationProbe(): JSX.Element {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderPopover(): void {
  render(
    <MemoryRouter initialEntries={['/tasks']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <NotificationsPopover />
              <button type="button">Внешняя кнопка</button>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectSocket).mockReturnValue({
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
  } as never);
  vi.mocked(listNotifications).mockResolvedValue([
    {
      id: 'notification-1',
      type: 'STATUS_CHANGED',
      isMessageNotification: false,
      taskId: 'task-7',
      messageId: null,
      title: 'Статус изменён',
      body: 'Новый статус: Выполнено',
      createdAt: '2026-06-24T12:00:00.000Z',
      siteStatus: 'DELIVERED',
      maxStatus: 'PENDING',
    },
  ]);
  vi.mocked(dismissNotification).mockResolvedValue();
  vi.mocked(markNotificationSeen).mockResolvedValue();
});

describe('NotificationsPopover keyboard behavior', () => {
  it('moves focus into the dialog and returns it to the trigger on Escape', async () => {
    const user = userEvent.setup();
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Открыть уведомления' });

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Центр уведомлений' });
    expect(dialog).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when a notification navigates to its related task', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    await user.click(await screen.findByRole('button', { name: /Статус изменён/ }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-7');
  });

  it('keeps non-message notifications after activation until explicit dismiss', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    await user.click(await screen.findByRole('button', { name: /Статус изменён/ }));

    expect(markNotificationSeen).not.toHaveBeenCalled();
    expect(dismissNotification).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-7');

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    expect(await screen.findByRole('button', { name: /Статус изменён/ })).toBeInTheDocument();
  });

  it('removes only message notifications with the seen message id', async () => {
    vi.mocked(listNotifications).mockResolvedValueOnce([
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
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    await user.click(await screen.findByRole('button', { name: /Первое сообщение/ }));

    expect(markNotificationSeen).toHaveBeenCalledWith('message-1');

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    expect(screen.queryByRole('button', { name: /Первое сообщение/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Второе сообщение/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Назначение на задачу/ })).toBeInTheDocument();
  });

  it('closes on outside activation', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'Открыть уведомления' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Внешняя кнопка' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
