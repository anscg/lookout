import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { colors, fontWeight } from "@lookout/react";
import { isLinux } from "../platform.js";

/**
 * DOM replica of the macOS native add menu (AddMenu.swift) for Windows/Linux,
 * where a SwiftUI NSPanel isn't available. Same look: a panel anchored under
 * the + button, fling-in spring scaled from the top-right, hover/arrow-key
 * selection, Escape or click-away to dismiss. The visual constants mirror the
 * Swift file — update both together, apart from the material (see below).
 *
 * Linux dresses differently: a GTK popover is an elevated solid panel with
 * a tail pointing back at its anchor, a quiet shadow and roomy 32px rows —
 * no blur and no saturation boost, which are macOS materials. Only the
 * material and metrics change; behaviour, keyboard handling, anchoring and
 * the open/close animation are shared with every other platform.
 */

export interface AddMenuPopupItem {
  id?: string;
  label?: string;
  /** Remote image shown instead of `fallbackIcon`, which stays the fallback. */
  iconUrl?: string;
  /** Rendered while the image loads/fails or when there's no iconUrl. */
  fallbackIcon?: React.ReactNode;
  separator?: boolean;
}

export interface AddMenuPopupAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AddMenuPopupProps {
  items: AddMenuPopupItem[];
  anchor: AddMenuPopupAnchor;
  /** Called with the chosen item id, or null on dismissal. */
  onSelect: (id: string | null) => void;
}

const GAP = 6; // px between the button and the menu
const EDGE = 8; // min distance from the viewport edges

/** GTK's popover tail: the little triangle aimed back at the anchor. */
const TAIL_W = 20;
const TAIL_H = 10;
/** Keeps the tail clear of the popover's rounded corners. */
const TAIL_INSET = 14;

