import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";

export const LAST_UPDATE_KEY = "lookout_last_update_ts";
const UPDATE_COOLDOWN_MS = 60_000;
const CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes

export type UpdatePhase =
  | { state: "idle" }
  | { state: "downloading"; version: string; progress: number }
  | { state: "ready"; version: string }
  | { state: "restarting"; version: string };

/**
 * Ghostty-style background updater. Checks at launch and every 30 minutes,
 * downloads a found update in the background (progress surfaces in the
 * titlebar pill), then waits for the user to click "Restart to Complete
 * Update". Nothing ever blocks the app at launch.
 *
 * install() stays behind the user's click: on Windows it exits the app to
 * run the installer, so it must never fire automatically.
 */
export function useAppUpdate(): { phase: UpdatePhase; restart: () => void } {
  const [phase, setPhase] = useState<UpdatePhase>({ state: "idle" });
  const updateRef = useRef<Update | null>(null);
  const demoRef = useRef(false);

  // Dev-only: run `__updatePillDemo()` in the webview console to watch the
  // full pill lifecycle (enter → download progress → ready → restart → exit)
  // without a real update. Clicking the pill in demo mode fakes the restart.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__updatePillDemo = () => {
      demoRef.current = true;
      let p = 0;
      setPhase({ state: "downloading", version: "9.9.9", progress: 0 });
      const id = setInterval(() => {
        p += 1 + Math.random() * 4;
        if (p >= 100) {
          clearInterval(id);
          setPhase({ state: "ready", version: "9.9.9" });
        } else {
          setPhase({ state: "downloading", version: "9.9.9", progress: Math.round(p) });
        }
      }, 80);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__updatePillDemo;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Right after an update-relaunch, skip the immediate re-check so a bad
    // update manifest can't relaunch-loop the app.
    let skipFirstCheck = false;
    const lastUpdate = localStorage.getItem(LAST_UPDATE_KEY);
    if (lastUpdate && Date.now() - Number(lastUpdate) < UPDATE_COOLDOWN_MS) {
      console.log("[updater] skipping immediate check — just updated");
      localStorage.removeItem(LAST_UPDATE_KEY);
      skipFirstCheck = true;
    }

    const runCheck = async () => {
      if (updateRef.current) return; // already downloading or downloaded
      try {
        const update = await check();
        if (cancelled || !update) return;
        updateRef.current = update;
        console.log(`[updater] found v${update.version}, downloading in background`);
        setPhase({ state: "downloading", version: update.version, progress: 0 });

        let totalBytes = 0;
        let downloadedBytes = 0;
        await update.download((event) => {
          if (cancelled) return;
          if (event.event === "Started" && event.data.contentLength) {
            totalBytes = event.data.contentLength;
          } else if (event.event === "Progress") {
            downloadedBytes += event.data.chunkLength;
            const progress =
              totalBytes > 0
                ? Math.round((downloadedBytes / totalBytes) * 100)
                : 0;
            setPhase({ state: "downloading", version: update.version, progress });
          }
        });

        if (!cancelled) {
          console.log(`[updater] v${update.version} downloaded — waiting for restart`);
          setPhase({ state: "ready", version: update.version });
        }
      } catch (e) {
        console.warn("[updater] background update failed:", e);
        // Clear the ref so the next interval tick retries from scratch.
        updateRef.current = null;
        if (!cancelled) setPhase({ state: "idle" });
      }
    };

    if (!skipFirstCheck) runCheck();
    const id = setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const restart = useCallback(async () => {
    if (demoRef.current) {
      demoRef.current = false;
      setPhase({ state: "idle" });
      return;
    }
    const update = updateRef.current;
    if (!update) return; // the pill only becomes clickable once downloaded
    setPhase({ state: "restarting", version: update.version });
    try {
      // The bytes are already on disk, so install() is near-instant.
      // relaunch() only fires after a successful install; on Windows
      // install() itself exits the app to run the installer.
      await update.install();
      localStorage.setItem(LAST_UPDATE_KEY, String(Date.now()));
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed:", e);
      setPhase({ state: "ready", version: update.version });
    }
  }, []);

  return { phase, restart };
}
