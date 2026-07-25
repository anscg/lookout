import { useState, useEffect, useCallback } from "react";
import type { SessionSummary } from "@lookout/shared";

export interface UseGalleryOptions {
  apiBaseUrl: string;
  tokens: string[];
}

export interface UseGallery {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

interface CachedSession {
  summary: SessionSummary;
  fetchedAt: number;
}

// Persisted across app restarts so the gallery paints instantly from the
// last known state (and thumbnails come out of the HTTP cache) while a
// background refresh runs.
const CACHE_STORAGE_KEY = "lookout:gallery-cache:v2";
const CACHE_MAX_ENTRIES = 500;

function loadPersistedCache(): Record<string, CachedSession> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, CachedSession>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCache(cache: Record<string, CachedSession>): void {
  if (typeof localStorage === "undefined") return;
  try {
    const entries = Object.entries(cache)
      .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
      .slice(0, CACHE_MAX_ENTRIES);
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota exceeded or storage unavailable — cache is best-effort.
  }
}

const globalSessionsCache: Record<string, CachedSession> = loadPersistedCache();

export function useGallery({ apiBaseUrl, tokens }: UseGalleryOptions): UseGallery {
  const validTokens = tokens.filter((t) => /^[a-f0-9]{64}$/i.test(t));
  
  const initialSessions = validTokens
    .map(t => globalSessionsCache[t]?.summary)
    .filter((s): s is SessionSummary => s !== undefined);

  const hasAllInCache = validTokens.length > 0 && initialSessions.length === validTokens.length;

  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  const [loading, setLoading] = useState(!hasAllInCache && validTokens.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Stable reference for the token list to avoid infinite re-renders
  const tokensKey = tokens.join(",");

  const refresh = useCallback(() => setRefreshCounter((c) => c + 1), []);

  useEffect(() => {
    if (tokens.length === 0) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Only send valid hex tokens to avoid server-side validation errors
    if (validTokens.length === 0) {
      setSessions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Only show loading if we don't have cached data to prevent skeleton flash
    if (!hasAllInCache) {
      setLoading(true);
    }

    const BATCH_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < validTokens.length; i += BATCH_SIZE) {
      chunks.push(validTokens.slice(i, i + BATCH_SIZE));
    }

    Promise.all(
      chunks.map((chunk) =>
        fetch(`${apiBaseUrl}/api/sessions/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens: chunk }),
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
          }
          return res.json() as Promise<{ sessions: SessionSummary[] }>;
        })
      )
    )
      .then((results) => ({ sessions: results.flatMap((r) => r.sessions ?? []) }))
      .then((data: { sessions: SessionSummary[] }) => {
        if (!cancelled) {
          // Thumbnail URLs are permanent (/api/media/:id/thumbnail.jpg) and
          // the endpoint serves proper cache headers, so the browser HTTP
          // cache handles image reuse — just store the latest summaries.
          const now = Date.now();
          const newSessions = data.sessions ?? [];
          for (const session of newSessions) {
            globalSessionsCache[session.token] = { summary: session, fetchedAt: now };
          }
          persistCache(globalSessionsCache);

          setSessions(newSessions);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("Gallery fetch error:", err instanceof Error ? err.message : err);
          setError(err.message);
          // Keep showing whatever sessions we had
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, tokensKey, refreshCounter, hasAllInCache]);

  // Re-fetch on tab focus
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [refresh]);

  return { sessions, loading, error, refresh };
}
