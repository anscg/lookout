/**
 * Dressing Lookout like a citizen of the Linux desktop.
 *
 * The shared design system is tuned for macOS: pure black on dark, pure
 * white on light, a fixed blue accent, and a bundled typeface. Every one of
 * those reads as "web app in a window" next to an Adwaita app, where the
 * window is #242424, the accent is whatever the user picked in Settings, and
 * the type is the desktop's own.
 *
 * So on Linux — and only on Linux — we overlay Adwaita's palette on the
 * theme's custom properties and pull the session's accent and UI font in
 * from GSettings. macOS and Windows never load any of this.
 */
import { setAccentColor } from "@lookout/react";
import { isLinux } from "./platform.js";
import { invoke } from "./logger.js";

export interface DesktopAppearance {
  accent: string | null;
  fontFamily: string | null;
  controlsOnRight: boolean;
}

export const DEFAULT_APPEARANCE: DesktopAppearance = {
  accent: null,
  fontFamily: null,
  controlsOnRight: true,
};

/** The header bar's height, in px. Adwaita's is 46 plus a 1px hairline. */
export const HEADER_BAR_HEIGHT = 47;

/** Adwaita rounds windows and dialogs at 12px; the shared tokens stop at 10. */
export const WINDOW_RADIUS = 12;

/**
 * Adwaita's own colours, mapped onto Lookout's tokens.
 *
 * Specificity matters here: the shared sheet defines light mode as
 * `:root[data-theme="light"]` (0,2,0), so an override has to carry at least
 * as much weight — hence `html.os-linux[data-theme=…]` (0,2,1) rather than
 * the `:root` these normally live on. Loading order can't be relied on,
 * since the shared sheet injects itself on first import.
 */
const ADWAITA_CSS = `
  html.os-linux[data-theme="dark"] {
    --color-bg-body: #242424;
    --color-bg-panel: #1e1e1e;
    --color-bg-surface: rgba(255, 255, 255, 0.08);
    --color-bg-sunken: rgba(255, 255, 255, 0.04);
    --color-bg-selected: rgba(255, 255, 255, 0.12);
    --color-modal-backdrop: rgba(0, 0, 0, 0.55);
    --color-text-secondary: rgba(255, 255, 255, 0.7);
    --color-text-tertiary: rgba(255, 255, 255, 0.5);
    --color-text-quaternary: rgba(255, 255, 255, 0.28);
    --color-border-default: rgba(255, 255, 255, 0.12);
    --color-border-hover: rgba(255, 255, 255, 0.22);
    --color-skeleton-bg: rgba(255, 255, 255, 0.06);
    --color-skeleton-shimmer: rgba(255, 255, 255, 0.12);
    --color-well: rgba(0, 0, 0, 0.32);
    --color-well-border: rgba(255, 255, 255, 0.1);
    --color-track: rgba(255, 255, 255, 0.1);
    --color-headerbar-control: rgba(255, 255, 255, 0.1);
    --color-headerbar-control-hover: rgba(255, 255, 255, 0.18);
  }
  html.os-linux[data-theme="light"] {
    --color-bg-body: #fafafa;
    --color-bg-panel: #ffffff;
    --color-bg-surface: #ffffff;
    --color-bg-sunken: rgba(0, 0, 0, 0.04);
    --color-bg-selected: rgba(0, 0, 0, 0.1);
    --color-modal-backdrop: rgba(0, 0, 0, 0.35);
    --color-text-primary: rgba(0, 0, 0, 0.85);
    --color-text-secondary: rgba(0, 0, 0, 0.65);
    --color-text-tertiary: rgba(0, 0, 0, 0.45);
    --color-text-quaternary: rgba(0, 0, 0, 0.25);
    --color-border-default: rgba(0, 0, 0, 0.12);
    --color-border-hover: rgba(0, 0, 0, 0.22);
    --color-well: rgba(0, 0, 0, 0.08);
    --color-well-border: rgba(0, 0, 0, 0.1);
    --color-track: rgba(0, 0, 0, 0.08);
    --color-headerbar-control: rgba(0, 0, 0, 0.08);
    --color-headerbar-control-hover: rgba(0, 0, 0, 0.16);
  }
  /* GTK never swaps in a hand cursor over a button — the pointer is a web
     convention, and having it follow every control around is one of the
     small constant reminders that this is a web view.

     !important because the app sets cursor:pointer inline in a couple of
     dozen components, and forking each of them per platform would be a far
     worse trade than one scoped override. The selector deliberately does
     NOT match everything: the resize handles and the editor's scrub cursors
     carry real information, and they set their own values. */
  html.os-linux button,
  html.os-linux a,
  html.os-linux [role="button"],
  html.os-linux [style*="cursor: pointer"] {
    cursor: default !important;
  }
  html.os-linux input,
  html.os-linux textarea,
  html.os-linux [contenteditable="true"] {
    cursor: text !important;
  }
  /* Undecorated windows draw their own corners. They're clipped on #root
     rather than the body because the body has to stay transparent for the
     rounding to show anything but a square. Opt in per window, since a
     window that kept its GTK titlebar must not round its own content. */
  html.os-linux.lookout-csd, html.os-linux.lookout-csd body {
    background: transparent;
  }
  html.os-linux.lookout-csd {
    --lookout-window-radius: ${WINDOW_RADIUS}px;
  }
  /* Snapped or maximized: the window is flush with the screen edge, and
     rounding it there leaves four notches of desktop showing through — the
     clearest tell that an app is drawing its own decorations badly. */
  html.os-linux.lookout-csd.lookout-snapped {
    --lookout-window-radius: 0px;
  }
  html.os-linux.lookout-csd #root {
    background: var(--color-bg-body);
    border-radius: var(--lookout-window-radius);
    overflow: hidden;
  }
`;

