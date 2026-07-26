import { useState, useEffect, useRef } from "react";
import { api } from "../api/client.js";
import { formatTime } from "@lookout/react";
import { VideoPlayer, TimelapseEditor } from "@lookout/react";
import type { SessionStatus } from "@lookout/shared";

interface ResultProps {
  status: SessionStatus;
  trackedSeconds: number;
}

/** Hosted recorder result view. Also owns the post-compile cut editor:
 *  the edit affordance shows on completed sessions unless the embedding
 *  program disabled it with `?edit=false` on the recorder URL. */
export function Result({ status: statusProp, trackedSeconds }: ResultProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editable, setEditable] = useState(false);
  // After an edit is applied the parent's polling has already stopped, so
  // this view tracks the cut-compile itself: null = mirror the prop.
  const [localStatus, setLocalStatus] = useState<SessionStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const status = localStatus ?? statusProp;

  const editingAllowed =
    new URLSearchParams(window.location.search).get("edit") !== "false";

  useEffect(() => {
    if (status === "complete") {
      api
        .getVideo()
        .then((data) => {
          if (data.videoUrl && !data.videoUrl.startsWith("https://") && !data.videoUrl.startsWith("/")) {
            throw new Error("Invalid video URL: must be HTTPS.");
          }
          setVideoUrl(data.videoUrl);
        })
        .catch((err) =>
          setError(err instanceof Error ? err.message : "Failed to load video"),
        );
      if (editingAllowed) {
        api
          .getStatus()
          .then((s) => setEditable((s as { editable?: boolean }).editable === true))
          .catch(() => {});
      }
    }
  }, [status, editingAllowed]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const onApplied = () => {
    setEditing(false);
    setEditable(false);
    setVideoUrl(null);
    setLocalStatus("compiling");
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getStatus();
        if (s.status === "complete" || s.status === "failed") {
          clearInterval(pollRef.current);
          setLocalStatus(s.status);
        }
      } catch {
        // Ignore poll errors — next tick retries.
      }
    }, 3000);
  };

  if (editing) {
    return (
      <div style={{ ...styles.container, textAlign: "left" }}>
        <TimelapseEditor
          token={api.getToken()}
          apiBaseUrl=""
          onCancel={() => setEditing(false)}
          onApplied={onApplied}
        />
      </div>
    );
  }

  if (status === "stopped" || status === "compiling") {
    return (
      <div style={styles.container}>
        <div style={styles.spinner} />
        <h2 style={styles.title}>Compiling your timelapse...</h2>
        <p style={styles.subtitle}>
          This may take a moment. Tracked time: {formatTime(trackedSeconds)}
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
          Something went wrong while creating your timelapse. The team has been
          notified and it will be retried automatically.
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
          <div style={styles.videoContainer}>
            <VideoPlayer src={videoUrl} />
          </div>
        )}
        {editingAllowed && editable && (
          <button style={styles.editButton} onClick={() => setEditing(true)}>
            Edit timelapse
          </button>
        )}
      </div>
    );
  }

  return null;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    margin: "40px auto",
    padding: 24,
    textAlign: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: "#fff",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#888",
    marginBottom: 24,
  },
  videoContainer: {
    width: "100%",
    borderRadius: 8,
    background: "#000",
    overflow: "hidden",
  },
  editButton: {
    marginTop: 16,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#ccc",
    background: "transparent",
    border: "1px solid #444",
    borderRadius: 8,
    cursor: "pointer",
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
