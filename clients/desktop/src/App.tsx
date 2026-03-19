import React, { useState, useEffect, useCallback } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";
import {
  checkScreenRecordingPermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import {
  CollapseProvider,
  useSession,
  useSessionTimer,
  StatusBar,
  ResultView,
  Gallery,
  SessionDetail,
  useTokenStore,
  useGallery,
  useHashRouter,
} from "@collapse/react";
import { useNativeCapture } from "./hooks/useNativeCapture.js";
import type { CaptureSource } from "./hooks/useNativeCapture.js";
import { SourcePicker } from "./components/SourcePicker.js";
import { useScreenPreview } from "./hooks/useScreenPreview.js";

const API_BASE = "https://collapse.b.selfhosted.hackclub.com";

// ── Helpers ──────────────────────────────────────────────────

function isValidToken(token: string): boolean {
  return /^[a-f0-9]{64}$/i.test(token);
}

function extractToken(url: string): string | null {
  try {
    const normalized = url.replace("collapse://", "https://collapse.local/");
    const parsed = new URL(normalized);
    const fromQuery = parsed.searchParams.get("token");
    if (fromQuery && isValidToken(fromQuery)) return fromQuery;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const candidate =
      segments.length >= 2
        ? segments[1]
        : segments.length === 1 && segments[0] !== "session"
          ? segments[0]
          : null;
    if (candidate && isValidToken(candidate)) return candidate;
    return null;
  } catch {
    return null;
  }
}

// ── Permission Screen ────────────────────────────────────────

type PermissionStatus = "checking" | "granted" | "denied";

function PermissionScreen({ onGranted }: { onGranted: () => void }) {
  const [status, setStatus] = useState<PermissionStatus>("checking");

  const checkPermission = useCallback(async () => {
    const granted = await checkScreenRecordingPermission();
    dbg("permission check: " + granted);
    if (granted) {
      setStatus("granted");
      onGranted();
    } else {
      setStatus("denied");
    }
  }, [onGranted]);

  useEffect(() => { checkPermission(); }, [checkPermission]);

  const handleRequest = useCallback(async () => {
    await requestScreenRecordingPermission();
  }, []);

  if (status === "checking") {
    return (
      <div style={styles.center}>
        <p style={styles.text}>Checking screen recording permission...</p>
      </div>
    );
  }

  return (
    <div style={styles.center}>
      <div style={styles.permissionCard}>
        <div style={styles.permissionIcon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
        <h2 style={styles.permissionHeading}>Screen Recording Permission</h2>
        <p style={styles.permissionText}>
          Collapse needs screen recording access to capture screenshots of your work.
          Your screen is captured locally and only periodic screenshots are uploaded.
        </p>
        <button style={styles.permissionBtn} onClick={handleRequest}>
          Grant Permission
        </button>
        <p style={{ ...styles.permissionText, color: "#f59e0b", marginTop: 12, fontSize: 11, lineHeight: 1.5 }}>
          After enabling "Collapse" in System Settings &gt; Privacy &gt; Screen Recording, quit and reopen the app.
          If it still doesn't work, remove Collapse from the list entirely, restart the app, and grant permission again.
        </p>
        <button
          style={{ ...styles.permissionBtnSecondary, marginTop: 16, fontSize: 11, color: "#666" }}
          onClick={onGranted}
        >
          Skip (proceed anyway)
        </button>
      </div>
    </div>
  );
}

// ── Desktop Recorder ─────────────────────────────────────────

function DesktopRecorder({ token, source, onChangeSource, onBack }: {
  token: string;
  source: CaptureSource;
  onChangeSource: () => void;
  onBack: () => void;
}) {
  const session = useSession();
  const capture = useNativeCapture(token, API_BASE, source);
  // Live preview when not actively recording
  const showLivePreview = !capture.isCapturing;
  const { previewUrl: livePreviewUrl } = useScreenPreview(
    showLivePreview ? source : null,
    2000,
  );
  const displaySeconds = useSessionTimer(
    capture.trackedSeconds || session.trackedSeconds,
    capture.isCapturing,
  );

  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    if (capture.trackedSeconds > 0) {
      session.updateTrackedSeconds(capture.trackedSeconds);
    }
  }, [capture.trackedSeconds, session.updateTrackedSeconds]);

  // Auto-start/resume capturing once session is ready
  const autoStarted = React.useRef(false);
  useEffect(() => {
    if (!autoStarted.current && !capture.isCapturing && !isTransitioning) {
      if (session.status === "active" || session.status === "pending") {
        autoStarted.current = true;
        capture.startCapturing();
      } else if (session.status === "paused") {
        autoStarted.current = true;
        session.resume().then(() => capture.startCapturing());
      }
    }
  }, [session.status, capture.isCapturing, capture.startCapturing, isTransitioning, session]);

  const handleStart = useCallback(async () => {
    await capture.startCapturing();
  }, [capture.startCapturing]);

  const handlePause = useCallback(async () => {
    setIsTransitioning(true);
    capture.stopCapturing();
    await session.pause();
    setIsTransitioning(false);
  }, [capture, session]);

  const handleResume = useCallback(async () => {
    setIsTransitioning(true);
    await session.resume();
    await capture.startCapturing();
    setIsTransitioning(false);
  }, [capture, session]);

  const handleStop = useCallback(async () => {
    setIsTransitioning(true);
    capture.stopCapturing();
    await session.stop();
  }, [capture, session]);

  if (session.status === "loading") {
    return <div style={styles.center}><p style={styles.text}>Loading session...</p></div>;
  }

  if (session.status === "error") {
    return (
      <div style={styles.center}>
        <h2 style={{ ...styles.heading, color: "#ef4444" }}>Session Error</h2>
        <div style={styles.errorBox}>
          <pre style={styles.errorDetail}>{session.error}</pre>
        </div>
        <button style={{ ...styles.backBtn, marginTop: 12 }} onClick={onBack}>
          &larr; Gallery
        </button>
      </div>
    );
  }

  if (["stopped", "compiling", "complete", "failed"].includes(session.status)) {
    return (
      <div style={styles.container}>
        <button style={styles.backBtn} onClick={onBack}>&larr; Gallery</button>
        <ResultView status={session.status} trackedSeconds={session.trackedSeconds} />
      </div>
    );
  }

  const isActive = session.status === "active" || session.status === "pending";
  const isPaused = session.status === "paused";

  return (
    <div style={styles.container}>
      <button style={styles.backBtn} onClick={onBack}>&larr; Gallery</button>
      <StatusBar
        displaySeconds={displaySeconds}
        screenshotCount={capture.screenshotCount}
        uploads={{ pending: 0, completed: capture.screenshotCount, failed: 0 }}
      />

      {/* Preview: live when idle, last capture when recording */}
      {(livePreviewUrl || capture.lastScreenshotUrl) && (
        <div style={styles.preview}>
          <img
            src={capture.isCapturing ? (capture.lastScreenshotUrl ?? livePreviewUrl!) : livePreviewUrl!}
            alt="Screen preview"
            style={styles.previewImg}
          />
          <span style={styles.previewLabel}>
            {capture.isCapturing ? "Latest capture" : "Live preview"}
          </span>
        </div>
      )}

      {capture.error && (
        <div style={styles.errorBanner}><span>{capture.error}</span></div>
      )}

      <div style={styles.controls}>
        {!capture.isCapturing && isActive && !isTransitioning && (
          <>
            <button style={styles.startBtn} onClick={handleStart}>Start Recording</button>
            <button style={styles.changeSrcBtn} onClick={onChangeSource}>Change Source</button>
          </>
        )}
        {!capture.isCapturing && isPaused && !isTransitioning && (
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

// ── Recording Page (source picker + recorder) ────────────────

function RecordPage({ token, onBack, onViewSession }: {
  token: string;
  onBack: () => void;
  onViewSession: (token: string) => void;
}) {
  const [captureSource, setCaptureSource] = useState<CaptureSource | null>(null);
  const [stopping, setStopping] = useState(false);
  const [sessionCheck, setSessionCheck] = useState<"loading" | "ok" | "finished" | "error">("loading");
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Check if the session is still recordable before showing source picker
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/sessions/${token}/status`);
        if (!res.ok) {
          setCheckError(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
          setSessionCheck("error");
          return;
        }
        const data = await res.json();
        setSessionStatus(data.status);
        if (["stopped", "compiling", "complete", "failed"].includes(data.status)) {
          setSessionCheck("finished");
        } else {
          setSessionCheck("ok");
        }
      } catch (err: any) {
        setCheckError(err.message || String(err));
        setSessionCheck("error");
      }
    })();
  }, [token]);

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      await fetch(`${API_BASE}/api/sessions/${token}/stop`, { method: "POST" });
    } catch {}
    onBack();
  }, [token, onBack]);

  if (sessionCheck === "loading") {
    return <div style={styles.center}><p style={styles.text}>Loading session...</p></div>;
  }

  if (sessionCheck === "error") {
    return (
      <div style={styles.center}>
        <h2 style={{ ...styles.heading, color: "#ef4444" }}>Session Error</h2>
        <pre style={{ ...styles.errorDetail, maxWidth: 400, marginBottom: 16 }}>{checkError}</pre>
        <button style={styles.backBtn} onClick={onBack}>&larr; Gallery</button>
      </div>
    );
  }

  if (sessionCheck === "finished") {
    const label = sessionStatus === "complete" ? "Complete" : sessionStatus === "compiling" ? "Compiling" : sessionStatus === "failed" ? "Failed" : "Stopped";
    return (
      <div style={styles.center}>
        <h2 style={styles.heading}>Session Already {label}</h2>
        <p style={{ ...styles.text, marginBottom: 20 }}>
          This session is no longer recordable.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button style={styles.permissionBtn} onClick={() => onViewSession(token)}>
            View Timelapse
          </button>
          <button style={styles.backBtn} onClick={onBack}>
            &larr; Gallery
          </button>
        </div>
      </div>
    );
  }

  if (!captureSource) {
    return (
      <div>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 16px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button style={styles.backBtn} onClick={onBack}>&larr; Gallery</button>
          <button style={styles.stopBtn} onClick={handleStop} disabled={stopping}>
            {stopping ? "Stopping..." : "Stop Session"}
          </button>
        </div>
        <SourcePicker
          onSelect={setCaptureSource}
          submitLabel={sessionStatus === "active" || sessionStatus === "paused" ? "Resume Session" : "Start Capture"}
        />
      </div>
    );
  }

  return (
    <CollapseProvider token={token} apiBaseUrl={API_BASE}>
      <DesktopRecorder
        token={token}
        source={captureSource}
        onChangeSource={() => setCaptureSource(null)}
        onBack={onBack}
      />
    </CollapseProvider>
  );
}

// ── App ──────────────────────────────────────────────────────

const dbg = (window as any).__dbg || console.log;

export function App() {
  dbg("App: render start");
  const [permissionGranted, setPermissionGranted] = useState(false);
  dbg("App: after useState");
  const { route, navigate } = useHashRouter();
  dbg("App: after useHashRouter");
  const tokenStore = useTokenStore();
  dbg("App: after useTokenStore, tokens=" + tokenStore.getAllTokenValues().length);
  const gallery = useGallery({
    apiBaseUrl: API_BASE,
    tokens: tokenStore.getAllTokenValues(),
  });
  dbg(`App: after useGallery, permissionGranted=${permissionGranted}`);

  // Deep link handler — saves token and navigates to record.
  // Tracks the last processed URL to deduplicate retried cold-start emits.
  const lastDeepLink = React.useRef<string | null>(null);
  const handleDeepLinkUrls = useCallback(
    (urls: string[]) => {
      for (const url of urls) {
        if (url === lastDeepLink.current) return; // already handled
        const token = extractToken(url);
        if (token) {
          lastDeepLink.current = url;
          tokenStore.addToken(token);
          navigate({ page: "record", token });
          return;
        }
      }
    },
    [tokenStore, navigate],
  );

  // Listen for deep links while app is running (warm start)
  useEffect(() => {
    const unlistenPlugin = onOpenUrl((urls) => {
      dbg("onOpenUrl: " + JSON.stringify(urls));
      handleDeepLinkUrls(urls);
    });
    return () => { unlistenPlugin.then((fn) => fn()); };
  }, [handleDeepLinkUrls]);

  // Poll for cold-start deep link URLs. The Rust side stashes URLs from both
  // get_current() (immediate) and on_open_url (delayed Apple Event). We poll
  // a few times to catch URLs that arrive after the app finishes launching.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        try {
          const urls = await invoke<string[]>("get_cold_start_urls");
          dbg(`cold start poll #${i}: ${JSON.stringify(urls)}`);
          if (urls.length > 0) {
            handleDeepLinkUrls(urls);
            return;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    check();
    return () => { cancelled = true; };
  }, [handleDeepLinkUrls]);

  // Handle ?token= query param (dev mode)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token && isValidToken(token)) {
      tokenStore.addToken(token);
      navigate({ page: "record", token });
    }
  }, []);

  // Step 1: Permission check (macOS)
  if (!permissionGranted) {
    return <PermissionScreen onGranted={() => setPermissionGranted(true)} />;
  }

  // Step 2: Route
  switch (route.page) {
    case "gallery":
      return (
        <Gallery
          sessions={gallery.sessions}
          loading={gallery.loading}
          error={gallery.error}
          onSessionClick={(token) => {
            const session = gallery.sessions.find((s) => s.token === token);
            if (session && ["pending", "active", "paused"].includes(session.status)) {
              navigate({ page: "record", token });
            } else {
              navigate({ page: "session", token });
            }
          }}
          onArchive={(token) => {
            tokenStore.archiveToken(token);
            gallery.refresh();
          }}
          onRefresh={gallery.refresh}
        />
      );

    case "record":
      return (
        <RecordPage
          token={route.token}
          onBack={() => {
            gallery.refresh();
            navigate({ page: "gallery" });
          }}
          onViewSession={(token) => {
            tokenStore.addToken(token);
            navigate({ page: "session", token });
          }}
        />
      );

    case "session":
      return (
        <SessionDetail
          token={route.token}
          apiBaseUrl={API_BASE}
          onBack={() => navigate({ page: "gallery" })}
          onArchive={() => {
            tokenStore.archiveToken(route.token);
            navigate({ page: "gallery" });
          }}
        />
      );
  }
}

