// Version targeting for admin announcements: pure matching logic, kept out
// of the route so the rules are unit-testable without a DB.

/** Loose dotted-numeric version: "0.3", "1.2.3", tolerant of a leading "v"
 *  and of a trailing pre-release/build suffix ("0.3.0-beta.1" → 0.3.0). */
const VERSION_RE = /^v?(\d+(?:\.\d+)*)/;

/** Parse a reported version into numeric segments, or null when the string
 *  carries no leading dotted number at all. */
export function parseVersion(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  return m[1].split(".").map(Number);
}

/** Compare two parsed versions segment-wise; missing segments count as 0
 *  (1.2 == 1.2.0). Returns negative/zero/positive like a comparator. */
export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether an announcement with the given (optional, inclusive) version
 * bounds should be shown to a client that reported `clientVersion`.
 *
 * A client that reports NO version — every build that predates version
 * reporting on the announcement fetch — is treated as version 0. That makes
 * the two targeting directions do the right thing for old builds:
 *
 *   - max_version-only ("everyone at or below X, please update"): matches
 *     unknown clients, which are definitionally the oldest.
 *   - min_version ("news about a feature only new builds have"): never
 *     matches unknown clients.
 *
 * An unparseable BOUND fails open on that bound (no filtering) rather than
 * hiding an announcement the admin thought was live.
 */
export function announcementMatchesVersion(
  bounds: { minVersion: string | null; maxVersion: string | null },
  clientVersion: string | null | undefined,
): boolean {
  const client = parseVersion(clientVersion) ?? [0];
  const min = parseVersion(bounds.minVersion);
  if (min && compareVersions(client, min) < 0) return false;
  const max = parseVersion(bounds.maxVersion);
  if (max && compareVersions(client, max) > 0) return false;
  return true;
}
