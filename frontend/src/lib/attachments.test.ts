import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentPreviewKind,
  decompress,
  fetchDocumentPreviewBlob,
  formatAttachmentSize,
  genericIconType,
  isDocumentFile,
  isPdfFile,
  isPresentationFile,
  isPreviewableAudio,
  isPreviewableDocument,
  isPreviewableImage,
  isPreviewablePresentation,
  isPreviewableVideo,
  isSpreadsheetFile,
  openAttachment,
  selectRepresentation,
} from "./attachments";
import type { AttachmentMeta } from "./chat-api";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./api", () => ({
  http: apiMock,
}));

/**
 * Юнит-тесты клиентской распаковки Вложений и выбора их представления
 * (Req 12.6, 12.7, 12.9).
 *
 * Распаковка проверяется на реальных сжатых потоках (`zstd` и `gzip`),
 * сформированных Node `zlib`, с побайтовым сравнением round-trip — это
 * подтверждает отсутствие потери данных (Req 12.9).
 */

/** Кодирует строку в байты (UTF-8). */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Сравнивает два байтовых массива на полное совпадение. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

describe("decompress", () => {
  it("возвращает содержимое без изменений для несжатого кодека", async () => {
    const raw = bytes("Произвольное содержимое");
    for (const codec of ["", "none", "identity", "store", "  NONE  "]) {
      const out = await decompress(raw, codec);
      expect(bytesEqual(out, raw)).toBe(true);
    }
  });

  it("распаковывает zstd-поток без потери данных (round-trip)", async () => {
    const original = bytes(
      "Изображение → сжатие zstd → распаковка на клиенте. ".repeat(50),
    );
    const compressed = new Uint8Array(zstdCompressSync(original));
    const restored = await decompress(compressed, "zstd");
    expect(bytesEqual(restored, original)).toBe(true);
  });

  it("распознаёт алиас кодека «zst» и регистр/пробелы", async () => {
    const original = bytes("короткие данные");
    const compressed = new Uint8Array(zstdCompressSync(original));
    const restored = await decompress(compressed, "  ZST ");
    expect(bytesEqual(restored, original)).toBe(true);
  });

  it("распаковывает gzip-поток без потери данных (round-trip)", async () => {
    // gzip-ветка использует браузерный DecompressionStream через Blob.stream().
    // jsdom не реализует Blob.prototype.stream(), поэтому в этой среде путь
    // непроверяем; основной кодек хранения Вложений — zstd (Req 12.8, 12.9),
    // он покрыт выше. Прогоняем gzip-тест только если Blob.stream доступен.
    if (typeof Blob.prototype.stream !== "function") {
      return;
    }
    const original = bytes("gzip данные ".repeat(100));
    const compressed = new Uint8Array(gzipSync(original));
    const restored = await decompress(compressed, "gzip");
    expect(bytesEqual(restored, original)).toBe(true);
  });

  it("корректно распаковывает пустое содержимое", async () => {
    const original = new Uint8Array(0);
    const compressed = new Uint8Array(zstdCompressSync(original));
    const restored = await decompress(compressed, "zstd");
    expect(restored.length).toBe(0);
  });

  it("бросает ошибку на неизвестном кодеке", async () => {
    await expect(decompress(bytes("x"), "lzma")).rejects.toThrow(
      /Неизвестный кодек/,
    );
  });
});

/** Базовая заготовка метаданных Вложения для тестов представления. */
function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: "att-1",
    messageId: "msg-1",
    originalName: "file.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 1024,
    hasThumbnail: false,
    compression: "zstd",
    checksum: "abc",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:attachment-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPreviewableImage", () => {
  it("считает растровые изображения пригодными для превью", () => {
    expect(isPreviewableImage("image/png")).toBe(true);
    expect(isPreviewableImage("IMAGE/JPEG")).toBe(true);
    expect(isPreviewableImage("image/webp; charset=binary")).toBe(true);
  });

  it("исключает SVG и не-изображения", () => {
    expect(isPreviewableImage("image/svg+xml")).toBe(false);
    expect(isPreviewableImage("application/pdf")).toBe(false);
    expect(isPreviewableImage("text/plain")).toBe(false);
  });
});

