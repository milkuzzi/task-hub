type PdfJsModule = typeof import("pdfjs-dist");
type PdfJsLoader = () => Promise<PdfJsModule>;

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let pdfJsLoader: PdfJsLoader = loadDefaultPdfJs;

function loadDefaultPdfJs(): Promise<PdfJsModule> {
  return Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as PdfJsModule;
  });
}

export function setPdfDocumentViewerPdfJsLoaderForTest(
  loader: PdfJsLoader | null,
): void {
  pdfJsPromise = null;
  pdfJsLoader = loader ?? loadDefaultPdfJs;
}

export function loadPdfJs(): Promise<PdfJsModule> {
  if (pdfJsPromise === null) {
    pdfJsPromise = pdfJsLoader();
  }
  return pdfJsPromise;
}
