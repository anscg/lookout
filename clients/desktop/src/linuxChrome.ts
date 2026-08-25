/**
 * The chrome an undecorated GTK window needs.
 *
 * The shared design system carries the Adwaita palette on every platform,
 * Linux included, and custom GTK themes are deliberately not followed. What
 * lives here is what a window with no server-side decorations has to do for
 * itself — the frame (corners, border, shadow, input shape), the backdrop
 * state, background blur where the compositor offers it, where the close
 * button goes — plus the one desktop setting the look does follow: the
 * session's accent colour. macOS and Windows never load any of it.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setAccentColor } from "@lookout/react";
import { isLinux } from "./platform.js";
import { invoke } from "./logger.js";

export interface DesktopAppearance {
  /** The session's accent colour as `#rrggbb`, read from GSettings. Null
   *  leaves the app on its own accent. */
  accent: string | null;
  /** Close on the trailing edge of the header bar. False means the user
   *  moved their window controls to the leading edge. */
  controlsOnRight: boolean;
}

export const DEFAULT_APPEARANCE: DesktopAppearance = {
  accent: null,
  // GNOME's own default, and what every other platform reports.
  controlsOnRight: true,
};

/** The header bar's height, in px. Adwaita's is 46 plus a 1px hairline. */
export const HEADER_BAR_HEIGHT = 47;

/**
 * The window's corner radius, in px. libadwaita's own.
 */
export const WINDOW_RADIUS = 12;

/**
 * Whether the shell is already drawing this window's rounded corners and
 * shadow, in which case Lookout draws no frame of its own — no margin, no
 * border, no radius, no shadow, no input shape. The header bar stays: the
 * window is still undecorated, and the extensions in question do nothing
 * about titlebars.
 *
 * The culprits are compositors that frame every window themselves —
 * Hyprland, niri, the tiling ones — and the Rounded Window Corners family
 * of GNOME extensions, which do it to a session that otherwise wouldn't.
 * Either way the frame is drawn from the window's real edge, 40px outside
 * ours, so the two nest with a band of desktop showing between them. A
 * tiler also sizes the window, so there the margin comes out of the app
 * instead. See `shell_draws_window_frame` in desktop_appearance.rs, which
 * is what decides this.
 *
 * Read off a global rather than fetched over IPC, and deliberately so. The
 * frame is painted on the very first frame (index.html), and the native
 * side has already sized the window against this same answer, so a value
 * that landed a round trip later would show as the frame flashing in and
 * out of a mis-sized window at every launch. The native side plants it at
 * document start instead (`js_init_script` in lib.rs).
 */
export const SHELL_DRAWS_FRAME: boolean =
  isLinux &&
  (globalThis as unknown as { __LOOKOUT_SHELL_DRAWS_FRAME__?: boolean })
    .__LOOKOUT_SHELL_DRAWS_FRAME__ === true;

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
 * intended size. Neither grows it when `SHELL_DRAWS_FRAME`, since there is
 * then no frame to make room for.
 *
 * IT MUST BE AT LEAST AS LARGE AS THE SHADOW REACHES. A box-shadow extends
 * `offset + blur` past its box, and anything past the frame is off the
 * window and clipped away — a shadow that looks generous in a browser gets
 * a hard straight edge on the desktop. The shadows below are sized against
 * this number; raising one means raising the other.
 */
export const WINDOW_MARGIN = 40;

/**
 * How much of that frame still accepts pointer input, measured inward from
 * the visible window's edge.
 *
 * The rest of the frame is passed through to whatever is behind, so a click
 * on the shadow doesn't land on Lookout — but this band has to stay live,
 * because it's where the resize strips are. Mirrored in window_shape.rs.
 */
export const RESIZE_BAND = 8;

/**
 * The outer ring of the frame that passes clicks through: everything
 * between the window's real edge and the resize band.
 */
export const SHADOW_PASSTHROUGH = WINDOW_MARGIN - RESIZE_BAND;

/**
 * How far in from the window's real edge the interactive area starts: the
 * shadow's passthrough ring while Lookout draws its own frame, and nothing
 * at all when the shell draws it — there is no frame then, so the window's
 * real edge is already its visible one.
 *
 * Drives both the input shape and where the resize strips sit, which have
 * to agree: a strip outside the shape could never be clicked.
 */
export const FRAME_INSET = SHELL_DRAWS_FRAME ? 0 : SHADOW_PASSTHROUGH;

