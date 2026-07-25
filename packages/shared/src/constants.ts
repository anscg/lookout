// ──────────────────────────────────────────────────────────
// Session statuses
// ──────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  "pending",
  "active",
  "paused",
  "stopped",
  "compiling",
  "complete",
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ──────────────────────────────────────────────────────────
// Capture & upload timing
// ──────────────────────────────────────────────────────────

/** How often the client should capture a screenshot.
 *  The server returns `nextExpectedAt` after each upload;
 *  this is the default interval if that value is missing.
 *  Default: 60000 (60 seconds) */
export const SCREENSHOT_INTERVAL_MS = 60_000;

/** Max tolerance for clock skew between client and server (ms).
 *  Used when validating timestamps in requests.
 *  Default: 5000 (5 seconds) */
export const MAX_CLOCK_SKEW_MS = 5_000;

// ──────────────────────────────────────────────────────────
// Credit-mode tracking (see plan: server-authoritative wall-clock)
// ──────────────────────────────────────────────────────────

/** Trust envelope: how far in the past `capturedAt` may be relative
 *  to server `now()` before being rejected. Wide enough to absorb
 *  normal client-clock skew and buffered uploads.
 *  Default: 300000 (5 minutes) */
export const CAPTURED_AT_PAST_TOLERANCE_MS = 300_000;

/** Trust envelope: how far in the future `capturedAt` may be relative
 *  to server `now()` before being rejected. Symmetric with the past
 *  bound to handle clients with fast-skewed clocks.
 *  Default: 300000 (5 minutes) */
export const CAPTURED_AT_FUTURE_TOLERANCE_MS = 300_000;

/** Credit-mode streak window: |capturedAt - expectedAt| ≤ this credits
 *  60s; outside resets the streak to a fresh anchor with 0 credit.
 *  Tightly coupled to SCREENSHOT_INTERVAL_MS — keep at half-interval.
 *  Default: 30000 (30 seconds) */
export const STREAK_WINDOW_MS = 30_000;

/** Seconds awarded per in-window capture in credit mode.
 *  Equals SCREENSHOT_INTERVAL_MS / 1000. Don't hardcode 60 in the
 *  credit path — derive from this constant.
 *  Default: 60 */
export const CREDIT_PER_CAPTURE_S = 60;

// ──────────────────────────────────────────────────────────
// Clips (20 frames/minute via per-minute video uploads)
// ──────────────────────────────────────────────────────────

/** Upload payload formats the server accepts on upload-url.
 *  "jpeg" is the legacy single-screenshot-per-minute payload.
 *  "webm"/"mp4" are per-minute video clips holding ~15 frames captured
 *  seconds apart (webm from Chromium/Firefox MediaRecorder; mp4 from
 *  Safari MediaRecorder and the desktop hardware encoder). The
 *  per-minute request cadence, credit math, and rate limits are
 *  identical in all formats — a clip is still ONE capture unit.
 *  Clips are gated per session by `sessions.clips_enabled`, set at
 *  creation via the internal API and immutable thereafter. */
export const CAPTURE_FORMATS = ["jpeg", "webm", "mp4"] as const;
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];

/** R2/HTTP content type for each capture format. The presigned PUT is
 *  signed with this content type and confirm re-validates it via
 *  HeadObject, so client and server must agree exactly. */
export const CAPTURE_FORMAT_CONTENT_TYPES: Record<CaptureFormat, string> = {
  jpeg: "image/jpeg",
  webm: "video/webm",
  mp4: "video/mp4",
};

/** How often a clip-recording client grabs a frame into the current
 *  clip. 4000ms = 15 frames per SCREENSHOT_INTERVAL_MS. The cadence is
 *  server-authoritative: it's sent to clients as `frameIntervalMs` on
 *  the session GET and upload-url responses, clients capture at exactly
 *  that rate, and no client exposes an override. 15/min trades a hair
 *  of smoothness for ~33% more bitrate budget per frame — text
 *  legibility wins.
 *  Default: 4000 (4 seconds) */
export const CLIP_FRAME_INTERVAL_MS = 4_000;

/** Nominal frames per clip (SCREENSHOT_INTERVAL_MS / CLIP_FRAME_INTERVAL_MS).
 *  Informational — clips are VFR and static screens legitimately emit
 *  fewer encoded frames. The worker derives real counts by demuxing.
 *  Default: 15 */
export const FRAMES_PER_CLIP = 15;

/** Client-side encoder bitrate cap for clips (bits/second).
 *  Sized for TEXT LEGIBILITY: at 15 frames/min, 800 kbps allows ~400 KB
 *  per 4s frame — JPEG-q85-class keyframes at 1080p, the bar the legacy
 *  single-screenshot pipeline set. This is a VBR ceiling, not a floor:
 *  static screen content undershoots it heavily (measured 133 kbps-era
 *  clips landed at ~400 KB/min total). 133k and 400k were tried first
 *  and produced visibly soft H.264.
 *  Default: 800000 */
export const CLIP_VIDEO_BITS_PER_SECOND = 800_000;

/** Max clip file size in bytes, validated server-side via HeadObject
 *  after upload. Sized above the bitrate budget (800 kbps × 60s ≈ 6 MB)
 *  to absorb encoder overshoot and container overhead.
 *  Default: 8388608 (8 MB) */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

// ──────────────────────────────────────────────────────────
// Auto-timeout thresholds
// ──────────────────────────────────────────────────────────

/** Auto-pause a session after this many minutes without a
 *  screenshot upload. The session moves to "paused" status.
 *  Default: 10 minutes */
