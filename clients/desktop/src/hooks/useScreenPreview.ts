import { useState, useEffect, useRef } from "react";
import { invoke } from "../logger.js";
import type { CaptureSource } from "./useNativeCapture.js";

interface PreviewResult {
  base64: string;
  width: number;
  height: number;
  size_bytes: number;
}

/**
 * Periodically captures a low-res preview screenshot from the given source.
 * Updates every `intervalMs` (default 2s). Returns an object URL for display.
 */
export function useScreenPreview(
  source: CaptureSource | null,
  intervalMs = 2000,
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Derive a stable key from the source for dependency tracking
  const sourceKey = source ? `${source.type}:${source.id}` : "";

  useEffect(() => {
    if (!source) {
      setPreviewUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
    console.debug(`[preview] starting preview for ${source.type} id=${source.id} every ${intervalMs}ms`);

    const capture = async () => {
      const s = sourceRef.current;
      if (!s || cancelled) return;
      try {
        const result = await invoke<PreviewResult>("take_screenshot", {
          source: s,
          maxWidth: 640,
          maxHeight: 360,
          jpegQuality: 50,
        });
        if (cancelled) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPreviewUrl(url);
        setError(null);
        console.debug(`[preview] got preview ${result.width}x${result.height} (${result.size_bytes} bytes)`);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[preview] preview failed: ${msg}`);
          setError(msg);
        }
      }
    };

    capture();
    const id = setInterval(capture, intervalMs);

    return () => {
      cancelled = true;
      console.debug("[preview] stopping preview");
      clearInterval(id);
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [sourceKey, intervalMs]);

  return { previewUrl, error };
}
