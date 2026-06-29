import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailPage } from "./TaskDetailPage";
import { AuthContext, type AuthContextValue } from "@/lib/use-auth";
import type { CurrentUser } from "@/lib/auth-api";
import {
  assignTask,
  getTask,
  listDirectory,
  updateTask,
  type TaskDetail,
} from "@/lib/tasks-api";
import {
  listAttachments,
  listMessages,
  listReaders,
  markRead,
} from "@/lib/chat-api";
import { listAuditEntries } from "@/lib/audit-api";
import { fetchAvatarBlob } from "@/lib/avatar";

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
});

vi.mock("@/lib/socket", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/socket")>("@/lib/socket");
  return {
    ...actual,
    connectSocket: vi.fn(() => ({ on: socketMock.on, off: socketMock.off })),
    joinTaskRoom: vi.fn(),
    leaveTaskRoom: vi.fn(),
  };
});

vi.mock("@/lib/tasks-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tasks-api")>("@/lib/tasks-api");
  return {
    ...actual,
    assignTask: vi.fn(),
    getTask: vi.fn(),
    listDirectory: vi.fn(),
    updateTask: vi.fn(),
  };
});

vi.mock("@/lib/chat-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/chat-api")>("@/lib/chat-api");
  return {
    ...actual,
    listMessages: vi.fn(),
    listAttachments: vi.fn(),
    listReaders: vi.fn(),
    markRead: vi.fn(),
  };
});

vi.mock("@/lib/audit-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/audit-api")>("@/lib/audit-api");
  return { ...actual, listAuditEntries: vi.fn() };
});

vi.mock("@/lib/avatar", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/avatar")>("@/lib/avatar");
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = vi.fn();
}

const mockedAssignTask = vi.mocked(assignTask);
const mockedGetTask = vi.mocked(getTask);
const mockedListDirectory = vi.mocked(listDirectory);
const mockedUpdateTask = vi.mocked(updateTask);
const mockedListMessages = vi.mocked(listMessages);
const mockedListAttachments = vi.mocked(listAttachments);
const mockedListReaders = vi.mocked(listReaders);
const mockedMarkRead = vi.mocked(markRead);
const mockedListAuditEntries = vi.mocked(listAuditEntries);
const mockedFetchAvatarBlob = vi.mocked(fetchAvatarBlob);

function taskFixture(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    title: "Старая задача",
    description: "Старое описание",
    deadline: "2025-01-01T09:00:00.000Z",
    status: "IN_PROGRESS",
    messageCount: 0,
    hasUnread: false,
    isOverdue: false,
    executorIds: ["executor-1"],
    managerIds: ["manager-1"],
    ...overrides,
  };
}

