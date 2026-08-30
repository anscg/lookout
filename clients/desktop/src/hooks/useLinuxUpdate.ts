import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "../logger.js";
import { isLinux } from "../platform.js";
import { instructionsFor, type LinuxInstall } from "../updateCommand.js";

/** Carries the top-level `version` even though it lists no linux platform. */
const MANIFEST_URL = "https://github.com/hackclub/lookout/releases/latest/download/latest.json";
const RELEASES_URL = "https://github.com/hackclub/lookout/releases/latest";
const CHECK_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
/** Remembers the version someone dismissed, so we ask once per release. */
const DISMISSED_KEY = "lookout_update_nag_dismissed";

export interface LinuxUpdate {
  version: string;
  /** Shell command to run, or null when there's no repository to run against. */
  command: string | null;
  /** Why there's no command — shown instead of the terminal block. */
  fallback: string | null;
  releasesUrl: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".");
  const pb = b.replace(/^v/, "").split(".");
  for (let i = 0; i < 3; i++) {
    const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Watches for a newer release on Linux, where the in-app updater is off by
 * design — packages are the package manager's business. Resolves to null when
 * current, when offline, or when this version was already dismissed.
 */
export function useLinuxUpdate(): { update: LinuxUpdate | null; dismiss: () => void } {
  const [update, setUpdate] = useState<LinuxUpdate | null>(null);

  useEffect(() => {
    if (!isLinux) return;
    let cancelled = false;

    const check = async () => {
      try {
        const [current, res] = await Promise.all([
          getVersion(),
          fetch(MANIFEST_URL, { cache: "no-store" }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const latest = String((await res.json()).version ?? "").replace(/^v/, "");
        if (cancelled || !latest) return;
        if (compareVersions(latest, current) <= 0) return setUpdate(null);
        if (localStorage.getItem(DISMISSED_KEY) === latest) return;

        const install = await invoke<LinuxInstall>("linux_install_kind");
        if (cancelled) return;
        setUpdate({ version: latest, releasesUrl: RELEASES_URL, ...instructionsFor(install) });
      } catch (e) {
        // Offline, rate-limited, or GitHub is down. Not worth telling anyone.
        console.warn("[linux-update] check failed:", e);
      }
    };

    void check();
    const id = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const dismiss = () => {
    if (update) localStorage.setItem(DISMISSED_KEY, update.version);
    setUpdate(null);
  };

  return { update, dismiss };
}
