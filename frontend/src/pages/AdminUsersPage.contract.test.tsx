import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsersPage } from "./AdminUsersPage";
import { AuthContext, type AuthContextValue } from "@/lib/use-auth";
import type { CurrentUser } from "@/lib/auth-api";
import {
  importUsers,
  inviteUser,
  listDeletedUsers,
  listUsers,
  transferAdmin,
  type AdminUser,
  type DeletedUser,
} from "@/lib/users-api";

vi.mock("@/lib/users-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/users-api")>("@/lib/users-api");
  return {
    ...actual,
    importUsers: vi.fn(),
    inviteUser: vi.fn(),
    listUsers: vi.fn(),
    listDeletedUsers: vi.fn(),
    transferAdmin: vi.fn(),
  };
});

const mockedListUsers = vi.mocked(listUsers);
const mockedListDeletedUsers = vi.mocked(listDeletedUsers);
const mockedTransferAdmin = vi.mocked(transferAdmin);
const mockedInviteUser = vi.mocked(inviteUser);
const mockedImportUsers = vi.mocked(importUsers);

const currentAdmin: CurrentUser = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Администратор",
  role: "ADMIN",
  avatarPath: null,
  maxLinked: false,
};

const authValue: AuthContextValue = {
  user: currentAdmin,
  initializing: false,
  isAuthenticated: true,
  signIn: vi.fn(),
  signInWithMax: vi.fn(),
  signOut: vi.fn(),
  setUser: vi.fn(),
};

