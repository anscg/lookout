import type {
  SessionResponse,
  UploadUrlResponse,
  ConfirmScreenshotRequest,
  ConfirmScreenshotResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  StatusResponse,
  VideoResponse,
} from "@collapse/shared";
import type { TokenProvider } from "../types.js";

export interface CollapseClient {
  resolveToken(): Promise<string>;
  getSession(): Promise<SessionResponse>;
  getUploadUrl(): Promise<UploadUrlResponse>;
  confirmScreenshot(body: ConfirmScreenshotRequest): Promise<ConfirmScreenshotResponse>;
  uploadToR2(uploadUrl: string, blob: Blob): Promise<void>;
  pause(): Promise<PauseResponse>;
  resume(): Promise<ResumeResponse>;
  stop(): Promise<StopResponse>;
  getStatus(): Promise<StatusResponse>;
  getVideo(): Promise<VideoResponse>;
}

export interface CreateClientOptions {
  baseUrl: string;
  token: TokenProvider;
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
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function createCollapseClient(options: CreateClientOptions): CollapseClient {
  const { baseUrl, token } = options;

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

    async getUploadUrl() {
      return fetchJson<UploadUrlResponse>(await sessionUrl("/upload-url"));
    },

    async confirmScreenshot(body) {
      return fetchJson<ConfirmScreenshotResponse>(await sessionUrl("/screenshots"), {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async uploadToR2(uploadUrl, blob) {
      let res: Response;
      try {
        res = await fetch(uploadUrl, {
          method: "PUT",
          body: blob,
          headers: { "Content-Type": "image/jpeg" },
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

    async stop() {
      return fetchJson<StopResponse>(await sessionUrl("/stop"), {
        method: "POST",
      });
    },

    async getStatus() {
      return fetchJson<StatusResponse>(await sessionUrl("/status"));
    },

    async getVideo() {
      return fetchJson<VideoResponse>(await sessionUrl("/video"));
    },
  };
}
