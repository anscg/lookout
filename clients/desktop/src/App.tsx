import React, { useState, useEffect, useCallback } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  CollapseProvider,
  useSession,
  useSessionTimer,
  StatusBar,
  ResultView,
} from "@collapse/react";
import { useNativeCapture } from "./hooks/useNativeCapture.js";

const API_BASE = "http://localhost:3001"; // TODO: make configurable

/**
 * Extract token from a deep link URL like:
 *   collapse://session?token=abc123
 *   collapse://session/abc123
 */
function extractToken(url: string): string | null {
  try {
    // Handle collapse:// scheme — URL constructor needs a valid base
    const normalized = url.replace("collapse://", "https://collapse.local/");
    const parsed = new URL(normalized);

    // Try query param first: collapse://session?token=abc123
    const fromQuery = parsed.searchParams.get("token");
    if (fromQuery) return fromQuery;

    // Try path: collapse://session/abc123
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) return segments[1];
    if (segments.length === 1 && segments[0] !== "session") return segments[0];

    return null;
  } catch {
    return null;
  }
}

/** Try to get token from multiple sources. */
function getInitialToken(): string {
  // 1. URL query param (for dev / direct vite access)
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) return fromUrl;

  // 2. Stored from a previous deep link
  const stored = sessionStorage.getItem("collapse-token");
  if (stored) return stored;

  return "";
}

function WaitingForToken({ onToken }: { onToken: (t: string) => void }) {
  useEffect(() => {
    // Listen for deep link events (app already running)
    const unlisten = onOpenUrl((urls) => {
      for (const url of urls) {
        const token = extractToken(url);
        if (token) {
          sessionStorage.setItem("collapse-token", token);
          onToken(token);
          return;
        }
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [onToken]);

  return (
    <div style={styles.center}>
      <h2 style={styles.heading}>Collapse</h2>
      <p style={styles.text}>
        Waiting for a session link...
      </p>
      <p style={{ ...styles.text, marginTop: 12, fontSize: 12, color: "#555" }}>
        Open a <code style={{ color: "#888" }}>collapse://session?token=...</code> link
        to start recording.
      </p>
    </div>
  );
}

function DesktopRecorder({ token }: { token: string }) {
  const session = useSession();
  const capture = useNativeCapture(token, API_BASE);
  const displaySeconds = useSessionTimer(
    capture.trackedSeconds || session.trackedSeconds,
    capture.isCapturing,
  );

  useEffect(() => {
    if (capture.trackedSeconds > 0) {
      session.updateTrackedSeconds(capture.trackedSeconds);
    }
  }, [capture.trackedSeconds, session.updateTrackedSeconds]);

  const handleStart = useCallback(async () => {
    await capture.startCapturing();
  }, [capture.startCapturing]);

  const handlePause = useCallback(async () => {
    capture.stopCapturing();
    await session.pause();
  }, [capture, session]);

  const handleResume = useCallback(async () => {
    await session.resume();
    await capture.startCapturing();
  }, [capture, session]);

  const handleStop = useCallback(async () => {
    capture.stopCapturing();
    await session.stop();
  }, [capture, session]);

  if (session.status === "loading") {
    return <div style={styles.center}><p style={styles.text}>Loading session...</p></div>;
  }

  if (session.status === "error") {
    return (
      <div style={styles.center}>
        <h2 style={{ ...styles.heading, color: "#ef4444" }}>Error</h2>
        <p style={styles.text}>{session.error}</p>
      </div>
    );
  }

  if (["stopped", "compiling", "complete", "failed"].includes(session.status)) {
    return <ResultView status={session.status} trackedSeconds={session.trackedSeconds} />;
  }

  const isActive = session.status === "active" || session.status === "pending";
  const isPaused = session.status === "paused";

  return (
    <div style={styles.container}>
      <StatusBar
        displaySeconds={displaySeconds}
        screenshotCount={capture.screenshotCount}
        uploads={{ pending: 0, completed: capture.screenshotCount, failed: 0 }}
      />

      {capture.lastScreenshotUrl && (
        <div style={styles.preview}>
          <img src={capture.lastScreenshotUrl} alt="Latest" style={styles.previewImg} />
          <span style={styles.previewLabel}>Latest screenshot</span>
        </div>
      )}

      {capture.error && (
        <div style={styles.errorBanner}><span>{capture.error}</span></div>
      )}

      <div style={styles.controls}>
        {!capture.isCapturing && isActive && (
          <button style={styles.startBtn} onClick={handleStart}>Start Recording</button>
        )}
        {!capture.isCapturing && isPaused && (
          <>
            <button style={styles.resumeBtn} onClick={handleResume}>Resume</button>
            <button style={styles.stopBtn} onClick={handleStop}>Stop Session</button>
          </>
        )}
        {capture.isCapturing && (
          <>
            <div style={styles.recordingDot} />
            <span style={styles.recordingText}>Recording</span>
            <button style={styles.pauseBtn} onClick={handlePause}>Pause</button>
            <button style={styles.stopBtn} onClick={handleStop}>Stop</button>
          </>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(getInitialToken);

  // Listen for deep links on mount (handles app launch via deep link)
  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      for (const url of urls) {
        const t = extractToken(url);
        if (t) {
          sessionStorage.setItem("collapse-token", t);
          setToken(t);
          return;
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  if (!token) {
    return <WaitingForToken onToken={setToken} />;
  }

  return (
    <CollapseProvider token={token} apiBaseUrl={API_BASE}>
      <DesktopRecorder token={token} />
    </CollapseProvider>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 480, margin: "20px auto", padding: 16 },
  center: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "100vh", padding: 24,
  },
  heading: { fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8 },
  text: { fontSize: 14, color: "#888", textAlign: "center" },
  preview: {
    position: "relative", marginBottom: 12, borderRadius: 8,
    overflow: "hidden", background: "#111", border: "1px solid #333",
  },
  previewImg: { width: "100%", display: "block" },
  previewLabel: {
    position: "absolute", bottom: 6, right: 6, fontSize: 11,
    color: "#aaa", background: "rgba(0,0,0,0.7)", padding: "2px 6px", borderRadius: 4,
  },
  errorBanner: {
    padding: "10px 14px", marginBottom: 12, background: "rgba(239,68,68,0.15)",
    border: "1px solid #ef4444", borderRadius: 8, color: "#fca5a5", fontSize: 13,
  },
  controls: {
    display: "flex", alignItems: "center", gap: 10,
    justifyContent: "center", flexWrap: "wrap",
  },
  startBtn: {
    padding: "12px 24px", fontSize: 15, fontWeight: 600,
    background: "#22c55e", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
  },
  pauseBtn: {
    padding: "8px 16px", fontSize: 13, fontWeight: 600,
    background: "#f59e0b", color: "#000", border: "none", borderRadius: 8, cursor: "pointer",
  },
  resumeBtn: {
    padding: "12px 24px", fontSize: 15, fontWeight: 600,
    background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
  },
  stopBtn: {
    padding: "8px 16px", fontSize: 13, fontWeight: 600,
    background: "#ef4444", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
  },
  recordingDot: {
    width: 10, height: 10, borderRadius: "50%", background: "#ef4444",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  recordingText: { fontSize: 13, fontWeight: 600, color: "#ef4444", marginRight: 6 },
};
