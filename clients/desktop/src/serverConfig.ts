/**
 * Runtime-configurable Lookout server.
 *
 * The desktop app historically hardcoded https://lookout.hackclub.com in
 * several modules. The base URL now lives here: persisted in localStorage
 * (like the app blacklist), read once at module-load time by every consumer,
 * and changed from Settings → Server — which reloads the webview so all
 * module-scope `API_BASE` reads pick up the new value. The Rust side needs
 * no storage of its own: it receives the URL per session via the
 * `configure` command, which the frontend calls with this value.
 *
 * NOTE: the webview CSP (tauri.conf.json) allows `https:` for connect/img/
 * media sources, so custom servers must be HTTPS. Plain-http servers are
 * blocked by the CSP (localhost excepted, for development).
 */

export const DEFAULT_API_BASE = "https://lookout.hackclub.com";

const STORAGE_KEY = "lookout-api-base";

/**
 * Validate and canonicalize a user-entered server URL to its origin
 * (scheme + host + port). Returns null when the input isn't a usable
 * server URL. HTTPS only, except localhost for development — anything
 * else would be blocked by the webview CSP anyway.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    // Accept bare hostnames like "lookout-stage.dino.icu".
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    return null;
  }
  return url.origin;
}

/** The active server base URL (no trailing slash). */
export function getApiBase(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const normalized = normalizeServerUrl(stored);
      if (normalized) return normalized;
    }
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return DEFAULT_API_BASE;
}

/** True when the app is pointed at the production server. */
export function isDefaultApiBase(): boolean {
  return getApiBase() === DEFAULT_API_BASE;
}

/**
 * Persist a new server base URL (pass null to reset to production).
 * Callers should reload the webview afterwards — consumers read the
 * value once at module load.
 */
export function setApiBase(url: string | null): void {
  try {
    if (url === null || url === DEFAULT_API_BASE) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, url);
    }
  } catch (e) {
    console.error("[server-config] failed to persist server URL:", e);
  }
}
