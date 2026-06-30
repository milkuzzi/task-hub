import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentViewer } from "./AttachmentViewer";
import {
  fetchDocumentExternalLinks,
  fetchDocumentPreviewBlob,
  openAttachment,
} from "@/lib/attachments";
import type { AttachmentMeta } from "@/lib/chat-api";

vi.mock("./PdfDocumentViewer", () => ({
  PdfDocumentViewer: ({
    fileName,
    surface,
    onError,
  }: {
    blob: Blob;
    fileName: string;
    surface?: "site" | "max";
    onError: () => void;
  }) => (
    <button
      type="button"
      data-testid="pdf-document-viewer"
      data-surface={surface}
      onClick={onError}
    >
      {fileName}
    </button>
  ),
}));

vi.mock("@/lib/attachments", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/attachments")>(
      "@/lib/attachments",
    );
  return {
    ...actual,
    fetchDocumentExternalLinks: vi.fn(),
    fetchDocumentPreviewBlob: vi.fn(),
    openAttachment: vi.fn(),
  };
});

const mockedFetchDocumentExternalLinks = vi.mocked(fetchDocumentExternalLinks);
const mockedFetchDocumentPreviewBlob = vi.mocked(fetchDocumentPreviewBlob);
const mockedOpenAttachment = vi.mocked(openAttachment);

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: "att-audio",
    messageId: "msg-1",
    originalName: "voice.mp3",
    mimeType: "audio/mpeg",
    sizeBytes: 1024,
    hasThumbnail: false,
    compression: "zstd",
    checksum: "abc",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  mockedFetchDocumentExternalLinks.mockReset();
  mockedFetchDocumentPreviewBlob.mockReset();
  mockedOpenAttachment.mockReset();
  delete window.WebApp;
  vi.restoreAllMocks();
});

