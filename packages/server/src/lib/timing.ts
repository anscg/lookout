import { RATE_LIMIT_PER_MINUTE } from "@collapse/shared";

/**
 * Compute the minute bucket for a screenshot based on server timestamp.
 */
export function computeMinuteBucket(
  requestedAt: Date,
  sessionStartedAt: Date,
): number {
  const diffMs = requestedAt.getTime() - sessionStartedAt.getTime();
  return Math.floor(diffMs / 60_000);
}

/**
 * Simple in-memory rate limiter per session.
 * Tracks upload-url requests per 60-second sliding window.
 */
const windows = new Map<
  string,
  { count: number; windowStart: number }
>();

export function checkRateLimit(sessionId: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const now = Date.now();
  const windowMs = 60_000;
  const entry = windows.get(sessionId);

  if (!entry || now - entry.windowStart >= windowMs) {
    windows.set(sessionId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_PER_MINUTE) {
    const retryAfterMs = windowMs - (now - entry.windowStart);
    return { allowed: false, retryAfterMs };
  }

  entry.count++;
  return { allowed: true };
}

/**
 * Clean up stale rate limit entries (call periodically).
 */
export function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.windowStart > 120_000) {
      windows.delete(key);
    }
  }
}