/**
 * Linux-only chrome that the shared theme can't carry.
 *
 * The Adwaita palette itself lives in the shared theme — it's the app's
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
    /* Reach is 8 + 28 = 36, inside the 40px frame. */
    box-shadow:
      0 0 0 1px var(--color-window-border),
      0 2px 8px rgba(0, 0, 0, 0.1),
      0 8px 28px rgba(0, 0, 0, 0.14);
    transition: box-shadow 160ms ease-out;
  }
  /* Unfocused windows cast less. GTK pulls its shadow back in :backdrop so
     the focused window is the one that looks lifted. */
  html.os-linux.lookout-csd.lookout-backdrop #root {
    box-shadow:
      0 0 0 1px var(--color-window-border),
      0 1px 4px rgba(0, 0, 0, 0.06),
      0 4px 16px rgba(0, 0, 0, 0.09);
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

  /* Background blur, on the compositors that offer it — niri and KDE today.
     See useBackgroundBlur below and background_blur.rs: the class arrives
     only once LOOKOUT_WINDOW_BLUR is set and the compositor has actually
     been handed a region and agreed to blur it. A desktop without the protocol, GNOME's default session very
     much included, never reaches these rules and stays exactly as opaque as
     it was. Nothing here is keyed on which compositor it is.

     The plate is a single semitransparent layer. Which element carries it
     depends on whether Lookout is drawing its own frame: without one the
     window IS the surface and <html> is the plate, with one <html> and
     <body> have to stay clear for the shadow and #root is the plate. Two
     stacked 80% layers would come out 96% opaque and blur nothing, so
     exactly one of them ever paints. */
  html.os-linux.lookout-blur {
    --lookout-blur-plate: color-mix(in srgb, var(--color-bg-body, #242424) 80%, transparent);
  }
  html.os-linux.lookout-blur[data-theme="light"] {
    --lookout-blur-plate: color-mix(in srgb, var(--color-bg-body, #fafafa) 80%, transparent);
  }
  html.os-linux.lookout-blur {
    background: var(--lookout-blur-plate);
    /* Opaque until the native side answers, so this is a fade rather than a
       flash — and the fade only ever runs where the answer was yes. */
    transition: background-color 200ms ease-out;
  }
  html.os-linux.lookout-blur body {
    background: transparent;
  }
  html.os-linux.lookout-blur.lookout-csd {
    background: transparent;
  }
  html.os-linux.lookout-blur.lookout-csd #root {
    background: var(--lookout-blur-plate);
    transition: background-color 200ms ease-out, box-shadow 160ms ease-out;
  }
`;

/**
 * WCAG relative luminance, or null if the input isn't a six-digit hex.
 */
export function relativeLuminance(hex: string): number | null {
  const value = hex.replace("#", "");
  if (value.length !== 6) return null;
  const channel = (offset: number) => {
    const srgb = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * White or black, whichever stays legible on the given accent.
 *
 * GNOME's accent palette runs from a dark purple to a fairly bright yellow,
 * and white-on-yellow is the one combination that fails outright.
 */
export function accentForeground(hex: string): string {
  const luminance = relativeLuminance(hex);
  if (luminance === null) return "#ffffff";
  return luminance > 0.45 ? "#000000" : "#ffffff";
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
 * Reconcile the window's frame with how the compositor is treating it.
 *
 * Applies the input shape and answers whether the frame is collapsed —
 * true when the window manager is sizing this window (tiled, maximized,
 * fullscreen), which is read from the compositor rather than inferred.
 *
 * That distinction is the whole point under a tiling WM: every window there
 * is WM-sized, and a frame kept in that state is not a shadow but a band of
 * desktop wedged between neighbours.
 *
 * Returns null if the native side couldn't answer, so callers can fall back
 * rather than treat "unknown" as "floating".
 */
export async function syncWindowFrame(inset: number): Promise<boolean | null> {
  if (!isLinux) return null;
  try {
    return await invoke<boolean>("sync_window_frame", { inset });
  } catch (e) {
    // Worth knowing about, not worth breaking over: the window keeps
    // catching clicks on its own shadow.
    console.warn("[csd] could not sync the window frame:", e);
    return null;
  }
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
 * Hand the compositor the region behind which it should blur, and report
 * whether it is actually doing it.
 *
 * False for X11, for every compositor without `ext-background-effect-v1`,
 * and for a window that isn't mapped yet — see background_blur.rs, which
 * answers by trying rather than by recognising a desktop.
 */
async function syncBackgroundBlur(inset: number, radius: number): Promise<boolean> {
  if (!isLinux) return false;
  try {
    return await invoke<boolean>("sync_background_blur", { inset, radius });
  } catch (e) {
    // A window that stays opaque is the status quo, not a failure worth
    // surfacing.
    console.warn("[blur] could not sync the blur region:", e);
    return false;
  }
}

/**
 * The visible window's corner radius right now, in px.
 *
 * Read back off the custom property rather than tracked separately, because
 * that property is what the corners are actually drawn from: a snapped
 * window overrides it to 0. Reading the same value the paint uses is what
 * stops the blurred shape and the painted one from drifting apart.
 */
function currentWindowRadius(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--lookout-window-radius")
    .trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : WINDOW_RADIUS;
}

/**
 * Keep the window's blurred area matching its visible one, and mark the
 * document when the compositor is blurring.
 *
 * Off unless `LOOKOUT_WINDOW_BLUR=1` is in the environment — the feature is
 * new, and it is the one thing in the app that shares a Wayland connection
 * with GTK. The switch lives on the native side, so this hook does not test
 * for it: it asks, and an unset variable is simply one more reason for the
 * answer to be no.
 *
 * The class is the *result*, never a prediction: `.lookout-blur` goes on
 * after the native side reports a region attached, and comes straight back
 * off if a later sync says no. That ordering is the whole safety property —
 * a session without the protocol never gets a translucent window, so a
 * default GNOME setup looks exactly as it does today.
 *
 * Re-synced on two signals, both of which move the visible window inside its
 * surface: a resize, and the frame collapsing when the window manager takes
 * over sizing (`useWindowFrameState` toggles `.lookout-snapped`, and a
 * maximized window has no 40px frame and no rounded corners to blur inside).
 */
export function useBackgroundBlur(): void {
  useEffect(() => {
    if (!isLinux) return;

    const root = document.documentElement;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = async () => {
      // Both numbers come from the classes the CSS is keyed on, so the
      // region cannot describe a window shape different from the painted
      // one. No frame drawn (a shell or compositor is drawing it) and a
      // window the WM has sized both mean the surface IS the visible window.
      const framed =
        root.classList.contains("lookout-csd") && !root.classList.contains("lookout-snapped");
      const inset = framed ? WINDOW_MARGIN : 0;
      const blurred = await syncBackgroundBlur(inset, framed ? currentWindowRadius() : 0);
      if (cancelled) return;
      root.classList.toggle("lookout-blur", blurred);
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void sync(); }, 120);
    };

    void sync();

    // The frame state is applied by another hook on the same resize, and the
    // two are not ordered against each other — so watch for the class
    // instead of racing it. Only a change to the classes this reads counts,
    // or toggling `.lookout-blur` below would retrigger this forever.
    let framing = "";
    const readFraming = () =>
      `${root.classList.contains("lookout-csd")}:${root.classList.contains("lookout-snapped")}`;
    framing = readFraming();
    const observer = new MutationObserver(() => {
      const next = readFraming();
      if (next === framing) return;
      framing = next;
      schedule();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onResized(schedule).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      if (unlisten) unlisten();
      root.classList.remove("lookout-blur");
    };
  }, []);
}

/**
 * Mark the document as a Linux window and, where this window is
 * undecorated, opt it into drawing its own frame.
 *
 * The stylesheet itself is already in the document by the time this runs —
 * it goes in on import, above. What's left here needs a round trip to the
 * native side (the window-controls layout), so it necessarily lands a moment
 * after the window opens; that's better than holding the first paint hostage
 * to an IPC call.
 */
export async function applyLinuxChrome(
  { undecorated = false }: { undecorated?: boolean } = {},
): Promise<DesktopAppearance> {
  if (!isLinux) return DEFAULT_APPEARANCE;

  document.documentElement.classList.add("os-linux");
  // Opts this window into drawing its own rounded corners. Only the windows
  // that actually had their decorations taken away may claim it, and only
  // when the shell isn't drawing corners for them already.
  //
  // index.html has normally added this class before the first paint; this is
  // the same decision from the same global, kept here so a window that keeps
  // its GTK titlebar never inherits it.
  if (undecorated && !SHELL_DRAWS_FRAME) {
    document.documentElement.classList.add("lookout-csd");
    // Stop the shadow catching clicks, and collapse the frame straight away
    // if we opened into a tile. Re-checked on every resize by
    // useWindowFrameState.
    void syncWindowFrame(FRAME_INSET);
  } else {
    document.documentElement.classList.remove("lookout-csd");
  }

  let appearance = DEFAULT_APPEARANCE;
  try {
    appearance = await invoke<DesktopAppearance>("desktop_appearance");
  } catch (e) {
    console.warn("[linux-chrome] could not read desktop appearance:", e);
    return DEFAULT_APPEARANCE;
  }

  // GNOME's accent-color is a name from a fixed palette, mapped to Adwaita's
  // own hex on the native side. This is the one desktop setting the look
  // follows — the surfaces themselves stay Adwaita.
  if (appearance.accent) {
    setAccentColor(appearance.accent, accentForeground(appearance.accent));
  }

  return appearance;
}

/**
 * The desktop's appearance, kept current.
 *
 * Re-read when the window regains focus: changing your accent or moving
 * your window controls means going to Settings or Tweaks and coming back,
 * so the return trip is the moment the answer is stale — and it costs one
 * IPC call at a point where nothing is animating.
 */
export function useDesktopAppearance(
  { undecorated = false }: { undecorated?: boolean } = {},
): DesktopAppearance {
  const [appearance, setAppearance] = useState<DesktopAppearance>(DEFAULT_APPEARANCE);

  useEffect(() => {
    if (!isLinux) return;

    let cancelled = false;
    const reapply = () => {
      void applyLinuxChrome({ undecorated }).then((next) => {
        if (!cancelled) setAppearance(next);
      });
    };

    reapply();

    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) reapply();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No window events: the initial read already happened.
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [undecorated]);

  return appearance;
}
