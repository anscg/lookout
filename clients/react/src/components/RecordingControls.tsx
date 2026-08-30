import React from "react";
import type { RecorderStatus, CaptureMode } from "../types.js";
import { stopGuard } from "../hooks/stopGuard.js";
import { Button } from "../ui/Button.js";
import { colors, spacing, fontSize, fontWeight } from "../ui/theme.js";

export interface RecordingControlsProps {
  status: RecorderStatus;
  isSharing: boolean;
  onStartSharing: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  loading?: boolean;
  /** Capture mode — adjusts button labels. Defaults to "screen". */
  captureMode?: CaptureMode;
  /** Server-credited seconds. Pass it (with `displaySeconds`) to hold Stop
   *  back until the session has a minute worth compiling — see stopGuard.
   *  Omitted, Stop is always offered, which is what a custom recorder
   *  driving these buttons got before the gate existed. */
  trackedSeconds?: number;
  /** The on-screen clock, used only to count down to the unlock. */
  displaySeconds?: number;
}

export function RecordingControls({
  status,
  isSharing,
  onStartSharing,
  onPause,
  onResume,
  onStop,
  loading,
  captureMode = "screen",
  trackedSeconds,
  displaySeconds = 0,
}: RecordingControlsProps) {
  const isActive = status === "active" || status === "pending";
  const isPaused = status === "paused";
  const { canStop, reason } =
    trackedSeconds === undefined
      ? { canStop: true, reason: null }
      : stopGuard(trackedSeconds, displaySeconds);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: spacing.sm,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.md,
        justifyContent: "center",
        flexWrap: "wrap",
      }}>
        {!isSharing && isActive && (
          <Button variant="success" size="lg" onClick={onStartSharing} loading={loading}>
            {captureMode === "camera" ? "Start Camera & Record" : "Share Screen & Start Recording"}
          </Button>
        )}

        {!isSharing && isPaused && (
          <>
            <Button variant="primary" size="lg" onClick={onStartSharing} loading={loading}>
              {captureMode === "camera" ? "Start Camera & Resume" : "Share Screen & Resume"}
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={onStop}
              disabled={!canStop}
              title={reason ?? undefined}
            >
              Stop Session
            </Button>
          </>
        )}

        {isSharing && isActive && (
          <>
            <div style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: colors.status.danger,
              animation: "pulse 1.5s ease-in-out infinite",
            }} />
            <span style={{
              fontSize: fontSize.lg,
              fontWeight: fontWeight.semibold,
              color: colors.status.danger,
              marginRight: spacing.sm,
            }}>
              Recording
            </span>
            <Button variant="warning" size="md" onClick={onPause}>
              Pause
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={onStop}
              disabled={!canStop}
              title={reason ?? undefined}
            >
              Stop
            </Button>
          </>
        )}
      </div>

      {/* A disabled button with no explanation reads as broken. Only shown
          where a Stop button is actually on screen to be disabled. */}
      {reason && (isSharing || isPaused) && (
        <span style={{ fontSize: fontSize.sm, color: colors.text.secondary }}>
          {reason}
        </span>
      )}
    </div>
  );
}
