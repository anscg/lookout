import React from "react";
import { useCollapse } from "../hooks/useCollapse.js";
import { StatusBar } from "./StatusBar.js";
import { ScreenPreview } from "./ScreenPreview.js";
import { RecordingControls } from "./RecordingControls.js";
import { ResultView } from "./ResultView.js";

/**
 * Drop-in recorder widget. Handles the full lifecycle:
 * screen sharing, capture, upload, pause/resume/stop, compilation, video playback.
 *
 * Must be used within a `<CollapseProvider>`.
 */
export function CollapseRecorder() {
  const { state, actions } = useCollapse();

  if (state.status === "loading") {
    return (
      <div style={styles.center}>
        <p style={styles.text}>Loading session...</p>
      </div>
    );
  }

  if (state.status === "no-token") {
    return (
      <div style={styles.center}>
        <h2 style={styles.heading}>No session token</h2>
        <p style={styles.text}>
          This page requires a session token. You should have been redirected
          here from another service.
        </p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div style={styles.center}>
        <h2 style={{ ...styles.heading, color: "#ef4444" }}>Error</h2>
        <p style={styles.text}>{state.error}</p>
      </div>
    );
  }

  // Terminal states: show result view
  if (
    state.status === "stopped" ||
    state.status === "compiling" ||
    state.status === "complete" ||
    state.status === "failed"
  ) {
    return (
      <ResultView
        status={state.status}
        trackedSeconds={state.trackedSeconds}
      />
    );
  }

  // Recording states: pending, active, paused
  return (
    <div style={styles.container}>
      <StatusBar
        displaySeconds={state.displaySeconds}
        screenshotCount={state.screenshotCount}
        uploads={state.uploads}
      />
      <ScreenPreview imageUrl={state.lastScreenshotUrl} />
      <RecordingControls
        status={state.status}
        isSharing={state.isSharing}
        onStartSharing={actions.startSharing}
        onPause={actions.pause}
        onResume={actions.resume}
        onStop={actions.stop}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 800, margin: "40px auto", padding: 24 },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: 24,
  },
  heading: { fontSize: 24, fontWeight: 700, color: "#fff", marginBottom: 8 },
  text: { fontSize: 16, color: "#888", textAlign: "center", maxWidth: 400 },
};
