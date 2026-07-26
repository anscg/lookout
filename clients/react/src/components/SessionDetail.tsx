import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { StatusResponse, VideoResponse, SessionResponse } from "@lookout/shared";
import { formatTrackedTime } from "../hooks/useSessionTimer.js";
import { Button } from "../ui/Button.js";
import { ErrorDisplay } from "../ui/ErrorDisplay.js";
import { ProcessingState } from "./ProcessingState.js";
import { TimelapseEditor } from "./TimelapseEditor.js";
import { SessionDetailSkeleton } from "../ui/Skeleton.js";
import { Card } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { statusConfig, colors, spacing, fontSize, fontWeight, radii } from "../ui/theme.js";

export interface SessionDetailProps {
  token: string;
  apiBaseUrl: string;
  onBack?: () => void;
  onArchive?: () => void;
  /** Fired once when the session is observed transitioning to "complete"
   *  while this view is polling (i.e. the timelapse just finished compiling).
   *  NOT fired when opening a session that is already complete. Carries the
   *  session's redirect-hook URL, if one was set at creation. */
  onComplete?: (info: { redirectUrl: string | null }) => void;
  /** Override for the Edit button. When provided, clicking Edit calls this
   *  instead of opening the inline editor — e.g. the desktop app opens a
   *  dedicated resizable editor window (the main window is a fixed 480px). */
  onEdit?: () => void;
}

