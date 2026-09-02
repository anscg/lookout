import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { StatusResponse, VideoResponse, SessionResponse } from "@lookout/shared";
import { formatTrackedTime } from "../hooks/useSessionTimer.js";
import { Button } from "../ui/Button.js";
import { ProgressRing } from "../ui/ProgressRing.js";
import { Overlay } from "../ui/Overlay.js";
import { ErrorDisplay } from "../ui/ErrorDisplay.js";
import { ProcessingState } from "./ProcessingState.js";
import { TimelapseEditor } from "./TimelapseEditor.js";
import { createLookoutClient, HttpError, type LookoutClient } from "../api/client.js";
import { useEditLease } from "../hooks/useEditLease.js";
import { estimateBuildProgress } from "../hooks/buildProgress.js";
import { SessionDetailSkeleton } from "../ui/Skeleton.js";
import { Card } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { statusConfig, colors, spacing, fontSize, fontWeight, radii } from "../ui/theme.js";

/**
 * Shown while a session sits in its edit hold: compiled, but deliberately
 * unpublished so the owner can cut it before anything downstream consumes
 * it. Both exits are one click, and doing nothing publishes it anyway —
 * the hold can delay publication, never cancel it.
 */
function HoldPanel({
  editable,
  progress,
  client,
  onEdit,
  onPublish,
}: {
  editable: boolean;
  /** Real compile progress from /status, when the worker is reporting it.
   *  Null/undefined → fall back to the time estimate. */
  progress?: number | null;
  client: LookoutClient;
  onEdit: () => void;
  onPublish: () => void | Promise<void>;
}) {
  const [publishing, setPublishing] = useState(false);
  // Sitting on this panel counts as still deciding, so it holds the lease
  // too. Without this, reading the panel for a couple of minutes would
  // publish the timelapse out from under the person reading it.
  useEditLease(client, !publishing);

  // Real worker progress wins when present; otherwise ease along the same
  // asymptotic time estimate the editor uses. Either way the `editable` flip
  // is what actually ends the wait, and the ring stays monotonic.
  const [buildProgress, setBuildProgress] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const sawRealRef = useRef(false);
  useEffect(() => {
    if (typeof progress !== "number") return;
    sawRealRef.current = true;
    setBuildProgress((prev) => Math.max(prev, progress));
  }, [progress]);
  useEffect(() => {
    if (editable) return;
    // Anchor the start once; a re-run must never rewind the ring.
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const startedAt = startedAtRef.current;
    const tick = () => {
      // Once real progress has arrived it owns the ring — don't let the
      // estimate race ahead of ground truth.
      if (sawRealRef.current) return;
      setBuildProgress((prev) =>
        Math.max(prev, estimateBuildProgress(Date.now() - startedAt, 30_000)),
      );
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [editable]);

  return (
    <Card padding={spacing.lg} style={{ marginBottom: spacing.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.lg }}>
        {!editable && (
          <ProgressRing size={48} strokeWidth={4} progress={buildProgress} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text.primary }}>
            {editable ? "Ready to review" : "Preparing your timelapse…"}
          </div>
          <div
            style={{
              fontSize: fontSize.md,
              color: colors.text.secondary,
              marginTop: spacing.xs,
            }}
          >
            {editable
              ? "Cut out anything you don't want to share, then save. Nothing is published until you do."
              : "Your recording is compiling. You'll be able to trim it in a moment."}
            {" "}
            <span style={{ color: colors.text.tertiary }}>
              If you close Lookout, it publishes as recorded.
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.lg }}>
        <Button variant="primary" size="md" onClick={onEdit} disabled={!editable || publishing}>
          Edit &amp; save
        </Button>
        <Button
          variant="secondary"
          size="md"
          loading={publishing}
          onClick={async () => {
            setPublishing(true);
            try {
              await onPublish();
            } finally {
              setPublishing(false);
            }
          }}
        >
          Publish as recorded
        </Button>
      </div>
    </Card>
  );
}