export const AUTO_PAUSE_AFTER_MINUTES = 10;

/** Auto-stop (and trigger compilation) after this many minutes
 *  without a screenshot upload. Applies to both "active" and
 *  "paused" sessions.
 *  Default: 24 hours */
export const AUTO_STOP_AFTER_MINUTES = 1440;

/** Sessions stuck in "compiling" for longer than this are
 *  assumed crashed and reset to "stopped" for re-enqueue.
 *  Default: 60 (minutes) */
export const STUCK_COMPILING_TIMEOUT_MINUTES = 60;

/** Max times the stuck-compiling timeout will re-enqueue a
 *  compilation before giving up and marking the session failed.
 *  Prevents infinite recompile loops from deeper corruption.
 *  Default: 3 */
export const MAX_COMPILE_ATTEMPTS = 3;

// ──────────────────────────────────────────────────────────
// Rate limiting & abuse prevention
// ──────────────────────────────────────────────────────────

/** Max upload-url requests per 60-second window per session.
 *  Sized for: 1 nominal capture/min + occasional burst (race in the
 *  client's fire-and-forget scheduling chain) + up to 3 client-side
 *  retries on transient network errors. 3 was too tight: any hiccup
 *  blew the budget and the chain stalled.
 *  Default: 10 */
export const RATE_LIMIT_PER_MINUTE = 10;

/** Max confirmed screenshots per session.
 *  At 1/min this equals 12 hours of recording.
 *  Default: 720 */
export const MAX_SCREENSHOTS_PER_SESSION = 720;

/** Max total upload-url requests per session (confirmed + unconfirmed).
 *  Sized at ~6x the screenshot cap to absorb client retries and burst
 *  races without truncating long sessions.
 *  Default: 4320 */
export const MAX_UPLOAD_REQUESTS_PER_SESSION = 4320;

/** Max screenshot file size in bytes.
 *  Validated server-side via HeadObject after upload.
 *  Default: 2097152 (2 MB) */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

// ──────────────────────────────────────────────────────────
// Presigned URL settings
// ──────────────────────────────────────────────────────────

/** How long a presigned PUT URL remains valid (seconds).
 *  Keep short to limit replay/leak window.
 *  Default: 120 (2 minutes) */
export const PRESIGNED_URL_EXPIRY_SECONDS = 120;

// ──────────────────────────────────────────────────────────
// Cleanup
// ──────────────────────────────────────────────────────────

/** Delete unconfirmed screenshot records after this many minutes.
 *  Their presigned URLs have long expired by this point.
 *  Default: 10 (minutes) */
export const UNCONFIRMED_CLEANUP_AFTER_MINUTES = 10;

/** Delete screenshot R2 image objects for successfully compiled sessions
 *  (status=complete with a video) after this many days. The screenshot DB
 *  rows are KEPT (so capture timings stay queryable); only the JPEGs in R2
 *  are removed. Only applies to sessions that have a videoR2Key set.
 *  Default: 7 (days) */
export const SCREENSHOT_RETENTION_DAYS = 7;

/** Max byte length of the client-supplied `clientInfo` query param on
 *  upload-url. Anything larger is ignored (stored as null). Bounds a hostile
 *  client; real payloads are a few hundred bytes. */
export const CLIENT_INFO_MAX_BYTES = 1024;

/** Max byte length of a JA4 TLS fingerprint read from the edge-set request
 *  header (JA4_HEADER). A canonical JA4 is ~36 chars (e.g.
 *  "t13d1516h2_8daaf6152771_b186095e22b6"); the cap leaves headroom for
 *  variants while bounding a hostile/misconfigured edge. Longer values are
 *  ignored (stored as null). */
export const JA4_MAX_BYTES = 128;

// ──────────────────────────────────────────────────────────
// Screenshot capture settings
// ──────────────────────────────────────────────────────────

/** JPEG quality for canvas -> blob conversion (0-1).
 *  0.85 balances quality (~100-300 KB at 1080p) and file size.
 *  Default: 0.85 */
export const JPEG_QUALITY = 0.85;

/** Max capture resolution (width). Screenshots are scaled down
 *  to fit within these bounds while preserving aspect ratio.
 *  Default: 1920 */
export const MAX_WIDTH = 1920;

/** Max capture resolution (height).
 *  Default: 1080 */
export const MAX_HEIGHT = 1080;

// ──────────────────────────────────────────────────────────
// Client upload resilience
// ──────────────────────────────────────────────────────────

/** Max retry attempts for each upload step
 *  (presigned URL request, R2 PUT, confirmation POST).
 *  Default: 3 */
export const MAX_UPLOAD_RETRIES = 3;

/** Retry delays in ms (exponential backoff).
 *  Default: [2000, 4000, 8000] */
export const UPLOAD_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

/** Max screenshots buffered in memory when uploads are slow.
 *  Oldest are dropped if the buffer overflows.
 *  Default: 5 */
export const MAX_PENDING_BUFFER = 5;

// ──────────────────────────────────────────────────────────
// Capture robustness
// ──────────────────────────────────────────────────────────

/** Timeout for canvas.toBlob() before giving up on a frame (ms).
 *  Prevents the capture pipeline from stalling permanently.
 *  Default: 10000 (10 seconds) */
export const CANVAS_TO_BLOB_TIMEOUT_MS = 10_000;

/** Timeout waiting for video element to have decoded dimensions
 *  after play() resolves (ms). Safari may resolve play() before
 *  the first frame is available.
 *  Default: 5000 (5 seconds) */
export const VIDEO_READY_TIMEOUT_MS = 5_000;
