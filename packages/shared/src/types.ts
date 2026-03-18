import type { SessionStatus } from "./constants.js";

export interface Session {
  id: string;
  token: string;
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
  createdAt: string;
}

// -- API request/response types --

export interface CreateSessionRequest {
  metadata?: Record<string, unknown>;
}

export interface CreateSessionResponse {
  token: string;
  sessionId: string;
  sessionUrl: string;
}

export interface SessionResponse {
  status: SessionStatus;
  trackedSeconds: number;
  screenshotCount: number;
  startedAt: string | null;
  totalActiveSeconds: number;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  r2Key: string;
  screenshotId: string;
  minuteBucket: number;
  nextExpectedAt: string;
}

export interface ConfirmScreenshotRequest {
  screenshotId: string;
  width: number;
  height: number;
  fileSize: number;
}

export interface ConfirmScreenshotResponse {
  confirmed: true;
  trackedSeconds: number;
  nextExpectedAt: string;
}

export interface PauseResponse {
  status: "paused";
  totalActiveSeconds: number;
}

export interface ResumeResponse {
  status: "active";
  nextExpectedAt: string;
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
  trackedSeconds: number;
}

export interface VideoResponse {
  videoUrl: string;
}
