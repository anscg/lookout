import React, { useState, useEffect } from "react";
import { useCollapseContext } from "../CollapseProvider.js";
import { formatTime } from "../hooks/useSessionTimer.js";
import type { RecorderStatus } from "../types.js";

export interface ResultViewProps {
  status: RecorderStatus;
  trackedSeconds: number;
}

export function ResultView({ status, trackedSeconds }: ResultViewProps) {
  const { client, config } = useCollapseContext();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "complete") {
      client
        .getVideo()
        .then((data) => {
          setVideoUrl(data.videoUrl);
          config.callbacks.onComplete?.({ videoUrl: data.videoUrl });
        })
        .catch((err) =>
          setError(err instanceof Error ? err.message : "Failed to load video"),
        );
    }
  }, [status, client, config.callbacks]);

  if (status === "stopped" || status === "compiling") {
    return (
      <div style={styles.container}>
        <div style={styles.spinner} />
        <h2 style={styles.title}>Compiling your timelapse...</h2>
        <p style={styles.subtitle}>
          Tracked time: {formatTime(trackedSeconds)}
        </p>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div style={styles.container}>
        <h2 style={{ ...styles.title, color: "#ef4444" }}>
          Compilation failed
        </h2>
        <p style={styles.subtitle}>
          Something went wrong. It will be retried automatically.
        </p>
      </div>
    );
  }

  if (status === "complete") {
    return (
      <div style={styles.container}>
        <h2 style={styles.title}>Your timelapse is ready!</h2>
        <p style={styles.subtitle}>
          Tracked time: {formatTime(trackedSeconds)}
        </p>
        {error && <p style={{ color: "#ef4444" }}>{error}</p>}
        {videoUrl && (
          <video src={videoUrl} controls autoPlay style={styles.video} />
        )}
      </div>
    );
  }

  return null;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 800,
    margin: "40px auto",
    padding: 24,
    textAlign: "center",
  },
  title: { fontSize: 24, fontWeight: 700, color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 16, color: "#888", marginBottom: 24 },
  video: {
    width: "100%",
    maxWidth: 800,
    borderRadius: 8,
    background: "#000",
  },
  spinner: {
    width: 40,
    height: 40,
    border: "4px solid #333",
    borderTop: "4px solid #3b82f6",
    borderRadius: "50%",
    margin: "0 auto 16px",
    animation: "spin 1s linear infinite",
  },
};
