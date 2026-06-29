import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import type { ChatMessage } from "@/lib/chat-api";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function renderPanel(
  onSend = vi.fn().mockResolvedValue(undefined),
  surface: "site" | "max" = "site",
): HTMLElement {
  const { container } = render(
    <ChatPanel
      surface={surface}
      messages={[]}
      currentUserId="user-1"
      currentUserRole="EXECUTOR"
      isModerator={false}
      readers={{}}
      readCounts={{}}
      onLoadReaders={vi.fn()}
      onSend={onSend}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onOpenAttachment={vi.fn()}
    />,
  );
  return container;
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    taskId: "task-1",
    chatId: "chat-1",
    authorId: "executor-1",
    authorDisplayName: "Исполнитель",
    authorRole: "EXECUTOR",
    authorAvatarPath: null,
    text: "Сообщение",
    createdAt: "2024-01-01T00:00:00.000Z",
    editedAt: null,
    deleted: false,
    ...overrides,
  };
}

function renderMessagesPanel(messages: ChatMessage[]): void {
  render(
    <ChatPanel
      messages={messages}
      currentUserId="manager-1"
      currentUserRole="MANAGER"
      isModerator
      readers={{}}
      readCounts={{}}
      onLoadReaders={vi.fn()}
      onSend={vi.fn().mockResolvedValue(undefined)}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onOpenAttachment={vi.fn()}
    />,
  );
}

describe("ChatPanel — отправка вложений", () => {
  it("использует прямой file picker без ограничения типов файлов", () => {
    const container = renderPanel();

    const fileInput = screen.getByLabelText("Прикрепить файл");
    const sendButton = screen.getByRole("button", { name: "Отправить" });
    expect(container.querySelector("form")).toBeNull();
    expect(sendButton).toHaveAttribute("type", "button");
    expect((sendButton as HTMLButtonElement).form).toBeNull();
    expect(fileInput).not.toBeNull();
    expect(fileInput).toHaveAttribute("type", "file");
    expect(fileInput).not.toHaveAttribute("accept");
    expect((fileInput as HTMLInputElement).multiple).toBe(true);
    expect((fileInput as HTMLInputElement).form).toBeNull();
  });

  it("в MAX явно запрашивает выбор любых файлов", () => {
    renderPanel(vi.fn().mockResolvedValue(undefined), "max");

    const accept = screen.getByLabelText("Прикрепить файл").getAttribute("accept");
    expect(accept).toContain("*/*");
    expect(accept).toContain("application/*");
    expect(accept).toContain("text/*");
    expect(accept).toContain(".json");
    expect(accept).toContain(".sig");
    expect(accept).toContain(".pub");
  });

  it.each([
    ["payload.json", "application/json"],
    ["signature.sig", "application/octet-stream"],
    ["public-key.pub", "application/octet-stream"],
  ])("добавляет файл %s из события input в MAX mini-app", (name, type) => {
    const container = renderPanel(vi.fn().mockResolvedValue(undefined), "max");
    const file = new File(["content"], name, { type });
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [file],
    });

    fireEvent.input(fileInput);

    expect(screen.getByText(name)).toBeInTheDocument();
  });

  it("прикрепляет неизвестный файл из paste-события в MAX mini-app", () => {
    const container = renderPanel(vi.fn().mockResolvedValue(undefined), "max");
    const panel = container.querySelector(".chat-panel") as HTMLDivElement;
    const file = new File(["signature"], "signature.sig", {
      type: "application/octet-stream",
    });

    fireEvent.paste(panel, {
      clipboardData: {
        files: [file],
      },
    });

    expect(screen.getByText("signature.sig")).toBeInTheDocument();
  });

  it("показывает ошибку, если WebView вернул пустой выбор файла", () => {
    const container = renderPanel(vi.fn().mockResolvedValue(undefined), "max");
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.input(fileInput);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Файл не выбран. Если MAX не показывает этот файл, попробуйте выбрать его через файловый менеджер.",
    );
  });

  it("не показывает MAX-ошибку при пустом выборе файла на сайте", () => {
    const container = renderPanel();
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.input(fileInput);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("показывает точную ошибку загрузки", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValue(new Error("Формат файла недоступен на устройстве."));
    const container = renderPanel(onSend);
    const file = new File(["content"], "data.custom", {
      type: "application/x-custom",
    });
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    await user.upload(fileInput, file);
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Формат файла недоступен на устройстве.",
    );
  });

  it("позволяет отправить выбранный файл без текста сообщения", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const container = renderPanel(onSend);

    const file = new File(["content"], "report.pdf", {
      type: "application/pdf",
    });
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(fileInput, file);
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("", [file]);
    expect(
      screen.queryByText(
        "Текст сообщения должен содержать от 1 до 4000 символов.",
      ),
    ).not.toBeInTheDocument();
  });

  it("позволяет прикрепить файл перетаскиванием в панель чата", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const container = renderPanel(onSend);
    const panel = container.querySelector(".chat-panel") as HTMLDivElement;
    const file = new File(["audio"], "briefing.mp3", { type: "audio/mpeg" });
    const dataTransfer = { types: ["Files"], files: [file] };

    fireEvent.dragEnter(panel, { dataTransfer });

    expect(
      screen.getByText("Отпустите файлы, чтобы прикрепить их к сообщению."),
    ).toBeInTheDocument();

    fireEvent.drop(panel, { dataTransfer });

    expect(
      screen.queryByText("Отпустите файлы, чтобы прикрепить их к сообщению."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("briefing.mp3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("", [file]);
  });

  it("прикрепляет файл при drop прямо на поле ввода сообщения", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderPanel(onSend);
    const input = screen.getByPlaceholderText(
      "Введите сообщение (до 4000 символов)",
    );
    const file = new File(["document"], "drop-on-input.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const dataTransfer = { types: ["Files"], files: [file] };

    fireEvent.dragOver(input, { dataTransfer });
    fireEvent.drop(input, { dataTransfer });

    expect(screen.getByText("drop-on-input.docx")).toBeInTheDocument();
  });
});

describe("ChatPanel — права изменения сообщений", () => {
  it("не показывает менеджеру действия изменения на сообщении Администратора", () => {
    renderMessagesPanel([
      message({
        authorId: "admin-1",
        authorDisplayName: "Администратор",
        authorRole: "ADMIN",
      }),
    ]);

    expect(
      screen.queryByRole("button", { name: "Изменить" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Удалить" }),
    ).not.toBeInTheDocument();
  });

  it("оставляет менеджеру действия изменения на сообщении Исполнителя", () => {
    renderMessagesPanel([message()]);

    expect(
      screen.getByRole("button", { name: "Изменить" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeInTheDocument();
  });
});