export interface SessionDetailProps {
  token: string;
  apiBaseUrl: string;
  onBack?: () => void;
  /**
   * Draw the in-content back button. Hosts with somewhere better to put it
   * — the Linux desktop build lifts it into the window's header bar — pass
   * false and drive `onBack` from there.
   */
  showBack?: boolean;
  onArchive?: () => void;
  /** Fired once when the session is observed transitioning to "complete"
   *  while this view is polling (i.e. the timelapse just finished compiling).
   *  NOT fired when opening a session that is already complete. Carries the
   *  session's redirect-hook URL, if one was set at creation. */
  onComplete?: (info: { redirectUrl: string | null; panelUrl?: string | null }) => void;
   /**
   * Fired once per mount when the recording is over and the session is no
   * longer being captured — saved, compiling, or already compiled.
   *
   * Deliberately NOT gated on observing the transition. The recorder navigates
   * here *after* it has stopped the session, so the first poll this view ever
   * makes already says `stopped` — a transition-gated callback would never
   * fire for the one case it exists to serve. Whether the host should act more
   * than once is the host's business, tracked by the host.
   *
   * Skipped while an edit hold is active: the user is on their way to the
   * editor, and the handoff belongs after they publish from there.
   *
   * Distinct from `onComplete`, which waits for the compile. A host that wants
   * to collect something from the user should do it here instead — compiling
   * can take many minutes and there is no reason to make anyone watch a
   * progress bar before answering a question.
   */
  onRecordingFinished?: (info: {
    redirectUrl: string | null;
    panelUrl?: string | null;
    panelResolved?: boolean;
    status: StatusResponse["status"];
  }) => void;
  /**
   * Host-supplied content rendered between the video and the session name.
   * The desktop app puts a program's outstanding panel request here; the web
   * SDK leaves it empty. Kept as a slot rather than a feature so this shared
   * component stays unaware of what the host wants to say.
   */
  belowVideo?: ReactNode;
  /**
   * Host content pinned to the right-hand end of the name/date row — the
   * desktop app puts a program's "Open in …" link there. A slot rather than a
   * feature, so this shared component needn't know what the host wants to
   * offer.
   */
  titleAction?: ReactNode;
  /** Override for the Edit button. When provided, clicking Edit calls this
   *  instead of opening the inline editor — e.g. the desktop app opens a
   *  dedicated resizable editor window (the main window is a fixed 480px). */
  onEdit?: () => void;
  /** Bring your own API client (see `LookoutProviderProps.client`).
   *  Defaults to the fetch client for `apiBaseUrl` + `token`. */
  client?: LookoutClient;
}

