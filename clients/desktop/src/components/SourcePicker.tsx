import React, { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CaptureSource } from "../hooks/useNativeCapture.js";
import { useScreenPreview } from "../hooks/useScreenPreview.js";

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
  submitLabel?: string;
}

function sourcesEqual(a: CaptureSource | null, b: CaptureSource | null): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id;
}

export function SourcePicker({ onSelect, submitLabel = "Start Capture" }: SourcePickerProps) {
  const [sources, setSources] = useState<CaptureSourceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"screens" | "windows">("screens");
  const [selected, setSelected] = useState<CaptureSource | null>(null);

  // Live preview of currently selected source
  const { previewUrl } = useScreenPreview(selected, 1500);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<CaptureSourceList>("list_capture_sources");
      setSources(result);
      setError(null);

      // Auto-select primary monitor if nothing selected yet
      if (!selected) {
        const primary = result.monitors.find((m) => m.isPrimary) ?? result.monitors[0];
        if (primary) {
          setSelected({ type: "monitor", id: primary.id });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selected]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) {
    return (
      <div style={styles.center}>
        <h2 style={styles.heading}>Failed to detect displays</h2>
        <p style={styles.errorText}>{error}</p>
        <button style={styles.retryBtn} onClick={refresh}>Retry</button>
      </div>
    );
  }

  if (!sources) {
    return (
      <div style={styles.center}>
        <p style={styles.text}>Detecting displays...</p>
      </div>
    );
  }

  const hasWindows = sources.windows.length > 0;

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>What should Collapse capture?</h2>

      {/* Live preview */}
      <div style={styles.previewWrap}>
        {previewUrl ? (
          <img src={previewUrl} alt="Preview" style={styles.previewImg} />
        ) : (
          <div style={styles.previewPlaceholder}>
            <p style={styles.previewPlaceholderText}>
              {selected ? "Capturing preview..." : "Select a source below"}
            </p>
          </div>
        )}
      </div>

      {/* Tabs */}
      {hasWindows && (
        <div style={styles.tabs}>
          <button
            style={tab === "screens" ? styles.tabActive : styles.tab}
            onClick={() => setTab("screens")}
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
      )}

      {/* Source list */}
      <div style={styles.list}>
        {(tab === "screens" || !hasWindows) &&
          sources.monitors.map((m) => {
            const src: CaptureSource = { type: "monitor", id: m.id };
            const isSelected = sourcesEqual(selected, src);
            return (
              <button
                key={`m-${m.id}`}
                style={{
                  ...styles.sourceItem,
                  ...(isSelected ? styles.sourceItemSelected : {}),
                }}
                onClick={() => setSelected(src)}
              >
                <div style={{
                  ...styles.radio,
                  ...(isSelected ? styles.radioSelected : {}),
                }}>
                  {isSelected && <div style={styles.radioDot} />}
                </div>
                <div style={styles.sourceInfo}>
                  <span style={styles.sourceName}>
                    {m.name}
                    {m.isPrimary && <span style={styles.badge}>Primary</span>}
                  </span>
                  <span style={styles.sourceMeta}>
                    {m.width}x{m.height}
                    {m.scaleFactor > 1 && ` @ ${m.scaleFactor}x`}
                  </span>
                </div>
              </button>
            );
          })}

        {tab === "windows" && hasWindows &&
          sources.windows.map((w) => {
            const src: CaptureSource = { type: "window", id: w.id };
            const isSelected = sourcesEqual(selected, src);
            return (
              <button
                key={`w-${w.id}`}
                style={{
                  ...styles.sourceItem,
                  ...(isSelected ? styles.sourceItemSelected : {}),
                  ...(w.isMinimized ? { opacity: 0.5 } : {}),
                }}
                onClick={() => setSelected(src)}
              >
                <div style={{
                  ...styles.radio,
                  ...(isSelected ? styles.radioSelected : {}),
                }}>
                  {isSelected && <div style={styles.radioDot} />}
                </div>
                <div style={styles.sourceInfo}>
                  <span style={styles.sourceName}>
                    {w.appName || w.title}
                    {w.isMinimized && <span style={styles.badgeDim}>Minimized</span>}
                  </span>
                  <span style={styles.sourceMeta}>
                    {w.title && w.appName ? w.title + " — " : ""}
                    {w.width}x{w.height}
                  </span>
                </div>
              </button>
            );
          })}
      </div>

      {/* Start button */}
      {selected && (
        <button
          style={styles.startBtn}
          onClick={() => onSelect(selected)}
        >
          {submitLabel}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 480, margin: "0 auto", padding: 16 },
  center: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: 200, padding: 24,
  },
  heading: {
    fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 12, textAlign: "center",
  },
  text: { fontSize: 14, color: "#888", textAlign: "center" },
  errorText: { fontSize: 13, color: "#fca5a5", textAlign: "center", marginBottom: 12 },
  retryBtn: {
    padding: "8px 20px", fontSize: 13, fontWeight: 600,
    background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
  },

  // Preview
  previewWrap: {
    borderRadius: 10, overflow: "hidden", background: "#111",
    border: "1px solid #333", marginBottom: 14, aspectRatio: "16/9",
  },
  previewImg: {
    width: "100%", height: "100%", objectFit: "contain", display: "block",
  },
  previewPlaceholder: {
    width: "100%", height: "100%", display: "flex",
    alignItems: "center", justifyContent: "center",
  },
  previewPlaceholderText: { fontSize: 13, color: "#555", textAlign: "center" },

  // Tabs
  tabs: {
    display: "flex", gap: 4, marginBottom: 10, background: "#1a1a1a",
    borderRadius: 8, padding: 4,
  },
  tab: {
    flex: 1, padding: "7px 10px", fontSize: 12, fontWeight: 500,
    background: "transparent", color: "#888", border: "none",
    borderRadius: 6, cursor: "pointer",
  },
  tabActive: {
    flex: 1, padding: "7px 10px", fontSize: 12, fontWeight: 600,
    background: "#333", color: "#fff", border: "none",
    borderRadius: 6, cursor: "pointer",
  },
  refreshBtn: {
    padding: "7px 10px", fontSize: 14, background: "transparent",
    color: "#888", border: "none", cursor: "pointer", borderRadius: 6,
  },

  // Source list
  list: {
    display: "flex", flexDirection: "column", gap: 4,
    maxHeight: 280, overflowY: "auto",
  },
  sourceItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 12px", background: "#1a1a1a", border: "1px solid #333",
    borderRadius: 8, cursor: "pointer", textAlign: "left" as const,
    width: "100%", transition: "border-color 0.15s",
  },
  sourceItemSelected: {
    borderColor: "#3b82f6",
    background: "rgba(59,130,246,0.08)",
  },

  // Radio button
  radio: {
    width: 18, height: 18, borderRadius: "50%",
    border: "2px solid #555", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  radioSelected: {
    borderColor: "#3b82f6",
  },
  radioDot: {
    width: 8, height: 8, borderRadius: "50%",
    background: "#3b82f6",
  },

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
  badgeDim: {
    fontSize: 10, fontWeight: 500, color: "#888",
    background: "rgba(136,136,136,0.15)", padding: "1px 6px",
    borderRadius: 4,
  },

  // Start button
  startBtn: {
    width: "100%", padding: "14px 24px", fontSize: 15, fontWeight: 600,
    background: "#3b82f6", color: "#fff", border: "none", borderRadius: 10,
    cursor: "pointer", marginTop: 14,
  },
};
