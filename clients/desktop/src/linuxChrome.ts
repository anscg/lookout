/**
 * Dressing Lookout like a citizen of the Linux desktop.
 *
 * The shared design system now carries Adwaita's surfaces itself, so the
 * palette isn't this file's job any more. What is: the session's own accent
 * colour and UI font, read from GSettings, plus the chrome that only an
 * undecorated GTK window needs. macOS and Windows never load any of it.
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
 * Linux-only chrome that the shared theme can't carry.
 *
 * The Adwaita palette itself now lives in the shared theme — it's the app's
 * baseline on every platform — so what's left here is the part that only
 * makes sense on a GTK desktop: the header bar's control colours, GTK's
 * cursor behaviour, and the rounded corners an undecorated window owns.
 *
 * Specificity note: these still key off `html.os-linux[data-theme=…]`
 * (0,2,1) because the shared sheet's light block is `:root[data-theme=
 * "light"]` (0,2,0), and loading order can't be relied on — the shared sheet
 * injects itself on first import.
 */
const ADWAITA_CSS = `
  html.os-linux[data-theme="dark"] {
    --color-headerbar-control: rgba(255, 255, 255, 0.1);
    --color-headerbar-control-hover: rgba(255, 255, 255, 0.18);
    /* Adwaita's popover_bg_color. Note it is LIGHTER than the #242424
       window, not darker: a GTK popover is an elevated surface, and
       reaching for the app's "panel" colour (a recessed one) is what makes
       a menu read as a hole in the window instead of a thing floating above
       it. */
    --color-popover-bg: #383838;
    /* GNOME's popovers aren't a flat fill — there's a slight vertical
       lift, lighter at the top. The tail sits above the panel, so it takes
       this top stop rather than the base colour. */
    --color-popover-bg-top: #3d3d3d;
    /* A light edge, not a dark one. The popover is an elevated surface
       sitting on a darker window, so its outline reads as the light catching
       the lifted edge; a dark border just sinks into the window behind it. */
    --color-popover-border: rgba(255, 255, 255, 0.14);
    --color-popover-hover: rgba(255, 255, 255, 0.1);
    --color-popover-separator: rgba(255, 255, 255, 0.15);
  }
  html.os-linux[data-theme="light"] {
    --color-headerbar-control: rgba(0, 0, 0, 0.08);
    --color-headerbar-control-hover: rgba(0, 0, 0, 0.16);
    --color-popover-bg: #f7f7f7;
    --color-popover-bg-top: #ffffff;
    --color-popover-border: rgba(0, 0, 0, 0.12);
    --color-popover-hover: rgba(0, 0, 0, 0.08);
    --color-popover-separator: rgba(0, 0, 0, 0.12);
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

// Injected on import rather than from applyLinuxChrome's effect, for the
// same reason HeaderBar's sheet is: an effect runs after the first paint, so
// the frame before it has --color-headerbar-control undefined and the window
// controls render with no background at all.
if (isLinux && typeof document !== "undefined" && !document.querySelector("style[data-lookout-linux-chrome]")) {
  const style = document.createElement("style");
  style.setAttribute("data-lookout-linux-chrome", "");
  style.textContent = ADWAITA_CSS;
  document.head.appendChild(style);
}

/**
 * Apply the Adwaita palette immediately, then fold in whatever GSettings
 * reports once it answers.
 *
 * `undecorated` says this window has had its GTK titlebar removed and is
 * therefore responsible for its own corners and header bar.
 *
 * The stylesheet itself is already in the document by the time this runs —
 * it goes in on import, above. What's left here needs a round trip to the
 * native side, so it necessarily lands a moment after the window opens;
 * that's better than holding the first paint hostage to an IPC call.
 */
export async function applyLinuxChrome(
  { undecorated = false }: { undecorated?: boolean } = {},
): Promise<DesktopAppearance> {
  if (!isLinux) return DEFAULT_APPEARANCE;

  document.documentElement.classList.add("os-linux");
  // Opts this window into drawing its own rounded corners. Only the windows
  // that actually had their decorations taken away may claim it.
  if (undecorated) document.documentElement.classList.add("lookout-csd");

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