function currentUser(
  role: CurrentUser["role"],
  id: string,
  overrides: Partial<CurrentUser> = {},
): CurrentUser {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    avatarPath: null,
    maxLinked: false,
    ...overrides,
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

function renderPage(user: CurrentUser): void {
  render(
    <AuthContext.Provider value={authValue(user)}>
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
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
  mockedUpdateTask.mockResolvedValue(taskFixture());
  mockedAssignTask.mockResolvedValue(taskFixture());
  mockedFetchAvatarBlob.mockResolvedValue(
    new Blob(["avatar"], { type: "image/png" }),
  );
});

afterEach(() => {
  cleanup();
  socketMock.handlers.clear();
  vi.clearAllMocks();
});

describe("TaskDetailPage edit action", () => {
  it("shows the edit action in the task hero for an assigned manager", async () => {
    renderPage(currentUser("MANAGER", "manager-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Изменить" }),
    ).toBeInTheDocument();
  });

  it("places status actions and edit action under task status metadata", async () => {
    renderPage(currentUser("ADMIN", "admin-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();
    const actionRow = document.querySelector(".task-hero__action-row");

    expect(actionRow).toBeInTheDocument();
    expect(actionRow).toContainElement(
      screen.getByRole("combobox", { name: "Выберите статус" }),
    );
    expect(actionRow).toContainElement(
      screen.getByRole("button", { name: "Применить" }),
    );
    expect(actionRow).toContainElement(
      screen.getByRole("button", { name: "Изменить" }),
    );
    expect(
      screen.queryByRole("button", { name: "Выполнено" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Отменить" }),
    ).not.toBeInTheDocument();
  });

  it("marks administrator review controls for stable task hero layout", async () => {
    mockedGetTask.mockResolvedValueOnce(taskFixture({ status: "NEEDS_ADMIN" }));

    renderPage(currentUser("ADMIN", "admin-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();

    const actionRow = document.querySelector(".task-hero__action-row");
    expect(actionRow).toHaveClass("task-hero__action-row--admin-review");
    expect(
      screen.getByRole("combobox", { name: "Выберите статус" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Применить" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Отменить" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Снять запрос" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Изменить" }),
    ).toBeInTheDocument();
  });

  it("does not show MAX notification toggle on the regular site", async () => {
    renderPage(currentUser("ADMIN", "admin-1", { maxLinked: true }));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /уведомления MAX/u }),
    ).not.toBeInTheDocument();
  });

  it("hides the edit action from an executor without manage permission", async () => {
    renderPage(currentUser("EXECUTOR", "executor-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Изменить" }),
    ).not.toBeInTheDocument();
  });

  it("shows overdue indicator in the task hero when task is overdue", async () => {
    mockedGetTask.mockResolvedValueOnce(taskFixture({ isOverdue: true }));

    renderPage(currentUser("ADMIN", "admin-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Просрочено")).toBeInTheDocument();
  });

  it("shows task executors and managers as expandable avatar rows", async () => {
    const user = userEvent.setup();
    mockedGetTask.mockResolvedValueOnce(
      taskFixture({
        executorIds: ["executor-1", "executor-2"],
        managerIds: ["manager-1"],
      }),
    );
    mockedListDirectory.mockResolvedValueOnce([
      { id: "executor-1", name: "Иван Исполнитель", role: "EXECUTOR" },
      { id: "executor-2", name: "Елена Исполнитель", role: "EXECUTOR" },
      { id: "manager-1", name: "Мария Менеджер", role: "MANAGER" },
    ]);

    renderPage(currentUser("ADMIN", "admin-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();

    const executorsRow = screen.getByRole("button", {
      name: /Исполнители\s*2/,
    });
    const managersRow = screen.getByRole("button", { name: /Менеджеры\s*1/ });
    const actionRow = document.querySelector(".task-hero__action-row");
    const participantsBlock = document.querySelector(".task-participants");

    expect(actionRow).toBeInTheDocument();
    expect(participantsBlock).toBeInTheDocument();
    expect(actionRow?.nextElementSibling).toBe(participantsBlock);

    await user.click(executorsRow);
    expect(await screen.findByText("Иван Исполнитель")).toBeInTheDocument();
    expect(screen.getByText("Елена Исполнитель")).toBeInTheDocument();
    expect(screen.queryByText("Мария Менеджер")).not.toBeInTheDocument();

    await user.click(managersRow);
    expect(await screen.findByText("Мария Менеджер")).toBeInTheDocument();
    expect(screen.queryByText("Иван Исполнитель")).not.toBeInTheDocument();
  });

  it("refreshes the task view after a realtime task update", async () => {
    const updated = taskFixture({
      title: "Реактивная задача",
      description: "Новое описание",
    });
    mockedGetTask
      .mockResolvedValueOnce(taskFixture())
      .mockResolvedValueOnce(updated);

    renderPage(currentUser("MANAGER", "manager-1"));

    expect(
      await screen.findByRole("heading", { name: "Старая задача" }),
    ).toBeInTheDocument();

    socketMock.handlers.get("task:updated")?.({
      taskId: "task-1",
      reason: "updated",
    });

    expect(
      await screen.findByRole("heading", { name: "Реактивная задача" }),
    ).toBeInTheDocument();
    expect(mockedGetTask).toHaveBeenCalledTimes(2);
  });

  it("submits edits through existing task APIs and refreshes the detail view", async () => {
    const user = userEvent.setup();
    const updated = taskFixture({
      title: "Обновленная задача",
      description: "Новое описание",
    });
    mockedGetTask
      .mockResolvedValueOnce(taskFixture())
      .mockResolvedValueOnce(updated);
    mockedUpdateTask.mockResolvedValueOnce(updated);

    renderPage(currentUser("ADMIN", "admin-1"));

    await user.click(await screen.findByRole("button", { name: "Изменить" }));

    await user.clear(screen.getByLabelText("Название"));
    await user.type(screen.getByLabelText("Название"), "Обновленная задача");
    await user.clear(screen.getByLabelText("Описание"));
    await user.type(screen.getByLabelText("Описание"), "Новое описание");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Подтвердите изменение задачи",
      }),
    ).toBeInTheDocument();
    expect(mockedUpdateTask).not.toHaveBeenCalled();
    expect(screen.getByText("Будут изменены поля:")).toBeInTheDocument();
    expect(screen.getByText("Название")).toBeInTheDocument();
    expect(screen.getByText("Описание")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Сохранить изменения" }),
    );

    await waitFor(() => {
      expect(mockedUpdateTask).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({
          title: "Обновленная задача",
          description: "Новое описание",
        }),
      );
    });
    expect(mockedAssignTask).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Обновленная задача" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Параметры задачи сохранены.",
    );
  });
});
