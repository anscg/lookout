import { useRef, useState, useCallback } from "react";
import type { CaptureResult, CaptureSettings } from "../types.js";
import { useLookoutContext } from "../LookoutProvider.js";
import { waitForVideoReady, captureFrameAsJpeg } from "./captureUtils.js";

/**
 * Handles getDisplayMedia, canvas snapshots, and stream lifecycle.
 *
 * Reads capture settings from LookoutProvider context. Pass explicit
 * settings to override or use standalone (without provider).
 */
export function useScreenCapture(overrides?: CaptureSettings) {
  let settings: Required<Omit<CaptureSettings, "displayMediaConstraints" | "mode" | "camera">> & {
    displayMediaConstraints?: DisplayMediaStreamOptions;
  };

  try {
    const { config } = useLookoutContext();
    settings = {
      ...config.capture,
      ...overrides,
    };
  } catch {
    // Standalone mode — no provider, require explicit settings
    settings = {
      intervalMs: overrides?.intervalMs ?? 60_000,
      jpegQuality: overrides?.jpegQuality ?? 0.85,
      maxWidth: overrides?.maxWidth ?? 1920,
      maxHeight: overrides?.maxHeight ?? 1080,
      displayMediaConstraints: overrides?.displayMediaConstraints,
    };
  }

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  // Store settings in a ref so takeScreenshot always uses latest
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const startSharing = useCallback(async () => {
    const s = settingsRef.current;
    // Deliberately NO width/height constraint: constraining makes the
    // browser pre-scale the track to 1080p with an uncontrollable filter
    // (in 4:2:0 chroma, no less), which is where Retina text goes soft.
    // We take native pixels and do the maxWidth/maxHeight downscale
    // ourselves with a proper stepped filter — see hqScale.ts. The frame
    // rate stays pinned low so the unscaled track costs next to nothing.
    const constraints: DisplayMediaStreamOptions = {
      video: {
        frameRate: { ideal: 1, max: 5 },
      },
      audio: false,
      ...s.displayMediaConstraints,
    };

    // Try full constraints first; Safari <16 throws TypeError on frameRate/nested constraints
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(constraints);
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
    await waitForVideoReady(video);

    videoRef.current = video;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }

    stream.getVideoTracks()[0].addEventListener("ended", () => {
      streamRef.current = null;
      setIsSharing(false);
    });

    setIsSharing(true);
  }, []);

  const takeScreenshot = useCallback((): Promise<CaptureResult | null> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const s = settingsRef.current;
    if (!video || !canvas || !streamRef.current) {
      return Promise.resolve(null);
    }

    return captureFrameAsJpeg(video, canvas, s);
  }, []);

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsSharing(false);
  }, []);

  // Stable accessor for the live capture <video> — for consumers (like the
  // clip recorder) that need the current element inside effects/callbacks
  // without re-render staleness.
  const getVideo = useCallback(() => videoRef.current, []);

  return { isSharing, startSharing, takeScreenshot, stopSharing, getVideo };
}
