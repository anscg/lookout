import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { colors, fontWeight } from "@lookout/react";
import { isLinux } from "../platform.js";

/**
 * DOM replica of the macOS native add menu (AddMenu.swift) for Windows/Linux,
 * where a SwiftUI NSPanel isn't available. Same look: translucent blurred
 * panel anchored under the + button, fling-in spring scaled from the top-right,
 * hover/arrow-key selection, Escape or click-away to dismiss. The visual
 * constants mirror the Swift file — update both together.
 *
 * Linux dresses differently. GTK popovers are a solid panel with a quiet
 * shadow and 6px item rows — no blur, no saturation boost, and none of the
 * spring overshoot, which is a macOS mannerism. Behaviour is identical; only
 * the material changes.
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
        gap: 9,
        padding: isLinux ? "8px 10px" : "7px 9px",
        borderRadius: isLinux ? 6 : 9,
        background: highlighted
          ? `color-mix(in srgb, ${colors.text.primary} 9%, transparent)`
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
      <span style={{ fontSize: 13.5, fontWeight: isLinux ? fontWeight.normal : fontWeight.medium, color: colors.text.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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

  const right = Math.max(EDGE, window.innerWidth - (anchor.x + anchor.width));

  return (
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, scale: isLinux ? 0.96 : 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      // Exit is a plain quick fade — no scale change.
      exit={{ opacity: 0, transition: { duration: 0.1, ease: "easeOut" } }}
      transition={
        isLinux
          // GTK popovers settle rather than overshoot.
          ? { scale: { duration: 0.14, ease: [0.2, 0, 0, 1] }, opacity: { duration: 0.1 } }
          : {
              scale: { type: "spring", stiffness: 1800, damping: 56 },
              opacity: { duration: 0.1 },
            }
      }
      style={{
        position: "fixed",
        right,
        ...(flipped
          ? { bottom: window.innerHeight - anchor.y + GAP }
          : { top: anchor.y + anchor.height + GAP }),
        zIndex: 10000,
        minWidth: 220,
        maxWidth: Math.min(320, window.innerWidth - right - EDGE),
        padding: 6,
        boxSizing: "border-box",
        ...(isLinux
          ? {
              // Adwaita's popover: solid, 12px, a quiet two-stop shadow.
              // Blur and a saturation boost are a macOS material and read as
              // borrowed here.
              borderRadius: 12,
              border: `1px solid ${colors.border.default}`,
              background: colors.bg.panel,
              boxShadow: "0 1px 4px rgba(0, 0, 0, 0.15), 0 6px 20px rgba(0, 0, 0, 0.25)",
            }
          : {
              borderRadius: 14,
              border: `1px solid color-mix(in srgb, ${colors.text.primary} 12%, transparent)`,
              // Opaque enough that content behind never ghosts through — the
              // backdrop blur only reads as a soft material at the edges.
              background: `color-mix(in srgb, ${colors.bg.panel} 86%, transparent)`,
              backdropFilter: "blur(32px) saturate(1.7)",
              WebkitBackdropFilter: "blur(32px) saturate(1.7)",
              boxShadow: "0 6px 32px rgba(0, 0, 0, 0.28)",
            }),
        transformOrigin: flipped ? "bottom right" : "top right",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} style={{ height: 1, background: colors.border.default, margin: "4px 10px" }} />
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
