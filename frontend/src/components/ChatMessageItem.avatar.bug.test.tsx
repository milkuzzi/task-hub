import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageItem } from './ChatMessageItem';
import { fetchAvatarBlob } from '@/lib/avatar';
import type { ChatMessage } from '@/lib/chat-api';

/**
 * Exploratory-тест условия дефекта 4 — UI ленты Чата (задача 10, frontend-часть).
 *
 * **Property 7: Bug Condition** — Аватар автора Сообщения и Пользователя в
 * администрировании.
 *
 * Здесь проверяется вторая половина `isBugCondition_4` для ленты Чата: UI
 * должен отображать аватар автора Сообщения (через переиспользуемый компонент
 * аватара на базе защищённого `fetchAvatarBlob(authorId)`), а при отсутствии
 * аватара — корректную заглушку.
 *
 * **CRITICAL**: тест запускается на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПАДАТЬ —
 * `ChatMessageItem` не содержит элемента аватара и не запрашивает байты
 * аватара автора. Падение подтверждает дефект 4. Чинить тест/код нельзя.
 */

// Аватар защищён авторизацией и грузится «fetch-as-blob». Мокаем модуль так,
// чтобы запрос аватара автора детерминированно отдавал 200 + blob.
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
    authorId: 'user-1',
    authorDisplayName: 'Иван Петров',
    text: 'Привет команде',
    createdAt: '2024-01-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    ...overrides,
  };
}

function renderItem(msg: ChatMessage): void {
  render(
    <ChatMessageItem
      message={msg}
      canModify={false}
      readers={undefined}
      onLoadReaders={vi.fn()}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onOpenAttachment={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mockedFetchAvatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }));
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
});

describe('ChatMessageItem — дефект 4 (аватар автора Сообщения)', () => {
  it('Property 7: лента Чата отображает аватар автора Сообщения', async () => {
    renderItem(message());

    // Property 7: компонент должен запросить защищённый аватар автора по его id
    // и показать изображение. На НЕИСПРАВЛЕННОМ коде элемента аватара нет —
    // запрос не выполняется и изображение не появляется (падение подтверждает дефект).
    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

    const avatarImg = await screen.findByRole('img', { name: 'Аватар пользователя' });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);
  });
});
