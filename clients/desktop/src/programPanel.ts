/**
 * Program panels: the state and message protocol behind ProgramPanel.tsx.
 *
 * A session can carry a `panelUrl` — an https URL the program minted for that
 * one session. When the timelapse finishes, instead of opening the program's
 * site in the browser (the `redirectUrl` hook), the app renders that URL in a
 * sheet with an iframe, so the program can collect whatever it needs (a title,
 * visibility, which Hackatime project to credit) without an app switch.
 *
 * The URL is the capability. The program made it unguessable and per-session,
 * so the frame needs no cookie (a third-party frame would not receive one
 * anyway — WebKit and WebView2 both partition them) and no credential of its
 * own. Lookout never reads or forwards anything from inside the frame.
 *
 * The frame cannot reach Tauri: a cross-origin iframe has its own JS realm,
 * and Tauri injects its IPC into the main frame only. `programPanel.test.ts`
 * pins the sandbox attribute that backs that up — notably the ABSENCE of
 * allow-top-navigation, so a panel can't navigate the app out from under
 * itself.
 */

/** Where a session's panel has got to. Persisted per token. */
export type PanelState =
  /** Never opened, or opened and still unresolved. */
  | "pending"
  /** The user closed it without finishing — offer it again on the session page. */
  | "dismissed"
  /** The program said it was finished. Never offered again. */
  | "done";

const STATE_KEY = "lookout-panel-state";

/** Messages a panel may send us. Anything else is ignored. */
export type PanelMessage =
  /** Content height changed; the sheet springs to match. */
  | { type: "lookout:resize"; height: number }
  /** The program finished (published, saved, whatever it does). */
  | { type: "lookout:done" }
  /** The user backed out inside the panel. Same as closing the sheet. */
  | { type: "lookout:cancel" };

/**
 * The sandbox the panel frame runs under.
 *
 * - allow-scripts / allow-forms — it's an app, it needs both.
 * - allow-same-origin — lets the panel reach ITS OWN origin's storage. It
 *   does NOT grant access to our document: the frame is cross-origin to the
 *   app shell, so this only un-opaques the program's own origin to itself.
 * - allow-popups — a panel may need to send the user out to a real browser
 *   tab (an OAuth step, a docs link).
 *
 * Deliberately absent: allow-top-navigation (and -by-user-activation). With
 * it, a panel could replace the whole app window with an arbitrary page —
 * the app shell must always stay the app shell.
 */
export const PANEL_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups";

/**
 * Sheet height bounds, in px.
 *
 * MAX is how tall the sheet may get, not how tall the frame may get: the frame
 * is always given the panel's full content height and the SHEET scrolls past
 * MAX. That keeps scrolling on our surface, where the app's own chrome already
 * hides the scrollbar — a cross-origin frame's scrollbar can't be styled from
 * out here, so the only way to not show one is to never need one.
 */
export const PANEL_MIN_HEIGHT = 220;
export const PANEL_MAX_HEIGHT = 720;
/**
 * Hard ceiling on a reported height, so a panel bug can't ask for a
 * hundred-thousand-pixel frame. Well past any real form.
 */
export const PANEL_SANITY_MAX_HEIGHT = 6000;
/**
 * Padding added to whatever height a panel reports.
 *
 * Content heights are fractional (a 500.38px body is normal), and a frame
 * sized to the rounded-off value overflows by a fraction of a pixel — which
 * is enough for the engine to reserve a full ~15px scrollbar gutter, so the
 * panel looks broken over a third of a pixel. Expecting every program to
 * measure itself perfectly is not a plan; absorbing it here is.
 *
 * Invisible in practice: panels paint no background of their own, so the extra
 * couple of pixels are just more of the sheet's own surface.
 */
export const PANEL_HEIGHT_SLACK = 2;
/** A panel that hasn't loaded by now is treated as broken. */
export const PANEL_LOAD_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Panels must be https, with http allowed on loopback so a program author can
 * develop their panel against a local server. The server enforces the same
 * rule at creation, but the value arrives here over the wire, and a frame is
 * the last place to take a URL on trust.
 */
export function isPanelUrlAcceptable(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // Never frame our own origin. The sandbox keeps a panel out of the app only
  // while it is cross-origin: `allow-same-origin` on a same-origin frame is no
  // isolation at all, and the frame could reach the parent's Tauri IPC — and
  // therefore every stored device credential. The dev shell runs on
  // http://localhost:1420, so without this a program could name that as its
  // panel and walk straight in. Production serves from tauri://localhost /
  // http://tauri.localhost, which the `.localhost` clause also covers.
  if (typeof location !== "undefined") {
    if (url.origin === location.origin) return false;
    if (url.hostname === location.hostname) return false;
  }
  if (url.hostname === "tauri.localhost" || url.hostname.endsWith(".localhost")) return false;

  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/** The origin a panel's messages must come from, or null if the URL is unusable. */
export function panelOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

/**
 * Validate a `message` event against the panel's origin and shape. Returns
 * null for anything that isn't a well-formed message from the panel itself —
 * other frames, other extensions, malformed payloads.
 */
export function parsePanelMessage(
  event: { origin: string; data: unknown; source?: unknown },
  expectedOrigin: string,
  expectedSource?: unknown,
): PanelMessage | null {
  if (event.origin !== expectedOrigin) return null;
  // Origin alone is not enough: the sandbox allows popups, so another window on
  // the panel's own origin could otherwise drive the sheet. When the caller
  // knows which frame it is listening to, require it.
  if (expectedSource != null && event.source !== expectedSource) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  switch (data.type) {
    case "lookout:done":
      return { type: "lookout:done" };
    case "lookout:cancel":
      return { type: "lookout:cancel" };
    case "lookout:resize": {
      const h = data.height;
      if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) return null;
      return {
        type: "lookout:resize",
        height: Math.min(
          PANEL_SANITY_MAX_HEIGHT,
          Math.max(PANEL_MIN_HEIGHT, Math.round(h)),
        ),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

function readStates(): Record<string, PanelState> {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getPanelState(token: string): PanelState {
  return readStates()[token] ?? "pending";
}

export function setPanelState(token: string, state: PanelState): void {
  const all = readStates();
  if (state === "pending") {
    delete all[token];
  } else {
    all[token] = state;
  }
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(all));
  } catch (e) {
    // Storage full or blocked: the panel just re-offers itself next time,
    // which is the safe direction to fail in.
    console.warn("[panel] could not persist panel state:", e);
  }
}

/**
 * Whether the session page should offer the panel — i.e. the program asked for
 * information and hasn't got it yet.
 *
 * Two sources of "already handled", and both matter:
 *
 * - `panelResolved` comes from the server and is the PROGRAM's word. It covers
 *   the case this device can't see: the user answered on the program's own
 *   website instead of in the sheet (or on another machine). Without it the
 *   card would nag forever about something already done.
 * - The local "done" state is this device seeing `lookout:done` first-hand,
 *   which retires the card immediately rather than after the program's next
 *   round-trip.
 *
 * "dismissed" and "pending" both still offer. "pending" counts because the
 * sheet opens itself when the compile lands, and if that moment was missed —
 * app closed, crash, nobody watching — the ask would otherwise vanish
 * silently.
 *
 * The caller is responsible for not showing the card *while* the sheet for the
 * same session is open — that's a display concern, not a state one.
 */
export function shouldOfferPanel(
  token: string,
  panelUrl: string | null | undefined,
  panelResolved?: boolean,
): boolean {
  if (panelResolved) return false;
  return isPanelUrlAcceptable(panelUrl) && getPanelState(token) !== "done";
}
