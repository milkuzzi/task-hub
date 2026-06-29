import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentViewer } from "./AttachmentViewer";
import { fetchDocumentPreviewBlob, openAttachment } from "@/lib/attachments";
import type { AttachmentMeta } from "@/lib/chat-api";

vi.mock("@/lib/attachments", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/attachments")>(
      "@/lib/attachments",
    );
  return {
    ...actual,
    fetchDocumentPreviewBlob: vi.fn(),
    openAttachment: vi.fn(),
  };
});

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
  mockedFetchDocumentPreviewBlob.mockReset();
  mockedOpenAttachment.mockReset();
  vi.clearAllMocks();
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
});
