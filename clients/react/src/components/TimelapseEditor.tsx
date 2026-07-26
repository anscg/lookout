import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type { UnitsResponse } from "@lookout/shared";
import { createLookoutClient, type LookoutClient } from "../api/client.js";
import {
  cutsToRegions,
  cutUnitCount,
  formatUnitsDuration,
  gapIndices,
  normalizeRegions,
  regionAtTime,
  regionsToCuts,
  unitAtTime,
  unitClockLabel,
  type UnitRegion,
} from "../hooks/editorMath.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { ErrorDisplay } from "../ui/ErrorDisplay.js";
import { colors, fontSize, fontWeight, radii, spacing } from "../ui/theme.js";

export interface TimelapseEditorProps {
  token: string;
  apiBaseUrl: string;
  /** The timelapse was published — with cuts baked in, or without them.
   *  The caller should return to its detail view and poll status. */
  onApplied?: () => void;
  /** Optional "not now" escape. The timelapse stays held and publishes
   *  itself when the hold expires, so this never loses anything. Omit it
   *  in flows where publishing must be an explicit choice. */
  onCancel?: () => void;
}

const TIMELINE_HEIGHT = 64;
const RULER_HEIGHT = 22;
const FILMSTRIP_SAMPLES = 60;
const CUT_FILL = "rgba(239, 68, 68, 0.38)";
const CUT_BORDER = "#ef4444";

type DragState =
  | { kind: "maybe"; downUnitF: number }
  | { kind: "scrub" }
  | {
      kind: "region";
      index: number;
      mode: "move" | "start" | "end";
      grabOffset: number;
      anchorUnit: number;
    }
  | null;

/**
 * The "Edit & Save" step of stopping a recording. The session is compiled
 * but deliberately UNPUBLISHED (held), so nothing downstream has consumed
 * it yet; this view previews that video (1 second = 1 capture unit = 1
 * real-world minute), lets the user drag out cut regions, and publishes —
 * with the cuts baked in, or without them.
 *
 * Regions are first-class objects: draggable edges, selection, delete key.
 * A plain click on the timeline seeks; playback skips cut regions so
 * previewing shows the published result, while scrubbing passes through
 * them (dimmed) so cut edges can be judged.
 */
