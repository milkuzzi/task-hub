import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { TaskDetailPage } from './TaskDetailPage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import { getTask, listDirectory, type TaskDetail } from '@/lib/tasks-api';
import { listAttachments, listMessages, listReaders, markRead } from '@/lib/chat-api';
import { listAuditEntries } from '@/lib/audit-api';

/**
 * Property-тест эксклюзивности активной вкладки экрана Задачи (задача 9.4).
 *
 * Компонент `TaskDetailPage` имеет тяжёлые зависимости (параметры маршрута,
 * аутентификация, Socket.IO, сетевые вызовы), поэтому выбран подход (a):
 * полноценный рендер страницы с мокированием инфраструктурных модулей
 * (`@/lib/socket`, `@/lib/tasks-api`, `@/lib/chat-api`, `@/lib/audit-api`) и
 * обёрткой в `MemoryRouter` + `AuthContext`. Пользователь — Администратор, чтобы
 * отображались все три вкладки (Чат / Вложения / Журнал изменений). Тест кликает
 * случайно выбранную вкладку и проверяет инвариант Property 12 напрямую по DOM:
 * ровно у выбранной вкладки `aria-selected="true"`, у остальных — `false`, при
 * этом показано содержимое именно выбранной вкладки, а панели остальных скрыты.
 */

// Socket.IO заменяем заглушкой: подписка/отписка не должны выходить в сеть.
vi.mock('@/lib/socket', async () => {
  const actual = await vi.importActual<typeof import('@/lib/socket')>('@/lib/socket');
  return {
    ...actual,
    connectSocket: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    joinTaskRoom: vi.fn(),
    leaveTaskRoom: vi.fn(),
  };
});

// REST-вызовы Задачи/справочника мокаем, сохраняя константы/типы модуля.
vi.mock('@/lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks-api')>('@/lib/tasks-api');
  return { ...actual, getTask: vi.fn(), listDirectory: vi.fn() };
});

// Лента Сообщений и Вложения загружаются при монтировании — мокаем загрузчики.
vi.mock('@/lib/chat-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat-api')>('@/lib/chat-api');
  return {
    ...actual,
    listMessages: vi.fn(),
    listAttachments: vi.fn(),
    listReaders: vi.fn(),
    markRead: vi.fn(),
  };
});

// Журнал изменений подгружается при открытии вкладки «Журнал изменений».
vi.mock('@/lib/audit-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-api')>('@/lib/audit-api');
  return { ...actual, listAuditEntries: vi.fn() };
});

// jsdom не реализует `scrollIntoView`, который `ChatPanel` вызывает в эффекте
// автопрокрутки ленты. Подменяем заглушкой, чтобы рендер чата не падал.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

const mockedGetTask = vi.mocked(getTask);
const mockedListDirectory = vi.mocked(listDirectory);
const mockedListMessages = vi.mocked(listMessages);
const mockedListAttachments = vi.mocked(listAttachments);
const mockedListReaders = vi.mocked(listReaders);
const mockedMarkRead = vi.mocked(markRead);
const mockedListAuditEntries = vi.mocked(listAuditEntries);

/** Детальная Задача-фикстура для рендера экрана. */
function taskFixture(): TaskDetail {
  return {
    id: 'task-1',
    title: 'Тестовая задача',
    description: null,
    deadline: '2025-01-01T00:00:00.000Z',
    status: 'IN_PROGRESS',
    messageCount: 0,
    hasUnread: false,
    isOverdue: false,
    executorIds: [],
    managerIds: [],
  };
}

/** Текущий Пользователь-Администратор: видит все три вкладки. */
function adminUser(): CurrentUser {
  return {
    id: 'admin-1',
    email: 'admin@example.com',
    name: 'Администратор',
    role: 'ADMIN',
    avatarPath: null,
    maxLinked: false,
  };
}

function authValue(user: CurrentUser): AuthContextValue {
  return {
    user,
    initializing: false,
    isAuthenticated: true,
    signIn: vi.fn(),
    signInWithMax: vi.fn(),
    signOut: vi.fn(),
    setUser: vi.fn(),
  };
}

/**
 * Набор вкладок: видимая подпись (для выбора кнопки) и уникальный маркер
 * содержимого соответствующей панели в пустом состоянии.
 */
interface TabSpec {
  readonly id: 'chat' | 'attachments' | 'audit';
  readonly label: string;
  /** Уникальный текст содержимого панели (пустое состояние). */
  readonly contentText: string;
  /** Является ли маркер плейсхолдером поля ввода (а не обычным текстом). */
  readonly contentIsPlaceholder?: boolean;
}

const TABS: readonly TabSpec[] = [
  {
    id: 'chat',
    label: 'Чат',
    contentText: 'Введите сообщение (до 4000 символов)',
    contentIsPlaceholder: true,
  },
  { id: 'attachments', label: 'Вложения', contentText: 'В чате задачи пока нет вложений.' },
  { id: 'audit', label: 'Журнал изменений', contentText: 'Изменений по задаче пока нет.' },
];

/** Ищет в DOM маркер содержимого панели для вкладки (или null, если скрыта). */
function queryContent(spec: TabSpec): HTMLElement | null {
  return spec.contentIsPlaceholder
    ? screen.queryByPlaceholderText(spec.contentText)
    : screen.queryByText(spec.contentText);
}

function renderPage(): void {
  render(
    <AuthContext.Provider value={authValue(adminUser())}>
      <MemoryRouter initialEntries={['/tasks/task-1']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  mockedGetTask.mockResolvedValue(taskFixture());
  mockedListDirectory.mockResolvedValue([]);
  mockedListMessages.mockResolvedValue([]);
  mockedListAttachments.mockResolvedValue([]);
  mockedListReaders.mockResolvedValue([]);
  mockedMarkRead.mockResolvedValue(undefined as never);
  mockedListAuditEntries.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaskDetailPage — вкладки (Property 12)', () => {
  // Feature: ui-ux-redesign, Property 12: Эксклюзивность активной вкладки
  it('для любой выбранной вкладки показано её содержимое, остальные скрыты, и ровно у неё aria-selected=true', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TABS), async (chosen) => {
        const user = userEvent.setup();
        renderPage();

        try {
          // Дожидаемся завершения загрузки и появления панели вкладок.
          const initialTab = await screen.findByRole('tab', { name: 'Чат' });
          expect(initialTab).toBeInTheDocument();

          // Активируем выбранную вкладку (если это не вкладка по умолчанию).
          if (chosen.id !== 'chat') {
            await user.click(screen.getByRole('tab', { name: chosen.label }));
          }

          // Содержимое выбранной вкладки отображается (Журнал грузится асинхронно).
          await waitFor(() => {
            expect(queryContent(chosen)).toBeInTheDocument();
          });

          // Панели остальных вкладок скрыты.
          for (const other of TABS) {
            if (other.id !== chosen.id) {
              expect(queryContent(other)).not.toBeInTheDocument();
            }
          }

          // Ровно у выбранной вкладки aria-selected="true", у остальных — "false".
          const tabs = screen.getAllByRole('tab');
          const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
          expect(selected).toHaveLength(1);
          // Длина проверена выше — единственный выбранный таб существует.
          const selectedTab = selected[0]!;
          expect(within(selectedTab).getByText(chosen.label)).toBeInTheDocument();
          for (const t of tabs) {
            if (t !== selectedTab) {
              expect(t.getAttribute('aria-selected')).toBe('false');
            }
          }
        } finally {
          // Каждая итерация property рендерит страницу заново — очищаем DOM.
          cleanup();
        }
      }),
      { numRuns: 100 },
    );
  }, 30000);
});