function Row({ item, highlighted, onHover, onLeave, onActivate }: {
  item: AddMenuPopupItem;
  highlighted: boolean;
  onHover: () => void;
  onLeave: () => void;
  onActivate: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = !!item.iconUrl && !failed;
  return (
    <div
      role="menuitem"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onActivate}
      style={{
        display: "flex",
        alignItems: "center",
        gap: isLinux ? 12 : 9,
        // Adwaita's modelbutton: a 32px row with the label inset 12px, not
        // the tighter, denser rhythm of a macOS menu.
        minHeight: isLinux ? 32 : undefined,
        padding: isLinux ? "0 12px" : "7px 9px",
        borderRadius: isLinux ? 6 : 9,
        background: highlighted
          ? isLinux
            ? "var(--color-popover-hover)"
            : `color-mix(in srgb, ${colors.text.primary} 9%, transparent)`
          : "transparent",
        cursor: "default",
        userSelect: "none",
      }}
    >
      <span style={{ width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: highlighted ? colors.text.primary : colors.text.secondary }}>
        {showImage ? (
          <img
            src={item.iconUrl}
            alt=""
            width={18}
            height={18}
            draggable={false}
            onError={() => setFailed(true)}
            style={{ width: 18, height: 18, objectFit: "contain", borderRadius: 5, display: "block" }}
          />
        ) : (
          item.fallbackIcon
        )}
      </span>
      <span style={{ fontSize: isLinux ? 14.5 : 13.5, fontWeight: isLinux ? fontWeight.normal : fontWeight.medium, color: colors.text.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {item.label}
      </span>
    </div>
  );
}

export function AddMenuPopup({ items, anchor, onSelect }: AddMenuPopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<number | null>(null);
  // Drops below the anchor by default; flipped above when there's no room.
  const [flipped, setFlipped] = useState(false);

  // Keep the latest onSelect without re-binding the listeners below.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const below = anchor.y + anchor.height + GAP;
    setFlipped(below + el.offsetHeight > window.innerHeight - EDGE);
  }, [anchor, items]);

  // Click-away and window blur dismiss, like the NSPanel's resignKey.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && el.contains(e.target as Node)) return;
      // The + button itself toggles the menu in its click handler; closing
      // here too would make that click immediately reopen it.
      if (
        e.clientX >= anchor.x && e.clientX <= anchor.x + anchor.width &&
        e.clientY >= anchor.y && e.clientY <= anchor.y + anchor.height
      ) return;
      onSelectRef.current(null);
    };
    const onBlur = () => onSelectRef.current(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor]);

  // Escape / arrows / enter, mirroring the Swift key monitor.
  useEffect(() => {
    const selectable = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => !item.separator)
      .map(({ i }) => i);
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onSelectRef.current(null);
          break;
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          if (selectable.length === 0) return;
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setSelection((current) => {
            const pos = current === null ? -1 : selectable.indexOf(current);
            if (pos === -1) return delta > 0 ? selectable[0] : selectable[selectable.length - 1];
            return selectable[(pos + delta + selectable.length) % selectable.length];
          });
          break;
        }
        case "Enter":
          e.preventDefault();
          setSelection((current) => {
            if (current !== null && !items[current].separator) {
              onSelectRef.current(items[current].id ?? null);
            }
            return current;
          });
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [items]);

  // Right-aligned to the anchor to begin with, the way the macOS menu is.
  const alignedRight = Math.max(EDGE, window.innerWidth - (anchor.x + anchor.width));

  // The tail has to point at the middle of the button AND stay clear of the
  // popover's rounded corner. Those fight each other on a small button: the
  // + is 30px wide, so its centre is only 15px in, and holding the tail
  // TAIL_INSET from the edge would leave it aiming ~9px wide of the icon.
  //
  // Resolve it by moving the popover, not the tail — slide the whole panel
  // right until the tail's proper position clears the corner on its own.
  const centreFromAligned = window.innerWidth - (anchor.x + anchor.width / 2) - alignedRight;
  const shift = Math.max(0, TAIL_INSET + TAIL_W / 2 - centreFromAligned);
  const right = Math.max(EDGE, alignedRight - shift);

  // Now this lands on the anchor's centre exactly; the clamp is only a
  // backstop for when the window edge stopped the shift short.
  const tailRight = Math.max(
    TAIL_INSET,
    window.innerWidth - (anchor.x + anchor.width / 2) - right - TAIL_W / 2,
  );
  const tailCentreFromRight = tailRight + TAIL_W / 2;

  return (
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      // Exit is a plain quick fade — no scale change.
      exit={{ opacity: 0, transition: { duration: 0.1, ease: "easeOut" } }}
      transition={{
        scale: { type: "spring", stiffness: 1800, damping: 56 },
        opacity: { duration: 0.1 },
      }}
      style={{
        position: "fixed",
        right,
        ...(flipped
          ? { bottom: window.innerHeight - anchor.y + GAP + (isLinux ? TAIL_H : 0) }
          : { top: anchor.y + anchor.height + GAP + (isLinux ? TAIL_H : 0) }),
        zIndex: 10000,
        minWidth: 220,
        maxWidth: Math.min(320, window.innerWidth - right - EDGE),
        padding: 6,
        boxSizing: "border-box",
        ...(isLinux
          ? {
              // Adwaita's popover: an elevated solid surface, 12px, with a
              // soft three-stop shadow. Blur and a saturation boost are a
              // macOS material and read as borrowed here.
              borderRadius: 12,
              border: "1px solid var(--color-popover-border)",
              // Not a flat fill: GNOME's popovers carry a slight vertical
              // lift, lighter at the top. The tail picks up the same top
              // stop so the two read as one surface.
              background:
                "linear-gradient(to bottom, var(--color-popover-bg-top), var(--color-popover-bg))",
              // Much lighter than a macOS menu's. GNOME's popovers sit close
              // to the surface — the shadow reads as a hint of separation
              // rather than the panel being lifted off the window.
              boxShadow:
                "0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.1), 0 10px 28px rgba(0, 0, 0, 0.12)",
            }
          : {
              borderRadius: 14,
              border: `1px solid color-mix(in srgb, ${colors.text.primary} 12%, transparent)`,
              // Solid, unlike the Swift file's translucent material: Mica
              // sits behind a transparent page here, so a backdrop blur has
              // nothing to soften and translucency just shows the wallpaper
              // through. Filling it in is what makes it read as a menu.
              background: colors.bg.panel,
              boxShadow: "0 6px 32px rgba(0, 0, 0, 0.28)",
            }),
        // A GTK popover grows out of its tail — that's the point it's
        // pinned to. The corner is only the right origin on macOS, where
        // there is no tail; here it would have the panel unfold from a spot
        // several pixels away from what it's pointing at, made worse by the
        // shift that aligns the tail in the first place.
        transformOrigin: isLinux
          ? `calc(100% - ${tailCentreFromRight}px) ${flipped ? "bottom" : "top"}`
          : flipped
            ? "bottom right"
            : "top right",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {isLinux && (
        // Drawn as an SVG rather than a clip-path triangle so the popover's
        // 1px outline can carry on around the tail — a bare shape leaves two
        // unstroked diagonals, which is very visible against a light popover.
        //
        // The viewBox runs 1px past the base and the element overlaps the
        // popover by that much, so the tail's fill covers the popover's own
        // top border underneath it. Otherwise the outline would read as a
        // triangle sitting on a line rather than one continuous edge.
        <svg
          aria-hidden="true"
          width={TAIL_W}
          height={TAIL_H}
          viewBox={`0 0 ${TAIL_W} ${TAIL_H}`}
          style={{
            position: "absolute",
            right: tailRight,
            // Offsets are measured from the PADDING box, so -TAIL_H puts the
            // SVG's bottom edge exactly on the popover's inner edge and its
            // last 1px squarely over the popover's own top border.
            ...(flipped ? { bottom: -TAIL_H } : { top: -TAIL_H }),
            display: "block",
            transform: flipped ? "scaleY(-1)" : undefined,
          }}
        >
          {/* Fill runs the full height so it hides the popover's top border
              across the tail's width — otherwise the outline reads as a
              triangle standing on a line instead of one continuous edge. */}
          <path
            d={`M0 ${TAIL_H} L${TAIL_W / 2} 0.5 L${TAIL_W} ${TAIL_H} Z`}
            fill="var(--color-popover-bg-top)"
          />
          {/* Open polyline: strokes the two diagonals and not the base. It
              stops 1px short of the fill, on the popover border's own outer
              edge, so the two outlines meet flush. Running it to the full
              height instead leaves the stroke poking past the border into
              the panel — two stray ticks under the tail. */}
          <path
            d={`M0.5 ${TAIL_H - 1} L${TAIL_W / 2} 1 L${TAIL_W - 0.5} ${TAIL_H - 1}`}
            fill="none"
            stroke="var(--color-popover-border)"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={i}
            style={{
              height: 1,
              background: isLinux ? "var(--color-popover-separator)" : colors.border.default,
              margin: isLinux ? "5px 0" : "4px 10px",
            }}
          />
        ) : (
          <Row
            key={item.id ?? i}
            item={item}
            highlighted={selection === i}
            onHover={() => setSelection(i)}
            onLeave={() => setSelection((s) => (s === i ? null : s))}
            onActivate={() => onSelect(item.id ?? null)}
          />
        ),
      )}
    </motion.div>
  );
}
