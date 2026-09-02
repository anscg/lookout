import { useState, useEffect, type CSSProperties } from "react";
import {
  Button,
  Spinner,
  colors,
  spacing,
  fontSize,
  fontWeight,
  radii,
} from "@lookout/react";

import { invoke } from "../logger.js";
import { extractToken } from "../utils.js";
import { parsePairCallback } from "../programLink.js";
import { emit } from "@tauri-apps/api/event";
import { PageLayout } from "./PageLayout.js";

import { getApiBase } from "../serverConfig.js";
import { fetchPrograms } from "../api/tauriClient.js";

// Read once per webview load; Settings → Server reloads the view on change.
const API_BASE = getApiBase();

interface Program {
  name: string;
  // Human-friendly label to show users; the server falls back to `name` when
  // unset, so this is always present, but guard anyway for older servers.
  displayName?: string;
  newSessionUrl: string;
  iconUrl?: string | null;
  // Desktop instant-start endpoints — see programLink.ts. Only relevant to
  // the onOpenProgram delegate; this page itself never touches them.
  pairUrl?: string | null;
  startUrl?: string | null;
}

interface AddSessionPageProps {
  onBack: () => void;
  onStart: (token: string) => void;
  /**
   * Preferred way to start a program's session (App's openProgram: instant
   * start for paired programs, pairing or the browser flow otherwise). Its
   * outcome decides whether we keep waiting on a deep link or report a
   * failure. When absent, the page opens newSessionUrl itself.
   */
  onOpenProgram?: (program: Program) => Promise<"started" | "browser" | "failed">;
}

export function AddSessionPage({ onBack, onStart, onOpenProgram }: AddSessionPageProps) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programsLoading, setProgramsLoading] = useState(true);
  const [launched, setLaunched] = useState<string | null>(null);

  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch the program registry. Failures and empty lists are non-fatal — the
  // paste-a-link backup always remains available.
  useEffect(() => {
    let cancelled = false;
    fetchPrograms(API_BASE)
      .then((d) => {
        if (!cancelled) setPrograms(Array.isArray(d.programs) ? d.programs : []);
      })
      .catch((e) => {
        // Don't surface as a blocking error — just fall back to manual entry.
        console.warn("[programs] failed to load registry:", e);
        if (!cancelled) setPrograms([]);
      })
      .finally(() => {
        if (!cancelled) setProgramsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const programLabel = (p: Program) => p.displayName || p.name;

  // If the deep link never comes back (user closed the browser tab, changed
  // their mind, the program errored), the buttons used to stay disabled with
  // a spinner forever. Re-enable them after a grace period so retrying
  // doesn't require leaving and re-entering the page.
  useEffect(() => {
    if (!launched) return;
    const id = setTimeout(() => setLaunched(null), 15_000);
    return () => clearTimeout(id);
  }, [launched]);

  const handleOpenProgram = async (program: Program) => {
    setError(null);
    setLaunched(programLabel(program));
    try {
      if (onOpenProgram) {
        // App's shared handler: instant start when this device is paired,
        // otherwise the pairing consent page or the plain browser flow.
        const outcome = await onOpenProgram(program);
        if (outcome === "failed") {
          setError("Couldn't open your browser. Try the link option below.");
          setLaunched(null);
        }
        // "started" unmounts us as the app routes to the record page;
        // "browser" keeps the spinner up until the deep link lands (or the
        // 15s grace period above re-enables the buttons).
        return;
      }
      await invoke("open_external_url", { url: program.newSessionUrl });
    } catch (e) {
      console.error("[programs] failed to open url:", e);
      setError("Couldn't open your browser. Try the link option below.");
      setLaunched(null);
    }
  };

  const handleStart = () => {
    const trimmed = link.trim();
    if (!trimmed) return;

    // A `lookout://pair?...` link routes through the same handler the OS
    // would have called - if the deep link never fired (Windows sometimes
    // fails to hand off), pasting the URL from the program's page is the
    // manual escape hatch.
    if (parsePairCallback(trimmed)) {
      setError(null);
      setLoading(true);
      void emit("lookout-deep-link", [trimmed]).catch((e) => {
        console.error("[add] pair paste emit failed:", e);
        setError("Couldn't finish linking - try again from the program's page.");
        setLoading(false);
      });
      return;
    }

    const token = extractToken(trimmed);
    if (!token) {
      setError("Couldn't find a valid session token or pair link in that URL.");
      return;
    }
    setError(null);
    setLoading(true);
    onStart(token);
  };

  const note: CSSProperties = {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    margin: 0,
    textAlign: "center",
    lineHeight: 1.5,
  };

  const hasPrograms = programs.length > 0;

  return (
    <PageLayout
      onBack={onBack}
      title="Start a recording"
      subtitle="Pick a program to start a timelapse"
      actions={
        <>
          {error && (
            <p style={{ ...note, color: colors.status.danger }}>{error}</p>
          )}
          {/* Backup: paste a lookout:// link, for when the deep link doesn't fire. */}
          <input
            type="text"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) handleStart();
            }}
            placeholder="Paste a lookout:// link here"
            disabled={loading}
            style={{
              width: "100%",
              padding: `${spacing.md}px ${spacing.lg}px`,
              fontSize: fontSize.md,
              fontWeight: fontWeight.medium,
              color: colors.text.primary,
              background: colors.bg.sunken,
              border: `1px solid ${error ? colors.status.danger : colors.border.default}`,
              borderRadius: radii.lg,
              outline: "none",
              boxSizing: "border-box",
              height: 48,
              opacity: loading ? 0.5 : 1,
            }}
          />
          <Button
            variant="primary"
            size="lg"
            fullWidth
            disabled={!link.trim() || loading}
            loading={loading}
            onClick={handleStart}
          >
            Start from link
          </Button>
        </>
      }
    >
      <div
        style={{
          width: "100%",
          marginTop: spacing.lg,
          display: "flex",
          flexDirection: "column",
          gap: spacing.md,
        }}
      >
        {programsLoading ? (
          <Spinner size="md" />
        ) : hasPrograms ? (
          <>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: spacing.sm,
              }}
            >
              {programs.map((p) => (
                <Button
                  key={p.name}
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={launched === programLabel(p)}
                  disabled={loading || (launched !== null && launched !== programLabel(p))}
                  onClick={() => handleOpenProgram(p)}
                >
                  {p.iconUrl && (
                    <img
                      src={p.iconUrl}
                      alt=""
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        marginRight: 8,
                        verticalAlign: -4,
                      }}
                    />
                  )}
                  {programLabel(p)}
                </Button>
              ))}
            </div>
            {launched ? (
              <p style={{ ...note, color: colors.text.secondary }}>
                Opened <strong>{launched}</strong> in your browser — finish there and
                you'll be sent back here to start recording.
              </p>
            ) : (
              <p style={note}>
                Not all programs support this. You may need to start the session on
                the program's website.
              </p>
            )}
          </>
        ) : (
          <p style={note}>
            No programs available right now. Open Lookout from a Hack Club site, or
            paste a link below.
          </p>
        )}
      </div>
    </PageLayout>
  );
}
