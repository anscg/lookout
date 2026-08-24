import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Button, Spinner, colors, spacing, fontSize, fontWeight, radii } from "@lookout/react";
import { invoke } from "../logger.js";
import {
  PANEL_HEIGHT_SLACK,
  PANEL_LOAD_TIMEOUT_MS,
  PANEL_READY_GRACE_MS,
  PANEL_MIN_HEIGHT,
  PANEL_SANDBOX,
  panelOrigin,
  parsePanelMessage,
} from "../programPanel.js";

/**
 * A program's own page, rendered in a sheet inside the app.
 *
 * The point is to stop bouncing people to a browser tab just so their program
 * can ask a few questions ("what's this called?", "which project should the
 * time land on?"). The program keeps its own UI, validation and design — we
 * give it a rectangle and get out of the way.
 *
 * The frame is sandboxed and talks to us over origin-checked postMessage
 * only; see programPanel.ts for the protocol and the reasoning. It cannot
 * reach Tauri, cannot navigate the app, and we never read its contents.
 *
 * A panel that won't load, errors, or never says anything falls back to the
 * program's page in a real browser. Dismissing the sheet is always free — the
 * ask persists as a card on the session page (PanelPrompt), so a panel is a
 * convenience and never the only way through.
 */

/**
 * Which way round the app currently is.
 *
 * `data-theme` is what the app itself keys off (App.tsx sets it from the
 * window's theme, and Linux sets it before first paint in index.html); the
 * media query is the fallback for the window between boot and that attribute
 * landing.
 */
function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ProgramPanelProps {
  /** The session's `panelUrl` — https, program-minted, per-session. */
  url: string;
  /** Program display name, for the attribution row. */
  programLabel: string;
  /** Program logo for the attribution row; falls back to a glyph. */
  programIconUrl?: string | null;
  /** Where to send the user if the panel can't do its job. */
  fallbackUrl?: string | null;
  /** The program reported it finished. */
  onDone: () => void;
  /** Sheet closed without finishing — swipe, Escape, X, or panel cancel. */
  onDismiss: () => void;
}

