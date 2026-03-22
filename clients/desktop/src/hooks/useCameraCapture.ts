import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_WIDTH,
  MAX_HEIGHT,
  JPEG_QUALITY,
  CANVAS_TO_BLOB_TIMEOUT_MS,
  VIDEO_READY_TIMEOUT_MS,
} from "@collapse/shared";

/**
 * Enumerate available cameras. Returns an empty array on failure (never throws).
 *
 * Browser quirk: `enumerateDevices()` returns empty labels until `getUserMedia`
 * has been called at least once in the session. If we detect empty labels, we
 * briefly open and close a camera stream to unlock them, then re-enumerate.
 */
export async function enumerateCameras(): Promise<MediaDeviceInfo[]> {
  try {
    console.log("[camera] enumerating devices...");
    if (!navigator.mediaDevices?.enumerateDevices) {
      console.warn("[camera] enumerateDevices API not available");
      return [];
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    let cameras = devices.filter((d) => d.kind === "videoinput");

    // If we found cameras but labels are empty, unlock labels with a brief getUserMedia call
    if (cameras.length > 0 && cameras.every((c) => !c.label)) {
      console.log("[camera] labels empty, requesting brief stream to unlock...");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        stream.getTracks().forEach((t) => t.stop());
        // Re-enumerate now that permission has been exercised
        devices = await navigator.mediaDevices.enumerateDevices();
        cameras = devices.filter((d) => d.kind === "videoinput");
        console.log("[camera] labels unlocked after getUserMedia");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[camera] failed to unlock labels (getUserMedia failed): ${msg}`);
        // Continue with empty labels — "Camera 1" fallback will be used
      }
    }

    console.log(`[camera] found ${cameras.length} camera(s)`, cameras.map((c) => c.label || c.deviceId));
    return cameras;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[camera] enumerate failed: ${msg}`);
    return [];
  }
}

/** Wait for the video element to have decoded dimensions. */
export function waitForVideoReady(
  video: HTMLVideoElement,
  timeoutMs: number = VIDEO_READY_TIMEOUT_MS,
): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (video.videoWidth > 0 && video.videoHeight > 0) return resolve();
      if (Date.now() > deadline)
        return reject(new Error("Video not ready — no frames received"));
      requestAnimationFrame(check);
    })();
  });
}

/**
 * Manages a persistent low-fps camera stream for timelapse capture.
 *
 * - `startStream(deviceId)` opens the camera at low frame rate
 * - `stopStream()` closes the camera and releases all tracks
 * - `captureFrame()` grabs a single JPEG frame from the active stream
 * - `stream` is exposed for `<video>` preview rendering
 *
 * All operations are fail-safe: errors are logged but never thrown.
 */
export function useCameraCapture() {
  const [stream, setStream] = useState<MediaStream | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const getCanvas = useCallback(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    return canvasRef.current;
  }, []);

  const startStream = useCallback(async (deviceId: string): Promise<MediaStream | null> => {
    console.log(`[camera] starting stream for device ${deviceId}...`);
    try {
      // Stop any existing stream first
      if (streamRef.current) {
        console.log("[camera] stopping existing stream before starting new one");
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: false,
      });

      streamRef.current = mediaStream;
      setStream(mediaStream);

      const track = mediaStream.getVideoTracks()[0];
      const settings = track?.getSettings();
      console.log(
        `[camera] stream started ${settings?.width ?? "?"}x${settings?.height ?? "?"} @ ${settings?.frameRate ?? "?"}fps`
      );

      // Detect camera disconnect
      track?.addEventListener("ended", () => {
        console.warn("[camera] stream ended (device disconnected?)");
        streamRef.current = null;
        setStream(null);
      });

      return mediaStream;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[camera] failed to start stream: ${msg}`);
      streamRef.current = null;
      setStream(null);
      return null;
    }
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      console.log("[camera] stopping stream");
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStream(null);
    }
  }, []);

  /**
   * Capture a single JPEG frame from the provided video element (or the
   * internally tracked one). The video must be playing the camera stream.
   * Returns null on failure (never throws).
   */
  const captureFrame = useCallback(async (video?: HTMLVideoElement | null): Promise<{
    base64: string;
    width: number;
    height: number;
  } | null> => {
    if (!video || !streamRef.current) {
      console.warn("[camera] captureFrame called but no active stream or video element");
      return null;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      console.warn("[camera] captureFrame: video has no dimensions yet");
      return null;
    }

    try {
      const canvas = getCanvas();

      // Scale to fit within MAX_WIDTH x MAX_HEIGHT
      const scale = Math.min(
        MAX_WIDTH / video.videoWidth,
        MAX_HEIGHT / video.videoHeight,
        1,
      );
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        console.error("[camera] captureFrame: failed to get canvas 2d context");
        return null;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Convert to JPEG blob with timeout
      const blob = await Promise.race([
        new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY),
        ),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), CANVAS_TO_BLOB_TIMEOUT_MS),
        ),
      ]);

      if (!blob) {
        console.error("[camera] captureFrame: toBlob returned null or timed out");
        return null;
      }

      // Convert blob to base64 using FileReader (avoids O(n^2) string concatenation)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          // Strip "data:image/jpeg;base64," prefix
          resolve(dataUrl.substring(dataUrl.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });

      console.log(
        `[camera] frame captured ${canvas.width}x${canvas.height} (${Math.round(blob.size / 1024)}KB)`
      );

      return {
        base64,
        width: canvas.width,
        height: canvas.height,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[camera] captureFrame failed: ${msg}`);
      return null;
    }
  }, [getCanvas]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        console.log("[camera] cleaning up stream on unmount");
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  return {
    stream,
    startStream,
    stopStream,
    captureFrame,
  };
}
