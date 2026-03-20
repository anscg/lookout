import { useRef, useState, useCallback, useEffect } from "react";
import type { CaptureResult, CaptureSettings } from "../types.js";
import { useCollapseContext } from "../CollapseProvider.js";
import { waitForVideoReady, captureFrameAsJpeg } from "./captureUtils.js";

/**
 * Handles getUserMedia (webcam), device enumeration, canvas snapshots,
 * and stream lifecycle.
 *
 * Mirrors the return shape of `useScreenCapture` so `useCollapse` can
 * delegate to either hook interchangeably, plus camera-specific extras
 * (device list, selection).
 *
 * Reads capture settings from CollapseProvider context. Pass explicit
 * settings to override or use standalone (without provider).
 */
export function useCameraCapture(overrides?: CaptureSettings) {
  let settings: {
    maxWidth: number;
    maxHeight: number;
    jpegQuality: number;
    deviceId?: string;
    userMediaConstraints?: MediaTrackConstraints;
  };

  try {
    const { config } = useCollapseContext();
    settings = {
      maxWidth: overrides?.maxWidth ?? config.capture.maxWidth,
      maxHeight: overrides?.maxHeight ?? config.capture.maxHeight,
      jpegQuality: overrides?.jpegQuality ?? config.capture.jpegQuality,
      deviceId: overrides?.camera?.deviceId ?? config.capture.camera.deviceId,
      userMediaConstraints:
        overrides?.camera?.userMediaConstraints ??
        config.capture.camera.userMediaConstraints,
    };
  } catch {
    // Standalone mode — no provider
    settings = {
      maxWidth: overrides?.maxWidth ?? 1920,
      maxHeight: overrides?.maxHeight ?? 1080,
      jpegQuality: overrides?.jpegQuality ?? 0.85,
      deviceId: overrides?.camera?.deviceId,
      userMediaConstraints: overrides?.camera?.userMediaConstraints,
    };
  }

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    settings.deviceId ?? null,
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ─── Device enumeration ────────────────────────────────
  const enumerateDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cameras = all.filter((d) => d.kind === "videoinput");
      setDevices(cameras);
      return cameras;
    } catch {
      return [];
    }
  }, []);

  // Enumerate on mount and listen for device changes
  useEffect(() => {
    enumerateDevices();
    const handler = () => enumerateDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [enumerateDevices]);

  // ─── Stream management ─────────────────────────────────
  const startSharing = useCallback(async () => {
    const s = settingsRef.current;
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: s.maxWidth, max: s.maxWidth },
      height: { ideal: s.maxHeight, max: s.maxHeight },
      ...s.userMediaConstraints,
    };

    // Apply device selection
    const deviceId = selectedDeviceId ?? s.deviceId;
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    streamRef.current = stream;

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
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

    // Re-enumerate after first getUserMedia — Safari may now expose labels
    enumerateDevices();
  }, [selectedDeviceId, enumerateDevices]);

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

  // ─── Device selection ──────────────────────────────────
  const selectDevice = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      // If currently streaming, restart with the new device
      if (streamRef.current) {
        stopSharing();
        // Defer start to next tick so state updates propagate
        setTimeout(() => {
          // Use the new deviceId directly since state may not have updated yet
          const s = settingsRef.current;
          const videoConstraints: MediaTrackConstraints = {
            width: { ideal: s.maxWidth, max: s.maxWidth },
            height: { ideal: s.maxHeight, max: s.maxHeight },
            deviceId: { exact: deviceId },
            ...s.userMediaConstraints,
          };
          navigator.mediaDevices
            .getUserMedia({ video: videoConstraints, audio: false })
            .then(async (stream) => {
              streamRef.current = stream;
              const video = document.createElement("video");
              video.srcObject = stream;
              video.muted = true;
              video.playsInline = true;
              await video.play();
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
            })
            .catch(() => {
              // Device switch failed — stay stopped
            });
        }, 0);
      }
    },
    [stopSharing],
  );

  return {
    isSharing,
    startSharing,
    takeScreenshot,
    stopSharing,
    devices,
    selectedDeviceId,
    selectDevice,
  };
}