describe("attachmentPreviewKind", () => {
  it("распознаёт изображения, видео и аудио для предпросмотра", () => {
    expect(attachmentPreviewKind(meta({ mimeType: "image/png" }))).toBe(
      "image",
    );
    expect(attachmentPreviewKind(meta({ mimeType: "video/mp4" }))).toBe(
      "video",
    );
    expect(attachmentPreviewKind(meta({ mimeType: "audio/mpeg" }))).toBe(
      "audio",
    );
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "voice.mp3",
        }),
      ),
    ).toBe("audio");
  });

  it("распознаёт поддержанные таблицы, включая старый xls", () => {
    expect(
      attachmentPreviewKind(
        meta({
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          originalName: "report.xlsx",
        }),
      ),
    ).toBe("spreadsheet");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "data.csv",
        }),
      ),
    ).toBe("spreadsheet");
    expect(
      attachmentPreviewKind(
        meta({ mimeType: "application/vnd.ms-excel", originalName: "old.xls" }),
      ),
    ).toBe("spreadsheet");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "native.ods",
        }),
      ),
    ).toBe("spreadsheet");
  });

  it("распознаёт PDF для общего canvas-предпросмотра", () => {
    expect(
      attachmentPreviewKind(
        meta({ mimeType: "application/pdf", originalName: "scan.bin" }),
      ),
    ).toBe("pdf");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "scan.pdf",
        }),
      ),
    ).toBe("pdf");
  });

  it("распознаёт Word-документы для PDF-предпросмотра", () => {
    expect(
      attachmentPreviewKind(
        meta({
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          originalName: "brief.docx",
        }),
      ),
    ).toBe("document");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "legacy.doc",
        }),
      ),
    ).toBe("document");
  });

  it("распознаёт презентации PowerPoint и Impress для PDF-предпросмотра", () => {
    expect(
      attachmentPreviewKind(
        meta({
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          originalName: "roadmap.pptx",
        }),
      ),
    ).toBe("presentation");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "all-hands.odp",
        }),
      ),
    ).toBe("presentation");
    expect(
      attachmentPreviewKind(
        meta({
          mimeType: "application/octet-stream",
          originalName: "show.ppsx",
        }),
      ),
    ).toBe("presentation");
  });
});

describe("document helpers", () => {
  it("распознаёт spreadsheet-файлы по MIME-типу и расширению", () => {
    expect(isSpreadsheetFile("text/csv", "report.csv")).toBe(true);
    expect(isSpreadsheetFile("application/octet-stream", "report.xlsx")).toBe(
      true,
    );
    expect(isSpreadsheetFile("application/vnd.ms-excel", "old.xls")).toBe(true);
    expect(isSpreadsheetFile("application/octet-stream", "native.ods")).toBe(
      true,
    );
  });

  it("распознаёт Word-документы по MIME-типу и расширению", () => {
    expect(
      isDocumentFile(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "file.bin",
      ),
    ).toBe(true);
    expect(isDocumentFile("application/octet-stream", "brief.docx")).toBe(true);
    expect(
      isPreviewableDocument("application/octet-stream", "legacy.doc"),
    ).toBe(true);
    expect(isPreviewableDocument("application/pdf", "report.pdf")).toBe(false);
  });

  it("распознаёт PDF по MIME-типу и расширению", () => {
    expect(isPdfFile("application/pdf", "file.bin")).toBe(true);
    expect(isPdfFile("application/octet-stream", "scan.pdf")).toBe(true);
    expect(isPdfFile("application/octet-stream", "scan.docx")).toBe(false);
  });

  it("распознаёт презентации по MIME-типу и расширению", () => {
    expect(
      isPresentationFile(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "file.bin",
      ),
    ).toBe(true);
    expect(
      isPresentationFile("application/octet-stream", "quarterly-review.pptx"),
    ).toBe(true);
    expect(
      isPreviewablePresentation("application/octet-stream", "deck.odp"),
    ).toBe(true);
    expect(
      isPreviewablePresentation("application/octet-stream", "archive.zip"),
    ).toBe(false);
  });

  it("распознаёт видео по MIME-типу", () => {
    expect(isPreviewableVideo("video/mp4")).toBe(true);
    expect(isPreviewableVideo("application/octet-stream")).toBe(false);
  });

  it("распознаёт аудио по MIME-типу", () => {
    expect(isPreviewableAudio("audio/mpeg")).toBe(true);
    expect(isPreviewableAudio("audio/ogg; codecs=opus")).toBe(true);
    expect(isPreviewableAudio("application/octet-stream", "voice.wav")).toBe(
      true,
    );
    expect(isPreviewableAudio("application/octet-stream")).toBe(false);
  });
});