beforeEach(() => {
  mockedListUsers.mockResolvedValue({} as never);
  mockedListDeletedUsers.mockResolvedValue([]);
  mockedTransferAdmin.mockResolvedValue();
  mockedInviteUser.mockResolvedValue({
    id: "new-1",
    email: "new@example.com",
    name: "Новый пользователь",
    role: "EXECUTOR",
    active: false,
    locked: false,
    maxLinked: false,
  });
  mockedImportUsers.mockResolvedValue({
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AdminUsersPage — защита API-контракта", () => {
  it("показывает контролируемую ошибку, если список пользователей не является массивом", async () => {
    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("рендерит активных и удалённых пользователей адаптивными списками без таблиц", async () => {
    const activeUser: AdminUser = {
      id: "user-1",
      email: "user@example.com",
      name: "Иван Петров",
      role: "EXECUTOR",
      avatarPath: null,
      active: true,
      locked: false,
      maxLinked: false,
    };
    const deletedUser: DeletedUser = {
      id: "deleted-1",
      name: "Удалённый пользователь",
      emails: ["deleted@example.com"],
      deletedAt: "2026-06-10T09:15:00.000Z",
    };
    mockedListUsers.mockResolvedValue([activeUser]);
    mockedListDeletedUsers.mockResolvedValue([deletedUser]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("deleted@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("показывает смену аватара только в меню изменения учётных данных", async () => {
    const user = userEvent.setup();
    const activeUser: AdminUser = {
      id: "user-1",
      email: "user@example.com",
      name: "Иван Петров",
      role: "EXECUTOR",
      avatarPath: null,
      active: true,
      locked: false,
      maxLinked: false,
    };
    mockedListUsers.mockResolvedValue([activeUser]);
    mockedListDeletedUsers.mockResolvedValue([]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Аватар: Иван Петров/u }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Изменить: Иван Петров/u }),
    );

    expect(
      screen.getByRole("dialog", { name: "Изменение учётных данных" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Изменить аватар" }),
    ).toBeInTheDocument();
  });

  it("приглашает пользователя только с именем и email", async () => {
    const user = userEvent.setup();
    mockedListUsers.mockResolvedValue([]);
    mockedListDeletedUsers.mockResolvedValue([]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    await screen.findByRole("heading", { name: "Пригласить пользователя" });
    await user.click(screen.getByRole("button", { name: "Пригласить" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Введите имя пользователя");

    await user.type(screen.getByLabelText("Имя"), "Новый пользователь");
    await user.type(
      screen.getByLabelText("Электронная почта"),
      "new@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Пригласить" }));

    await waitFor(() =>
      expect(mockedInviteUser).toHaveBeenCalledWith({
        email: "new@example.com",
        name: "Новый пользователь",
      }),
    );
  });

  it("импортирует Excel-файл и показывает результат по строкам", async () => {
    mockedListUsers.mockResolvedValue([]);
    mockedListDeletedUsers.mockResolvedValue([]);
    mockedImportUsers.mockResolvedValue({
      created: 1,
      updated: 1,
      unchanged: 0,
      failed: 1,
      errors: [{ row: 4, email: "bad", message: "Некорректный email" }],
    });

    const { container } = render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    await screen.findByRole("button", { name: "Импорт Excel" });
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".xlsx"]',
    );
    expect(input).not.toBeNull();
    const file = new File(["xlsx"], "users.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => expect(mockedImportUsers).toHaveBeenCalledWith(file));
    expect(await screen.findByText(/создано 1, обновлено 1/u)).toBeInTheDocument();
    expect(screen.getByText(/Строка 4 \(bad\): Некорректный email/u)).toBeInTheDocument();
  });

  it("ищет активных и удалённых пользователей по имени и email", async () => {
    const user = userEvent.setup();
    mockedListUsers.mockResolvedValue([
      {
        id: "admin-1",
        email: "admin@example.com",
        name: "Администратор",
        role: "ADMIN",
        active: true,
        locked: false,
        maxLinked: false,
      },
      {
        id: "user-1",
        email: "ivan@example.com",
        name: "Иван Петров",
        role: "EXECUTOR",
        active: true,
        locked: false,
        maxLinked: false,
      },
    ]);
    mockedListDeletedUsers.mockResolvedValue([
      {
        id: "deleted-1",
        name: "Пётр Сидоров",
        emails: ["archive@example.com"],
        deletedAt: "2026-06-10T09:15:00.000Z",
      },
    ]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    await screen.findByText("ivan@example.com");
    await user.type(
      screen.getByRole("searchbox", { name: "Поиск пользователей" }),
      "archive@",
    );

    expect(screen.getByText("archive@example.com")).toBeInTheDocument();
    expect(screen.queryByText("ivan@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
  });

  it("передаёт администрирование из строки текущего администратора", async () => {
    const user = userEvent.setup();
    mockedListUsers.mockResolvedValue([
      {
        id: "admin-1",
        email: "admin@example.com",
        name: "Администратор",
        role: "ADMIN",
        active: true,
        locked: false,
        maxLinked: false,
      },
      {
        id: "user-1",
        email: "user@example.com",
        name: "Иван Петров",
        role: "MANAGER",
        active: true,
        locked: false,
        maxLinked: false,
      },
      {
        id: "locked-1",
        email: "locked@example.com",
        name: "Заблокированный",
        role: "EXECUTOR",
        active: true,
        locked: true,
        maxLinked: false,
      },
    ]);
    mockedListDeletedUsers.mockResolvedValue([]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    const transferButton = await screen.findByRole("button", {
      name: "Передать администрирование: Администратор",
    });
    expect(
      screen.queryByRole("button", { name: /Сделать админом/u }),
    ).not.toBeInTheDocument();

    await user.click(transferButton);
    const dialog = screen.getByRole("dialog", {
      name: "Передача администрирования",
    });
    const targetSelect = within(dialog).getByRole("combobox", {
      name: "Новый администратор",
    });
    expect(
      within(dialog).queryByRole("option", { name: /Заблокированный/u }),
    ).not.toBeInTheDocument();

    await user.selectOptions(targetSelect, "user-1");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Передать администрирование",
      }),
    );

    await waitFor(() =>
      expect(mockedTransferAdmin).toHaveBeenCalledWith("user-1"),
    );
  });
});