describe("AttachmentViewer", () => {
  it("открывает audio-вложение в нативном плеере", async () => {
    const revoke = vi.fn();
    mockedOpenAttachment.mockResolvedValue({
      url: "blob:audio-preview",
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
      mimeType: "audio/mpeg",
      integrityOk: true,
      revoke,
    });

    const { container, unmount } = render(
      <AttachmentViewer attachment={meta()} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(mockedOpenAttachment).toHaveBeenCalledWith(meta()),
    );
    const audio = container.querySelector("audio.viewer__audio");
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("src", "blob:audio-preview");

    unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("открывает video-вложение по расширению при неточном MIME", async () => {
    const revoke = vi.fn();
    mockedOpenAttachment.mockResolvedValue({
      url: "blob:video-preview",
      blob: new Blob(["video"], { type: "video/mp4" }),
      mimeType: "video/mp4",
      integrityOk: true,
      revoke,
    });

    const { container, unmount } = render(
      <AttachmentViewer
        surface="max"
        attachment={meta({
          id: "att-video",
          originalName: "clip.mp4",
          mimeType: "application/octet-stream",
        })}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockedOpenAttachment).toHaveBeenCalledWith(
        meta({
          id: "att-video",
          originalName: "clip.mp4",
          mimeType: "application/octet-stream",
        }),
      ),
    );
    const video = container.querySelector("video.viewer__video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", "blob:video-preview");

    unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "att-xlsx",
      "report.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["att-xls", "legacy.xls", "application/vnd.ms-excel"],
    ["att-ods", "native.ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ])(
    "открывает таблицу %s через LibreOffice PDF с исходным форматированием",
    async (id, originalName, mimeType) => {
      mockedFetchDocumentPreviewBlob.mockResolvedValue(
        new Blob(["pdf"], { type: "application/pdf" }),
      );

      render(
        <AttachmentViewer
          attachment={meta({
            id,
            originalName,
            mimeType,
          })}
          onClose={() => {}}
        />,
      );

      await waitFor(() =>
        expect(mockedFetchDocumentPreviewBlob).toHaveBeenCalledWith(id),
      );
      const frame = screen.getByTitle(
        `Предпросмотр документа: ${originalName}`,
      );
      expect(frame).toHaveClass("viewer__document-frame");
      expect(frame.getAttribute("src")).toMatch(/^blob:mock\//);
      expect(mockedOpenAttachment).not.toHaveBeenCalled();
    },
  );

  it("открывает Word-документ через серверный PDF-предпросмотр", async () => {
    mockedFetchDocumentPreviewBlob.mockResolvedValue(
      new Blob(["pdf"], { type: "application/pdf" }),
    );

    render(
      <AttachmentViewer
        attachment={meta({
          id: "att-doc",
          originalName: "brief.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockedFetchDocumentPreviewBlob).toHaveBeenCalledWith("att-doc"),
    );
    const frame = screen.getByTitle(
      "Предпросмотр документа: brief.docx",
    );
    expect(frame).toHaveClass("viewer__document-frame");
    expect(frame.getAttribute("src")).toMatch(/^blob:mock\//);
  });

  it("открывает презентацию через серверный PDF-предпросмотр LibreOffice", async () => {
    mockedFetchDocumentPreviewBlob.mockResolvedValue(
      new Blob(["pdf"], { type: "application/pdf" }),
    );

    render(
      <AttachmentViewer
        attachment={meta({
          id: "att-presentation",
          originalName: "roadmap.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        })}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockedFetchDocumentPreviewBlob).toHaveBeenCalledWith(
        "att-presentation",
      ),
    );
    const frame = screen.getByTitle(
      "Предпросмотр документа: roadmap.pptx",
    );
    expect(frame).toHaveClass("viewer__document-frame");
    expect(frame.getAttribute("src")).toMatch(/^blob:mock\//);
  });

  it("открывает PDF через общий встроенный предпросмотр", async () => {
    mockedFetchDocumentPreviewBlob.mockResolvedValue(
      new Blob(["pdf"], { type: "application/pdf" }),
    );

    const { container } = render(
      <AttachmentViewer
        attachment={meta({
          id: "att-pdf",
          originalName: "scan.pdf",
          mimeType: "application/pdf",
        })}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockedFetchDocumentPreviewBlob).toHaveBeenCalledWith("att-pdf"),
    );
    const frame = screen.getByTitle(
      "Предпросмотр документа: scan.pdf",
    );
    expect(frame).toHaveClass("viewer__document-frame");
    expect(frame.getAttribute("src")).toMatch(/^blob:mock\//);
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("в MAX mini-app показывает внешние действия документа без iframe и canvas", async () => {
    const openLink = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    window.WebApp = {
      initData: "auth_date=1&hash=test",
      openLink,
      downloadFile,
    };
    mockedFetchDocumentExternalLinks.mockResolvedValue({
      preview: {
        url: "/api/attachment-tickets/preview-token",
        fileName: "report.pdf",
      },
      original: {
        url: "/api/attachment-tickets/original-token",
        fileName: "report.xlsx",
      },
      expiresAt: "2026-06-30T10:05:00.000Z",
    });

    const { container } = render(
      <AttachmentViewer
        surface="max"
        attachment={meta({
          id: "att-mobile-doc",
          originalName: "report.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockedFetchDocumentExternalLinks).toHaveBeenCalledWith(
        "att-mobile-doc",
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".pdf-document-viewer__canvas")).toBeNull();
    expect(container.querySelector(".viewer-overlay--max")).not.toBeNull();
    expect(
      screen.getByText("Документ готов к просмотру"),
    ).toBeInTheDocument();
    expect(mockedFetchDocumentPreviewBlob).not.toHaveBeenCalled();

    expect(
      screen.queryByText(
        "PDF откроется во внешнем просмотрщике, где доступны масштабирование и копирование текста.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Скачать PDF" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Скачать оригинал" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Предпросмотр" }));
    expect(openLink).toHaveBeenCalledWith(
      `${window.location.origin}/api/attachment-tickets/preview-token`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
    await waitFor(() =>
      expect(downloadFile).toHaveBeenCalledWith(
        `${window.location.origin}/api/attachment-tickets/original-token`,
        "report.xlsx",
      ),
    );
  });

  it("показывает ошибку внешних ссылок MAX и оставляет скачивание доступным", async () => {
    mockedFetchDocumentExternalLinks.mockRejectedValue(new Error("failed"));

    render(
      <AttachmentViewer
        surface="max"
        attachment={meta({
          id: "att-mobile-doc",
          originalName: "report.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось открыть вложение.",
    );
    expect(
      screen.getByRole("button", { name: "Скачать" }),
    ).toBeEnabled();
  });
});
