import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SCREENSHOT_INTERVAL_MS, MAX_WIDTH, MAX_HEIGHT, JPEG_QUALITY } from "@collapse/shared";

export interface CaptureSource {
  type: "monitor" | "window";
  id: number;
}

interface CaptureUploadResult {
  confirmed: boolean;
  trackedSeconds: number;
  nextExpectedAt: string;
  previewBase64: string;
  previewWidth: number;
  previewHeight: number;
}

/**
 * Desktop-native capture hook. Uses Tauri IPC to:
 * 1. Take a native screenshot via xcap (Rust)
 * 2. Upload directly from Rust (no CORS)
 * 3. Confirm with the server
 * 4. Return the captured frame as a preview URL
 */
export function useNativeCapture(
  token: string,
  apiBaseUrl: string,
  source: CaptureSource,
) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [trackedSeconds, setTrackedSeconds] = useState(0);
  const [screenshotCount, setScreenshotCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastScreenshotUrl, setLastScreenshotUrl] = useState<string | null>(null);

  const configuredRef = useRef(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Track blob URL for cleanup
  const blobUrlRef = useRef<string | null>(null);

  const captureOnce = useCallback(async () => {
    try {
      const result = await invoke<CaptureUploadResult>("capture_and_upload", {
        source: sourceRef.current,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        jpegQuality: Math.round(JPEG_QUALITY * 100),
      });
      setTrackedSeconds(result.trackedSeconds);
      setScreenshotCount((c) => c + 1);
      setError(null);

      // Convert preview base64 to blob URL for display
      if (result.previewBase64) {
        const bytes = Uint8Array.from(atob(result.previewBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setLastScreenshotUrl(url);
      }
    } catch (err) {
      const msg = err instanceof Error
        ? err.message + (err.stack ? "\n" + err.stack : "")
        : String(err);
      setError(msg);
    }
  }, []);

  // Keep captureOnce in a ref so the interval always calls the latest version
  const captureRef = useRef(captureOnce);
  captureRef.current = captureOnce;

  // The capture loop: one effect manages the entire interval lifecycle.
  // Starts when isCapturing becomes true, stops when it becomes false.
  useEffect(() => {
    if (!isCapturing) return;

    captureRef.current();
    const id = setInterval(() => captureRef.current(), SCREENSHOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isCapturing]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const startCapturing = useCallback(async () => {
    if (!configuredRef.current) {
      await invoke("configure", { token, apiBaseUrl });
      configuredRef.current = true;
    }
    setIsCapturing(true);
    setError(null);
  }, [token, apiBaseUrl]);

  const stopCapturing = useCallback(() => {
    setIsCapturing(false);
  }, []);

  return {
    isCapturing,
    trackedSeconds,
    screenshotCount,
    error,
    lastScreenshotUrl,
    startCapturing,
    stopCapturing,
  };
}