describe("genericIconType", () => {
  it("сопоставляет MIME-типу категорию значка", () => {
    expect(genericIconType("image/png")).toBe("image");
    expect(genericIconType("video/mp4")).toBe("video");
    expect(genericIconType("audio/mpeg")).toBe("audio");
    expect(genericIconType("text/csv")).toBe("spreadsheet");
    expect(genericIconType("application/pdf")).toBe("pdf");
    expect(genericIconType("application/octet-stream", "scan.pdf")).toBe(
      "pdf",
    );
    expect(genericIconType("application/octet-stream", "report.xlsx")).toBe(
      "spreadsheet",
    );
    expect(genericIconType("application/zip")).toBe("archive");
    expect(genericIconType("application/vnd.ms-excel")).toBe("spreadsheet");
    expect(
      genericIconType(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("presentation");
    expect(genericIconType("application/msword")).toBe("document");
    expect(genericIconType("application/x-unknown")).toBe("generic");
  });
});

describe("formatAttachmentSize", () => {
  it("форматирует байты, килобайты и мегабайты", () => {
    expect(formatAttachmentSize(512)).toBe("512 Б");
    expect(formatAttachmentSize(1536)).toBe("1.5 КБ");
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2.0 МБ");
  });
});

describe("openAttachment", () => {
  it("создаёт audio Blob по расширению, если сервер отдал application/octet-stream", async () => {
    apiMock.get.mockResolvedValue({
      data: bytes("audio-bytes").buffer,
      headers: {
        "content-type": "application/octet-stream",
        "x-compression": "none",
        "x-checksum": "",
      },
    });

    const result = await openAttachment(
      meta({
        originalName: "voice.mp3",
        mimeType: "application/octet-stream",
        compression: "none",
        checksum: "",
      }),
    );

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.blob.type).toBe("audio/mpeg");
    expect(result.url).toBe("blob:attachment-preview");

    result.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:attachment-preview");
  });
});

describe("fetchDocumentPreviewBlob", () => {
  it("ждёт LibreOffice-предпросмотр до двух минут", async () => {
    apiMock.get.mockResolvedValue({
      data: new Blob(["pdf"], { type: "application/pdf" }),
      headers: {},
    });

    await fetchDocumentPreviewBlob("att-1");

    expect(apiMock.get).toHaveBeenCalledWith("/attachments/att-1/preview", {
      responseType: "blob",
      timeout: 120_000,
    });
  });
});

describe("selectRepresentation", () => {
  it("выбирает миниатюру для изображения в пределах лимита с готовой миниатюрой", () => {
    const rep = selectRepresentation(
      meta({
        mimeType: "image/png",
        hasThumbnail: true,
        sizeBytes: 2 * 1024 * 1024,
      }),
    );
    expect(rep).toEqual({ kind: "thumbnail" });
  });

  it("выбирает значок, если миниатюра не сформирована", () => {
    const rep = selectRepresentation(
      meta({ mimeType: "image/png", hasThumbnail: false }),
    );
    expect(rep).toEqual({ kind: "icon", icon: "image" });
  });

  it("выбирает значок для изображения сверх лимита 25 МБ", () => {
    const rep = selectRepresentation(
      meta({
        mimeType: "image/png",
        hasThumbnail: true,
        sizeBytes: 25 * 1024 * 1024 + 1,
      }),
    );
    expect(rep).toEqual({ kind: "icon", icon: "image" });
  });

  it("выбирает значок по типу для не-изображений", () => {
    const rep = selectRepresentation(
      meta({ mimeType: "application/pdf", hasThumbnail: true }),
    );
    expect(rep).toEqual({ kind: "icon", icon: "pdf" });
  });

  it("выбирает PDF-значок по расширению при неточном MIME", () => {
    const rep = selectRepresentation(
      meta({
        originalName: "scan.pdf",
        mimeType: "application/octet-stream",
        hasThumbnail: true,
      }),
    );
    expect(rep).toEqual({ kind: "icon", icon: "pdf" });
  });
});
