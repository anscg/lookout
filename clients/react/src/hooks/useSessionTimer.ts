import { useState, useEffect, useRef } from "react";

/**
 * Client-side interpolated timer. Uses server-provided trackedSeconds
 * as ground truth, interpolates between updates for smooth display.
 */
export function useSessionTimer(
  serverTrackedSeconds: number,
  isActive: boolean,
): number {
  const [displaySeconds, setDisplaySeconds] = useState(serverTrackedSeconds);
  const lastSyncRef = useRef(Date.now());

  useEffect(() => {
    setDisplaySeconds(serverTrackedSeconds);
    lastSyncRef.current = Date.now();
  }, [serverTrackedSeconds]);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastSyncRef.current) / 1000);
      setDisplaySeconds(serverTrackedSeconds + elapsed);
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive, serverTrackedSeconds]);

  return displaySeconds;
}

/** Format seconds as H:MM:SS or M:SS. */
export function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