/**
 * White or black, whichever stays legible on the given accent.
 *
 * GNOME's accent palette runs from a dark purple to a fairly bright yellow,
 * and white-on-yellow is the one combination that fails outright.
 */
export function accentForeground(hex: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return "#ffffff";
  const channel = (offset: number) => {
    const srgb = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "#000000" : "#ffffff";
}

/**
 * The font stack to run on Linux: the desktop's configured UI font first,
 * then the families GNOME has shipped as its default across versions, then
 * whatever the session calls `system-ui`.
 */
export function linuxFontStack(family: string | null): string {
  const fallbacks = ['Adwaita Sans', 'Cantarell'];
  const families = family ? [family, ...fallbacks.filter((f) => f !== family)] : fallbacks;
  return [...families.map((f) => `"${f}"`), 'system-ui', '"Geist"', 'sans-serif'].join(', ');
}

let injected = false;

/**
 * Apply the Adwaita palette immediately, then fold in whatever GSettings
 * reports once it answers.
 *
 * `undecorated` says this window has had its GTK titlebar removed and is
 * therefore responsible for its own corners and header bar.
 *
 * Split in two on purpose: the palette is static and can land before first
 * paint, while the accent and font need a round trip to the native side.
 * Waiting for that round trip to paint anything would show a black window
 * first and recolour it a frame later, which is worse than an accent that
 * settles a moment after the window opens.
 */
export async function applyLinuxChrome(
  { undecorated = false }: { undecorated?: boolean } = {},
): Promise<DesktopAppearance> {
  if (!isLinux) return DEFAULT_APPEARANCE;

  document.documentElement.classList.add("os-linux");
  // Opts this window into drawing its own rounded corners. Only the windows
  // that actually had their decorations taken away may claim it.
  if (undecorated) document.documentElement.classList.add("lookout-csd");

  if (!injected) {
    injected = true;
    const style = document.createElement("style");
    style.setAttribute("data-lookout-linux-chrome", "");
    style.textContent = ADWAITA_CSS;
    document.head.appendChild(style);
  }

  let appearance = DEFAULT_APPEARANCE;
  try {
    appearance = await invoke<DesktopAppearance>("desktop_appearance");
  } catch (e) {
    console.warn("[linux-chrome] could not read desktop appearance:", e);
    return DEFAULT_APPEARANCE;
  }

  if (appearance.accent) {
    setAccentColor(appearance.accent, accentForeground(appearance.accent));
  }
  document.body.style.fontFamily = linuxFontStack(appearance.fontFamily);

  return appearance;
}
