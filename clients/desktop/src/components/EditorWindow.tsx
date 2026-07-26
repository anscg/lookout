import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TimelapseEditor, colors, fontSize, fontWeight, spacing } from "@lookout/react";
import { getApiBase } from "../serverConfig.js";

/** Event the editor window emits after applying cuts, so the main window
 *  can refresh the session detail + gallery. Payload: { token }. */
export const EDITED_EVENT = "lookout-edited";

/** Emitted when an editor window is opened, so the main window can step
 *  out of the way. Payload: { token }. */
export const EDITOR_OPENED_EVENT = "lookout-editor-opened";

/** Tauri window label for a session's editor. */
export function editorWindowLabel(token: string): string {
  return `editor-${token.slice(0, 8)}`;
}

/** Is the editor window for this session currently open? */
export async function isEditorWindowOpen(token: string): Promise<boolean> {
  try {
    return (await WebviewWindow.getByLabel(editorWindowLabel(token))) !== null;
  } catch {
    return false;
  }
}

/** Bring an already-open editor window to the front. */
export async function focusEditorWindow(token: string): Promise<void> {
  const win = await WebviewWindow.getByLabel(editorWindowLabel(token));
  await win?.setFocus().catch(() => {});
}

/**
 * Open (or focus) the dedicated editor window for a session. The main
 * window is a fixed 480×640 — far too small to scrub a multi-hour
 * timeline with any precision — so editing gets its own resizable window.
 */
export async function openEditorWindow(token: string): Promise<void> {
  const label = editorWindowLabel(token);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    await emit(EDITOR_OPENED_EVENT, { token }).catch(() => {});
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
  await emit(EDITOR_OPENED_EVENT, { token }).catch(() => {});
}

/**
 * What the main window shows while the editor window is up. The editing
 * happens over there, so anything rendered here would just be a second,
 * stale copy of the same session competing for attention.
 */
export function EditorOpenPlaceholder({ token }: { token: string }) {
  const [focusing, setFocusing] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        setFocusing(true);
        void focusEditorWindow(token).finally(() => setFocusing(false));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") void focusEditorWindow(token);
      }}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.md,
        padding: spacing.xxl,
        textAlign: "center",
        cursor: "pointer",
        userSelect: "none",
        opacity: focusing ? 0.6 : 1,
        transition: "opacity 0.15s ease",
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.text.tertiary}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 9h20" />
        <path d="M9 14h6" />
      </svg>
      <div
        style={{
          fontSize: fontSize.lg,
          fontWeight: fontWeight.bold,
          color: colors.text.primary,
        }}
      >
        Edit your timelapse in the edit window.
      </div>
      <div style={{ fontSize: fontSize.sm, color: colors.text.tertiary }}>
        Click here to bring it to the front.
      </div>
    </div>
  );
}

/**
 * Tracks whether an editor window is open, for the main window.
 *
 * Listens for the open event, then polls for the window's existence — the
 * poll is what guarantees the main window can never get stuck behind the
 * placeholder if the editor window is force-quit or crashes.
 */
export function useEditorWindowOpen(): string | null {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisteners.push(
        await listen<{ token: string }>(EDITOR_OPENED_EVENT, (e) => {
          if (e.payload?.token) setToken(e.payload.token);
        }),
        // Publishing closes the editor window; clear immediately rather
        // than waiting for the poll, so the session view is back the
        // instant the user saves.
        await listen(EDITED_EVENT, () => setToken(null)),
      );
    });
    return () => {
      for (const un of unlisteners) un();
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const id = setInterval(async () => {
      if (cancelled) return;
      if (!(await isEditorWindowOpen(token))) setToken(null);
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  return token;
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
