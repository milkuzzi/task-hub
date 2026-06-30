import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfDocumentViewer } from "./PdfDocumentViewer";
import { setPdfDocumentViewerPdfJsLoaderForTest } from "./pdfjs-loader";

const pdfJsMock = vi.hoisted(() => {
  const getDocument = vi.fn();
  const workerOptions = { workerSrc: "" };
  return {
    getDocument,
    workerOptions,
  };
});

interface MockPage {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}

function makePage(): MockPage {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 240 * scale,
      height: 320 * scale,
    })),
    render: vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    })),
    cleanup: vi.fn(),
  };
}

function makeDocument(pageCount = 2): {
  document: {
    numPages: number;
    getPage: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  };
  pages: MockPage[];
} {
  const pages = Array.from({ length: pageCount }, makePage);
  return {
    pages,
    document: {
      numPages: pageCount,
      getPage: vi.fn((pageNumber: number) =>
        Promise.resolve(pages[pageNumber - 1]),
      ),
      cleanup: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeTouchList(
  touches: Array<Pick<Touch, "clientX" | "clientY">>,
): TouchList {
  return Object.assign(touches, {
    item: (index: number) => touches[index] ?? null,
  }) as unknown as TouchList;
}

function renderViewer({
  onError = vi.fn(),
  surface = "site",
}: {
  onError?: () => void;
  surface?: "site" | "max";
} = {}): HTMLElement {
  const { container } = render(
    <PdfDocumentViewer
      blob={new Blob(["%PDF"], { type: "application/pdf" })}
      fileName="report.pdf"
      surface={surface}
      onError={onError}
    />,
  );
  return container;
}

describe("PdfDocumentViewer", () => {
  beforeEach(() => {
    pdfJsMock.getDocument.mockReset();
    pdfJsMock.workerOptions.workerSrc = "";
    setPdfDocumentViewerPdfJsLoaderForTest(() => {
      pdfJsMock.workerOptions.workerSrc = "mock-pdf-worker.mjs";
      return Promise.resolve({
        GlobalWorkerOptions: pdfJsMock.workerOptions,
        getDocument: pdfJsMock.getDocument,
      } as unknown as typeof import("pdfjs-dist"));
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({})),
    });
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      value: vi.fn(() => Promise.resolve(new ArrayBuffer(4))),
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 360,
    });
  });

  afterEach(() => {
    setPdfDocumentViewerPdfJsLoaderForTest(null);
    vi.restoreAllMocks();
  });

  it("загружает PDF и рендерит страницы на canvas", async () => {
    const { document, pages } = makeDocument(2);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const container = renderViewer();

    await waitFor(() => expect(pdfJsMock.getDocument).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText("Страница 1 / 2")).toBeInTheDocument(),
    );
    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());

    expect(container.querySelectorAll(".pdf-document-viewer__canvas")).toHaveLength(
      2,
    );
    expect(pdfJsMock.workerOptions.workerSrc).toBe("mock-pdf-worker.mjs");
  });

  it("меняет масштаб и поворот через toolbar controls", async () => {
    const { document, pages } = makeDocument(1);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    renderViewer();

    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Увеличить" }));
    expect(await screen.findByText("110%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Повернуть" }));
    await waitFor(() =>
      expect(pages[0]?.getViewport).toHaveBeenCalledWith(
        expect.objectContaining({ rotation: 90 }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "По ширине" }));
    expect(await screen.findByText("100%")).toBeInTheDocument();
  });

  it("сообщает об ошибке загрузки PDF", async () => {
    const onError = vi.fn();
    pdfJsMock.getDocument.mockImplementation(() => ({
      promise: Promise.resolve().then(() => {
        throw new Error("bad pdf");
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    }));

    renderViewer({ onError });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  it("в MAX mini-app подгоняет страницу под узкую ширину без лишнего минимума", async () => {
    const { document, pages } = makeDocument(1);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const container = renderViewer({ surface: "max" });

    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());

    expect(container.querySelector(".pdf-document-viewer--max")).not.toBeNull();
    const canvas = container.querySelector<HTMLCanvasElement>(
      ".pdf-document-viewer__canvas",
    );
    expect(canvas?.style.width).toBe("336px");
    expect(pages[0]?.getViewport).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 1.4 }),
    );
  });

  it("в MAX mini-app увеличивает крупным шагом без верхнего лимита", async () => {
    const { document, pages } = makeDocument(1);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    renderViewer({ surface: "max" });

    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());

    const zoomIn = screen.getByRole("button", { name: "Увеличить" });
    fireEvent.click(zoomIn);
    expect(await screen.findByText("125%")).toBeInTheDocument();

    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(zoomIn);
    }
    expect(await screen.findByText("625%")).toBeInTheDocument();
    expect(zoomIn).not.toBeDisabled();
  });

  it("в MAX mini-app меняет масштаб двухпальцевым жестом", async () => {
    const { document, pages } = makeDocument(1);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const container = renderViewer({ surface: "max" });

    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());

    const pagesElement = container.querySelector<HTMLDivElement>(
      ".pdf-document-viewer__pages",
    );
    if (pagesElement === null) {
      throw new Error("Pages element is missing.");
    }

    fireEvent.touchStart(pagesElement, {
      touches: makeTouchList([
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]),
    });
    fireEvent.touchMove(pagesElement, {
      touches: makeTouchList([
        { clientX: 50, clientY: 100 },
        { clientX: 250, clientY: 100 },
      ]),
    });
    expect(await screen.findByText("200%")).toBeInTheDocument();

    fireEvent.touchEnd(pagesElement, { touches: makeTouchList([]) });
    fireEvent.touchStart(pagesElement, {
      touches: makeTouchList([
        { clientX: 50, clientY: 100 },
        { clientX: 250, clientY: 100 },
      ]),
    });
    fireEvent.touchMove(pagesElement, {
      touches: makeTouchList([
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]),
    });
    expect(await screen.findByText("100%")).toBeInTheDocument();
  });

  it("освобождает PDF document при размонтировании", async () => {
    const { document, pages } = makeDocument(1);
    const destroyLoadingTask = vi.fn().mockResolvedValue(undefined);
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: destroyLoadingTask,
    });

    const { unmount } = render(
      <PdfDocumentViewer
        blob={new Blob(["%PDF"], { type: "application/pdf" })}
        fileName="report.pdf"
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(pages[0]?.render).toHaveBeenCalled());
    unmount();

    expect(destroyLoadingTask).toHaveBeenCalledTimes(1);
  });
});
