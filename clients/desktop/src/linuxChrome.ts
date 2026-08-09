/**
 * Dressing Lookout like a citizen of the Linux desktop.
 *
 * The shared design system now carries Adwaita's surfaces itself, so the
 * palette isn't this file's job any more. What is: the session's own accent
 * colour and UI font, read from GSettings, plus the chrome that only an
 * undecorated GTK window needs. macOS and Windows never load any of it.
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
 * Transparent frame reserved around the visible window, in px per side.
 *
 * A window is normally exactly the size of its content, which leaves nowhere
 * to draw an outer border or a shadow — both paint outside the content box,
 * i.e. off the window, where the compositor clips them. GTK solves this by
 * making the window bigger than it looks and keeping the extra transparent;
 * the shadow lives in there, and so does the invisible frame you grab to
 * resize. Same trick here.
 *
 * The native side grows each window by twice this (lib.rs for the main
 * window, EditorWindow.tsx for the editor), so the content keeps its
 * intended size.
 */
export const WINDOW_MARGIN = 20;

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
    --color-window-border: rgba(255, 255, 255, 0.18);
  }
  html.os-linux[data-theme="light"] {
    --color-headerbar-control: rgba(0, 0, 0, 0.08);
    --color-headerbar-control-hover: rgba(0, 0, 0, 0.16);
    --color-popover-bg: #f7f7f7;
    --color-popover-bg-top: #ffffff;
    --color-popover-border: rgba(0, 0, 0, 0.12);
    --color-popover-hover: rgba(0, 0, 0, 0.08);
    --color-popover-separator: rgba(0, 0, 0, 0.12);
    --color-window-border: rgba(0, 0, 0, 0.18);
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
    --lookout-window-margin: ${WINDOW_MARGIN}px;
  }
  /* Snapped or maximized: the window is flush with the screen edge, and
     rounding it there leaves four notches of desktop showing through — the
     clearest tell that an app is drawing its own decorations badly. */
  html.os-linux.lookout-csd.lookout-snapped {
    --lookout-window-radius: 0px;
  }
  /* The visible window: inset from the real one by the transparent frame,
     so the outer border and the shadow have somewhere to land. Both are
     spread/blur on one box-shadow — the 1px spread ring IS the outer
     border, which keeps it off the content box entirely and lets it follow
     the corner radius. */
  html.os-linux.lookout-csd #root {
    position: fixed;
    inset: var(--lookout-window-margin);
    height: auto;
    background: var(--color-bg-body);
    border-radius: var(--lookout-window-radius);
    overflow: hidden;
    /* Wide and faint rather than tight and dark. A compositor shadow is
       mostly a large, very soft falloff — reading the alpha off a dark
       screenshot tempts you into something far heavier than GNOME's, which
       then looks like a drop shadow on a web card. */
    box-shadow:
      0 0 0 1px var(--color-window-border),
      0 4px 12px rgba(0, 0, 0, 0.1),
      0 14px 40px rgba(0, 0, 0, 0.14);
    transition: box-shadow 160ms ease-out;
  }
  /* Unfocused windows cast less. GTK pulls its shadow back in :backdrop so
     the focused window is the one that looks lifted. */
  html.os-linux.lookout-csd.lookout-backdrop #root {
    box-shadow:
      0 0 0 1px var(--color-window-border),
      0 2px 8px rgba(0, 0, 0, 0.06),
      0 8px 24px rgba(0, 0, 0, 0.09);
  }
  /* Snapped or maximized: the frame collapses so the content fills the
     screen edge to edge, and the outline and shadow have nothing to
     separate the window from. */
  html.os-linux.lookout-csd.lookout-snapped #root {
    inset: 0;
    border-radius: 0;
    box-shadow: none;
  }
  /* Modal backdrops portal to <body>, so they cover the whole window —
     including the transparent frame, which paints the dim over the shadow
     and squares off the rounded corners. Pull them in to the visible window.

     !important because these set their own inset inline, and an inline
     declaration otherwise beats anything a stylesheet says. */
  html.os-linux.lookout-csd [data-lookout-overlay] {
    inset: var(--lookout-window-margin) !important;
    border-radius: var(--lookout-window-radius);
    overflow: hidden;
  }
  html.os-linux.lookout-csd.lookout-snapped [data-lookout-overlay] {
    inset: 0 !important;
    border-radius: 0;
  }

  /* The header bar dims with the window, GTK's :backdrop state. */
  html.os-linux .lookout-headerbar {
    transition: opacity 160ms ease-out;
  }
  html.os-linux.lookout-backdrop .lookout-headerbar {
    opacity: 0.55;
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
 * Track focus and mirror it onto the document as GTK's :backdrop state.
 *
 * One class for the whole window rather than per-component opacity, because
 * both the header bar and the window's own shadow have to dim together —
 * they're the same signal, and driving them from two places is how they end
 * up disagreeing.
 */
export function useBackdropState(): void {
  useEffect(() => {
    if (!isLinux) return;

    const apply = (focused: boolean) => {
      document.documentElement.classList.toggle("lookout-backdrop", !focused);
    };

    // Ask the WINDOW whether it's focused, not the document. Dragging the
    // window by the header bar takes a pointer grab, which costs the webview
    // its DOM focus — so document.hasFocus() goes false and the titlebar
    // dimmed the whole time you were moving the window. The window itself
    // never stopped being focused.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const win = getCurrentWindow();
    void win.isFocused().then((f) => { if (!cancelled) apply(f); }).catch(() => {
      apply(document.hasFocus());
    });
    void win.onFocusChanged(({ payload }) => apply(payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {
      // No window events (a plain browser, say) — fall back to the document.
      const sync = () => apply(document.hasFocus());
      window.addEventListener("focus", sync);
      window.addEventListener("blur", sync);
      unlisten = () => {
        window.removeEventListener("focus", sync);
        window.removeEventListener("blur", sync);
      };
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      document.documentElement.classList.remove("lookout-backdrop");
    };
  }, []);
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