export function ProgramPanel({
  url,
  programLabel,
  programIconUrl,
  fallbackUrl,
  onDone,
  onDismiss,
}: ProgramPanelProps) {
  const [height, setHeight] = useState(PANEL_MIN_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  // `loaded` is the frame's document; `ready` is the panel saying it has
  // something worth showing. We reveal on whichever we get, so a panel that
  // never announces itself still appears.
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const origin = panelOrigin(url);

  // Tell the panel which way round the app is, in the URL rather than over
  // postMessage. A message can only arrive after the frame has loaded, by
  // which point it has already painted — and a dark panel on a light sheet
  // (or the reverse) is exactly the flash we are trying to avoid. Query
  // params are there before the first byte of CSS is applied.
  //
  // Only the query is touched, so the origin the sandbox and the message
  // checks key off is unchanged.
  const frameSrc = useMemo(() => {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("lookout_theme", currentTheme());
      return parsed.toString();
    } catch {
      return url;
    }
  }, [url]);

  // The sheet closes itself, then reports.
  //
  // Calling onDone/onDismiss straight away would have the host drop this
  // component on the spot, unmounting the drawer mid-flight — so the sheet
  // vanished instead of sliding out. Instead: flip `open` false, let vaul run
  // its exit, and hand the outcome up in onAnimationEnd. Every route out
  // (done, cancel, X, swipe, Escape, overlay) funnels through requestClose so
  // they all animate identically.
  const [open, setOpen] = useState(true);
  const outcomeRef = useRef<"done" | "dismiss">("dismiss");
  // Set only when WE ask to close. vaul runs onAnimationEnd for its entry
  // animation too, and reports `false` while the content is still settling —
  // acting on that dismissed the sheet the instant it opened, and recorded it
  // as "the user closed this", so the panel could never be shown again.
  const closingRef = useRef(false);
  const requestClose = useCallback((outcome: "done" | "dismiss") => {
    outcomeRef.current = outcome;
    closingRef.current = true;
    setOpen(false);
  }, []);

  // Align the sheet to the app's own frame, not the OS viewport.
  //
  // The drawer portals to <body>, and on Linux the window is undecorated: the
  // app draws itself into a rounded rect inset from the real window edge
  // (index.html, .lookout-csd), with the gap left for its shadow. A sheet
  // pinned to the viewport therefore hangs outside the app — full-bleed across
  // the shadow gap and square where the window is round. Measuring #root and
  // matching it keeps the sheet inside the window on every platform, inset or
  // not.
  const [frame, setFrame] = useState<{
    top: number;
    left: number;
    right: number;
    bottom: number;
    radius: number;
  } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const root = document.getElementById("root");
      if (!root) return setFrame(null);
      const r = root.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(root).borderTopLeftRadius) || 0;
      setFrame({
        top: Math.max(0, Math.round(r.top)),
        left: Math.max(0, Math.round(r.left)),
        right: Math.max(0, Math.round(window.innerWidth - r.right)),
        bottom: Math.max(0, Math.round(window.innerHeight - r.bottom)),
        radius,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Inside an inset frame the sheet has to round its bottom corners too,
  // otherwise it pokes square through the window's rounded ones.
  const insetFromWindow = (frame?.bottom ?? 0) > 0;

  // The drawer is portalled into this, not into <body>.
  //
  // Positioning the sheet to the frame is not enough on its own: vaul slides
  // it in and out with a transform, so on the way past `bottom` it travels
  // straight through the window's edge and into the shadow gap around it —
  // visibly outside the app. A clip layer matching the frame, with the
  // window's own corner radius, contains the whole animation.
  //
  // `translateZ(0)` is load-bearing: it makes this the containing block for
  // the position:fixed drawer inside, so the sheet's own offsets resolve
  // against the frame instead of the viewport.
  const [clip, setClip] = useState<HTMLDivElement | null>(null);


  // Latest callbacks without re-binding the message listener.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  // Assigned below the callback's definition; read only from event handlers.
  const requestCloseRef = useRef<(outcome: "done" | "dismiss") => void>(() => {});

  // The panel drives its own size. Until it says otherwise we show the
  // minimum, so a panel that never sends `resize` is still usable.
  //
  // A LAYOUT effect, deliberately: panels send their first `resize` as soon as
  // they render, and a passive effect can lose that race against a cached
  // frame — leaving the sheet pinned at the minimum until the user happened to
  // change something. useLayoutEffect runs before the browser yields, so the
  // listener is always attached before the frame's scripts can run.
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useLayoutEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      // Once the frame exists, only it may drive the sheet — the sandbox allows
      // popups, and a popup on the panel's origin would otherwise pass the
      // origin check.
      const msg = parsePanelMessage(event, origin, frameRef.current?.contentWindow ?? undefined);
      if (!msg) return;
      switch (msg.type) {
        case "lookout:ready":
          setReady(true);
          break;
        case "lookout:resize":
          setHeight(msg.height);
          break;
        case "lookout:done":
          requestCloseRef.current("done");
          break;
        case "lookout:cancel":
          requestCloseRef.current("dismiss");
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  // `load` alone does not mean "ready to look at", so hold the spinner a beat to
  // let a panel announce itself first.
  //
  // Timed from MOUNT, not from `load`. Two things made the load-gated version
  // deadlock: React can attach `onLoad` after a local frame has already fired
  // it, so `loaded` may never become true; and a frame we keep hidden is a
  // frame the browser does not paint, so a panel measuring itself in
  // requestAnimationFrame never runs and never reports. Either way the wait has
  // to end on its own.
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setGraceElapsed(true), PANEL_READY_GRACE_MS);
    return () => clearTimeout(id);
  }, []);
  const revealed = ready || graceElapsed;

  // A frame that never fires `load` (offline, DNS, a hung server) would sit
  // on a spinner forever. Give it a deadline, then offer the browser.
  useEffect(() => {
    if (loaded || broken) return;
    const id = setTimeout(() => {
      console.warn(`[panel] ${programLabel} panel did not load in time`);
      setBroken(true);
    }, PANEL_LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [loaded, broken, programLabel]);

  requestCloseRef.current = requestClose;

  const openInBrowser = useCallback(() => {
    const target = fallbackUrl || url;
    invoke("open_external_url", { url: target }).catch((e) =>
      console.error("[panel] browser fallback failed:", e),
    );
    requestClose("dismiss");
  }, [fallbackUrl, url, requestClose]);

  // An unusable URL should never have reached us (the server enforces https
  // and so does the caller), so treat it as broken rather than framing it.
  useEffect(() => {
    if (!origin) setBroken(true);
  }, [origin]);

  return (
    <>
      <div
        ref={setClip}
        aria-hidden={clip ? undefined : true}
        style={{
          position: "fixed",
          top: frame?.top ?? 0,
          left: frame?.left ?? 0,
          right: frame?.right ?? 0,
          bottom: frame?.bottom ?? 0,
          borderRadius: frame?.radius ?? 0,
          overflow: "hidden",
          zIndex: 9998,
          transform: "translateZ(0)",
          // Only the sheet and its overlay are interactive; this layer spans
          // the whole window and must not swallow clicks meant for the app.
          pointerEvents: "none",
        }}
      />
      {clip && (
    <Drawer.Root
      open={open}
      // Closing by any route — swipe, Escape, overlay click — is a dismissal,
      // never a completion. Only the program says "done".
      onOpenChange={(next) => {
        if (!next) requestClose("dismiss");
      }}
      // Fires once the exit animation has finished, which is the only safe
      // moment to tell the host: it unmounts us in response. Guarded on
      // `closingRef` because this also fires for the entry animation.
      onAnimationEnd={(isOpen) => {
        if (isOpen || !closingRef.current) return;
        if (outcomeRef.current === "done") onDoneRef.current();
        else onDismissRef.current();
      }}
    >
      <Drawer.Portal container={clip}>
        <Drawer.Overlay
          // Deliberately NOT tagged data-lookout-overlay. That attribute pulls
          // a backdrop in to the visible window (linuxChrome.ts) because
          // modals portal to <body> and would otherwise dim the transparent
          // frame around it. This one is already inside the clip layer, which
          // IS the visible window — so the tag would inset it a second time
          // and leave the dim floating with a 40px margin inside the app.
          style={{
            position: "absolute",
            inset: 0,
            background: colors.bg.backdrop,
            zIndex: 1,
            pointerEvents: "auto",
          }}
        />
        <Drawer.Content
          aria-label={`${programLabel} panel`}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2,
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            outline: "none",
            background: colors.bg.panel,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            // The clip layer rounds the bottom for us — matching the window's
            // radius here as well would double the curve.
            border: `1px solid ${colors.border.default}`,
            borderBottom: insetFromWindow ? undefined : "none",
            overflow: "hidden",
          }}
        >
          {/* Grabber + attribution. Whose UI this is must never be
              ambiguous: the frame is a third party drawing inside our
              window, so it gets a name and a visible boundary. */}
          <div style={{ padding: `${spacing.sm}px ${spacing.md}px`, flexShrink: 0 }}>
            <div
              aria-hidden="true"
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: colors.border.hover,
                margin: "0 auto",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.sm,
                marginTop: spacing.sm,
              }}
            >
              {/* The program's own logo, or nothing. A generic glyph here
                  would be a placeholder standing in for identity, which is
                  the one thing this row exists to establish. */}
              {programIconUrl && !iconFailed && (
                <img
                  src={programIconUrl}
                  alt=""
                  width={18}
                  height={18}
                  draggable={false}
                  onError={() => setIconFailed(true)}
                  style={{
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    objectFit: "contain",
                    borderRadius: 5,
                    display: "block",
                  }}
                />
              )}
              <Drawer.Title
                style={{
                  fontSize: fontSize.md,
                  fontWeight: fontWeight.semibold,
                  color: colors.text.primary,
                  margin: 0,
                  flexShrink: 0,
                }}
              >
                {programLabel}
              </Drawer.Title>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: fontSize.xs,
                  color: colors.text.quaternary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "right",
                }}
              >
                {origin?.replace(/^https?:\/\//, "") ?? ""}
              </span>
              {/* Explicit close. Swipe and Escape both work, but neither is
                  discoverable, and this sheet can be the last thing between
                  someone and their finished timelapse. */}
              <button
                type="button"
                onClick={() => requestClose("dismiss")}
                aria-label="Close"
                title="Close"
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  borderRadius: "50%",
                  border: "none",
                  background: colors.bg.selected,
                  color: colors.text.secondary,
                  cursor: "pointer",
                }}
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            </div>
          </div>

          <motion.div
            // Springs, matching the app's other transitions, and `initial
            // false` so the first paint lands at the loading height instead of
            // unfolding from zero. Steps of a form then spring between sizes
            // rather than sliding on a fixed-duration ease.
            data-vaul-no-drag=""
            initial={false}
            animate={{ height: height + PANEL_HEIGHT_SLACK }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
            style={{
              position: "relative",
              // Not shrinkable, and not capped: the sheet is exactly as tall as
              // the panel asks for. Constraining it here (or on the sheet) left
              // vaul unable to place the sheet at all — it stayed translated
              // off the bottom of the window.
              flexShrink: 0,
              // Taller-than-MAX panels scroll HERE, not inside the frame. The
              // app hides its own scrollbars (index.html), so this surface
              // scrolls without one; the frame's own scrollbar is
              // cross-origin and cannot be styled, so it must never appear.
              overflowY: "auto",
              overflowX: "hidden",
              scrollbarWidth: "none",
            }}
          >
            {broken ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: spacing.md,
                  padding: spacing.xl,
                  textAlign: "center",
                }}
              >
                <WarningCircleIcon size={26} weight="fill" color={colors.text.tertiary} aria-hidden="true" />
                <div style={{ fontSize: fontSize.sm, color: colors.text.secondary, lineHeight: 1.5 }}>
                  {programLabel} couldn&apos;t load here. You can finish up in your
                  browser instead.
                </div>
                <Button variant="primary" size="sm" onClick={openInBrowser}>
                  Open in browser
                </Button>
              </div>
            ) : (
              <>
                <iframe
                  ref={frameRef}
                  // vaul treats a pointerdown anywhere in the sheet as the start
                  // of a drag, which swallows every click before it reaches the
                  // frame — the panel looks rendered but is completely dead.
                  data-vaul-no-drag=""
                  src={frameSrc}
                  title={`${programLabel} panel`}
                  sandbox={PANEL_SANDBOX}
                  onLoad={() => setLoaded(true)}
                  onError={() => setBroken(true)}
                  style={{
                    display: "block",
                    width: "100%",
                    // Full content height, so the frame has no overflow of its
                    // own to scroll. Anything past MAX scrolls on the
                    // container above.
                    height: height + PANEL_HEIGHT_SLACK,
                    border: "none",
                    // The sheet is the only scroll surface; a frame that scrolls
                    // itself shows a scrollbar we cannot style from out here.
                    overflow: "hidden",
                    // The sheet is the surface. A panel that paints no
                    // background of its own sits directly on it, so the
                    // program's content reads as part of the app instead of a
                    // rectangle pasted into it.
                    background: "transparent",
                    colorScheme: "normal",
                    // Faded in so a white-flashing page doesn't strobe the
                    // sheet before its own styles land.
                    opacity: revealed ? 1 : 0,
                    transition: "opacity 0.18s ease-out",
                  }}
                />
                {/* Crossfades with the frame rather than switching: the
                    sheet enters at its loading height and springs to the
                    panel's, and a hard swap mid-spring reads as a flicker. */}
                <motion.div
                  initial={{ opacity: 1 }}
                  animate={{ opacity: revealed ? 0 : 1 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "none",
                  }}
                >
                  <Spinner size="md" />
                </motion.div>
              </>
            )}
          </motion.div>

          <div style={{ height: radii.lg, flexShrink: 0 }} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
      )}
    </>
  );
}
