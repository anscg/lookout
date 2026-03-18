import React from "react";
import { formatTime } from "../hooks/useSessionTimer.js";
import type { UploadState } from "../types.js";

export interface StatusBarProps {
  displaySeconds: number;
  screenshotCount: number;
  uploads: UploadState;
}

export function StatusBar({ displaySeconds, screenshotCount, uploads }: StatusBarProps) {
  return (
    <div style={styles.bar}>
      <div style={styles.time}>{formatTime(displaySeconds)}</div>
      <div style={styles.stats}>
        <span>{screenshotCount + uploads.completed} screenshots</span>
        {uploads.pending > 0 && (
          <span style={styles.pending}>{uploads.pending} uploading...</span>
        )}
        {uploads.failed > 0 && (
          <span style={styles.failed}>{uploads.failed} failed</span>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#1a1a1a",
    borderRadius: 8,
    marginBottom: 16,
  },
  time: {
    fontSize: 32,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: "#fff",
  },
  stats: { display: "flex", gap: 16, fontSize: 14, color: "#888" },
  pending: { color: "#f59e0b" },
  failed: { color: "#ef4444" },
};
