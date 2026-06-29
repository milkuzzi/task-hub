import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./ProfilePage";
import { AdminUsersPage } from "./AdminUsersPage";
import { AuthContext, type AuthContextValue } from "@/lib/use-auth";
import { fetchAvatarBlob } from "@/lib/avatar";
import { listUsers, listDeletedUsers, type AdminUser } from "@/lib/users-api";
import type { CurrentUser } from "@/lib/auth-api";

/**
 * Exploratory-тест условия дефекта 6 (метка роли) — задача 16.
 *
 * **Property 11: Bug Condition** — Скрытие метки роли в интерфейсе.
 *
 * `isBugCondition_6` истинно, когда UI отображает метку роли: строку «Роль: …»
 * в профиле ИЛИ колонку роли в списке администрирования. Желаемое (исправленное)
 * поведение по Property 11 — таких меток в интерфейсе быть НЕ должно, при этом
 * сервер продолжает использовать роль для контроля доступа (Property 12).
 *
 * **CRITICAL**: тест запускается на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПАДАТЬ —
 * `ProfilePage` рендерит абзац «Роль: …», а `AdminUsersPage` — колонку «Роль»
 * (`<th>` + `<td>`). Падение подтверждает наличие дефекта 6. Чинить тест или код
 * на этом этапе НЕЛЬЗЯ.
 */

// `AdminUsersPage` рендерит аватары строк через защищённый `fetchAvatarBlob`,
// а данные тянет из `users-api`. Мокаем оба, чтобы изолировать проверку метки роли.
vi.mock("@/lib/avatar", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/avatar")>("@/lib/avatar");
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

vi.mock("@/lib/users-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/users-api")>("@/lib/users-api");
  return { ...actual, listUsers: vi.fn(), listDeletedUsers: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);
const mockedListUsers = vi.mocked(listUsers);
const mockedListDeleted = vi.mocked(listDeletedUsers);

function profileUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Иван Петров",
    role: "EXECUTOR",
    avatarPath: null,
    maxLinked: false,
    ...overrides,
  };
}

function adminUser(): AdminUser {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Иван Петров",
    role: "EXECUTOR",
    active: true,
    locked: false,
    avatarPath: null,
    maxLinked: false,
  };
}

function currentAdmin(): CurrentUser {
  return {
    id: "admin-1",
    email: "admin@example.com",
    name: "Администратор",
    role: "ADMIN",
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

beforeEach(() => {
  mockedFetchAvatar.mockResolvedValue(
    new Blob(["avatar"], { type: "image/png" }),
  );
  mockedListUsers.mockResolvedValue([adminUser()]);
  mockedListDeleted.mockResolvedValue([]);
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
  mockedListUsers.mockReset();
  mockedListDeleted.mockReset();
});

describe("Дефект 6 (метка роли в интерфейсе)", () => {
  it("Property 11: профиль НЕ показывает метку «Роль: …»", () => {
    render(
      <AuthContext.Provider value={authValue(profileUser())}>
        <ProfilePage />
      </AuthContext.Provider>,
    );

    // Прочие сведения профиля остаются на месте (Property 12 / Req 3.6).
    expect(screen.getByText("user@example.com")).toBeInTheDocument();

    // Property 11: метки роли быть не должно. На НЕИСПРАВЛЕННОМ коде профиль
    // рендерит «Роль: » + значение роли — поэтому утверждение ПАДАЕТ.
    expect(screen.queryByText(/Роль:/)).not.toBeInTheDocument();
  });

  it("Property 11: список администрирования НЕ содержит колонку роли", async () => {
    render(
      <AuthContext.Provider value={authValue(currentAdmin())}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    // Дожидаемся загрузки списка Пользователей (прочие колонки сохраняются — Req 3.6).
    await screen.findByText("user@example.com");

    // Property 11: колонки роли (заголовок «Роль») быть не должно. На
    // НЕИСПРАВЛЕННОМ коде таблица рендерит `<th>Роль</th>` — утверждение ПАДАЕТ.
    expect(
      screen.queryByRole("columnheader", { name: "Роль" }),
    ).not.toBeInTheDocument();
  });
});
