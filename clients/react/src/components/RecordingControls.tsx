import React from "react";
import type { RecorderStatus } from "../types.js";

export interface RecordingControlsProps {
  status: RecorderStatus;
  isSharing: boolean;
  onStartSharing: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function RecordingControls({
  status,
  isSharing,
  onStartSharing,
  onPause,
  onResume,
  onStop,
}: RecordingControlsProps) {
  const isActive = status === "active" || status === "pending";
  const isPaused = status === "paused";

  return (
    <div style={styles.controls}>
      {!isSharing && isActive && (
        <button style={styles.startBtn} onClick={onStartSharing}>
          Share Screen & Start Recording
        </button>
      )}

      {!isSharing && isPaused && (
        <>
          <button style={styles.resumeBtn} onClick={onStartSharing}>
            Share Screen & Resume
          </button>
          <button style={styles.stopBtn} onClick={onStop}>
            Stop Session
          </button>
        </>
      )}

      {isSharing && isActive && (
        <>
          <div style={styles.recordingDot} />
          <span style={styles.recordingText}>Recording</span>
          <button style={styles.pauseBtn} onClick={onPause}>
            Pause
          </button>
          <button style={styles.stopBtn} onClick={onStop}>
            Stop
          </button>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  controls: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    justifyContent: "center",
    flexWrap: "wrap",
  },
  startBtn: {
    padding: "14px 28px",
    fontSize: 16,
    fontWeight: 600,
    background: "#22c55e",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  pauseBtn: {
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    background: "#f59e0b",
    color: "#000",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  resumeBtn: {
    padding: "14px 28px",
    fontSize: 16,
    fontWeight: 600,
    background: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  stopBtn: {
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    background: "#ef4444",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#ef4444",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  recordingText: {
    fontSize: 14,
    fontWeight: 600,
    color: "#ef4444",
    marginRight: 8,
  },
};
