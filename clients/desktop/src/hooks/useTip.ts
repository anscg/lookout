import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { getApiBase } from "../serverConfig.js";
import { fetchTip } from "../api/tauriClient.js";
import type { Tip } from "../tip.js";

// Read once per webview load; Settings → Server reloads the view on change.
const API_BASE = getApiBase();
// Re-check while the app stays open: a tip published mid-session would
// otherwise wait for a restart.
const CHECK_INTERVAL_MS = 15 * 60_000;

/**
 * Hero images fetched and decoded this session.
 *
 * Holding the element, not firing and forgetting: a live reference keeps the
 * decoded bitmap in the image cache for the life of the app, which an HTTP
 * cache alone wouldn't guarantee — the hero is hosted wherever the author put
 * it, and a `no-store` one would re-download on open.
 */
const preloaded = new Map<string, HTMLImageElement>();

function preloadHero(url: string): void {
  if (preloaded.has(url)) return;
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  preloaded.set(url, img);
  // Decode ahead of paint too, so opening costs neither a fetch nor a decode.
  // Failures are the drawer's problem — it falls back to a text-only sheet.
  img.decode?.().catch(() => {});
}

/**
 * Polls for the active tip, or null. Failures and the no-tip case both
 * resolve to null. Whether it should actually open is `shouldShowTip`.
 */
export function useTip(): Tip | null {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        let version: string | undefined;
        try {
          version = await getVersion();
        } catch {
          // Unreported version counts as 0 server-side.
        }
        const data = await fetchTip<Tip>(API_BASE, { client: "lookout-desktop", version });
        if (cancelled) return;
        const next = data.tip ?? null;
        setTip(next);
        // Warm the artwork now — minutes before anyone sees the sheet.
        if (next?.imageUrl) preloadHero(next.imageUrl);
      } catch (e) {
        console.warn("[tip] fetch failed:", e);
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return tip;
}
