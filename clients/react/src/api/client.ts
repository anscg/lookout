import type {
  CaptureFormat,
  SessionResponse,
  UploadUrlResponse,
  ConfirmScreenshotRequest,
  ConfirmScreenshotResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  RenameSessionResponse,
  StatusResponse,
  VideoResponse,
  UnitsResponse,
  SetCutsResponse,
  ApplyCutsResponse,
  EditHeartbeatResponse,
  CutInterval,
} from "@lookout/shared";
import type { TokenProvider } from "../types.js";

export interface LookoutClient {
  resolveToken(): Promise<string>;
  getSession(): Promise<SessionResponse>;
  /** `capturedAt` is optional. Sending it on the first request of a new
   *  session opts the session into credit-mode tracking; subsequent
   *  requests must keep sending it. Omit for legacy bucket-count behavior.
   *  `format` requests a clip upload ('webm'/'mp4'); omit for a single
   *  JPEG. The response's `format` is the GRANTED format — the caller
   *  must upload exactly that. */
  getUploadUrl(opts?: {
    capturedAt?: string;
    format?: CaptureFormat;
  }): Promise<UploadUrlResponse>;
  confirmScreenshot(body: ConfirmScreenshotRequest): Promise<ConfirmScreenshotResponse>;
  uploadToR2(uploadUrl: string, blob: Blob, contentType?: string): Promise<void>;
  pause(): Promise<PauseResponse>;
  resume(): Promise<ResumeResponse>;
  /** Stop the session. Pass `{ edit: true }` to hold it unpublished after
   *  compiling so the user can cut it first — programs never see
   *  `complete` until the edits are baked in. The hold auto-publishes if
   *  the user walks away, so this can never strand a timelapse. Only send
   *  it from a client that can actually render the editor. */
  stop(opts?: { edit?: boolean }): Promise<StopResponse>;
  rename(name: string): Promise<RenameSessionResponse>;
  getStatus(): Promise<StatusResponse>;
  getVideo(): Promise<VideoResponse>;
  /** Editor metadata: the compiled original's unit map (video second i ↔
   *  wall clock), current cut list, and a token-gated presigned URL for the
   *  UNCUT original video. */
  getUnits(): Promise<UnitsResponse>;
  /** Replace the session's cut list (full replace; [] clears all edits).
   *  Returns the normalized list plus a server-authoritative preview. */
  setCuts(cuts: CutInterval[]): Promise<SetCutsResponse>;
  /** Apply the current cut list to the published video (a cut-compile —
   *  usually a lossless stream copy, seconds not minutes). */
  applyCuts(): Promise<ApplyCutsResponse>;
  /** Renew the edit lease — "an editor is still open". Call every
   *  EDIT_HEARTBEAT_SECONDS while an editing surface is showing; stop when
   *  the response reports `held: false`. */
  heartbeatEditing(): Promise<EditHeartbeatResponse>;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface CreateClientOptions {
  baseUrl: string;
  token: TokenProvider;
  /** Free-form client telemetry string attached to every upload-url request
   *  (server query param `clientInfo`). Optional. */
  clientInfo?: string;
}

async function resolveTokenValue(provider: TokenProvider): Promise<string> {
  if (typeof provider === "string") return provider;
  const result = provider();
  return result instanceof Promise ? result : result;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  } catch (err) {
    // Network-level failure (DNS, connection refused, CORS, SSL)
    // WebKit just says "Load failed" — add the URL for context
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error fetching ${url}: ${msg}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = "";
    try {
      const json = JSON.parse(text);
      detail = json.error || json.message || text;
    } catch {
      detail = text;
    }
    throw new HttpError(
      res.status,
      `HTTP ${res.status} ${res.statusText} from ${url}${detail ? "\n" + detail.slice(0, 500) : ""}`,
    );
  }
  return res.json() as Promise<T>;
}

export function createLookoutClient(options: CreateClientOptions): LookoutClient {
  const { baseUrl, token, clientInfo } = options;

  const resolveToken = () => resolveTokenValue(token);

  async function sessionUrl(path = ""): Promise<string> {
    const t = await resolveToken();
    return `${baseUrl}/api/sessions/${t}${path}`;
  }

  return {
    resolveToken,

    async getSession() {
      return fetchJson<SessionResponse>(await sessionUrl());
    },

    async getUploadUrl(opts) {
      const base = await sessionUrl("/upload-url");
      const params = new URLSearchParams();
      if (opts?.capturedAt) params.set("capturedAt", opts.capturedAt);
      if (opts?.format) params.set("format", opts.format);
      if (clientInfo) params.set("clientInfo", clientInfo);
      const qs = params.toString();
      return fetchJson<UploadUrlResponse>(qs ? `${base}?${qs}` : base);
    },

    async confirmScreenshot(body) {
      return fetchJson<ConfirmScreenshotResponse>(await sessionUrl("/screenshots"), {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async uploadToR2(uploadUrl, blob, contentType = "image/jpeg") {
      if (!uploadUrl.startsWith("https://") && !uploadUrl.startsWith("/")) {
        throw new Error("Invalid upload URL: must be HTTPS or a relative path.");
      }
      let res: Response;
      try {
        res = await fetch(uploadUrl, {
          method: "PUT",
          body: blob,
          // Must match the content type the presigned URL was signed with.
          headers: { "Content-Type": contentType },
        });
      } catch (err) {
        if (err instanceof TypeError) {
          throw new Error(
            "Upload failed: network error or CORS misconfiguration on R2 bucket.",
          );
        }
        throw err;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `R2 upload failed: HTTP ${res.status}${text ? " — " + text.slice(0, 200) : ""}`,
        );
      }
    },

    async pause() {
      return fetchJson<PauseResponse>(await sessionUrl("/pause"), {
        method: "POST",
      });
    },

    async resume() {
      return fetchJson<ResumeResponse>(await sessionUrl("/resume"), {
        method: "POST",
      });
    },

    async stop(opts) {
      return fetchJson<StopResponse>(await sessionUrl("/stop"), {
        method: "POST",
        // Old servers ignore an unknown body; omit it entirely for the
        // plain stop so the request stays byte-identical to before.
        ...(opts?.edit ? { body: JSON.stringify({ edit: true }) } : {}),
      });
    },

    async rename(name: string) {
      return fetchJson<RenameSessionResponse>(await sessionUrl("/name"), {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    },

    async getStatus() {
      return fetchJson<StatusResponse>(await sessionUrl("/status"));
    },

    async getVideo() {
      return fetchJson<VideoResponse>(await sessionUrl("/video"));
    },

    async getUnits() {
      return fetchJson<UnitsResponse>(await sessionUrl("/units"));
    },

    async setCuts(cuts) {
      return fetchJson<SetCutsResponse>(await sessionUrl("/cuts"), {
        method: "PUT",
        body: JSON.stringify({ cuts }),
      });
    },

    async applyCuts() {
      return fetchJson<ApplyCutsResponse>(await sessionUrl("/compile"), {
        method: "POST",
      });
    },

    async heartbeatEditing() {
      return fetchJson<EditHeartbeatResponse>(await sessionUrl("/editing"), {
        method: "POST",
      });
    },
  };
}