export function SessionDetail({
  token,
  apiBaseUrl,
  onBack,
  onArchive,
  onComplete,
  onEdit,
}: SessionDetailProps) {
  const [sessionInfo, setSessionInfo] = useState<{ name: string; createdAt: string } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [inputWidth, setInputWidth] = useState<number | null>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  // Springs can't interpolate values like "max(100%, 300px)", so measure the
  // text via the hidden mirror span and animate the input's width in pixels.
  // Widths account for the input's 1px borders and horizontal padding.
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const textWidth = el.getBoundingClientRect().width;
    setInputWidth(isRenaming ? Math.max(textWidth + 18, 300) : textWidth + 10);
  }, [isRenaming, editName, sessionInfo?.name]);

  // Apply the first measured width instantly so the name doesn't animate
  // open from the input's intrinsic size on mount.
  const prevInputWidth = useRef<number | null>(null);
  const isFirstWidth = prevInputWidth.current === null && inputWidth !== null;
  useEffect(() => {
    prevInputWidth.current = inputWidth;
  });
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Completion detection for the redirect hook: only a live transition from
  // an in-flight state counts — a session opened when already "complete"
  // must not re-fire. Refs (not state) so fetchStatus stays stable.
  const prevStatusRef = useRef<StatusResponse["status"] | null>(null);
  const completeFiredRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Fetch session info (name, createdAt) once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/sessions/${token}`);
        if (res.ok) {
          const data: SessionResponse = await res.json();
          setSessionInfo({ name: data.name, createdAt: data.createdAt });
        }
      } catch {
        // Non-fatal — name display is optional
      }
    })();
  }, [token, apiBaseUrl]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/sessions/${token}/status`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from /api/sessions/${token}/status\n${body.slice(0, 500)}`);
      }
      const data: StatusResponse = await res.json();
      setStatus(data);

      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = data.status;
      if (
        data.status === "complete" &&
        (prevStatus === "stopped" || prevStatus === "compiling") &&
        !completeFiredRef.current
      ) {
        completeFiredRef.current = true;
        onCompleteRef.current?.({ redirectUrl: data.redirectUrl ?? null });
      }

      // Fetch video URL when complete
      if (data.status === "complete" && !videoUrl) {
        try {
          const vRes = await fetch(`${apiBaseUrl}/api/sessions/${token}/video`);
          if (vRes.ok) {
            const v: VideoResponse = await vRes.json();
            setVideoUrl(v.videoUrl);
          }
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token, apiBaseUrl, videoUrl]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while compiling
  useEffect(() => {
    if (!status || !["stopped", "compiling"].includes(status.status)) return;
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [status?.status, fetchStatus]);

  const cardButtonStyle: React.CSSProperties = {
    background: colors.bg.surface,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radii.lg,
  };

  return (
    <div style={{ padding: spacing.lg }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg }}>
        {onBack && (
          <Button variant="secondary" size="sm" onClick={onBack} style={cardButtonStyle}>
            &larr; Back
          </Button>
        )}
        <div style={{ display: "flex", gap: spacing.sm }}>
          {status?.status === "complete" && status.editable && !editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => (onEdit ? onEdit() : setEditing(true))}
              style={cardButtonStyle}
            >
              Edit
            </Button>
          )}
          {onArchive && (
            <Button variant="secondary" size="sm" onClick={onArchive} style={cardButtonStyle}>
              Archive
            </Button>
          )}
        </div>
      </div>

      {error && (
        <ErrorDisplay error={error} variant="banner" title="Error" />
      )}

      {!status && !error && <SessionDetailSkeleton />}

      {status && editing && (
        <div style={{ marginBottom: spacing.lg }}>
          <TimelapseEditor
            token={token}
            apiBaseUrl={apiBaseUrl}
            onCancel={() => setEditing(false)}
            onApplied={() => {
              // Back to the detail view; the status poll below picks up
              // "compiling" and flips to the re-published video. Reset the
              // cached video URL so the edited MP4 is re-fetched.
              setEditing(false);
              setVideoUrl(null);
              setStatus((prev) =>
                prev ? { ...prev, status: "compiling" } : prev,
              );
              fetchStatus();
            }}
          />
        </div>
      )}

      {status && !editing && (
        <>
          {/* Video area */}
          <div style={{ marginBottom: spacing.lg, borderRadius: radii.lg, overflow: "hidden" }}>
            <ProcessingState
              status={status.status}
              trackedSeconds={status.trackedSeconds}
              videoUrl={videoUrl}
            />
          </div>

          {/* Session name + date */}
          {sessionInfo && (
            <div style={{ marginBottom: spacing.lg }}>
              <div style={{ display: "flex", alignItems: "center", gap: spacing.xs, height: 32 }}>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const newName = editName.trim();
                    if (newName && newName !== sessionInfo.name) {
                      try {
                        const res = await fetch(`${apiBaseUrl}/api/sessions/${token}/name`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: newName })
                        });
                        if (res.ok) {
                          setSessionInfo(prev => prev ? { ...prev, name: newName } : prev);
                        } else {
                          alert("Failed to rename session.");
                        }
                      } catch (err) {
                        alert("Error renaming session.");
                      }
                    }
                    setIsRenaming(false);
                    if (inputRef.current) inputRef.current.blur();
                  }}
                  style={{
                    margin: 0,
                    minWidth: 0,
                    maxWidth: "100%",
                    position: "relative"
                  }}
                >
                  <span
                    ref={measureRef}
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      visibility: "hidden",
                      whiteSpace: "pre",
                      fontFamily: "inherit",
                      fontSize: fontSize.xl,
                      fontWeight: fontWeight.bold,
                      pointerEvents: "none"
                    }}
                  >
                    {isRenaming ? editName || " " : sessionInfo.name}
                  </span>

                  <motion.input
                    ref={inputRef}
                    readOnly={!isRenaming}
                    value={isRenaming ? editName : sessionInfo.name}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => setIsRenaming(false)}
                    onDoubleClick={() => {
                      if (!isRenaming) {
                        setEditName(sessionInfo.name);
                        setIsRenaming(true);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setIsRenaming(false);
                        e.currentTarget.blur();
                      }
                    }}
                    size={1}
                    initial={false}
                    animate={{
                      width: inputWidth ?? "auto",
                      paddingLeft: isRenaming ? 8 : 0,
                      paddingRight: 8
                    }}
                    transition={isFirstWidth ? { duration: 0 } : { type: "spring", stiffness: 550, damping: 38 }}
                    style={{
                      display: "block",
                      minWidth: 0,
                      maxWidth: "100%",
                      height: 32,
                      fontFamily: "inherit",
                      fontSize: fontSize.xl,
                      fontWeight: fontWeight.bold,
                      color: colors.text.primary,
                      backgroundColor: isRenaming ? colors.bg.surface : "transparent",
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderColor: isRenaming ? colors.border.selected : "transparent",
                      transition: "background-color 0.15s ease, border-color 0.15s ease",
                      borderRadius: radii.md,
                      boxSizing: "border-box",
                      outline: "none",
                      cursor: isRenaming ? "text" : "default",
                      transformOrigin: "left center"
                    }}
                  />
                </form>

                <div style={{ display: "flex", alignItems: "center", width: 24, height: 24 }}>
                  <AnimatePresence initial={false}>
                    {!isRenaming && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{
                          opacity: 1,
                          scale: 1,
                          transition: { type: "spring", stiffness: 500, damping: 28 }
                        }}
                        exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.1 } }}
                        title="Rename session"
                        onClick={() => {
                          setEditName(sessionInfo.name);
                          setIsRenaming(true);
                        }}
                        onMouseDown={(e) => e.currentTarget.style.transform = "scale(0.9)"}
                        onMouseUp={(e) => e.currentTarget.style.transform = "none"}
                        onMouseLeave={(e) => e.currentTarget.style.transform = "none"}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          margin: -5,
                          color: colors.text.tertiary,
                          display: "flex",
                          alignItems: "center",
                          transition: "transform 0.1s ease-in-out"
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                        </svg>
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              <motion.div
                animate={{ y: isRenaming ? 0 : -4 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                style={{ fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2, y: -4 }}
              >
                {new Date(sessionInfo.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </motion.div>
            </div>
          )}

          {/* Stats */}
          <div style={{ display: "flex", gap: spacing.lg, justifyContent: "center" }}>
            <Card padding={`${spacing.md}px ${spacing.xxl}px`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.xs }}>
              <span style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text.primary, height: 32, display: "flex", alignItems: "center" }}>
                {formatTrackedTime(status.trackedSeconds)}
              </span>
              <span style={{ fontSize: fontSize.xs, color: colors.text.tertiary }}>Tracked time</span>
            </Card>
            <Card padding={`${spacing.md}px ${spacing.xxl}px`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.xs }}>
              <div style={{ height: 32, display: "flex", alignItems: "center" }}>
                <Badge status={status.status} variant="inline" size="lg" />
              </div>
              <span style={{ fontSize: fontSize.xs, color: colors.text.tertiary }}>Status</span>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
