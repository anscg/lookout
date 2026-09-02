import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  countCutUnits,
  type ApplyCutsResponse,
  type CutInterval,
  type UnitsResponse,
} from "@lookout/shared";
import { createLookoutClient, type LookoutClient } from "../api/client.js";
import {
  cutsToRegions,
  gapIndices,
  normalizeRegions,
  regionAtTime,
  regionsToCuts,
  elapsedLabel,
  rulerStep,
  rulerTicks,
  unitAtTime,
  unitClockLabel,
  type UnitRegion,
} from "../hooks/editorMath.js";
import {
  openDecoderFrames,
  openVideoFrames,
  prefersDecoderFrames,
  type FilmstripFrames,
} from "../hooks/filmstripFrames.js";
import { useEditLease } from "../hooks/useEditLease.js";
import {
  compileEstimateMs,
  estimateBuildProgress,
  interpolateBuildProgress,
  PROGRESS_CAP,
} from "../hooks/buildProgress.js";
import { injectEditorStyles } from "./editorStyles.js";
import { Button } from "../ui/Button.js";
import { MinutesFlow } from "../ui/MinutesFlow.js";
import { Spinner } from "../ui/Spinner.js";
import { ProgressRing } from "../ui/ProgressRing.js";
import { ErrorDisplay } from "../ui/ErrorDisplay.js";
import { colors, fontSize, fontWeight, radii, spacing } from "../ui/theme.js";

export interface TimelapseEditorProps {
  token: string;
  apiBaseUrl: string;
  /** Bring your own API client (see `LookoutProviderProps.client`).
   *  Defaults to the fetch client for `apiBaseUrl` + `token`. */
  client?: LookoutClient;
  /** The timelapse was published — with cuts baked in, or without them.
   *  The caller should return to its detail view and poll status. The
   *  publish response is passed through: `instant`/`complete` means it's
   *  already done (fire any redirect now), otherwise a compile is running. */
  onApplied?: (result: ApplyCutsResponse) => void;
  /** Dismiss the editor. Only offered when it can't load — there is no
   *  "leave without deciding" exit, because closing the editor is itself
   *  the decision: the session publishes. */
  onCancel?: () => void;
  /** Fired whenever the cut list changes, with the normalized list and
   *  whether it differs from what's saved. Lets a host (the desktop
   *  window) publish the current edit when the user closes it. */
  onCutsChange?: (cuts: CutInterval[], dirty: boolean) => void;
}

const STRIP_HEIGHT = 56;
/** Diagonal hatch marking removed stretches on the timeline — the
 *  conventional "excluded" texture, and a second channel beyond colour
 *  alone. Kept faint: it should register as texture, not as content
 *  competing with the thumbnails underneath. */
const hatch = (periodPx: number) =>
  `repeating-linear-gradient(45deg, ${colors.editor.cutStripe} 0 ${
    periodPx / 2
  }px, transparent ${periodPx / 2}px ${periodPx}px)`;

const RULER_HEIGHT = 22;
/** Playhead cap: a slim pill, bottom-aligned to the ruler so it tucks
 *  under the labels instead of covering them. Small on purpose — it marks
 *  a position, it isn't a control that should dominate the timeline. */
const HEAD_W = 9;
const HEAD_H = 13;
/** Invisible grab area around the cap. The cap is too small to hit
 *  comfortably; the target isn't. */
const HEAD_HIT = 22;
/** Upper bound on filmstrip tiles. The real count comes from the track
 *  width; this only stops an ultra-wide display from queueing hundreds of
 *  decodes. */
const FILMSTRIP_MAX_TILES = 48;
/** Faulty tiles tolerated before a frame source is written off. One can
 *  be the recording's own fault; two in a row is the source. */
const MAX_TILE_FAULTS = 2;
/** Canvases are sized in device pixels and scaled down by CSS — without
 *  this a 2x display renders every thumbnail at half resolution, which
 *  reads as a blurry, low-quality preview. Capped at 2 because 3x gains
 *  nothing visible here and triples the decode cost. */
