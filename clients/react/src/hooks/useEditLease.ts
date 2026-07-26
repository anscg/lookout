import { useEffect, useRef, useState } from "react";
import { EDIT_HEARTBEAT_SECONDS } from "@lookout/shared";
import type { LookoutClient } from "../api/client.js";

/**
 * Holds a session's edit lease open for as long as an editing surface is
 * mounted.
 *
 * The server publishes a held session once nothing has renewed the lease
 * for a lease term, so "am I still editing?" is answered by the surface
 * actually existing rather than by a countdown the user has to race. Any
 * view that represents active editing — the editor itself, the review
 * panel — should call this; when the last one unmounts, the session
 * publishes on its own a lease later.
 *
 * Returns false once the server reports the session is no longer held
 * (published, failed, or past the ceiling), so callers can stop showing
 * editing affordances.
 */
export function useEditLease(client: LookoutClient, active = true): boolean {
  const [held, setHeld] = useState(true);
  // Read inside the interval so a lease that lapses doesn't keep polling.
  const heldRef = useRef(true);
  heldRef.current = held;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const beat = async () => {
      if (cancelled || !heldRef.current) return;
      try {
        const res = await client.heartbeatEditing();
        if (!cancelled && !res.held) setHeld(false);
      } catch {
        // Transient failures are fine: the lease is longer than several
        // heartbeats, so a dropped request never ends an edit on its own.
      }
    };

    void beat();
    const id = setInterval(beat, EDIT_HEARTBEAT_SECONDS * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, active]);

  return held;
}
