import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilePage } from './ProfilePage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import { fetchAvatarBlob } from '@/lib/avatar';
import type { CurrentUser } from '@/lib/auth-api';

/**
 * Exploratory-тест условия дефекта 1 (профиль-аватар) — задача 1.
 *
 * **Property 1: Bug Condition** — Аватар в профиле отображается.
 *
 * --- Ход исследования (методология «наблюдать реальную точку отказа») ---
 *
 * Первая редакция теста воспроизводила формальное `isBugCondition_1` буквально:
 * `user.avatarPath` ЗАДАН И `GET /api/avatars/:userId` отдаёт 200 + blob. На
 * НЕИСПРАВЛЕННОМ коде тест ПРОШЁЛ: `AvatarUploader` при заданном `avatarPath`
 * и успешной загрузке корректно рендерит `<img>`. Сквозная проверка показала,
 * что бэкенд (`toCurrentUser`) штатно отдаёт `avatarPath`, а «счастливый путь»
 * формально корректен. Гипотеза «отказ во фронтенд-рендере при заданном
 * avatarPath + 200» ОПРОВЕРГНУТА — этот вход не воспроизводит дефект.
 *
 * --- Перегипотезирование (реальная точка отказа) ---
 *
 * Рендер аватара в профиле управляется ИСКЛЮЧИТЕЛЬНО клиентским флагом
 * `user.avatarPath` (`AvatarUploader`: `hasAvatar = avatarPath != null && != ''`;
 * только при `hasAvatar` вызывается `fetchAvatarBlob`). Поэтому, когда аватар
 * РЕАЛЬНО сохранён на сервере (защищённый эндпоинт отдаёт 200), но `avatarPath`
 * в контексте отсутствует/устарел (не проброшен после входа/восстановления
 * Сессии — ветка гипотезы из design.md), профиль НЕ запрашивает эндпоинт и
 * показывает заглушку. Это и есть наблюдаемая точка отказа дефекта 1.1
 * («аватар загружен и сохранён → отображается заглушка вместо изображения»).
 *
 * **CRITICAL**: тест запускается на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПАДАТЬ —
 * падение подтверждает дефект 1. Чинить тест/код на этом этапе НЕЛЬЗЯ.
 */

// Аватар защищён авторизацией и грузится «fetch-as-blob» через `fetchAvatarBlob`.
// Мокаем модуль так, чтобы `GET /api/avatars/:userId` детерминированно отдавал
// 200 + blob — то есть аватар РЕАЛЬНО существует на сервере.
vi.mock('@/lib/avatar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/avatar')>('@/lib/avatar');
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);

/**
 * Пользователь, у которого аватар СОХРАНЁН на сервере, но путь НЕ проброшен
 * в контекст (`avatarPath = null`) — реалистичное состояние «сохранён, но не
 * обновлён в контексте» после входа/восстановления Сессии.
 */
function userWithSavedButUnpropagatedAvatar(overrides: Partial<CurrentUser> = {}): CurrentUser {
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

beforeEach(() => {
  // Эндпоинт аватара отдаёт изображение (200 + blob) — аватар существует на сервере.
  mockedFetchAvatar.mockResolvedValue(new Blob(['avatar-bytes'], { type: 'image/png' }));
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
});

describe('ProfilePage — дефект 1 (аватар в профиле)', () => {
  it('Property 1: при сохранённом на сервере аватаре профиль показывает изображение, а не заглушку', async () => {
    renderProfile(userWithSavedButUnpropagatedAvatar());

    // Property 1: профиль должен запросить защищённый эндпоинт аватара и показать
    // изображение. На НЕИСПРАВЛЕННОМ коде рендер привязан к клиентскому флагу
    // `avatarPath`, поэтому эндпоинт не запрашивается и показывается заглушка.
    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

    const avatarImg = await screen.findByRole('img', { name: 'Аватар пользователя' });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);

    // …и НЕ отображается заглушка «Нет аватара».
    expect(screen.queryByText('Нет аватара')).not.toBeInTheDocument();
  });
});