export function TimelapseEditor({
  token,
  apiBaseUrl,
  onApplied,
  onCancel,
}: TimelapseEditorProps) {
  const client = useMemo<LookoutClient>(
    () => createLookoutClient({ baseUrl: apiBaseUrl, token }),
    [apiBaseUrl, token],
  );

  const [data, setData] = useState<UnitsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regions, setRegions] = useState<UnitRegion[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [filmstrip, setFilmstrip] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);
  const regionsRef = useRef<UnitRegion[]>(regions);
  regionsRef.current = regions;
  const rafRef = useRef<number>(0);

  const units = data?.units ?? [];
  const unitCount = units.length;

  // ── Load ────────────────────────────────────────────────────
  // The preview video is built by the compile that ran at stop; while it's
  // still building, /units reports the hold with editable=false. Poll until
  // it's ready rather than sending the user away.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const res = await client.getUnits();
        if (cancelled) return;
        if (res.editable && res.originalVideoUrl) {
          setData(res);
          setRegions(cutsToRegions(res.cuts, res.units));
          return;
        }
        if (res.editableReason === "no_original" && res.editHoldUntil) {
          // Still compiling inside the hold — check back shortly.
          timer = setTimeout(load, 2000);
          return;
        }
        setLoadError(
          res.editableReason === "published"
            ? "This timelapse has already been published, so it can't be edited."
            : res.editableReason === "recompiles_exhausted"
              ? "This timelapse has reached its edit limit."
              : "This timelapse isn't available for editing.",
        );
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  // ── Hold countdown ──────────────────────────────────────────
  // The session publishes itself when the hold expires. Surface the
  // deadline (and bail out gracefully once it passes) instead of letting
  // a Save silently 409.
  const holdUntilMs = data?.editHoldUntil ? Date.parse(data.editHoldUntil) : null;
  const [holdSecondsLeft, setHoldSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (holdUntilMs === null) return;
    const tick = () => {
      const left = Math.max(0, Math.round((holdUntilMs - Date.now()) / 1000));
      setHoldSecondsLeft(left);
      if (left === 0) {
        // Auto-published underneath us — the timelapse is safe, just no
        // longer editable.
        setLoadError(
          "The edit window closed, so your timelapse was published as recorded.",
        );
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [holdUntilMs]);

  // ── Playhead tracking (rAF for a smooth 60fps playhead) ─────
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) setTime(v.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Playback skips cut regions (scrubbing passes through) ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => {
      if (v.paused) return;
      const region = regionAtTime(v.currentTime, regionsRef.current);
      if (!region) return;
      if (region.endUnit >= unitCount) {
        // Cut runs to the end — nothing kept after it.
        v.pause();
        v.currentTime = region.startUnit;
      } else {
        v.currentTime = region.endUnit;
      }
    };
    v.addEventListener("timeupdate", onTimeUpdate);
    return () => v.removeEventListener("timeupdate", onTimeUpdate);
  }, [unitCount, data?.originalVideoUrl]);

  // ── Filmstrip: sample frames from an offscreen copy of the video.
  // Best-effort — if the CDN response isn't CORS-readable the canvas
  // taints and we quietly fall back to a plain timeline.
  useEffect(() => {
    const src = data?.originalVideoUrl;
    if (!src || unitCount === 0) return;
    let cancelled = false;
    (async () => {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.preload = "auto";
      v.src = src;
      try {
        await new Promise<void>((resolve, reject) => {
          v.onloadedmetadata = () => resolve();
          v.onerror = () => reject(new Error("video load failed"));
        });
        const canvas = document.createElement("canvas");
        const thumbH = TIMELINE_HEIGHT;
        const thumbW = Math.round(
          (v.videoWidth / Math.max(1, v.videoHeight)) * thumbH,
        );
        canvas.width = thumbW;
        canvas.height = thumbH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const count = Math.min(FILMSTRIP_SAMPLES, unitCount);
        const thumbs: string[] = [];
        for (let i = 0; i < count; i++) {
          if (cancelled) return;
          // Sample the middle of each strip cell, +0.5 to land inside a
          // second (unit) rather than on the boundary between two.
          const t = Math.min(
            v.duration - 0.05,
            (i / count) * unitCount + 0.5,
          );
          await new Promise<void>((resolve) => {
            v.onseeked = () => resolve();
            v.currentTime = t;
          });
          ctx.drawImage(v, 0, 0, thumbW, thumbH);
          thumbs.push(canvas.toDataURL("image/jpeg", 0.5));
          // Stream partial strips in so the timeline fills as we go.
          if (i % 6 === 5) setFilmstrip([...thumbs]);
        }
        if (!cancelled) setFilmstrip(thumbs);
      } catch {
        // Tainted canvas / load failure → no thumbnails, timeline still works.
      } finally {
        v.removeAttribute("src");
        v.load();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.originalVideoUrl, unitCount]);

  // ── Pointer plumbing ────────────────────────────────────────
  const unitFromEvent = useCallback(
    (e: { clientX: number }): number => {
      const el = timelineRef.current;
      if (!el || unitCount === 0) return 0;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return frac * unitCount;
    },
    [unitCount],
  );

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(unitCount - 0.05, t));
  }, [unitCount]);

  const beginDrag = useCallback((e: React.PointerEvent, state: DragState) => {
    dragRef.current = state;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onTimelinePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (saving) return;
      beginDrag(e, { kind: "maybe", downUnitF: unitFromEvent(e) });
    },
    [beginDrag, saving, unitFromEvent],
  );

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (saving) return;
      beginDrag(e, { kind: "scrub" });
      seekTo(unitFromEvent(e));
    },
    [beginDrag, saving, seekTo, unitFromEvent],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const unitF = unitFromEvent(e);

      if (drag.kind === "scrub") {
        seekTo(unitF);
        return;
      }

      if (drag.kind === "maybe") {
        // Click-vs-drag disambiguation: past a third of a unit of travel,
        // the gesture becomes a new cut region growing from the press point.
        if (Math.abs(unitF - drag.downUnitF) < 0.34) return;
        const a = Math.floor(Math.min(unitF, drag.downUnitF));
        const b = Math.ceil(Math.max(unitF, drag.downUnitF));
        setRegions((prev) => {
          const next = [...prev, { startUnit: a, endUnit: Math.max(b, a + 1) }];
          setSelected(next.length - 1);
          return next;
        });
        dragRef.current = {
          kind: "region",
          index: regionsRef.current.length, // index of the region just added
          mode: unitF >= drag.downUnitF ? "end" : "start",
          grabOffset: 0,
          anchorUnit: Math.floor(drag.downUnitF),
        };
        return;
      }

      // Region move/resize. Edges snap to whole units by construction.
      setRegions((prev) => {
        const next = prev.map((r) => ({ ...r }));
        const r = next[drag.index];
        if (!r) return prev;
        if (drag.mode === "move") {
          const width = r.endUnit - r.startUnit;
          let start = Math.round(unitF - drag.grabOffset);
          start = Math.max(0, Math.min(unitCount - width, start));
          r.startUnit = start;
          r.endUnit = start + width;
        } else if (drag.mode === "start") {
          r.startUnit = Math.max(0, Math.min(r.endUnit - 1, Math.round(unitF)));
          // The preview rides the dragged edge: show the first REMOVED unit.
          seekTo(r.startUnit + 0.02);
        } else {
          const anchor = drag.anchorUnit;
          const rounded = Math.round(unitF);
          if (rounded <= anchor) {
            // Dragged back across the anchor — grow leftward instead.
            r.startUnit = Math.max(0, rounded);
            r.endUnit = anchor + 1;
            seekTo(r.startUnit + 0.02);
          } else {
            r.endUnit = Math.min(unitCount, Math.max(r.startUnit + 1, rounded));
            // Show the first KEPT unit after the cut — the frame the splice
            // will land on.
            seekTo(Math.min(unitCount - 0.05, r.endUnit + 0.02));
          }
        }
        return next;
      });
      setSelected(drag.index);
    },
    [seekTo, unitCount, unitFromEvent],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "maybe") {
      // A plain click: seek. (Deselect any selected region.)
      seekTo(drag.downUnitF);
      setSelected(null);
      return;
    }
    if (drag.kind === "region") {
      setRegions((prev) => {
        const next = normalizeRegions(prev);
        setSelected(null);
        return next;
      });
    }
  }, [seekTo]);

  const onRegionPointerDown = useCallback(
    (e: React.PointerEvent, index: number, mode: "move" | "start" | "end") => {
      if (saving) return;
      const r = regionsRef.current[index];
      if (!r) return;
      setSelected(index);
      beginDrag(e, {
        kind: "region",
        index,
        mode,
        grabOffset: unitFromEvent(e) - r.startUnit,
        anchorUnit: r.startUnit,
      });
    },
    [beginDrag, saving, unitFromEvent],
  );

  // ── Keyboard: space = play/pause, delete = remove selection ─
  // Capture phase + preventDefault so hosting apps' global key handlers
  // (e.g. the desktop router's Backspace-goes-back) never fire underneath
  // an open editor — losing unsaved cuts to a stray Backspace is the worst
  // possible outcome of this surface.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selected !== null) {
          setRegions((prev) => prev.filter((_, i) => i !== selected));
          setSelected(null);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSelected(null);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seekTo((videoRef.current?.currentTime ?? 0) + (e.key === "ArrowLeft" ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, seekTo]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Never start playback inside a cut — jump to the next kept unit.
      const region = regionAtTime(v.currentTime, regionsRef.current);
      if (region && region.endUnit < unitCount) v.currentTime = region.endUnit;
      void v.play();
    } else {
      v.pause();
    }
  }, [unitCount]);

  // ── Publish ─────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cuts = regionsToCuts(normalizeRegions(regionsRef.current), data.units);
      // Always write the list — an empty one is a meaningful "publish it
      // as recorded" — then publish. The server bakes cuts in before the
      // session ever reaches `complete`.
      await client.setCuts(cuts);
      await client.applyCuts();
      onApplied?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [client, data, onApplied]);

  // ── Derived display values ──────────────────────────────────
  const normalized = useMemo(() => normalizeRegions(regions), [regions]);
  const removedUnits = cutUnitCount(normalized);
  const keptUnits = unitCount - removedUnits;
  const allCut = unitCount > 0 && keptUnits === 0;
  const gaps = useMemo(() => (data ? gapIndices(data.units) : []), [data]);
  const currentUnit = unitAtTime(time, Math.max(1, unitCount));
  const inCutNow = regionAtTime(time, normalized) !== null;

  const pct = (u: number) => `${(u / Math.max(1, unitCount)) * 100}%`;

  // ── Render ──────────────────────────────────────────────────
  if (loadError) {
    return (
      <div style={{ padding: spacing.lg }}>
        <ErrorDisplay error={loadError} variant="banner" title="Can't edit" />
        {onCancel && (
          <div style={{ marginTop: spacing.md }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              &larr; Back
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!data) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 260,
          gap: spacing.sm,
          color: colors.text.secondary,
          fontSize: fontSize.md,
        }}
      >
        <Spinner size="sm" /> Preparing your timelapse…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      {/* Preview */}
      <div
        style={{
          position: "relative",
          borderRadius: radii.lg,
          overflow: "hidden",
          background: "#000",
          lineHeight: 0,
        }}
      >
        <video
          ref={videoRef}
          src={data.originalVideoUrl ?? undefined}
          playsInline
          muted
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          style={{ width: "100%", display: "block", cursor: "pointer" }}
        />
        {/* Play affordance when paused (clicking the video toggles) */}
        <AnimatePresence>
          {!playing && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.65)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Removed-minute overlay while scrubbing inside a cut */}
        <AnimatePresence>
          {inCutNow && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(239, 68, 68, 0.18)",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "flex-end",
                padding: spacing.md,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  background: "rgba(0,0,0,0.75)",
                  color: "#fca5a5",
                  fontSize: fontSize.sm,
                  fontWeight: fontWeight.semibold,
                  padding: "4px 10px",
                  borderRadius: radii.md,
                  lineHeight: 1.4,
                }}
              >
                This minute will be removed
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Wall-clock of the frame under the playhead */}
        {unitCount > 0 && (
          <div
            style={{
              position: "absolute",
              left: spacing.md,
              bottom: spacing.md,
              background: "rgba(0,0,0,0.7)",
              color: "#fff",
              fontSize: fontSize.sm,
              padding: "3px 8px",
              borderRadius: radii.sm,
              pointerEvents: "none",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1.4,
            }}
          >
            {unitClockLabel(units[currentUnit])}
            <span style={{ opacity: 0.55 }}>
              {" "}· minute {currentUnit + 1}/{unitCount}
            </span>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div
        style={{ position: "relative", userSelect: "none", touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Ruler lane — owns scrubbing */}
        <div
          onPointerDown={onRulerPointerDown}
          style={{
            position: "relative",
            height: RULER_HEIGHT,
            cursor: "ew-resize",
            borderBottom: `1px solid ${colors.border.default}`,
          }}
        >
          {units.length > 0 &&
            [0, 0.25, 0.5, 0.75, 1].map((f) => {
              const idx = Math.min(unitCount - 1, Math.round(f * (unitCount - 1)));
              return (
                <span
                  key={f}
                  style={{
                    position: "absolute",
                    left: `calc(${f * 100}% ${f === 0 ? "" : f === 1 ? "- 34px" : "- 17px"})`,
                    bottom: 4,
                    fontSize: fontSize.xs,
                    color: colors.text.tertiary,
                    fontVariantNumeric: "tabular-nums",
                    pointerEvents: "none",
                  }}
                >
                  {unitClockLabel(units[idx])}
                </span>
              );
            })}
        </div>

        {/* Filmstrip lane — drag creates a cut, click seeks */}
        <div
          ref={timelineRef}
          onPointerDown={onTimelinePointerDown}
          style={{
            position: "relative",
            height: TIMELINE_HEIGHT,
            marginTop: 2,
            borderRadius: radii.md,
            overflow: "hidden",
            cursor: "crosshair",
            background: colors.bg.surface,
          }}
        >
          {/* Thumbnails */}
          <div style={{ position: "absolute", inset: 0, display: "flex" }}>
            {filmstrip.length > 0
              ? filmstrip.map((url, i) => (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      backgroundImage: `url(${url})`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }}
                  />
                ))
              : null}
          </div>

          {/* Pause-gap markers */}
          {gaps.map((i) => (
            <div
              key={`gap-${i}`}
              title="Recording paused here"
              style={{
                position: "absolute",
                left: pct(i),
                top: 0,
                bottom: 0,
                width: 0,
                borderLeft: `2px dashed ${colors.text.quaternary}`,
                pointerEvents: "none",
              }}
            />
          ))}

          {/* Cut regions */}
          {regions.map((r, i) => {
            const isSelected = selected === i;
            return (
              <div
                key={i}
                onPointerDown={(e) => onRegionPointerDown(e, i, "move")}
                style={{
                  position: "absolute",
                  left: pct(r.startUnit),
                  width: pct(r.endUnit - r.startUnit),
                  top: 0,
                  bottom: 0,
                  background: CUT_FILL,
                  border: `${isSelected ? 2 : 1}px solid ${CUT_BORDER}`,
                  borderRadius: radii.sm,
                  cursor: "grab",
                  boxSizing: "border-box",
                }}
              >
                {[
                  { mode: "start" as const, side: { left: -6 } },
                  { mode: "end" as const, side: { right: -6 } },
                ].map(({ mode, side }) => (
                  <div
                    key={mode}
                    onPointerDown={(e) => onRegionPointerDown(e, i, mode)}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      width: 12,
                      ...side,
                      cursor: "ew-resize",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 4,
                        height: 26,
                        borderRadius: 2,
                        background: CUT_BORDER,
                      }}
                    />
                  </div>
                ))}
              </div>
            );
          })}

          {/* Playhead */}
          {unitCount > 0 && (
            <div
              style={{
                position: "absolute",
                left: pct(Math.min(time, unitCount)),
                top: 0,
                bottom: 0,
                width: 2,
                marginLeft: -1,
                background: colors.text.primary,
                pointerEvents: "none",
                boxShadow: "0 0 4px rgba(0,0,0,0.6)",
              }}
            />
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: spacing.md,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: spacing.sm,
            fontSize: fontSize.md,
            color: colors.text.secondary,
          }}
        >
          <span
            style={{
              fontWeight: fontWeight.bold,
              color: allCut ? colors.status.danger : colors.text.primary,
              fontSize: fontSize.lg,
            }}
          >
            {formatUnitsDuration(keptUnits)}
          </span>
          <span>kept</span>
          <AnimatePresence>
            {removedUnits > 0 && (
              <motion.span
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{ color: colors.status.danger }}
              >
                · {formatUnitsDuration(removedUnits)} removed
              </motion.span>
            )}
          </AnimatePresence>
          <span style={{ fontSize: fontSize.xs, color: colors.text.quaternary }}>
            drag the strip to cut · click to seek · space to preview
          </span>
        </div>

        <div style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
          {selected !== null && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRegions((prev) => prev.filter((_, i) => i !== selected));
                setSelected(null);
              }}
            >
              Remove cut
            </Button>
          )}
          {normalized.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRegions([]);
                setSelected(null);
              }}
            >
              Clear all
            </Button>
          )}
          {onCancel && (
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
              Not now
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={allCut}
            title={allCut ? "You can't remove the entire timelapse" : undefined}
          >
            {saving
              ? "Saving…"
              : removedUnits > 0
                ? "Save & publish"
                : "Publish as recorded"}
          </Button>
        </div>
      </div>

      {saveError && (
        <ErrorDisplay error={saveError} variant="banner" title="Couldn't save your edits" />
      )}

      {/* The hold is the promise that nothing gets lost — say so plainly,
          and get louder as it runs out. */}
      {holdSecondsLeft !== null && (
        <div
          style={{
            fontSize: fontSize.xs,
            color:
              holdSecondsLeft < 120 ? colors.status.warning : colors.text.tertiary,
          }}
        >
          {holdSecondsLeft < 120
            ? `Publishing automatically in ${holdSecondsLeft}s — save now to keep your cuts.`
            : `Not published yet. If you close this, it publishes as recorded in ${Math.round(
                holdSecondsLeft / 60,
              )} min.`}
        </div>
      )}
    </div>
  );
}