export function SessionDetail({
  token,
  apiBaseUrl,
  onBack,
  showBack = true,
  onArchive,
  onComplete,
  onRecordingFinished,
  onEdit,
  belowVideo,
  titleAction,
  client: clientProp,
}: SessionDetailProps) {
  const [sessionInfo, setSessionInfo] = useState<{ name: string; createdAt: string } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isRenamingAnim, setIsRenamingAnim] = useState(false);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setIsRenamingAnim(true);
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    } else {
      // Small delay before showing icon again to let layout animations finish
      const t = setTimeout(() => setIsRenamingAnim(false), 600);
      return () => clearTimeout(t);
    }
  }, [isRenaming]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const client = useMemo(
    () => clientProp ?? createLookoutClient({ baseUrl: apiBaseUrl, token }),
    [clientProp, apiBaseUrl, token],
  );

  // Completion detection for the redirect hook: only a live transition from
  // an in-flight state counts — a session opened when already "complete"
  // must not re-fire. Refs (not state) so fetchStatus stays stable.
  const prevStatusRef = useRef<StatusResponse["status"] | null>(null);
  const completeFiredRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const finishedFiredRef = useRef(false);
  const onRecordingFinishedRef = useRef(onRecordingFinished);
  onRecordingFinishedRef.current = onRecordingFinished;

  // Fetch session info (name, createdAt) once
  useEffect(() => {
    (async () => {
      try {
        const data: SessionResponse = await client.getSession();
        setSessionInfo({ name: data.name, createdAt: data.createdAt });
      } catch {
        // Non-fatal — name display is optional
      }
    })();
  }, [client]);

  const fetchStatus = useCallback(async () => {
    try {
      const data: StatusResponse = await client.getStatus();
      setStatus(data);

      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = data.status;

      // The recording is over. Held sessions are skipped — their handoff is
      // after the editor publishes, not while the user is still deciding what
      // to cut.
      const finishedRecording =
        data.status === "stopped" ||
        data.status === "compiling" ||
        data.status === "complete";
      const held = Boolean(data.editHoldUntil) && data.status !== "failed";
      if (finishedRecording && !held && !finishedFiredRef.current) {
        finishedFiredRef.current = true;
        onRecordingFinishedRef.current?.({
          redirectUrl: data.redirectUrl ?? null,
          panelUrl: data.panelUrl ?? null,
          panelResolved: data.panelResolved,
          status: data.status,
        });
      }

      if (
        data.status === "complete" &&
        (prevStatus === "stopped" || prevStatus === "compiling") &&
        !completeFiredRef.current
      ) {
        completeFiredRef.current = true;
        onCompleteRef.current?.({
          redirectUrl: data.redirectUrl ?? null,
          panelUrl: data.panelUrl ?? null,
        });
      }

      // Fetch video URL when complete
      if (data.status === "complete" && !videoUrl) {
        try {
          const v: VideoResponse = await client.getVideo();
          setVideoUrl(v.videoUrl);
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, videoUrl]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while compiling
  useEffect(() => {
    if (!status || !["stopped", "compiling"].includes(status.status)) return;
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [status?.status, fetchStatus]);

  // A live edit hold owns the view: the review panel replaces the compile
  // spinner. A failed compile is not a hold worth waiting on, even if the
  // deadline hasn't passed yet — show the normal failure state instead.
  const inHold = Boolean(status?.editHoldUntil) && status?.status !== "failed";

  const cardButtonStyle: React.CSSProperties = {
    background: colors.bg.surface,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radii.lg,
  };

  return (
    <div style={{ padding: spacing.lg }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg }}>
        {onBack && showBack && (
          <Button variant="secondary" size="sm" onClick={onBack} style={cardButtonStyle}>
            &larr; Back
          </Button>
        )}
        <div style={{ display: "flex", gap: spacing.sm }}>
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
        // Same overlay the recorder uses, so editing looks and behaves
        // identically wherever it's entered from.
        <Overlay label="Review your timelapse" height="min(820px, 92vh)">
          <div style={{ flex: "1 1 auto", minHeight: 0, padding: spacing.xl }}>
          <TimelapseEditor
            token={token}
            apiBaseUrl={apiBaseUrl}
            client={client}
            onCancel={() => setEditing(false)}
            onApplied={() => {
              // Publishing flips the session compiling → complete (or
              // straight to complete when there were no cuts); the poll
              // below picks it up. Drop the cached URL so the published
              // MP4 is re-fetched.
              setEditing(false);
              setVideoUrl(null);
              fetchStatus();
            }}
          />
          </div>
        </Overlay>
      )}

      {/* Edit hold: the recording is compiled but deliberately not
          published yet, so this is the user's one chance to cut it. */}
      {status && !editing && inHold && (
        <HoldPanel
          editable={status.editable === true}
          progress={status.progress}
          client={client}
          onEdit={() => (onEdit ? onEdit() : setEditing(true))}
          onPublish={async () => {
            try {
              await client.applyCuts();
            } catch {
              // Non-fatal: the hold publishes on its own if this fails.
            }
            fetchStatus();
          }}
        />
      )}

      {status && (
        <>
          {/* Video area. Suppressed during an edit hold: the session reads
              as "stopped", but showing a compile spinner under a panel that
              says "ready to review" would contradict it. */}
          {!inHold && (
            <div style={{ marginBottom: spacing.lg, borderRadius: radii.lg, overflow: "hidden" }}>
              <ProcessingState
                status={status.status}
                trackedSeconds={status.trackedSeconds}
                videoUrl={videoUrl}
              />
            </div>
          )}

          {belowVideo}

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
                        await client.rename(newName);
                        setSessionInfo(prev => prev ? { ...prev, name: newName } : prev);
                      } catch (err) {
                        alert(
                          err instanceof HttpError
                            ? "Failed to rename session."
                            : "Error renaming session.",
                        );
                      }
                    }
                    setIsRenaming(false);
                    if (inputRef.current) inputRef.current.blur();
                  }}
                  style={{
                    display: "grid",
                    alignItems: "center",
                    margin: 0
                  }}
                >
                  <motion.span
                    animate={{
                      padding: isRenaming ? "0 16px" : "0 8px 0 0"
                    }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    style={{
                      gridArea: "1 / 1",
                      visibility: "hidden",
                      whiteSpace: "pre",
                      fontFamily: "inherit",
                      fontSize: fontSize.xl,
                      fontWeight: fontWeight.bold,
                      pointerEvents: "none"
                    }}
                  >
                    {isRenaming ? editName || " " : sessionInfo.name}
                  </motion.span>

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
                    animate={{
                      padding: isRenaming ? "0 8px" : "0",
                      width: isRenaming ? "max(100%, 300px)" : "100%",
                      backgroundColor: isRenaming ? colors.bg.surface : "transparent",
                      borderColor: isRenaming ? colors.border.selected : "transparent"
                    }}
                    transition={{
                      padding: { type: "spring", stiffness: 500, damping: 30 },
                      width: { type: "spring", stiffness: 500, damping: 30 },
                      backgroundColor: { duration: 0.15 },
                      borderColor: { duration: 0.15 }
                    }}
                    style={{
                      gridArea: "1 / 1",
                      minWidth: 0,
                      height: 32,
                      fontFamily: "inherit",
                      fontSize: fontSize.xl,
                      fontWeight: fontWeight.bold,
                      color: colors.text.primary,
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderRadius: radii.md,
                      boxSizing: "border-box",
                      outline: "none",
                      cursor: isRenaming ? "text" : "default",
                      transformOrigin: "left center"
                    }}
                  />
                </form>

                <div style={{ display: "flex", alignItems: "center", width: 24, height: 24 }}>
                  <AnimatePresence>
                    {!isRenamingAnim && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.15 }}
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

                {/* Pushed to the far end so it reads as an action on the
                    session rather than another word in its title. */}
                {titleAction && (
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                    {titleAction}
                  </div>
                )}
              </div>
              <motion.div
                animate={{
                  y: (isRenaming == false) ? -4 : 0
                }}
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
