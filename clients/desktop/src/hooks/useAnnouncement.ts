import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { getApiBase } from "../serverConfig.js";
import { fetchAnnouncement } from "../api/tauriClient.js";

// Read once per webview load; Settings → Server reloads the view on change.
const API_BASE = getApiBase();
// Re-check for a new/cleared announcement while the app stays open.
const CHECK_INTERVAL_MS = 15 * 60_000; // 15 minutes

export interface Announcement {
  level: "info" | "success" | "warning" | "danger";
  message: string;
  url: string | null;
}

/**
 * Polls the server's public announcement endpoint — once on open and every
 * ~15 min thereafter — so the gallery can show an admin-authored banner.
 * Failures and the no-announcement case both resolve to null; the banner is
 * simply not shown. Never blocks or interrupts the user.
 */
export function useAnnouncement(): Announcement | null {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        // Report who's asking so the server can target announcements (e.g.
        // "please update" only to versions ≤ X). Best-effort: with no
        // version the server treats us as version 0, exactly like the old
        // builds that never sent one.
        let version: string | undefined;
        try {
          version = await getVersion();
        } catch {
          // version stays unreported
        }
        const data = await fetchAnnouncement(API_BASE, { client: "lookout-desktop", version });
        if (!cancelled) setAnnouncement(data.announcement ?? null);
      } catch (e) {
        // Non-fatal — keep whatever we last had (or null) and try again later.
        console.warn("[announcement] fetch failed:", e);
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return announcement;
}
