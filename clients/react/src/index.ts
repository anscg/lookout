// Provider
export { CollapseProvider } from "./CollapseProvider.js";
export type { CollapseProviderProps } from "./CollapseProvider.js";

// Drop-in widget
export { CollapseRecorder } from "./components/CollapseRecorder.js";

// Sub-components
export { StatusBar } from "./components/StatusBar.js";
export type { StatusBarProps } from "./components/StatusBar.js";
export { RecordingControls } from "./components/RecordingControls.js";
export type { RecordingControlsProps } from "./components/RecordingControls.js";
export { ScreenPreview } from "./components/ScreenPreview.js";
export type { ScreenPreviewProps } from "./components/ScreenPreview.js";
export { ResultView } from "./components/ResultView.js";
export type { ResultViewProps } from "./components/ResultView.js";

// Headless hooks
export { useCollapse } from "./hooks/useCollapse.js";
export { useScreenCapture } from "./hooks/useScreenCapture.js";
export { useUploader } from "./hooks/useUploader.js";
export { useSession } from "./hooks/useSession.js";
export { useSessionTimer, formatTime } from "./hooks/useSessionTimer.js";

// API client (no React dependency)
export { createCollapseClient } from "./api/client.js";
export type { CollapseClient, CreateClientOptions } from "./api/client.js";

// Types
export type {
  CollapseConfig,
  CollapseState,
  CollapseActions,
  CollapseCallbacks,
  CaptureSettings,
  RetrySettings,
  UploadState,
  CaptureResult,
  RecorderStatus,
  TokenProvider,
  ResolvedConfig,
} from "./types.js";

// Re-export shared types consumers need
export type { SessionStatus } from "@collapse/shared";
export { SESSION_STATUSES } from "@collapse/shared";
