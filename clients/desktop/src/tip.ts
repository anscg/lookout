/**
 * Eligibility and once-only bookkeeping for the tip sheet (TipDrawer).
 *
 * The server publishes at most one active tip and ships its audience rule
 * with the copy. The half it can't answer is evaluated here, because it's
 * about this machine: whether a deep link landed, and whether the program is
 * already paired.
 *
 * A qualifying deep link binds the tip to that one session token. Both
 * moments must belong to that session, and each fires once — so a tip is seen
 * at most twice, around the timelapse that earned it, and never again.
 */

import { getLink } from "./programLink.js";

export interface Tip {
  id: string;
  badge: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  /** Program registry `name` this tip is about; null = everyone. */
  program: string | null;
  trigger: "any" | "deep_link";
  requireUnlinked: boolean;
}

/** The two moments a tip may surface, both on the session that qualified it. */
export type TipMoment = "source" | "panel-done";

const DEEP_LINK_KEY = "lookout-deeplink-sessions";
const MOMENTS_KEY = "lookout-tip-moments";

interface TipMomentRecord {
  token: string;
  moments: TipMoment[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A tip that shows twice beats one that throws on the way to the screen.
  }
}

/**
 * Remember that `token` — a session belonging to `program` — was deep-linked.
 * One token per program: the newest wins. Called before the deep-link handler
 * navigates, so the record is in place when the destination page asks.
 */
export function recordDeepLinkSession(program: string | null, token: string): void {
  if (!program) return;
  const sessions = readJson<Record<string, string>>(DEEP_LINK_KEY, {});
  sessions[program] = token;
  writeJson(DEEP_LINK_KEY, sessions);
}

export function deepLinkSessionFor(program: string): string | null {
  const sessions = readJson<Record<string, string>>(DEEP_LINK_KEY, {});
  const token = sessions[program];
  return typeof token === "string" && token ? token : null;
}

function readMoments(): Record<string, TipMomentRecord> {
  return readJson<Record<string, TipMomentRecord>>(MOMENTS_KEY, {});
}

/**
 * Every gate, named. `shouldShowTip` is the AND of these; the breakdown is
 * what `__tip.state()` prints, since "it didn't appear" has six causes.
 * `null` means the gate doesn't apply to this tip.
 */
export interface TipGates {
  hasTip: boolean;
  hasToken: boolean;
  deepLinkMatches: boolean | null;
  unlinked: boolean | null;
  boundToThisSession: boolean;
  momentUnused: boolean;
  show: boolean;
}

export function explainTip(
  tip: Tip | null,
  moment: TipMoment,
  token: string | null | undefined,
): TipGates {
  const gates: TipGates = {
    hasTip: Boolean(tip),
    hasToken: Boolean(token),
    deepLinkMatches: null,
    unlinked: null,
    boundToThisSession: true,
    momentUnused: true,
    show: false,
  };
  if (!tip || !token) return gates;

  if (tip.program) {
    // Only the session the deep link actually landed on counts — reaching an
    // old one from the gallery hasn't triggered anything.
    if (tip.trigger === "deep_link") {
      gates.deepLinkMatches = deepLinkSessionFor(tip.program) === token;
    }
    if (tip.requireUnlinked) {
      gates.unlinked = !getLink(tip.program);
    }
  }

  const record = readMoments()[tip.id];
  if (record) {
    gates.boundToThisSession = record.token === token;
    gates.momentUnused = !record.moments.includes(moment);
  }

  gates.show =
    gates.hasTip &&
    gates.hasToken &&
    gates.deepLinkMatches !== false &&
    gates.unlinked !== false &&
    gates.boundToThisSession &&
    gates.momentUnused;
  return gates;
}

export function shouldShowTip(
  tip: Tip | null,
  moment: TipMoment,
  token: string | null | undefined,
): boolean {
  return explainTip(tip, moment, token).show;
}

/** Marked on open, not close: someone who quits with the sheet up has seen it. */
export function markTipMoment(tip: Tip, moment: TipMoment, token: string): void {
  const all = readMoments();
  const existing = all[tip.id];
  const record: TipMomentRecord =
    existing && existing.token === token ? existing : { token, moments: [] };
  if (!record.moments.includes(moment)) record.moments.push(moment);
  all[tip.id] = record;
  writeJson(MOMENTS_KEY, all);
}

// ---------------------------------------------------------------------------
// Debug surface
// ---------------------------------------------------------------------------

/** Stand-in for `__tip.show()` when the server has published nothing. */
const SAMPLE_TIP: Tip = {
  id: "__debug",
  badge: "NEW!",
  title: "Sample tip title that runs about this long",
  body: "Sample body copy, roughly the length a real tip runs to, so the sheet is the height it will actually be in front of a user.",
  imageUrl: null,
  program: null,
  trigger: "any",
  requireUnlinked: false,
};

export interface TipDebug {
  /** Open the sheet now, bypassing every gate. */
  show(overrides?: Partial<Tip>): string;
  hide(): string;
  /** Forget impressions and deep-link records, so the real flow replays. */
  reset(): string;
  /** What the client believes, and why the sheet would or would not open. */
  state(token?: string): unknown;
}

/**
 * Install `window.__tip`. Registered unconditionally, like
 * `__simulateDeepLink` in main.tsx — the flow it debugs is at its most
 * confusing in a shipped build against the real server.
 */
export function installTipDebug(host: {
  current: () => Tip | null;
  show: (tip: Tip) => void;
  hide: () => void;
}): () => void {
  const api: TipDebug = {
    show(overrides) {
      const base = host.current() ?? SAMPLE_TIP;
      host.show({ ...base, ...overrides });
      return `[tip] showing ${host.current() ? "published" : "sample"} tip — this does NOT consume a moment`;
    },
    hide() {
      host.hide();
      return "[tip] hidden";
    },
    reset() {
      localStorage.removeItem(MOMENTS_KEY);
      localStorage.removeItem(DEEP_LINK_KEY);
      return "[tip] cleared impressions and deep-link records — reopen a timelapse through its deep link to replay the real flow";
    },
    state(token) {
      const tip = host.current();
      const sessions = readJson<Record<string, string>>(DEEP_LINK_KEY, {});
      // Default to the session this tip's program was deep-linked to: the
      // only token the gates can pass for.
      const subject = token ?? (tip?.program ? sessions[tip.program] : undefined);
      return {
        published: tip,
        deepLinkSessions: sessions,
        impressions: readMoments(),
        checkedAgainstToken: subject ?? null,
        gates: {
          source: explainTip(tip, "source", subject),
          "panel-done": explainTip(tip, "panel-done", subject),
        },
      };
    },
  };
  (window as unknown as { __tip?: TipDebug }).__tip = api;
  return () => {
    delete (window as unknown as { __tip?: TipDebug }).__tip;
  };
}
