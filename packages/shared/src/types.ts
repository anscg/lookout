import type { CaptureFormat, SessionStatus } from "./constants.js";
import type { CutInterval, VideoUnit } from "./cuts.js";

export interface Session {
  id: string;
  token: string;
  name: string;
  metadata: Record<string, unknown>;
  status: SessionStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  pausedAt: string | null;
  lastScreenshotAt: string | null;
  resumedAt: string | null;
  totalActiveSeconds: number;
  videoUrl: string | null;
  videoR2Key: string | null;
  thumbnailUrl: string | null;
  thumbnailR2Key: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Screenshot {
  id: string;
  sessionId: string;
  r2Key: string;
  requestedAt: string;
  minuteBucket: number;
  confirmed: boolean;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  sampled: boolean;
  /** Payload format of this capture unit. "jpeg" = legacy single frame;
   *  "webm"/"mp4" = per-minute clip. */
  format: CaptureFormat;
  /** Client-reported frame count inside a clip. Informational only —
   *  the worker derives the real count by demuxing. NULL for jpeg rows. */
  frameCount: number | null;
  createdAt: string;
}

/**
 * Free-form client telemetry string, reported by the recording client on the
 * `upload-url` request (query param `clientInfo`) and stored opaquely per
 * screenshot. This is NOT the HTTP User-Agent — it's explicit, for
 * telemetry/debugging. The server never parses it.
 *
 * Recommended (not enforced) format, User-Agent–like, encoding: Lookout type,
 * version, embedded host app (web/sdk), OS type+version, browser type+version
 * (web/sdk):
 *   "Lookout Desktop/0.2.6 (macOS 14.3)"
 *   "Lookout Web (Fallout)/0.2.6 (macOS 14.3; Chrome 120.0)"
 *   "Lookout SDK (Stardance)/0.2.6 (Windows 10; Firefox 121.0)"
 */
export type ClientInfo = string;

// -- API request/response types --

export interface CreateSessionRequest {
  name?: string;
  metadata?: Record<string, unknown>;
  /** Allow this session to receive clip uploads (per-minute videos of
   *  ~15 frames) instead of one JPEG per minute. Default false.
   *  Immutable after creation. */
  clips?: boolean;
  /** Redirect hook: http(s) URL the recording client sends the user to once
   *  the timelapse finishes compiling (the desktop app opens it in the
   *  default browser). Immutable after creation. */
  redirectUrl?: string;
}

export interface CreateSessionResponse {
  token: string;
  sessionId: string;
  sessionUrl: string;
}

export interface SessionResponse {
  name: string;
  status: SessionStatus;
  trackedSeconds: number;
  screenshotCount: number;
  startedAt: string | null;
  totalActiveSeconds: number;
  createdAt: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  /** @deprecated WebM is no longer produced. Populated only for legacy clients —
   * points at a static "please update" message video. */
  videoWebmUrl?: string | null;
  /** First recorded client telemetry for the session; `null` if none captured. */
  clientInfo?: ClientInfo | null;
  /** First recorded JA4 TLS fingerprint (edge-observed); `null` if none. */
  ja4?: string | null;
  /** Whether this session accepts clip uploads. Clients read this BEFORE
   *  the first capture (this endpoint is the session-recovery fetch) so
   *  the very first upload can already be a clip. Absent on pre-clips
   *  servers — treat as false. */
  clipsEnabled?: boolean;
  /** Server-authoritative clip cadence (ms between frames). Absent on
   *  pre-clips servers. */
  frameIntervalMs?: number;
  /** Redirect hook URL to open once the timelapse completes; `null`/absent
   *  when the session has none. */
  redirectUrl?: string | null;
  /** The session's cut list; `[]` when never edited. Absent on pre-edits
   *  servers. Note `trackedSeconds` already reflects these cuts. */
  cuts?: CutInterval[];
  /** Credited seconds removed by `cuts` (trackedSeconds = uncut − this). */
  cutSeconds?: number;
  /** Tracked seconds before subtracting cuts. */
  uncutTrackedSeconds?: number;
  /** Whether the compiled timelapse can (still) be edited. */
  editable?: boolean;
  metadata: Record<string, unknown>;
}

export type TrackingMode = "bucket" | "credit";

export interface TimingsResponse {
  status: SessionStatus;
  count: number;
  first: string | null;
  last: string | null;
  /** First recorded client telemetry for the session; `null` if none captured. */
  clientInfo: ClientInfo | null;
  /** First recorded JA4 TLS fingerprint (edge-observed); `null` if none. */
  ja4: string | null;
  /** Kept capture timestamps — captures inside a cut interval are EXCLUDED
   *  so heartbeat forwarders respect edits with no code changes. */
  timestamps: string[];
  /** The session's cut list; `[]` when never edited. Absent on pre-edits
   *  servers. */
  cuts?: CutInterval[];
  /** Number of confirmed captures removed by `cuts`. */
  cutCount?: number;
  /** Capture timestamps removed by `cuts`. Only present when the request
   *  passed `?includeCut=true`. */
  cutTimestamps?: string[];
}

// -- Edits (cuts) --

export interface UnitsResponse {
  /** Units of the compiled ORIGINAL video, in output order: array index =
   *  video second = real-world minute. Empty for sessions compiled before
   *  edit support (not editable). */
  units: VideoUnit[];
  /** Current cut list ([] = no edits). */
  cuts: CutInterval[];
  /** Whether the session can (still) be edited: original video present,
   *  recompile budget remaining. */
  editable: boolean;
  /** Why `editable` is false (for UX copy); absent when editable. */
  editableReason?: "no_original" | "recompiles_exhausted" | "not_complete";
  /** Presigned GET URL (~1h) of the UNCUT original video — the editor's
   *  preview source. Token-gated by this endpoint; deliberately NOT the
   *  public media URL, which after an edit serves the cut version only.
   *  Null when not editable. */
  originalVideoUrl: string | null;
  /** Remaining user-initiated cut-compiles. */
  recompilesRemaining: number;
}

export interface SetCutsRequest {
  cuts: CutInterval[];
}

export interface SetCutsResponse {
  /** Normalized (sorted, merged, clamped) cut list as persisted. */
  cuts: CutInterval[];
  /** Units in the original video. */
  unitsTotal: number;
  /** Units removed by the normalized list. */
  unitsCut: number;
  /** Post-cut tracked seconds (what GET /sessions/:token will report once
   *  the cuts are applied). */
  trackedSeconds: number;
  /** Tracked seconds before subtracting cuts. */
  uncutTrackedSeconds: number;
}

export interface ApplyCutsResponse {
  status: SessionStatus;
  /** True when the change was applied instantly without a compile job
   *  (clearing all cuts just repoints the published video at the original). */
  instant: boolean;
  recompilesRemaining: number;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  r2Key: string;
  screenshotId: string;
  minuteBucket: number;
  nextExpectedAt: string;
  /** Server wall-clock time at the moment this response was generated.
   *  Optional — not present on responses from pre-0.3 servers. Clients
   *  may use it for diagnostics; scheduling needs only `nextExpectedAt`. */
  serverTime?: string;
  /** Sticky tracking mode for the session. Optional for backwards compat. */
  trackingMode?: TrackingMode;
  /** Echo of the GRANTED capture format — may differ from the requested
   *  one (the server downgrades clip formats to "jpeg" on sessions where
   *  clips are disabled). Absent on pre-clips servers — clients MUST
   *  treat absence as "server only supports jpeg". The client must
   *  upload exactly this format. */
  format?: CaptureFormat;
  /** Whether this session accepts clip uploads. Absent on pre-clips
   *  servers (treat as false). */
  clipsEnabled?: boolean;
  /** Server-authoritative clip cadence (ms between frames inside a
   *  clip). Absent on pre-clips servers. Clients must capture at exactly
   *  this rate — there is deliberately no client-side override. */
  frameIntervalMs?: number;
}

export interface ConfirmScreenshotRequest {
  screenshotId: string;
  width: number;
  height: number;
  fileSize: number;
  /** Frames inside the uploaded clip. Omit for jpeg captures. */
  frameCount?: number;
}

export interface ConfirmScreenshotResponse {
  confirmed: true;
  trackedSeconds: number;
  nextExpectedAt: string;
  /** Server wall-clock time. Optional for backwards compat. */
  serverTime?: string;
}

export interface PauseResponse {
  status: "paused";
  totalActiveSeconds: number;
}

export interface ResumeResponse {
  status: "active";
  nextExpectedAt: string;
  /** Optional server wall-clock time. */
  serverTime?: string;
}

export interface StopResponse {
  status: "stopped";
  trackedSeconds: number;
  totalActiveSeconds: number;
}

export interface StatusResponse {
  status: SessionStatus;
  progress?: number;
  videoUrl?: string;
  /** @deprecated WebM is no longer produced. Populated only for legacy clients —
   * points at a static "please update" message video. */
  videoWebmUrl?: string;
  trackedSeconds: number;
  /** Redirect hook URL — clients watching the compile open this when the
   *  status flips to "complete". Absent when the session has none. */
  redirectUrl?: string;
  /** Whether the compiled timelapse can (still) be edited. */
  editable?: boolean;
}

export interface VideoResponse {
  videoUrl: string;
}

export interface ThumbnailResponse {
  thumbnailUrl: string;
}

export interface SessionSummary {
  token: string;
  name: string;
  status: SessionStatus;
  trackedSeconds: number;
  screenshotCount: number;
  startedAt: string | null;
  createdAt: string;
  totalActiveSeconds: number;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  /** @deprecated WebM is no longer produced. Populated only for legacy clients —
   * points at a static "please update" message video. */
  videoWebmUrl?: string | null;
  metadata: Record<string, unknown>;
}

export interface RenameSessionRequest {
  name: string;
}

export interface RenameSessionResponse {
  name: string;
}

export interface BatchSessionsRequest {
  tokens: string[];
}

export interface BatchSessionsResponse {
  sessions: SessionSummary[];
}
