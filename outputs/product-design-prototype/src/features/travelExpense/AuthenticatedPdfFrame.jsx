import {
  CircleAlert,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { loadAuthenticatedPdfBlob } from "./authenticatedPdf.js";

let pdfRuntimePromise;

function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, workerModule]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfJs;
    }).catch((error) => {
      pdfRuntimePromise = undefined;
      const runtimeError = new Error("PDF 渲染组件加载失败，请重新加载页面。");
      runtimeError.name = "PdfRuntimeLoadError";
      runtimeError.cause = error;
      throw runtimeError;
    });
  }
  return pdfRuntimePromise;
}

function initialState() {
  return { status: "loading", error: "", pageCount: 0, requiresPageReload: false };
}

function normalizedRenderWidth(value) {
  if (!Number.isFinite(value)) return 1200;
  return Math.min(1800, Math.max(480, Math.round(value)));
}

export function AuthenticatedPdfFrame({
  resourceKey,
  loadPdf,
  title,
  pageNumber = 1,
  renderAllPages = false,
  renderWidth = 1200,
  className = "",
  onStatusChange,
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(initialState);
  const canvasRef = useRef(null);
  const loadPdfRef = useRef(loadPdf);
  const statusCallbackRef = useRef(onStatusChange);

  useEffect(() => {
    loadPdfRef.current = loadPdf;
  }, [loadPdf]);

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  function publishStatus(status) {
    statusCallbackRef.current?.(status);
  }

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loadingTask = null;
    let renderTask = null;
    const canvas = canvasRef.current;

    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.removeProperty("aspect-ratio");
    }
    setState(initialState());
    publishStatus("loading");

    void (async () => {
      const blob = await loadAuthenticatedPdfBlob(loadPdfRef.current, {
        signal: controller.signal,
      });
      const [pdfJs, buffer] = await Promise.all([
        loadPdfRuntime(),
        blob.arrayBuffer(),
      ]);
      if (disposed) return;

      loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) });
      const documentProxy = await loadingTask.promise;
      if (disposed) return;
      if (!renderAllPages && (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > documentProxy.numPages)) {
        throw new Error(`PDF 页码无效（第 ${pageNumber} 页，共 ${documentProxy.numPages} 页）`);
      }

      const pageNumbers = renderAllPages
        ? Array.from({ length: documentProxy.numPages }, (_, index) => index + 1)
        : [pageNumber];
      const canvases = [];
      for (const [index, currentPageNumber] of pageNumbers.entries()) {
        const page = await documentProxy.getPage(currentPageNumber);
        if (disposed) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = normalizedRenderWidth(renderWidth);
        const viewport = page.getViewport({ scale: targetWidth / baseViewport.width });
        const targetCanvas = index === 0 ? canvasRef.current : document.createElement("canvas");
        if (!targetCanvas) throw new Error("当前浏览器无法创建 PDF Canvas。 ");
        if (index > 0) {
          targetCanvas.hidden = true;
          targetCanvas.dataset.pdfGeneratedPage = String(currentPageNumber);
          targetCanvas.setAttribute("role", "img");
          targetCanvas.setAttribute("aria-label", `${title} 第 ${currentPageNumber} 页`);
          canvases[index - 1].after(targetCanvas);
        }
        targetCanvas.dataset.pdfPageNumber = String(currentPageNumber);
        const context = targetCanvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("当前浏览器无法创建 PDF Canvas。 ");

        targetCanvas.width = Math.max(1, Math.ceil(viewport.width));
        targetCanvas.height = Math.max(1, Math.ceil(viewport.height));
        targetCanvas.style.aspectRatio = `${targetCanvas.width} / ${targetCanvas.height}`;
        canvases.push(targetCanvas);
        renderTask = page.render({
          canvasContext: context,
          viewport,
          background: "rgb(255, 255, 255)",
        });
        await renderTask.promise;
        if (disposed) return;
      }

      canvases.forEach((renderedCanvas) => { renderedCanvas.hidden = false; });

      setState({
        status: "ready",
        error: "",
        pageCount: documentProxy.numPages,
        requiresPageReload: false,
      });
      publishStatus("ready");
    })().catch((error) => {
      if (
        disposed
        || error?.name === "AbortError"
        || error?.name === "RenderingCancelledException"
      ) return;
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      canvasRef.current?.parentElement?.querySelectorAll(":scope > [data-pdf-generated-page]")
        .forEach((generatedCanvas) => generatedCanvas.remove());
      setState({
        status: "error",
        error: error instanceof Error ? error.message : "PDF 原件渲染失败。",
        pageCount: 0,
        requiresPageReload: error?.name === "PdfRuntimeLoadError",
      });
      publishStatus("error");
    });

    return () => {
      disposed = true;
      controller.abort();
      renderTask?.cancel();
      void loadingTask?.destroy();
      canvasRef.current?.parentElement?.querySelectorAll(":scope > [data-pdf-generated-page]")
        .forEach((generatedCanvas) => generatedCanvas.remove());
    };
  }, [attempt, pageNumber, renderAllPages, renderWidth, resourceKey, title]);

  const classes = ["authenticated-pdf-frame", renderAllPages ? "is-all-pages" : "", className].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      data-authenticated-pdf-state={state.status}
      data-pdf-page-count={state.pageCount || undefined}
      aria-busy={state.status === "loading"}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={title}
        hidden={state.status !== "ready"}
      />
      {state.status === "error" ? (
        <div className="authenticated-pdf-frame-state is-error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{state.error}</span>
          <button
            type="button"
            onClick={() => {
              if (state.requiresPageReload) {
                window.location.reload();
                return;
              }
              setAttempt((value) => value + 1);
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {state.requiresPageReload ? "重新加载页面" : "重新加载"}
          </button>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="authenticated-pdf-frame-state" role="status">
          <LoaderCircle className="state-spinner" size={20} aria-hidden="true" />
          <span>正在安全渲染 PDF 原件</span>
        </div>
      ) : null}
    </div>
  );
}