const pixelRatio = () =>
  Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

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
 * The "Edit & save" step of stopping a recording. The session is compiled
 * but deliberately UNPUBLISHED (held), so nothing downstream has consumed
 * it yet; this view previews that video (1 second = 1 capture unit = 1
 * real-world minute), lets the user drag out cut regions, and publishes —
 * with the cuts baked in, or without them.
 *
 * Layout is a three-row shell: a fixed transport bar, a stage that shrinks
 * (the only flexible row), and a dock pinned to the bottom. Every ancestor
 * of the stage carries `min-height: 0` so the video letterboxes down
 * instead of shoving the timeline out of the window.
 */
export function TimelapseEditor({
  token,
  apiBaseUrl,
  client: clientProp,
  onApplied,
  onCancel,
  onCutsChange,
}: TimelapseEditorProps) {
  const client = useMemo<LookoutClient>(
    () => clientProp ?? createLookoutClient({ baseUrl: apiBaseUrl, token }),
    [clientProp, apiBaseUrl, token],
  );

  useEffect(() => injectEditorStyles(), []);

  const [data, setData] = useState<UnitsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Unit count while the preview video is still compiling; null once it's
   *  ready. Deliberately a NUMBER, not an object: the poll below re-sets it
   *  every 1.5s, and a fresh object literal would change identity on every
   *  poll, re-running the progress effect and restarting the ring at 0. */
  const [preparingUnits, setPreparingUnits] = useState<number | null>(null);
  const [buildProgress, setBuildProgress] = useState(0);
  /** Real compile progress from /status, when the worker reports it; null
   *  until the first metered poll (or forever, for cut-apply/old workers). */
  const [realProgress, setRealProgress] = useState<number | null>(null);
  /** Latest real value and when it landed. Real progress ANCHORS the ring
   *  rather than owning it outright: it arrives once per 2s poll and only when
   *  the worker has moved another 1%, so displaying it directly lurches in
   *  steps with long dead pauses. The tick eases between anchors. */
  const realAnchorRef = useRef<{ value: number; atMs: number } | null>(null);
  /** Anchored once per preparing spell, so even a genuine change in the
   *  unit count can't restart the estimate. */
  const prepareStartRef = useRef<number | null>(null);
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
  // The preview video is built by the compile that ran at stop, so the
  // editor almost always opens BEFORE it exists: `/units` reports
  // `preparing` for the whole build. That is the normal path, not a
  // failure — but it must be waited out on `/status`, not `/units`.
  //
  // `/units` presigns a URL and is rate limited to 10/min; polling it
  // every 1.5s is 40/min, so the wait itself would 429 after ~15s and the
  // editor would report a rate-limit error instead of a video. `/status`
  // is the cheap endpoint built for polling (60/min) and already carries
  // `editable`, so wait on that and fetch `/units` only at the edges.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: UnitsResponse["editableReason"]) =>
      setLoadError(
        reason === "published"
          ? "This timelapse has already been published, so it can't be edited."
          : reason === "failed"
            ? "This timelapse couldn't be compiled, so there's nothing to edit."
            : reason === "recompiles_exhausted"
              ? "This timelapse has reached its edit limit."
              : "This timelapse isn't available for editing.",
      );

    const loadUnits = async () => {
      const res = await client.getUnits();
      if (cancelled) return;
      if (res.editable && res.originalVideoUrl) {
        setPreparingUnits(null);
        setData(res);
        setRegions(cutsToRegions(res.cuts, res.units));
        return;
      }
      if (res.editableReason === "preparing" || res.editableReason === "no_original") {
        // Keep the unit count for the progress estimate, then hand the
        // waiting over to /status.
        setPreparingUnits(res.expectedUnits ?? 0);
        timer = setTimeout(waitForReady, 2000);
        return;
      }
      fail(res.editableReason);
    };

    const waitForReady = async () => {
      if (cancelled) return;
      try {
        const status = await client.getStatus();
        if (cancelled) return;
        if (typeof status.progress === "number") setRealProgress(status.progress);
        if (status.editable) {
          await loadUnits();
          return;
        }
        if (status.status === "complete") {
          fail("published");
          return;
        }
        if (status.status === "failed") {
          fail("failed");
          return;
        }
      } catch (err) {
        // Transient: keep waiting rather than dropping the user out of an
        // edit because one poll failed.
        console.warn("[editor] status poll failed:", err);
      }
      timer = setTimeout(waitForReady, 2000);
    };

    void (async () => {
      try {
        await loadUnits();
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  // ── Build progress ──────────────────────────────────────────
  // Real worker progress wins when the /status poll reports it. Until then
  // (and for cut-apply/old-worker compiles that never report it) this is a
  // time estimate scaled by how much footage there is to compile. Either
  // source eases toward — and stops short of — 100%, and only the real
  // thing completing ends the wait; a ring that sat at 100% while the user
  // waited would be worse than none.
  useEffect(() => {
    if (realProgress === null) return;
    realAnchorRef.current = { value: realProgress, atMs: Date.now() };
    setBuildProgress((prev) => Math.max(prev, realProgress));
  }, [realProgress]);
  useEffect(() => {
    if (preparingUnits === null) {
      prepareStartRef.current = null;
      return;
    }
    if (prepareStartRef.current === null) prepareStartRef.current = Date.now();
    const startedAt = prepareStartRef.current;
    const estimateMs = compileEstimateMs(preparingUnits);
    const tick = () => {
      // BOTH sources run, and the ring takes whichever is further along.
      // Neither may switch the other off, and that is the whole trick:
      //
      //  - The estimate is a continuous function of time, so something is
      //    always moving at every 200ms tick — the ring can never sit still.
      //    Letting real progress silence it is what made this feel like a
      //    hang: updates dropped to one per 2s poll, in >=1% steps.
      //  - Real worker progress pulls the ring UP whenever the compile is
      //    further along than the guess, so the number stays tied to truth
      //    instead of drifting off on a curve.
      //  - Easing out of the last real anchor keeps the gaps between polls
      //    smooth, bounded by what one poll is expected to deliver.
      //
      // Monotonic via `prev`, and capped short of 100% — only the status flip
      // ends the wait, so a full ring while the user is still waiting would
      // be a lie.
      const now = Date.now();
      const anchor = realAnchorRef.current;
      const estimated = estimateBuildProgress(now - startedAt, estimateMs);
      const fromReal = anchor
        ? interpolateBuildProgress(anchor.value, now - anchor.atMs, estimateMs)
        : 0;
      setBuildProgress((prev) =>
        Math.min(PROGRESS_CAP, Math.max(prev, estimated, fromReal)),
      );
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [preparingUnits]);

  // ── Edit lease ──────────────────────────────────────────────
  // This editor being open IS the signal that editing is in progress, so
  // it renews the lease while mounted. No countdown, no deadline to race:
  // the session waits as long as the window is up, and publishes on its
  // own shortly after it isn't. Stops once the session is no longer held.
  const leaseHeld = useEditLease(client, !saving);
  useEffect(() => {
    if (leaseHeld || saving) return;
    setLoadError(
      "This timelapse was already published, so it can no longer be edited.",
    );
  }, [leaseHeld, saving]);

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
        v.pause();
        v.currentTime = region.startUnit;
      } else {
        v.currentTime = region.endUnit;
      }
    };
    v.addEventListener("timeupdate", onTimeUpdate);
    return () => v.removeEventListener("timeupdate", onTimeUpdate);
  }, [unitCount, data?.originalVideoUrl]);

  // ── Filmstrip frame source ──────────────────────────────────
  //
  // Getting pixels out of the preview has two independent problems, and
  // the openers below cover both:
  //
  //  1. Reading a <video> through a canvas needs a taint-free source. A
  //     presigned GET that carries CORS headers can be loaded with
  //     crossOrigin="anonymous" directly; a bucket that doesn't send them
  //     fails that load outright (which is exactly what a missing CORS
  //     config looks like), so the bytes are pulled through the app's own
  //     fetch — on desktop that is Tauri's HTTP plugin, not subject to
  //     browser CORS at all — and handed over as a same-origin blob.
  //  2. WebKitGTK can't be read through a canvas AT ALL while accelerated
  //     compositing is on: the frames come back empty, or as whatever was
  //     in that graphics memory. So a third opener decodes the same bytes
  //     with WebCodecs instead, and on that engine it goes first. See
  //     hooks/filmstripFrames.ts.
  //
  // Whichever opener runs, its tiles are checked before they are shown and
  // the source is dropped if they can't be real frames. Only if all three
  // fail does the timeline degrade to a plain track.
  /** The downloaded preview, shared between openers and kept across track
   *  resizes so a window drag can't re-download it. Held for as long as
   *  the editor is open, because the decoder needs random access to the
   *  samples: ~29KB per recorded minute at the preview tier, so single
   *  digits of MB for a normal session. Only fetched if an opener that
   *  needs the bytes actually runs. */
  const previewBytesRef = useRef<Promise<ArrayBuffer | null> | null>(null);
  useEffect(() => {
    previewBytesRef.current = null;
  }, [data?.originalVideoUrl]);

  // Track width drives the filmstrip: tiles are whole frames at the
  // video's own aspect ratio, so how many fit is a function of the track,
  // not of how many minutes were recorded.
  const [stripWidth, setStripWidth] = useState(0);
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) =>
      setStripWidth(entry.contentRect.width),
    );
    ro.observe(el);
    setStripWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [data]);

  /**
   * Filmstrip: whole, uncropped frames tiled across the track — the
   * Premiere / CapCut / iOS scrubber look.
   *
   * The math: a tile is the full frame at track height, so
   *   tileW = STRIP_HEIGHT × (videoW / videoH)   — 56 × 16/9 ≈ 100px
   *   tiles = ceil(trackW / tileW)               — ~9 across a 900px track
   * Tile i covers x ∈ [i·tileW, (i+1)·tileW), so it samples the frame at
   * its own midpoint: t = clamp(((i + 0.5)·tileW) / trackW) × duration.
   * The last tile is clipped by the track's overflow, exactly as a real
   * filmstrip is. Deliberately NOT one tile per minute: at 48 minutes
   * that squeezed each frame into 19px and cropped it to a smear.
   */
  const [tileWidth, setTileWidth] = useState(Math.round(STRIP_HEIGHT * (16 / 9)));
  useEffect(() => {
    const src = data?.originalVideoUrl;
    if (!src || unitCount === 0 || stripWidth <= 0) return;
    let cancelled = false;
    let source: FilmstripFrames | null = null;
    let blobUrl: string | null = null;

    // Debounce: a live window drag fires dozens of resizes, and each
    // regeneration is a series of decoder seeks.
    const timer = setTimeout(() => {
      const bytes = () => {
        if (!previewBytesRef.current) {
          previewBytesRef.current = fetch(src)
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.arrayBuffer();
            })
            .catch((err) => {
              console.error("[editor] preview download failed:", err);
              return null;
            });
        }
        return previewBytesRef.current;
      };

      const viaDecoder = async () => {
        const buf = await bytes();
        return buf ? openDecoderFrames(buf) : null;
      };
      const viaCorsVideo = () => openVideoFrames(src, { crossOrigin: true });
      const viaBlobVideo = async () => {
        const buf = await bytes();
        if (!buf || cancelled) return null;
        blobUrl = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
        return openVideoFrames(blobUrl);
      };
      const openers = prefersDecoderFrames()
        ? [viaDecoder, viaCorsVideo, viaBlobVideo]
        : [viaCorsVideo, viaBlobVideo, viaDecoder];

      /** Tiles for one source, or null if the source should be abandoned. */
      const render = async (frames: FilmstripFrames): Promise<string[] | null> => {
        const tileW = Math.max(24, Math.round(STRIP_HEIGHT * frames.aspect));
        setTileWidth(tileW);
        const tiles = Math.min(
          FILMSTRIP_MAX_TILES,
          Math.max(1, Math.ceil(stripWidth / tileW)),
        );
        const duration =
          Number.isFinite(frames.durationSec) && frames.durationSec > 0
            ? frames.durationSec
            : unitCount;

        const dpr = pixelRatio();
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(tileW * dpr);
        canvas.height = Math.round(STRIP_HEIGHT * dpr);
        // Every tile is read back for the fault check, which is exactly
        // the access pattern this hint exists for.
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.imageSmoothingQuality = "high";

        const thumbs: string[] = [];
        let faults = 0;
        for (let i = 0; i < tiles; i++) {
          if (cancelled) return null;
          const frac = Math.min(1, ((i + 0.5) * tileW) / stripWidth);
          const t = Math.max(0, Math.min(duration - 0.05, frac * duration));
          const outcome = await frames.draw(t, ctx, canvas.width, canvas.height);
          if (outcome !== "ok") {
            // One bad tile could be the frame's own fault — a recording
            // that really was one flat colour for a minute. Two is the
            // source, so hand over to the next opener. The progressive
            // publish below starts at the third tile, so a source that
            // fails this way never puts anything on screen.
            if (++faults >= MAX_TILE_FAULTS) {
              console.warn(
                `[editor] ${frames.kind} frames unusable (${outcome}); trying the next source`,
              );
              return null;
            }
            continue;
          }
          thumbs.push(canvas.toDataURL("image/jpeg", 0.82));
          if (i % 3 === 2) setFilmstrip([...thumbs]);
        }
        return thumbs.length ? thumbs : null;
      };

      void (async () => {
        for (const open of openers) {
          if (cancelled) return;
          source = await open().catch((err) => {
            console.warn("[editor] filmstrip source failed to open:", err);
            return null;
          });
          if (!source) continue;
          // Opening is async, so the effect can have been torn down while
          // it ran — the cleanup below saw a null `source` and had nothing
          // to close.
          if (cancelled) {
            source.close();
            return;
          }
          const thumbs = await render(source);
          source.close();
          source = null;
          if (cancelled) return;
          if (thumbs) {
            setFilmstrip(thumbs);
            return;
          }
        }
        if (!cancelled) {
          console.error(
            "[editor] no usable frame source; the timeline has no thumbnails",
          );
          setFilmstrip([]);
        }
      })();
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      source?.close();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [data?.originalVideoUrl, unitCount, stripWidth]);

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

  const seekTo = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(0, Math.min(unitCount - 0.05, t));
    },
    [unitCount],
  );

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
          index: regionsRef.current.length,
          mode: unitF >= drag.downUnitF ? "end" : "start",
          grabOffset: 0,
          anchorUnit: Math.floor(drag.downUnitF),
        };
        return;
      }

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
          seekTo(r.startUnit + 0.02);
        } else {
          const anchor = drag.anchorUnit;
          const rounded = Math.round(unitF);
          if (rounded <= anchor) {
            r.startUnit = Math.max(0, rounded);
            r.endUnit = anchor + 1;
            seekTo(r.startUnit + 0.02);
          } else {
            r.endUnit = Math.min(unitCount, Math.max(r.startUnit + 1, rounded));
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
      // A plain click on open track: seek there and drop any selection.
      seekTo(drag.downUnitF);
      setSelected(null);
      return;
    }
    if (drag.kind === "region") {
      // Keep the region selected after the gesture. Clearing it here meant
      // a selection could never outlive the click that made it, so "Remove
      // cut" was unreachable. Normalizing can merge regions and shift
      // indices, so re-find the one the gesture ended on rather than
      // trusting the old index.
      const dragged = regionsRef.current[drag.index];
      const next = normalizeRegions(regionsRef.current);
      setRegions(next);
      const idx = dragged
        ? next.findIndex(
            (r) => dragged.startUnit >= r.startUnit && dragged.startUnit < r.endUnit,
          )
        : -1;
      setSelected(idx >= 0 ? idx : null);
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

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const region = regionAtTime(v.currentTime, regionsRef.current);
      if (region && region.endUnit < unitCount) v.currentTime = region.endUnit;
      void v.play();
    } else {
      v.pause();
    }
  }, [unitCount]);

  const cutHere = useCallback(() => {
    const v = videoRef.current;
    if (!v || unitCount === 0) return;
    const at = unitAtTime(v.currentTime, unitCount);
    setRegions((prev) => {
      const next = normalizeRegions([...prev, { startUnit: at, endUnit: at + 1 }]);
      setSelected(next.findIndex((r) => at >= r.startUnit && at < r.endUnit));
      return next;
    });
  }, [unitCount]);

  // ── Keyboard ────────────────────────────────────────────────
  // Capture phase + preventDefault so hosting apps' global key handlers
  // (e.g. the desktop router's Backspace-goes-back) never fire underneath
  // an open editor — losing unsaved cuts to a stray Backspace is the worst
  // possible outcome of this surface.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "x" || e.key === "c") {
        e.preventDefault();
        cutHere();
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
        const step = e.shiftKey ? 10 : 1;
        seekTo(
          (videoRef.current?.currentTime ?? 0) +
            (e.key === "ArrowLeft" ? -step : step),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [selected, seekTo, togglePlay, cutHere]);

  // ── Publish ─────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cuts = regionsToCuts(normalizeRegions(regionsRef.current), data.units);
      await client.setCuts(cuts);
      const result = await client.applyCuts();
      onApplied?.(result);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [client, data, onApplied]);

  // ── Derived display values ──────────────────────────────────
  const normalized = useMemo(() => normalizeRegions(regions), [regions]);
  // Count what the SERVER will count. The footer used to count region
  // widths in unit space while the server counted timestamp membership on
  // the serialized intervals — so the two could disagree, and the editor
  // would happily offer a Save the server then rejected. Same input, same
  // shared function, no daylight between them.
  const serializedCuts = useMemo(
    () => (data ? regionsToCuts(normalized, data.units) : []),
    [normalized, data],
  );
  const unitTimesMs = useMemo(
    () => units.map((u) => Date.parse(u.capturedAt)),
    [units],
  );
  const removedUnits = useMemo(
    () => countCutUnits(unitTimesMs, serializedCuts),
    [unitTimesMs, serializedCuts],
  );
  const keptUnits = unitCount - removedUnits;
  const allCut = unitCount > 0 && keptUnits === 0;
  const gaps = useMemo(() => (data ? gapIndices(data.units) : []), [data]);
  const step = useMemo(
    () => rulerStep(unitCount, stripWidth),
    [unitCount, stripWidth],
  );
  const ticks = useMemo(() => rulerTicks(unitCount, step), [unitCount, step]);
  const currentUnit = unitAtTime(time, Math.max(1, unitCount));
  const inCutNow = regionAtTime(time, normalized) !== null;
  const pct = (u: number) => `${(u / Math.max(1, unitCount)) * 100}%`;

  // Keep the host informed of the working cut list, so closing the
  // window can publish exactly what's on screen.
  const onCutsChangeRef = useRef(onCutsChange);
  onCutsChangeRef.current = onCutsChange;
  useEffect(() => {
    if (!data) return;
    const saved = JSON.stringify(data.cuts ?? []);
    onCutsChangeRef.current?.(
      serializedCuts,
      JSON.stringify(serializedCuts) !== saved,
    );
  }, [serializedCuts, data]);

  // ── Render ──────────────────────────────────────────────────
  if (loadError) {
    return (
      <div style={{ padding: spacing.xl, maxWidth: 520 }}>
        <ErrorDisplay error={loadError} variant="banner" title="Can't edit" />
        {onCancel && (
          <div style={{ marginTop: spacing.md }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Close
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
          height: "100%",
          minHeight: 260,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.lg,
          textAlign: "center",
          padding: spacing.xl,
        }}
      >
        {preparingUnits !== null ? (
          <ProgressRing progress={buildProgress} showPercent />
        ) : (
          <Spinner size="lg" />
        )}
        <div>
          <div
            style={{
              fontSize: fontSize.xl,
              fontWeight: fontWeight.semibold,
              color: colors.text.primary,
              letterSpacing: "-0.01em",
            }}
          >
            Preparing your timelapse
          </div>
          <div
            style={{
              fontSize: fontSize.md,
              color: colors.text.secondary,
              marginTop: spacing.xs,
              maxWidth: 340,
              lineHeight: 1.5,
            }}
          >
            {preparingUnits !== null && preparingUnits > 0
              ? `Stitching ${preparingUnits} minute${
                  preparingUnits === 1 ? "" : "s"
                } of footage.`
              : "oooooooooooo"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
      }}
    >
      {/* ── Stage: the only row that flexes ──────────────────── */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: colors.editor.well,
          border: `1px solid ${colors.editor.wellBorder}`,
          borderRadius: 12,
          overflow: "hidden",
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
          // max-* rather than width:100% is what lets the stage shrink:
          // the video letterboxes into whatever height is left instead of
          // forcing the dock off the bottom of the window.
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            display: "block",
            cursor: "pointer",
          }}
        />

        <AnimatePresence>
          {!playing && (
            <motion.div
              initial={{ opacity: 0, scale: 0.88 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.88 }}
              transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
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
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.55)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
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
                // Matches the stage's radius: an inset ring on a square
                // box inside a rounded, clipped parent gets sliced at the
                // corners and reads as a rendering glitch.
                borderRadius: 12,
                boxShadow: `inset 0 0 0 3px ${colors.editor.cutBorder}`,
                // Tint only, no hatch: the stage is already showing the
                // frame you're judging, and texture over live footage
                // fights it. The hatch belongs on the timeline, where the
                // question is "which stretch", not "what's in it".
                backgroundColor: "rgba(220, 38, 38, 0.10)",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: spacing.md,
                  right: spacing.md,
                  background: colors.editor.cutBorder,
                  color: "#fff",
                  fontSize: fontSize.xs,
                  fontWeight: fontWeight.semibold,
                  padding: "3px 8px",
                  borderRadius: radii.sm,
                  letterSpacing: "0.01em",
                }}
              >
                Will be removed
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Dock: transport, timeline, actions ───────────────── */}
      <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: spacing.sm }}>
        {/* Transport */}
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <button
            className="lk-ed-iconbtn"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            style={{ width: 30, height: 30, borderRadius: radii.md }}
          >
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <div
            style={{
              fontSize: fontSize.md,
              color: colors.text.primary,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.01em",
            }}
          >
            {elapsedLabel(currentUnit, unitCount)}
            <span style={{ color: colors.text.tertiary }}>
              {" of "}
              {elapsedLabel(unitCount, unitCount)}
              {" · recorded at "}
              {unitClockLabel(units[currentUnit])}
            </span>
          </div>

          <div style={{ flex: 1 }} />

        </div>

        {/* Timeline */}
        <div
          style={{ position: "relative", userSelect: "none", touchAction: "none" }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* Playhead: a slim cap at the foot of the ruler with a stem
              through the strip. Rendered as a sibling of both lanes (not
              inside the strip) so it isn't clipped by its overflow. */}
          {unitCount > 0 && (
            <div
              style={{
                position: "absolute",
                left: pct(Math.min(time, unitCount)),
                top: 0,
                bottom: 0,
                width: 0,
                zIndex: 3,
                pointerEvents: "none",
              }}
            >
              <div
                onPointerDown={onRulerPointerDown}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: RULER_HEIGHT - HEAD_H,
                  left: -HEAD_HIT / 2,
                  width: HEAD_HIT,
                  height: HEAD_HIT,
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "flex-start",
                  cursor: "ew-resize",
                  pointerEvents: "auto",
                }}
              >
                <div
                  className="lk-ed-playhead"
                  style={{
                    width: HEAD_W,
                    height: HEAD_H,
                    borderRadius: HEAD_W / 2,
                    background: colors.text.primary,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
                  }}
                />
              </div>
              <div
                style={{
                  position: "absolute",
                  top: RULER_HEIGHT - 4,
                  bottom: 0,
                  left: -1,
                  width: 2,
                  background: colors.text.primary,
                  boxShadow: "0 0 0 0.5px rgba(0,0,0,0.35)",
                }}
              />
            </div>
          )}

          {/* Ruler lane — owns scrubbing. Labels sit above their tick, at
              a step chosen so they never crowd (see rulerStep). */}
          <div
            onPointerDown={onRulerPointerDown}
            style={{
              position: "relative",
              height: RULER_HEIGHT,
              cursor: "ew-resize",
            }}
          >
            {ticks.map(({ unit, major }) => {
              const left = (unit / Math.max(1, unitCount)) * 100;
              return (
                <div key={unit} style={{ position: "absolute", left: `${left}%`, top: 0, bottom: 0 }}>
                  {major && (
                    <span
                      style={{
                        position: "absolute",
                        top: 0,
                        // First and last labels tuck inside the track
                        // instead of hanging off its edges.
                        left: unit === 0 ? 0 : undefined,
                        right: unit >= unitCount ? 0 : undefined,
                        transform:
                          unit === 0 || unit >= unitCount
                            ? undefined
                            : "translateX(-50%)",
                        fontSize: fontSize.xs,
                        color: colors.text.tertiary,
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                        pointerEvents: "none",
                      }}
                    >
                      {elapsedLabel(unit, unitCount)}
                    </span>
                  )}
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: unit === 0 ? 0 : unit >= unitCount ? -1 : -0.5,
                      width: 1,
                      height: major ? 7 : 4,
                      background: major
                        ? colors.text.tertiary
                        : colors.text.quaternary,
                      pointerEvents: "none",
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Filmstrip — drag creates a cut, click seeks */}
          <div
            ref={timelineRef}
            className="lk-ed-strip"
            tabIndex={0}
            role="group"
            aria-label="Timelapse timeline. Drag to remove a stretch of time."
            onPointerDown={onTimelinePointerDown}
            style={{
              position: "relative",
              height: STRIP_HEIGHT,
              borderRadius: radii.md,
              overflow: "hidden",
              cursor: "crosshair",
              background: colors.editor.track,
              border: `1px solid ${colors.border.default}`,
            }}
          >
            {/* Whole frames at the source aspect ratio, tiled left to
                right. Fixed width (not flex) is the point: stretching
                tiles to fill would distort them, and `cover` would crop
                them. The final tile runs past the edge and is clipped. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                pointerEvents: "none",
              }}
            >
              {filmstrip.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt=""
                  draggable={false}
                  style={{
                    width: tileWidth,
                    height: "100%",
                    flex: "0 0 auto",
                    objectFit: "fill",
                    display: "block",
                  }}
                />
              ))}
            </div>

            {/* Pause markers: the recording stopped between these minutes */}
            {gaps.map((i) => (
              <div
                key={`gap-${i}`}
                title="Recording paused here"
                style={{
                  position: "absolute",
                  left: pct(i),
                  top: 0,
                  bottom: 0,
                  width: 2,
                  marginLeft: -1,
                  background:
                    "repeating-linear-gradient(180deg, var(--color-text-quaternary) 0 3px, transparent 3px 6px)",
                  pointerEvents: "none",
                }}
              />
            ))}

            {regions.map((r, i) => {
              const isSelected = selected === i;
              return (
                <div
                  key={i}
                  className="lk-ed-region"
                  onPointerDown={(e) => onRegionPointerDown(e, i, "move")}
                  style={{
                    position: "absolute",
                    left: pct(r.startUnit),
                    width: pct(r.endUnit - r.startUnit),
                    top: 0,
                    bottom: 0,
                    borderRadius: radii.sm,
                    // backgroundColor (not background) so the hover rule
                    // in editorStyles can swap the tint without dropping
                    // the hatch layered on top of it.
                    backgroundColor: colors.editor.cutFill,
                    backgroundImage: hatch(10),
                    boxShadow: isSelected
                      ? `inset 0 0 0 2px ${colors.editor.cutBorder}`
                      : `inset 0 0 0 1px ${colors.editor.cutBorder}`,
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
                      className="lk-ed-handle"
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
                        className="lk-ed-grip"
                        style={{
                          width: 3,
                          height: 22,
                          borderRadius: 2,
                          background: colors.editor.cutBorder,
                        }}
                      />
                    </div>
                  ))}
                </div>
              );
            })}

          </div>
        </div>

        {/* Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.md,
            flexWrap: "wrap",
            marginTop: spacing.xs,
          }}
        >
          <div
            style={{
              minWidth: 0,
              fontSize: fontSize.lg,
              color: colors.text.primary,
              fontWeight: fontWeight.semibold,
              letterSpacing: "-0.01em",
            }}
          >
            <MinutesFlow minutes={keptUnits} /> kept
            {removedUnits > 0 && (
              <span style={{ color: colors.editor.cutBorder, fontWeight: fontWeight.medium }}>
                {" · "}
                <MinutesFlow minutes={removedUnits} color={colors.editor.cutBorder} /> removed
              </span>
            )}
          </div>

          <div style={{ flex: 1, minWidth: spacing.md }} />

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
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={allCut}
            title={allCut ? "You can't remove the entire timelapse" : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>

        {saveError && (
          <ErrorDisplay error={saveError} variant="banner" title="Couldn't save your edits" />
        )}
      </div>
    </div>
  );
}
