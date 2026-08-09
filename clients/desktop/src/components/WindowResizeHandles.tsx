/**
 * Resize borders for a window that no longer has any.
 *
 * Taking GTK's decorations away (which is what buys us a real header bar)
 * also takes away the invisible frame you grab to resize. GTK apps that go
 * client-side draw that frame themselves; so do we. Eight strips around the
 * edge, each handing off to the compositor's own resize-drag the moment the
 * pointer goes down — from there the window manager is driving, so snapping,
 * aspect constraints and multi-monitor all behave exactly as they would on a
 * decorated window.
 *
 * Only mounted on Linux, and only for windows that are both undecorated and
 * resizable. The main window is a fixed 480×640 and needs none of this.
 */
import React, { useEffect, useState } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { WINDOW_MARGIN } from "../linuxChrome.js";

/** Mirrors Tauri's ResizeDirection, which the package declares but doesn't export. */
type ResizeDirection =
  | "East" | "North" | "NorthEast" | "NorthWest"
  | "South" | "SouthEast" | "SouthWest" | "West";

/**
 * The grab strips span the whole transparent frame — in GTK that frame is
 * both the shadow's canvas and the invisible border you resize by, and it
 * costs nothing to make it serve both here too.
 */
const GRAB = WINDOW_MARGIN;

/** The corner zones overlap the edges and win, as they do in GTK. */
const CORNER = WINDOW_MARGIN + 12;

interface Zone {
  direction: ResizeDirection;
  cursor: string;
  style: React.CSSProperties;
}

const ZONES: Zone[] = [
  { direction: "North", cursor: "n-resize", style: { top: 0, left: 0, right: 0, height: GRAB } },
  { direction: "South", cursor: "s-resize", style: { bottom: 0, left: 0, right: 0, height: GRAB } },
  { direction: "West", cursor: "w-resize", style: { top: 0, bottom: 0, left: 0, width: GRAB } },
  { direction: "East", cursor: "e-resize", style: { top: 0, bottom: 0, right: 0, width: GRAB } },
  { direction: "NorthWest", cursor: "nw-resize", style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { direction: "NorthEast", cursor: "ne-resize", style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { direction: "SouthWest", cursor: "sw-resize", style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { direction: "SouthEast", cursor: "se-resize", style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];

/**
 * True when the window is flush with an edge of the work area — maximized,
 * or snapped to a half by the window manager.
 *
 * Why this shape: `isMaximized()` answers for maximize alone, and GNOME's
 * side-snap is not maximize. There's no portable "am I tiled" question to
 * ask, so we infer it from the geometry — a snapped window matches the work
 * area exactly along at least one axis.
 *
 * Deliberately compares sizes and not positions: Wayland doesn't tell a
 * client where its own window is, so `outerPosition()` is either unavailable
 * or a lie there, and folding it in would make this wrong on the desktop it
 * most needs to be right on.
 */
async function isFlushWithWorkArea(): Promise<boolean> {
  const win = getCurrentWindow();
  try {
    if (await win.isMaximized()) return true;
    const monitor = await currentMonitor();
    if (!monitor) return false;
    const size = await win.outerSize();
    const work = monitor.workArea.size;
    // A couple of physical pixels of slack, scaled: fractional scaling means
    // an exactly-snapped window can land a pixel off its own work area.
    const slack = Math.max(2, Math.ceil(monitor.scaleFactor));
    return (
      Math.abs(size.height - work.height) <= slack ||
      Math.abs(size.width - work.width) <= slack
    );
  } catch (e) {
    // Rounded corners on a snapped window are a cosmetic wart; a throw here
    // that took the editor down with it would not be.
    console.warn("[csd] could not read window geometry:", e);
    return false;
  }
}

/**
 * Square the window's corners whenever it's snapped or maximized, and round
 * them again when it floats free.
 *
 * Rounded corners on a maximized window leave four notches of desktop
 * showing through, which is the single most obvious way a client-side-
 * decorated app gives itself away.
 */
export function useSquareCornersWhenSnapped(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = async () => {
      const flush = await isFlushWithWorkArea();
      if (cancelled) return;
      document.documentElement.classList.toggle("lookout-snapped", flush);
    };

    // `onResized` fires continuously through a drag, and each check costs a
    // few IPC round trips. Snapping is a discrete event, so trailing-edge
    // debouncing loses nothing and spares the bridge.
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void sync(); }, 100);
    };

    void sync();

    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onResized(schedule).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
      document.documentElement.classList.remove("lookout-snapped");
    };
  }, []);
}

export function WindowResizeHandles() {
  // A snapped or maximized window has no edge to drag — the compositor owns
  // those edges — and leaving live handles there would swallow clicks on
  // content sitting underneath them.
  const [snapped, setSnapped] = useState(false);
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      setSnapped(target.classList.contains("lookout-snapped"));
    });
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    setSnapped(target.classList.contains("lookout-snapped"));
    return () => observer.disconnect();
  }, []);

  if (snapped) return null;

  return (
    <>
      {ZONES.map((zone) => (
        <div
          key={zone.direction}
          aria-hidden="true"
          onMouseDown={(e) => {
            // Left button only: a right-click here should fall through to
            // the window menu, not start a resize.
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(zone.direction).catch((err) => {
              console.warn(`[csd] resize drag (${zone.direction}) failed:`, err);
            });
          }}
          style={{
            position: "fixed",
            zIndex: 10000,
            cursor: zone.cursor,
            ...zone.style,
          }}
        />
      ))}
    </>
  );
}
