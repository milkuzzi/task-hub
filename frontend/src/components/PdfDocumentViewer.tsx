import {
  type TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowClockwise,
  ArrowsOutLineHorizontal,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import { loadPdfJs } from "./pdfjs-loader";

const MIN_ZOOM = 0.5;
const SITE_MAX_ZOOM = 2.5;
const SITE_ZOOM_STEP = 0.1;
const MAX_MINI_APP_ZOOM_STEP = 0.25;
const MAX_DEVICE_PIXEL_RATIO = 2;
const MOBILE_PAGE_INSET = 12;
const DESKTOP_PAGE_INSET = 24;

interface PinchState {
  distance: number;
  zoom: number;
  originX: number;
  originY: number;
  scrollLeft: number;
  scrollTop: number;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
}

interface TouchCollection {
  readonly length: number;
  readonly [index: number]: TouchPoint | undefined;
  item?: (touchIndex: number) => TouchPoint | null;
}

function clampZoom(value: number, maxZoom: number): number {
  return Math.min(maxZoom, Math.max(MIN_ZOOM, value));
}

function getTouchAt(touches: TouchCollection, index: number): TouchPoint | null {
  return touches.item?.(index) ?? touches[index] ?? null;
}

function getTouchPair(
  touches: TouchCollection,
): [TouchPoint, TouchPoint] | null {
  const first = getTouchAt(touches, 0);
  const second = getTouchAt(touches, 1);
  if (first === null || second === null) {
    return null;
  }
  return [first, second];
}

function getTouchDistance(first: TouchPoint, second: TouchPoint): number {
  return Math.hypot(
    second.clientX - first.clientX,
    second.clientY - first.clientY,
  );
}

function pageNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

export interface PdfDocumentViewerProps {
  blob: Blob;
  fileName: string;
  surface?: "site" | "max";
  onError: () => void;
}

export function PdfDocumentViewer({
  blob,
  fileName,
  surface = "site",
  onError,
}: PdfDocumentViewerProps): JSX.Element {
  const { t } = useTranslation();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [renderedPages, setRenderedPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const pinchScrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const element = pagesRef.current ?? containerRef.current;
    if (element === null) {
      return;
    }

    const updateWidth = (): void => {
      setContainerWidth(
        element.clientWidth || document.documentElement.clientWidth || 360,
      );
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedDocument: PDFDocumentProxy | null = null;

    setPdf(null);
    setPageCount(0);
    setCurrentPage(1);
    setRenderedPages(0);
    setFailed(false);

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) {
          return;
        }
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) {
          return;
        }
        loadingTask = pdfjs.getDocument({ data });
        const documentProxy = await loadingTask.promise;
        if (cancelled) {
          await documentProxy.cleanup();
          return;
        }
        loadedDocument = documentProxy;
        setPdf(documentProxy);
        setPageCount(documentProxy.numPages);
      } catch {
        if (!cancelled) {
          setFailed(true);
          onError();
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask !== null) {
        void loadingTask.destroy();
      } else if (loadedDocument !== null) {
        void loadedDocument.cleanup();
      }
    };
  }, [blob, onError]);

  useEffect(
    () => () => {
      if (pinchScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pinchScrollFrameRef.current);
      }
    },
    [],
  );

  const numbers = useMemo(() => pageNumbers(pageCount), [pageCount]);
  const maxZoom =
    surface === "max" ? Number.POSITIVE_INFINITY : SITE_MAX_ZOOM;
  const zoomStep = surface === "max" ? MAX_MINI_APP_ZOOM_STEP : SITE_ZOOM_STEP;
  const zoomLabel = t("attachment.viewer.zoomValue", {
    value: Math.round(zoom * 100),
  });

  const markRendered = useCallback(() => {
    setRenderedPages((value) => Math.min(pageCount, value + 1));
  }, [pageCount]);

  const handleZoomOut = (): void => {
    setZoom((value) => clampZoom(value - zoomStep, maxZoom));
  };

  const handleZoomIn = (): void => {
    setZoom((value) => clampZoom(value + zoomStep, maxZoom));
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    if (surface !== "max" || event.touches.length < 2) {
      pinchRef.current = null;
      return;
    }

    const pair = getTouchPair(event.touches);
    const pages = pagesRef.current;
    if (pair === null || pages === null) {
      return;
    }

    const [first, second] = pair;
    const distance = getTouchDistance(first, second);
    if (distance <= 0) {
      return;
    }

    const bounds = pages.getBoundingClientRect();
    pinchRef.current = {
      distance,
      zoom,
      originX: (first.clientX + second.clientX) / 2 - bounds.left,
      originY: (first.clientY + second.clientY) / 2 - bounds.top,
      scrollLeft: pages.scrollLeft,
      scrollTop: pages.scrollTop,
    };
    event.preventDefault();
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
    const pinch = pinchRef.current;
    const pages = pagesRef.current;
    if (surface !== "max" || pinch === null || pages === null) {
      return;
    }

    const pair = getTouchPair(event.touches);
    if (pair === null) {
      return;
    }

    const [first, second] = pair;
    const distance = getTouchDistance(first, second);
    if (distance <= 0) {
      return;
    }

    const nextZoom = clampZoom(
      pinch.zoom * (distance / pinch.distance),
      maxZoom,
    );
    const zoomRatio = nextZoom / pinch.zoom;

    event.preventDefault();
    setZoom(nextZoom);

    if (pinchScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pinchScrollFrameRef.current);
    }
    pinchScrollFrameRef.current = window.requestAnimationFrame(() => {
      pages.scrollLeft =
        (pinch.scrollLeft + pinch.originX) * zoomRatio - pinch.originX;
      pages.scrollTop =
        (pinch.scrollTop + pinch.originY) * zoomRatio - pinch.originY;
      pinchScrollFrameRef.current = null;
    });
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>): void => {
    if (event.touches.length < 2) {
      pinchRef.current = null;
    }
  };

  const handleFitWidth = (): void => {
    setFitWidth(true);
    setZoom(1);
  };

  const handleRotate = (): void => {
    setRotation((value) => (value + 90) % 360);
  };

  return (
    <div
      className={
        surface === "max"
          ? "pdf-document-viewer pdf-document-viewer--max"
          : "pdf-document-viewer"
      }
      ref={containerRef}
    >
      <div className="pdf-document-viewer__toolbar" aria-label={fileName}>
        <span className="pdf-document-viewer__page-count">
          {t("attachment.viewer.pdfPage")} {currentPage}
          {pageCount > 0 && (
            <>
              {" "}
              / {pageCount}
            </>
          )}
        </span>
        <span className="pdf-document-viewer__tools">
          <button
            className="btn btn--sm pdf-document-viewer__tool"
            type="button"
            title={t("attachment.viewer.zoomOut")}
            aria-label={t("attachment.viewer.zoomOut")}
            disabled={zoom <= MIN_ZOOM}
            onClick={handleZoomOut}
          >
            <MagnifyingGlassMinus size={18} aria-hidden="true" />
          </button>
          <span className="pdf-document-viewer__zoom">{zoomLabel}</span>
          <button
            className="btn btn--sm pdf-document-viewer__tool"
            type="button"
            title={t("attachment.viewer.zoomIn")}
            aria-label={t("attachment.viewer.zoomIn")}
            disabled={Number.isFinite(maxZoom) && zoom >= maxZoom}
            onClick={handleZoomIn}
          >
            <MagnifyingGlassPlus size={18} aria-hidden="true" />
          </button>
          <button
            className="btn btn--sm pdf-document-viewer__tool"
            type="button"
            title={t("attachment.viewer.fitWidth")}
            aria-label={t("attachment.viewer.fitWidth")}
            aria-pressed={fitWidth}
            onClick={handleFitWidth}
          >
            <ArrowsOutLineHorizontal size={18} aria-hidden="true" />
          </button>
          <button
            className="btn btn--sm pdf-document-viewer__tool"
            type="button"
            title={t("attachment.viewer.rotate")}
            aria-label={t("attachment.viewer.rotate")}
            onClick={handleRotate}
          >
            <ArrowClockwise size={18} aria-hidden="true" />
          </button>
        </span>
      </div>

      <div
        className="pdf-document-viewer__pages"
        ref={pagesRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {pdf === null && !failed && (
          <p className="text-muted">{t("attachment.viewer.loading")}</p>
        )}
        {pdf !== null && (
          <>
            <p className="visually-hidden" aria-live="polite">
              {t("attachment.viewer.pdfRendering", {
                current: renderedPages,
                total: pageCount,
              })}
            </p>
            {numbers.map((pageNumber) => (
              <PdfPageCanvas
                key={pageNumber}
                pdf={pdf}
                pageNumber={pageNumber}
                containerWidth={containerWidth}
                fitWidth={fitWidth}
                zoom={zoom}
                rotation={rotation}
                pageInset={
                  surface === "max" ? MOBILE_PAGE_INSET : DESKTOP_PAGE_INSET
                }
                scrollRoot={pagesRef.current}
                onVisible={setCurrentPage}
                onRendered={markRendered}
                onError={() => {
                  setFailed(true);
                  onError();
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface PdfPageCanvasProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  containerWidth: number;
  fitWidth: boolean;
  zoom: number;
  rotation: number;
  pageInset: number;
  scrollRoot: HTMLDivElement | null;
  onVisible: (pageNumber: number) => void;
  onRendered: () => void;
  onError: () => void;
}

function PdfPageCanvas({
  pdf,
  pageNumber,
  containerWidth,
  fitWidth,
  zoom,
  rotation,
  pageInset,
  scrollRoot,
  onVisible,
  onRendered,
  onError,
}: PdfPageCanvasProps): JSX.Element {
  const { t } = useTranslation();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [active, setActive] = useState(pageNumber === 1);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const element = shellRef.current;
    if (element === null) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting === true) {
          setActive(true);
          onVisible(pageNumber);
        }
      },
      {
        root: scrollRoot,
        rootMargin: "640px 0px",
        threshold: 0.35,
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, pageNumber, scrollRoot]);

  useEffect(() => {
    if (!active || containerWidth <= 0) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let page: PDFPageProxy | null = null;

    setRendered(false);

    void (async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled || page === null) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1, rotation });
        const availableWidth = Math.max(1, containerWidth - pageInset * 2);
        const fitScale = availableWidth / baseViewport.width;
        const scale = (fitWidth ? fitScale : 1) * zoom;
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas === null || context === null) {
          throw new Error("Canvas is unavailable.");
        }

        const outputScale = Math.min(
          window.devicePixelRatio || 1,
          MAX_DEVICE_PIXEL_RATIO,
        );
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const renderViewport = page.getViewport({
          scale: scale * outputScale,
          rotation,
        });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport: renderViewport,
        });
        await renderTask.promise;
        if (!cancelled) {
          setRendered(true);
          onRendered();
        }
      } catch {
        if (!cancelled) {
          onError();
        }
      } finally {
        page?.cleanup();
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [
    active,
    containerWidth,
    fitWidth,
    onError,
    onRendered,
    pageNumber,
    pageInset,
    pdf,
    rotation,
    zoom,
  ]);

  return (
    <div className="pdf-document-viewer__page-shell" ref={shellRef}>
      <span className="pdf-document-viewer__page-label">
        {t("attachment.viewer.pdfPage")} {pageNumber}
      </span>
      <div className="pdf-document-viewer__page">
        {!rendered && (
          <span className="pdf-document-viewer__page-loading">
            {t("attachment.viewer.loading")}
          </span>
        )}
        <canvas
          ref={canvasRef}
          className="pdf-document-viewer__canvas"
          aria-label={`${t("attachment.viewer.pdfPage")} ${pageNumber}`}
        />
      </div>
    </div>
  );
}
