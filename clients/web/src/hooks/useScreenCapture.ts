import { useRef, useState, useCallback } from "react";
import {
  MAX_WIDTH,
  MAX_HEIGHT,
  JPEG_QUALITY,
  CANVAS_TO_BLOB_TIMEOUT_MS,
  VIDEO_READY_TIMEOUT_MS,
} from "@lookout/shared";
import { drawScaledHQ } from "@lookout/react";

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
  /** Client-clock ms timestamp recorded at frame-grab time. Forwarded to
   *  the server as `capturedAt` to drive credit-mode tracking. */
  capturedAtMs?: number;
}

/** Wait for the video element to have decoded dimensions after play(). */
function waitForVideoReady(
  video: HTMLVideoElement,
  timeoutMs: number,
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

export function useScreenCapture() {
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  const startSharing = useCallback(async () => {
    // Try full constraints first; Safari <16 throws TypeError on frameRate/nested constraints
    let stream: MediaStream;
    try {
      // No width/height constraint — take native pixels and downscale
      // ourselves with a proper filter (see @lookout/react's hqScale);
      // a constrained track is pre-scaled by the browser with an
      // uncontrollable filter, which is where Retina text goes soft.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 1, max: 5 },
        },
        audio: false,
      });
    } catch (err) {
      if (err instanceof TypeError) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
      } else {
        throw err;
      }
    }

    streamRef.current = stream;

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    // Wait for first frame to be decoded before allowing captures
    await waitForVideoReady(video, VIDEO_READY_TIMEOUT_MS);

    videoRef.current = video;

    const canvas = document.createElement("canvas");
    canvasRef.current = canvas;

    // Handle user stopping share via browser UI
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      setIsSharing(false);
      streamRef.current = null;
    });

    setIsSharing(true);
  }, []);

  const takeScreenshotAsync = useCallback((): Promise<CaptureResult | null> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) {
      return Promise.resolve(null);
    }

    // Guard against zero-dimension video (race condition / not ready)
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return Promise.resolve(null);
    }

    const scale = Math.min(
      MAX_WIDTH / video.videoWidth,
      MAX_HEIGHT / video.videoHeight,
      1,
    );
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    if (!canvas.getContext("2d")) {
      return Promise.resolve(null);
    }

    // Stepped high-quality downscale from the native-resolution track.
    drawScaledHQ(video, video.videoWidth, video.videoHeight, canvas);

    // Stamp client-clock time at the moment the frame was grabbed.
    const capturedAtMs = Date.now();

    const toBlobPromise = new Promise<CaptureResult | null>((resolve) => {
      canvas.toBlob(
        (blob) => {
          resolve(
            blob
              ? { blob, width: canvas.width, height: canvas.height, capturedAtMs }
              : null,
          );
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    });

    // Timeout prevents the pipeline from stalling if toBlob hangs
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CANVAS_TO_BLOB_TIMEOUT_MS),
    );

    return Promise.race([toBlobPromise, timeoutPromise]);
  }, []);

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsSharing(false);
  }, []);

  return {
    isSharing,
    startSharing,
    takeScreenshotAsync,
    stopSharing,
    videoElement: videoRef.current,
  };
}
