import { useEffect, useLayoutEffect, useState } from "react";
import { Drawer } from "vaul";
import { XIcon } from "@phosphor-icons/react";
import { colors, spacing } from "@lookout/react";
import { backdropFill } from "../backdrop.js";

/** Inset from the window on three sides — the sheet floats, it isn't docked. */
export const SHEET_INSET = spacing.xxl;
export const SHEET_RADIUS = 24;
export const SHEET_CLOSE_SIZE = 34;

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Full-bleed band above the body, e.g. a hero image. */
  hero?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The bottom sheet chrome shared by the tip and update drawers: the clip layer
 * that keeps vaul inside the app frame, the backdrop, and the close button.
 * Callers own the body and supply their own Drawer.Title/Description.
 */
export function Sheet({ open, onClose, ariaLabel, hero, children }: SheetProps) {
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

  // The clip layer outlives `open` so vaul can animate the exit inside it, but
  // not the whole session — it's a full-window compositor layer above the app.
  // Timed rather than vaul's onAnimationEnd, which also fires for the entry
  // animation (see ProgramPanel's closingRef).
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

  if (!present) return null;

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
              aria-label={ariaLabel}
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
                {hero}
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
                    width: SHEET_CLOSE_SIZE,
                    height: SHEET_CLOSE_SIZE,
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
                  {children}
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </>
  );
}
