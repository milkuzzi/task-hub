import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilePage } from './ProfilePage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import { fetchAvatarBlob } from '@/lib/avatar';
import type { CurrentUser } from '@/lib/auth-api';

/**
 * Preservation-тест дефекта 1 (нет аватара → заглушка) — задача 2.
 *
 * **Property 2: Preservation** — Заглушка при отсутствии аватара.
 *
 * --- Методология «сначала наблюдение» ---
 *
 * Тест фиксирует БАЗОВОЕ поведение для входов, где `isBugCondition_1` ЛОЖНО
 * (¬C): у Пользователя НЕТ сохранённого аватара (`avatarPath` null/пусто) ЛИБО
 * файл недоступен (эндпоинт `GET /api/avatars/:userId` отвечает 404). В этих
 * случаях профиль ДОЛЖЕН показывать заглушку «Нет аватара» БЕЗ «битой» картинки
 * (без `<img>` со сломанным `src`) — Req 3.1.
 *
 * Серверная половина preservation (эндпоинт отвечает 404 при отсутствии
 * аватара/файла без раскрытия деталей) уже зафиксирована в
 * `backend/src/users/avatars.controller.spec.ts`. Здесь фиксируется
 * фронтенд-половина: UI отображает заглушку без broken image.
 *
 * **EXPECTED OUTCOME**: тест ПРОХОДИТ на НЕИСПРАВЛЕННОМ коде — это базовая линия
 * ¬C для предотвращения регрессий при будущем исправлении дефекта 1.
 */

// Аватар грузится «fetch-as-blob» через `fetchAvatarBlob`. Мокаем модуль, чтобы
// детерминированно моделировать ответ защищённого эндпоинта аватара.
vi.mock('@/lib/avatar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/avatar')>('@/lib/avatar');
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);

/** Базовый Пользователь профиля; `avatarPath` переопределяется в кейсах. */
function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Иван Петров',
    role: 'EXECUTOR',
    avatarPath: null,
    maxLinked: false,
    ...overrides,
  };
}

/** Контекст аутентификации с заданным Пользователем. */
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

function renderProfile(user: CurrentUser): void {
  render(
    <AuthContext.Provider value={authValue(user)}>
      <ProfilePage />
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  mockedFetchAvatar.mockReset();
});

describe('ProfilePage — дефект 1 (preservation: заглушка при отсутствии аватара)', () => {
  describe('¬C: у Пользователя нет сохранённого аватара (avatarPath null/пусто)', () => {
    beforeEach(() => {
      // Сервер — источник истины: при отсутствии аватара эндпоинт отвечает 404.
      mockedFetchAvatar.mockRejectedValue(new Error('404'));
    });

    it.each([
      ['avatarPath === null', null],
      ['avatarPath === ""', ''],
    ])('Property 2: при %s показана заглушка без «битой» картинки', async (_label, avatarPath) => {
      renderProfile(makeUser({ avatarPath }));

      // Заглушка «Нет аватара» отображается.
      expect(await screen.findByText('Нет аватара')).toBeInTheDocument();

      // Нет элемента изображения аватара — значит, нет и «битой» картинки.
      expect(screen.queryByRole('img', { name: 'Аватар пользователя' })).not.toBeInTheDocument();

      // Наблюдаемый контракт preservation (Req 3.1, Property 2): когда аватара
      // нет, UI показывает заглушку БЕЗ «битой» картинки. Запрашивает ли клиент
      // эндпоинт — деталь реализации: после корневого исправления дефекта 1
      // источником истины служит сервер (200 → изображение, 404 → заглушка),
      // поэтому при `avatarPath` null/'' эндпоинт МОЖЕТ быть запрошен. Решающим
      // остаётся отсутствие broken image при отсутствии аватара (проверено выше).
    });
  });

  describe('¬C: файл аватара недоступен (эндпоинт отвечает 404)', () => {
    beforeEach(() => {
      // Эндпоинт `GET /api/avatars/:userId` отвечает 404 — файл недоступен.
      mockedFetchAvatar.mockRejectedValue(new Error('404 Not Found'));
    });

    it('Property 2: при 404 от эндпоинта показана заглушка без «битой» картинки', async () => {
      // avatarPath задан (клиент считает, что аватар есть), но файл недоступен.
      renderProfile(makeUser({ avatarPath: 'avatars/user-1/missing.png' }));

      // Запрос к защищённому эндпоинту выполнен и завершился 404.
      await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

      // Показана заглушка «Нет аватара».
      expect(await screen.findByText('Нет аватара')).toBeInTheDocument();

      // Нет «битой» картинки: элемент изображения не отрисован при ошибке загрузки.
      expect(screen.queryByRole('img', { name: 'Аватар пользователя' })).not.toBeInTheDocument();
    });
  });
});
