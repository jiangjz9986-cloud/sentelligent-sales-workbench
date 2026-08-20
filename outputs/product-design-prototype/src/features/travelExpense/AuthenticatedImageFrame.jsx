import {
  CircleAlert,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { loadAuthenticatedImageBlob } from "./authenticatedPdf.js";
import {
  createImageVariant,
  DOCUMENT_VARIANT_TARGETS,
} from "./documentVariant.js";

function initialState() {
  return { status: "loading", error: "", source: "original" };
}
export function AuthenticatedImageFrame({
  resourceKey,
  loadImage,
  title,
  variant = "preview",
  maxDimension = DOCUMENT_VARIANT_TARGETS[variant] ?? DOCUMENT_VARIANT_TARGETS.preview,
  className = "",
  onStatusChange,
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(initialState);
  const [objectUrl, setObjectUrl] = useState("");
  const loadImageRef = useRef(loadImage);
  const statusCallbackRef = useRef(onStatusChange);

  useEffect(() => {
    loadImageRef.current = loadImage;
  }, [loadImage]);

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let nextUrl = "";
    setState(initialState());
    setObjectUrl("");
    statusCallbackRef.current?.("loading");

    void (async () => {
      const original = await loadAuthenticatedImageBlob(loadImageRef.current, {
        signal: controller.signal,
      });
      const result = await createImageVariant(original, {
        maxDimension,
        mediaType: original.type,
      });
      if (disposed) return;
      nextUrl = URL.createObjectURL(result.blob);
      setObjectUrl(nextUrl);
      setState({ status: "ready", error: "", source: result.usedOriginal ? "original" : "derivative" });
      statusCallbackRef.current?.("ready");
    })().catch((error) => {
      if (disposed || error?.name === "AbortError") return;
      setState({
        status: "error",
        error: error instanceof Error ? error.message : "图片原件读取失败。",
        source: "original",
      });
      statusCallbackRef.current?.("error");
    });

    return () => {
      disposed = true;
      controller.abort();
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [attempt, maxDimension, resourceKey]);

  const classes = ["authenticated-image-frame", className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      data-authenticated-image-state={state.status}
      data-image-source={state.source}
      aria-busy={state.status === "loading"}
    >
      {state.status === "ready" && objectUrl ? (
        <img
          src={objectUrl}
          alt={title}
          onError={() => {
            setState({ status: "error", error: "图片原件显示失败。", source: state.source });
            statusCallbackRef.current?.("error");
          }}
        />
      ) : null}
      {state.status === "error" ? (
        <div className="authenticated-image-frame-state is-error" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <span>{state.error}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={14} aria-hidden="true" />重新加载
          </button>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="authenticated-image-frame-state" role="status">
          <LoaderCircle className="state-spinner" size={20} aria-hidden="true" />
          <span>正在准备图片原件</span>
        </div>
      ) : null}
    </div>
  );
}