// ── Styles ───────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 480, margin: "20px auto", padding: 16 },
  center: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "100vh", padding: 24,
  },
  heading: { fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8 },
  text: { fontSize: 14, color: "#888", textAlign: "center" },
  backBtn: {
    padding: "6px 12px", fontSize: 13, fontWeight: 500,
    background: "transparent", color: "#888", border: "1px solid #444",
    borderRadius: 6, cursor: "pointer", marginBottom: 12,
  },
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
  errorBox: {
    maxWidth: 400, width: "100%", padding: "12px 14px",
    background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444",
    borderRadius: 8, marginTop: 8,
  },
  errorDetail: {
    margin: 0, fontSize: 11, fontFamily: "monospace",
    whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const,
    maxHeight: 150, overflowY: "auto" as const, color: "#fca5a5",
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
  changeSrcBtn: {
    padding: "8px 16px", fontSize: 12, fontWeight: 500,
    background: "transparent", color: "#888", border: "1px solid #444",
    borderRadius: 8, cursor: "pointer",
  },
  permissionCard: {
    maxWidth: 360, padding: 32, background: "#1a1a1a", borderRadius: 16,
    border: "1px solid #333", textAlign: "center" as const,
  },
  permissionIcon: { marginBottom: 16 },
  permissionHeading: {
    fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 12,
  },
  permissionText: {
    fontSize: 13, color: "#999", lineHeight: 1.6, marginBottom: 20,
  },
  permissionBtn: {
    width: "100%", padding: "12px 24px", fontSize: 14, fontWeight: 600,
    background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8,
    cursor: "pointer",
  },
  permissionBtnSecondary: {
    width: "100%", padding: "10px 24px", fontSize: 13, fontWeight: 500,
    background: "transparent", color: "#888", border: "1px solid #444",
    borderRadius: 8, cursor: "pointer",
  },
};
