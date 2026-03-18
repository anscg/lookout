import { useState, useEffect, useRef } from "react";

/**
 * Display timer that shows elapsed active time.
 * Uses server-provided trackedSeconds as ground truth,
 * interpolates client-side for smooth display between API calls.
 */
export function useSessionTimer(
  serverTrackedSeconds: number,
  isActive: boolean,
) {
  const [displaySeconds, setDisplaySeconds] = useState(serverTrackedSeconds);
  const lastServerUpdateRef = useRef(Date.now());

  // Sync with server whenever trackedSeconds changes
  useEffect(() => {
    setDisplaySeconds(serverTrackedSeconds);
    lastServerUpdateRef.current = Date.now();
  }, [serverTrackedSeconds]);

  // Client-side interpolation when active
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      const elapsedSinceSync = Math.floor(
        (Date.now() - lastServerUpdateRef.current) / 1000,
      );
      setDisplaySeconds(serverTrackedSeconds + elapsedSinceSync);
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, serverTrackedSeconds]);

  return displaySeconds;
}

/**
 * Format seconds as HH:MM:SS
 */
export function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
