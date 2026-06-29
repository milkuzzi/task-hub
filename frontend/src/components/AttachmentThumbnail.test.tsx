import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { fetchThumbnailBlob, openAttachment } from "@/lib/attachments";
import type { AttachmentMeta } from "@/lib/chat-api";

/**
 * Компонентные тесты плитки Вложения (Req 12.6, 12.7, 12.9, 5.7).
 *
 * Миниатюра защищена авторизацией, поэтому байты грузятся через `http`
 * («fetch-as-blob») и показываются как Object URL. Тесты подменяют
 * `fetchThumbnailBlob` и проверяют: показ `<img>` с Object URL для изображения
 * с готовым превью, откат на обобщённый значок при 404 (превью не сформировано)
 * и отсутствие запроса миниатюры для не-изображений.
 */
vi.mock("@/lib/attachments", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/attachments")>(
      "@/lib/attachments",
    );
  return { ...actual, fetchThumbnailBlob: vi.fn(), openAttachment: vi.fn() };
});

const mockedFetchThumbnail = vi.mocked(fetchThumbnailBlob);
const mockedOpenAttachment = vi.mocked(openAttachment);

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: "att-1",
    messageId: "msg-1",
    originalName: "photo.png",
    mimeType: "image/png",
    sizeBytes: 2 * 1024 * 1024,
    hasThumbnail: true,
    compression: "zstd",
    checksum: "abc",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  mockedFetchThumbnail.mockReset();
  mockedOpenAttachment.mockReset();
});

describe("AttachmentThumbnail", () => {
  it("рисует миниатюру (Object URL) для изображения с готовым превью", async () => {
    mockedFetchThumbnail.mockResolvedValue(
      new Blob(["img"], { type: "image/png" }),
    );

    render(<AttachmentThumbnail attachment={meta()} onOpen={() => {}} />);

    const img = await screen.findByRole("img", { name: "photo.png" });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
    expect(screen.queryByText("2.0 МБ")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "photo.png · 2.0 МБ",
    );
    expect(mockedFetchThumbnail).toHaveBeenCalledWith("att-1");
  });

  it("возвращается к обобщённому значку при 404 миниатюры", async () => {
    mockedFetchThumbnail.mockRejectedValue(new Error("404"));

    render(<AttachmentThumbnail attachment={meta()} onOpen={() => {}} />);

    await waitFor(() => expect(mockedFetchThumbnail).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("img")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "photo.png · 2.0 МБ",
    );
  });

  it("рисует обобщённый значок для не-изображения без запроса миниатюры", () => {
    const { container } = render(
      <AttachmentThumbnail
        attachment={meta({
          mimeType: "application/pdf",
          originalName: "doc.pdf",
          hasThumbnail: false,
        })}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("doc.pdf")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "doc.pdf · 2.0 МБ",
    );
    expect(
      container.querySelector(".attachment-tile__icon--pdf"),
    ).not.toBeNull();
    expect(container).not.toHaveTextContent("📕");
    expect(mockedFetchThumbnail).not.toHaveBeenCalled();
  });

  it("рисует spreadsheet-файл как статичный значок без фоновой загрузки содержимого", () => {
    render(
      <AttachmentThumbnail
        attachment={meta({
          mimeType: "application/octet-stream",
          originalName: "report.xlsx",
          hasThumbnail: false,
        })}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "report.xlsx · 2.0 МБ",
    );
    expect(mockedFetchThumbnail).not.toHaveBeenCalled();
    expect(mockedOpenAttachment).not.toHaveBeenCalled();
  });

  it("рисует Word-документ как статичный значок без фоновой загрузки содержимого", () => {
    render(
      <AttachmentThumbnail
        attachment={meta({
          mimeType: "application/octet-stream",
          originalName: "brief.docx",
          hasThumbnail: false,
        })}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "brief.docx · 2.0 МБ",
    );
    expect(mockedFetchThumbnail).not.toHaveBeenCalled();
    expect(mockedOpenAttachment).not.toHaveBeenCalled();
  });

  it("рисует презентацию как статичный значок без фоновой загрузки содержимого", () => {
    render(
      <AttachmentThumbnail
        attachment={meta({
          mimeType: "application/octet-stream",
          originalName: "roadmap.pptx",
          hasThumbnail: false,
        })}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "roadmap.pptx · 2.0 МБ",
    );
    expect(mockedFetchThumbnail).not.toHaveBeenCalled();
    expect(mockedOpenAttachment).not.toHaveBeenCalled();
  });

  it("рисует аудио-плеер для audio-файла без запроса миниатюры", async () => {
    const revoke = vi.fn();
    mockedOpenAttachment.mockResolvedValue({
      url: "blob:audio-thumbnail",
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
      mimeType: "audio/mpeg",
      integrityOk: true,
      revoke,
    });

    const { container, unmount } = render(
      <AttachmentThumbnail
        attachment={meta({
          mimeType: "audio/mpeg",
          originalName: "voice.mp3",
          hasThumbnail: false,
        })}
        onOpen={() => {}}
      />,
    );

    const player = await screen.findByLabelText("Аудиоплеер: voice.mp3");
    expect(player.tagName).toBe("AUDIO");
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("src", "blob:audio-thumbnail");
    expect(
      container.querySelector(".attachment-tile--audio-player"),
    ).toHaveAttribute("title", "voice.mp3 · 2.0 МБ");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(mockedFetchThumbnail).not.toHaveBeenCalled();
    expect(mockedOpenAttachment).toHaveBeenCalledTimes(1);

    unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("вызывает onOpen по клику для полноэкранного просмотра", async () => {
    mockedFetchThumbnail.mockResolvedValue(
      new Blob(["img"], { type: "image/png" }),
    );
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<AttachmentThumbnail attachment={meta()} onOpen={onOpen} />);
    await user.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
