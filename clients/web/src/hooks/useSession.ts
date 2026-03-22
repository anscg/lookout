import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionStatus, SessionResponse } from "@lookout/shared";
import { api } from "../api/client.js";

interface SessionState {
  status: SessionStatus | "loading" | "error" | "no-token";
  trackedSeconds: number;
  screenshotCount: number;
  startedAt: string | null;
  totalActiveSeconds: number;
  error?: string;
}

export function useSession() {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    trackedSeconds: 0,
    screenshotCount: 0,
    startedAt: null,
    totalActiveSeconds: 0,
  });

  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // Load session state on mount
  useEffect(() => {
    try {
      api.getToken(); // throws if no token
    } catch {
      setState((s) => ({ ...s, status: "no-token" }));
      return;
    }

    loadSession();
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const data = await api.getSession();
      setState({
        status: data.status,
        trackedSeconds: data.trackedSeconds,
        screenshotCount: data.screenshotCount,
        startedAt: data.startedAt,
        totalActiveSeconds: data.totalActiveSeconds,
      });

      // If compiling, start polling for status
      if (data.status === "compiling" || data.status === "stopped") {
        startPolling();
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getStatus();
        setState((s) => ({
          ...s,
          status: data.status,
          trackedSeconds: data.trackedSeconds,
        }));

        if (data.status === "complete" || data.status === "failed") {
          clearInterval(pollRef.current);
          pollRef.current = undefined;
        }
      } catch {
        // Ignore poll errors
      }
    }, 3000);
  }, []);

  const pause = useCallback(async () => {
    const data = await api.pause();
    setState((s) => ({
      ...s,
      status: data.status,
      totalActiveSeconds: data.totalActiveSeconds,
    }));
  }, []);

  const resume = useCallback(async () => {
    const data = await api.resume();
    setState((s) => ({ ...s, status: data.status }));
  }, []);

  const stop = useCallback(async () => {
    const data = await api.stop();
    setState((s) => ({
      ...s,
      status: data.status,
      trackedSeconds: data.trackedSeconds,
      totalActiveSeconds: data.totalActiveSeconds,
    }));
    startPolling();
  }, [startPolling]);

  const updateTrackedSeconds = useCallback((seconds: number) => {
    setState((s) => ({ ...s, trackedSeconds: seconds }));
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return {
    ...state,
    pause,
    resume,
    stop,
    loadSession,
    updateTrackedSeconds,
  };
}
