import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { XIcon } from "@phosphor-icons/react";
import { colors, spacing, fontSize, fontWeight } from "@lookout/react";
import { backdropFill } from "../backdrop.js";
import type { Tip } from "../tip.js";

/**
 * The tip sheet: hero image, badge, headline, paragraph, and an X.
 *
 * Content comes from the server; this file knows the shape of a tip, never
 * the contents of one. App drives `open` and keeps the component mounted for
 * as long as a tip is published, so the close animation is survived here
 * (`present`) rather than by the host.
 */

/** Inset from the window on three sides — the sheet floats, it isn't docked. */
const SHEET_INSET = spacing.xxl;
const SHEET_RADIUS = 24;
const HERO_HEIGHT = 210;
const CLOSE_SIZE = 34;

export interface TipDrawerProps {
  tip: Tip | null;
  open: boolean;
  onClose: () => void;
}

export function TipDrawer({ tip, open, onClose }: TipDrawerProps) {
  const [heroBroken, setHeroBroken] = useState(false);

  // useTip warms the hero at startup, so it usually paints with the sheet.
  // For the rest — published seconds ago, cold cache, slow host — fade it in
  // over the reserved band instead of letting it snap in late. A warm image
  // is `complete` before React can hear `load`, hence both paths.
  const rawHeroUrl = tip?.imageUrl ?? null;
  const heroRef = useRef<HTMLImageElement>(null);
  const [heroLoaded, setHeroLoaded] = useState(false);
  useLayoutEffect(() => {
    setHeroBroken(false);
    setHeroLoaded(Boolean(heroRef.current?.complete));
  }, [rawHeroUrl]);

  // Align to the app's own frame, not the OS viewport. On Linux the window is
  // undecorated and inset from its real edge for the shadow, so a
  // viewport-pinned sheet hangs outside the app — and vaul's transform carries
  // it through that gap even when the resting position is right.
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

  const [clip, setClip] = useState<HTMLDivElement | null>(null);

  // The clip layer outlives `open` so vaul can animate the exit inside it,
  // but not the whole session — it's a full-window compositor layer above the
  // app. Timed rather than vaul's onAnimationEnd, which also fires for the
  // entry animation (see ProgramPanel's closingRef).
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const t = setTimeout(() => setPresent(false), 600); // vaul's exit is 500ms
    return () => clearTimeout(t);
  }, [open, present]);

  if (!tip || !present) return null;

  const heroUrl = heroBroken ? null : rawHeroUrl;
  // Without a hero the X drops into the copy, so the headline must clear it.
  const titleClearance = heroUrl ? 0 : CLOSE_SIZE + spacing.sm;

  return (
    <>
      {/* `translateZ(0)` is load-bearing: it makes this the containing block
          for the position:fixed sheet, so the sheet's offsets resolve against
          the app frame instead of the viewport. */}
      <div
        ref={setClip}
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
          pointerEvents: "none",
        }}
      />
      {clip && (
        <Drawer.Root
          open={open}
          onOpenChange={(next) => {
            if (!next) onClose();
          }}
        >
          <Drawer.Portal container={clip}>
            <Drawer.Overlay
              // Not tagged data-lookout-overlay: the clip layer is already the
              // visible window, so the Linux CSD rule would inset it twice.
              style={{
                position: "absolute",
                inset: 0,
                background: backdropFill,
                zIndex: 1,
                pointerEvents: "auto",
              }}
            />
            {/* Reaches the window's edge and holds the inset as padding. vaul
                closes by translating down 100% of its own height, which from
                an inset resting position leaves a sliver parked at the bottom;
                padding counts toward that height. The sheet is the inner div. */}
            <Drawer.Content
              aria-label={tip.title}
              style={{
                position: "absolute",
                left: SHEET_INSET,
                right: SHEET_INSET,
                bottom: 0,
                paddingBottom: SHEET_INSET,
                boxSizing: "border-box",
                zIndex: 2,
                pointerEvents: "auto",
                display: "flex",
                flexDirection: "column",
                outline: "none",
                background: "transparent",
              }}
            >
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  background: colors.bg.panel,
                  border: `1px solid ${colors.border.default}`,
                  borderRadius: SHEET_RADIUS,
                  overflow: "hidden",
                  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.45)",
                }}
              >
                {heroUrl && (
                  <div
                    style={{
                      height: HERO_HEIGHT,
                      flexShrink: 0,
                      background: colors.bg.sunken,
                      position: "relative",
                    }}
                  >
                    <img
                      ref={heroRef}
                      src={heroUrl}
                      alt=""
                      onLoad={() => setHeroLoaded(true)}
                      onError={() => setHeroBroken(true)}
                      style={{
                        display: "block",
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        opacity: heroLoaded ? 1 : 0,
                        transition: "opacity 220ms ease-out",
                        // Dragging an image in a webview starts a native drag
                        // that fights the sheet's own gesture.
                        pointerEvents: "none",
                        userSelect: "none",
                      }}
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  // vaul reads a pointerdown anywhere in the sheet as a drag.
                  data-vaul-no-drag=""
                  style={{
                    position: "absolute",
                    top: spacing.xl,
                    right: spacing.lg + 2,
                    width: CLOSE_SIZE,
                    height: CLOSE_SIZE,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    background: colors.badge.overlayBg,
                    color: colors.badge.overlayText,
                    zIndex: 1,
                  }}
                >
                  <XIcon size={15} weight="bold" aria-hidden="true" />
                </button>

                <div
                  style={{
                    padding: spacing.xxl,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    // Capping the height leaves vaul unable to place the sheet
                    // at all (see ProgramPanel).
                    flexShrink: 0,
                  }}
                >
                  {tip.badge && (
                    <span
                      style={{
                        display: "inline-block",
                        padding: `3px ${spacing.sm}px`,
                        marginBottom: 10,
                        borderRadius: 4,
                        background: colors.text.primary,
                        color: colors.text.inverse,
                        fontSize: fontSize.sm,
                        fontWeight: fontWeight.semibold,
                        letterSpacing: "-0.4px",
                        lineHeight: 1.15,
                      }}
                    >
                      {tip.badge}
                    </span>
                  )}
                  <Drawer.Title
                    style={{
                      margin: 0,
                      fontSize: fontSize.xxl,
                      fontWeight: fontWeight.semibold,
                      letterSpacing: "-0.36px",
                      color: colors.text.primary,
                      lineHeight: 1.25,
                      paddingRight: titleClearance,
                    }}
                  >
                    {tip.title}
                  </Drawer.Title>
                  <Drawer.Description
                    style={{
                      margin: `${spacing.sm}px 0 0`,
                      fontSize: fontSize.lg,
                      color: colors.text.secondary,
                      lineHeight: 1.45,
                    }}
                  >
                    {tip.body}
                  </Drawer.Description>
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </>
  );
}
