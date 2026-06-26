import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageItem, type ChatMessageItemProps } from './ChatMessageItem';
import { fetchAvatarBlob } from '@/lib/avatar';
import type { ChatMessage, MessageReader } from '@/lib/chat-api';

/**
 * Preservation-тест для дефекта 5 (ручное раскрытие списка прочитавших) — задача 14.
 *
 * **Property 10: Preservation** — Ручное раскрытие списка прочитавших.
 *
 * --- Методология «сначала наблюдение» (¬C на НЕИСПРАВЛЕННОМ коде) ---
 *
 * Фикс дефекта 5 (задача 15) добавит реактивный счётчик прочитавших по
 * `messageId`, обновляемый событием `chat:reads`. Этот счётчик НЕ должен менять
 * базовое поведение ручного раскрытия списка прочитавших: клик по переключателю
 * лениво запрашивает список (`onLoadReaders`), а когда список получен — он
 * отображается с перечнем Участников и временем прочтения в MSK (Req 11.8, 3.5).
 *
 * Здесь фиксируется это базовое поведение, чтобы предстоящий фикс не привёл к
 * регрессии.
 *
 * **EXPECTED OUTCOME**: тест ПРОХОДИТ на неисправленном коде.
 *
 * _Requirements: 3.5_
 */

// `ChatMessageItem` рендерит аватар автора через защищённый `fetchAvatarBlob`.
// Мокаем модуль, чтобы рендер был детерминированным и не зависел от сети.
vi.mock('@/lib/avatar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/avatar')>('@/lib/avatar');
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    chatId: 'chat-1',
    authorId: 'author-1',
    authorDisplayName: 'Иван Петров',
    text: 'Сообщение для проверки списка прочитавших',
    createdAt: '2024-01-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    ...overrides,
  };
}

/**
 * Базовые пропсы. `readers` управляется снаружи: `undefined` — список ещё не
 * загружен (свёрнутое состояние), массив — список получен после `onLoadReaders`.
 */
function props(
  readers: MessageReader[] | undefined,
  onLoadReaders: ChatMessageItemProps['onLoadReaders'],
): ChatMessageItemProps {
  return {
    message: message(),
    canModify: false,
    readers,
    onLoadReaders,
    onEdit: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onOpenAttachment: vi.fn(),
  };
}

beforeEach(() => {
  mockedFetchAvatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }));
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
});

describe('ChatMessageItem — дефект 5 (ручное раскрытие списка прочитавших)', () => {
  it('Property 10: клик по переключателю запрашивает список, затем рендерит прочитавших с временем прочтения', async () => {
    const user = userEvent.setup();
    const onLoadReaders = vi.fn();

    // Свёрнутое Сообщение: список прочитавших ещё не загружен.
    const { rerender } = render(<ChatMessageItem {...props(undefined, onLoadReaders)} />);

    // Перечень прочитавших скрыт до ручного раскрытия.
    expect(screen.queryByText('Прочитавшие')).not.toBeInTheDocument();

    // Ручное раскрытие: клик по переключателю «Прочитали: …».
    await user.click(screen.getByRole('button', { name: 'Прочитали: 0' }));

    // Базовое поведение: лениво запрашивается список прочитавших для этого Сообщения.
    expect(onLoadReaders).toHaveBeenCalledWith('msg-1');

    // Пока список не получен — показывается индикатор загрузки.
    expect(screen.getByText('Прочитавшие')).toBeInTheDocument();
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();

    // Список получен (как если бы родитель подгрузил readers).
    const readers: MessageReader[] = [
      { userId: 'u-1', displayName: 'Мария Сидорова', readAt: '2024-01-01T00:00:00.000Z' },
      { userId: 'u-2', displayName: 'Пётр Кузнецов', readAt: '2024-01-02T09:30:00.000Z' },
    ];
    rerender(<ChatMessageItem {...props(readers, onLoadReaders)} />);

    // Property 10: список отображает каждого прочитавшего с временем прочтения в MSK.
    await waitFor(() => {
      expect(screen.getByText('Мария Сидорова')).toBeInTheDocument();
    });
    expect(screen.getByText('Пётр Кузнецов')).toBeInTheDocument();
    // readAt MSK = UTC+3: 00:00 UTC → 03:00, 09:30 UTC → 12:30.
    expect(screen.getByText('(прочитано 01.01.2024 03:00)')).toBeInTheDocument();
    expect(screen.getByText('(прочитано 02.01.2024 12:30)')).toBeInTheDocument();

    // Счётчик переключателя отражает размер загруженного списка (базовое поведение).
    expect(screen.getByRole('button', { name: 'Прочитали: 2' })).toBeInTheDocument();
  });
});
