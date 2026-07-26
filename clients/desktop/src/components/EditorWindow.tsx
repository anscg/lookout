import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TimelapseEditor, colors, fontSize, fontWeight, spacing } from "@lookout/react";
import { getApiBase } from "../serverConfig.js";

/** Event the editor window emits after applying cuts, so the main window
 *  can refresh the session detail + gallery. Payload: { token }. */
export const EDITED_EVENT = "lookout-edited";

/**
 * Open (or focus) the dedicated editor window for a session. The main
 * window is a fixed 480×640 — far too small to scrub a multi-hour
 * timeline with any precision — so editing gets its own resizable window.
 */
export async function openEditorWindow(token: string): Promise<void> {
  const label = `editor-${token.slice(0, 8)}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  const win = new WebviewWindow(label, {
    url: `${window.location.pathname}#/editor?token=${token}`,
    title: "Edit timelapse",
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    resizable: true,
    center: true,
  });
  win.once("tauri://error", (e) => {
    console.error("[editor] failed to open editor window:", e);
  });
}

/** The editor window's root view (route `#/editor?token=…`). */
export function EditorWindow({ token }: { token: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        background: "var(--color-bg-body)",
        color: colors.text.primary,
        padding: spacing.xl,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
      }}
    >
      <div
        style={{
          fontSize: fontSize.lg,
          fontWeight: fontWeight.bold,
          color: colors.text.primary,
        }}
      >
        Edit timelapse
        <span
          style={{
            marginLeft: spacing.sm,
            fontSize: fontSize.xs,
            fontWeight: fontWeight.normal,
            color: colors.text.tertiary,
          }}
        >
          drag the strip to remove minutes — the tracked time updates with it
        </span>
      </div>
      <TimelapseEditor
        token={token}
        apiBaseUrl={getApiBase()}
        onApplied={() => {
          // Tell the main window, then close. Fire-and-forget on purpose:
          // even if the emit fails, closing is correct — the main window
          // shows the recompiled video on its next fetch.
          void emit(EDITED_EVENT, { token })
            .catch((e) => console.error("[editor] emit failed:", e))
            .finally(() => getCurrentWindow().close().catch(() => {}));
        }}
        onCancel={() => {
          void getCurrentWindow().close().catch(() => {});
        }}
      />
    </div>
  );
}
