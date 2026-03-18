import React, { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CaptureSource } from "../hooks/useNativeCapture.js";

interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  isBuiltin: boolean;
  scaleFactor: number;
}

interface WindowInfo {
  id: number;
  appName: string;
  title: string;
  width: number;
  height: number;
  isMinimized: boolean;
  isFocused: boolean;
}

interface CaptureSourceList {
  monitors: MonitorInfo[];
  windows: WindowInfo[];
}

interface SourcePickerProps {
  onSelect: (source: CaptureSource) => void;
}

export function SourcePicker({ onSelect }: SourcePickerProps) {
  const [sources, setSources] = useState<CaptureSourceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"monitors" | "windows">("monitors");

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<CaptureSourceList>("list_capture_sources");
      setSources(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) {
    return (
      <div style={styles.center}>
        <h2 style={styles.heading}>Failed to list sources</h2>
        <p style={styles.errorText}>{error}</p>
        <button style={styles.retryBtn} onClick={refresh}>Retry</button>
      </div>
    );
  }

  if (!sources) {
    return (
      <div style={styles.center}>
        <p style={styles.text}>Loading capture sources...</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Select what to capture</h2>
      <p style={styles.subtext}>Choose a screen or window to record</p>

      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          style={tab === "monitors" ? styles.tabActive : styles.tab}
          onClick={() => setTab("monitors")}
        >
          Screens ({sources.monitors.length})
        </button>
        <button
          style={tab === "windows" ? styles.tabActive : styles.tab}
          onClick={() => setTab("windows")}
        >
          Windows ({sources.windows.length})
        </button>
        <button style={styles.refreshBtn} onClick={refresh} title="Refresh">
          &#x21bb;
        </button>
      </div>

      {/* Source list */}
      <div style={styles.list}>
        {tab === "monitors" && sources.monitors.map((m) => (
          <button
            key={m.id}
            style={styles.sourceItem}
            onClick={() => onSelect({ type: "monitor", id: m.id })}
          >
            <div style={styles.sourceIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div style={styles.sourceInfo}>
              <span style={styles.sourceName}>
                {m.name}
                {m.isPrimary && <span style={styles.badge}>Primary</span>}
                {m.isBuiltin && <span style={styles.badgeSecondary}>Built-in</span>}
              </span>
              <span style={styles.sourceMeta}>
                {m.width}x{m.height}
                {m.scaleFactor > 1 && ` @ ${m.scaleFactor}x`}
              </span>
            </div>
            <span style={styles.arrow}>&rsaquo;</span>
          </button>
        ))}

        {tab === "windows" && sources.windows.length === 0 && (
          <p style={{ ...styles.text, padding: 20 }}>No capturable windows found.</p>
        )}

        {tab === "windows" && sources.windows.map((w) => (
          <button
            key={w.id}
            style={{
              ...styles.sourceItem,
              ...(w.isMinimized ? { opacity: 0.5 } : {}),
            }}
            onClick={() => onSelect({ type: "window", id: w.id })}
          >
            <div style={styles.sourceIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <circle cx="7" cy="6" r="1" fill="currentColor" />
                <circle cx="10" cy="6" r="1" fill="currentColor" />
              </svg>
            </div>
            <div style={styles.sourceInfo}>
              <span style={styles.sourceName}>
                {w.appName}
                {w.isFocused && <span style={styles.badge}>Focused</span>}
                {w.isMinimized && <span style={styles.badgeSecondary}>Minimized</span>}
              </span>
              <span style={styles.sourceMeta}>
                {w.title || "(untitled)"} — {w.width}x{w.height}
              </span>
            </div>
            <span style={styles.arrow}>&rsaquo;</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 480, margin: "20px auto", padding: 16 },
  center: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "100vh", padding: 24,
  },
  heading: {
    fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 4, textAlign: "center",
  },
  subtext: {
    fontSize: 13, color: "#888", marginBottom: 16, textAlign: "center",
  },
  text: { fontSize: 14, color: "#888", textAlign: "center" },
  errorText: { fontSize: 13, color: "#fca5a5", textAlign: "center", marginBottom: 12 },
  retryBtn: {
    padding: "8px 20px", fontSize: 13, fontWeight: 600,
    background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
  },
  tabs: {
    display: "flex", gap: 4, marginBottom: 12, background: "#1a1a1a",
    borderRadius: 8, padding: 4,
  },
  tab: {
    flex: 1, padding: "8px 12px", fontSize: 13, fontWeight: 500,
    background: "transparent", color: "#888", border: "none",
    borderRadius: 6, cursor: "pointer",
  },
  tabActive: {
    flex: 1, padding: "8px 12px", fontSize: 13, fontWeight: 600,
    background: "#333", color: "#fff", border: "none",
    borderRadius: 6, cursor: "pointer",
  },
  refreshBtn: {
    padding: "8px 10px", fontSize: 16, background: "transparent",
    color: "#888", border: "none", cursor: "pointer", borderRadius: 6,
  },
  list: {
    display: "flex", flexDirection: "column", gap: 4,
    maxHeight: 400, overflowY: "auto",
  },
  sourceItem: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "12px 14px", background: "#1a1a1a", border: "1px solid #333",
    borderRadius: 8, cursor: "pointer", textAlign: "left" as const,
    transition: "border-color 0.15s",
    width: "100%",
  },
  sourceIcon: { color: "#888", flexShrink: 0 },
  sourceInfo: {
    flex: 1, display: "flex", flexDirection: "column" as const, gap: 2,
    minWidth: 0,
  },
  sourceName: {
    fontSize: 13, fontWeight: 600, color: "#fff",
    display: "flex", alignItems: "center", gap: 6,
  },
  sourceMeta: {
    fontSize: 11, color: "#666", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
  },
  badge: {
    fontSize: 10, fontWeight: 600, color: "#22c55e",
    background: "rgba(34,197,94,0.15)", padding: "1px 6px",
    borderRadius: 4,
  },
  badgeSecondary: {
    fontSize: 10, fontWeight: 500, color: "#888",
    background: "rgba(136,136,136,0.15)", padding: "1px 6px",
    borderRadius: 4,
  },
  arrow: { fontSize: 20, color: "#555", flexShrink: 0 },
};
