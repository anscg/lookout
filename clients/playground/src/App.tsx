import { useCallback, useEffect, useRef, useState } from "react";
import {
  LookoutProvider,
  LookoutRecorder,
  SessionDetail,
  TimelapseEditor,
  createLookoutClient,
  colors,
  fontSize,
  fontWeight,
  radii,
  spacing,
  type CutInterval,
} from "@lookout/react";

/**
 * A harness for the edit feature.
 *
 * The point isn't to look like the product — it's to make the parts that
 * are hard to eyeball checkable: the editor at arbitrary sizes, and the
 * server's own numbers next to what the editor is claiming. Most of the
 * bugs in this feature were disagreements between those two.
 */

type Tab = "record" | "editor" | "detail";

const LS_KEY = "lookout-playground";

interface Settings {
  apiBaseUrl: string;
  token: string;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Settings;
  } catch {
    // Fall through to defaults.
  }
  return { apiBaseUrl: "https://lookout-stage.dino.icu", token: "" };
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [applied, setApplied] = useState<Settings | null>(() => {
    const s = loadSettings();
    return s.token ? s : null;
  });
  const [tab, setTab] = useState<Tab>("editor");
  const [cuts, setCuts] = useState<CutInterval[]>([]);

  const apply = () => {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
    setApplied({ ...settings });
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Header
        settings={settings}
        onChange={setSettings}
        onApply={apply}
        tab={tab}
        onTab={setTab}
        ready={Boolean(applied?.token)}
      />

      {!applied?.token ? (
        <Empty />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }}>
            {tab === "record" && (
              <LookoutProvider token={applied.token} apiBaseUrl={applied.apiBaseUrl}>
                <LookoutRecorder />
              </LookoutProvider>
            )}
            {tab === "editor" && (
              <ResizableEditor
                key={applied.token}
                settings={applied}
                onCuts={setCuts}
              />
            )}
            {tab === "detail" && (
              <SessionDetail
                key={applied.token}
                token={applied.token}
                apiBaseUrl={applied.apiBaseUrl}
              />
            )}
          </div>
          <ServerTruth settings={applied} cuts={cuts} />
        </div>
      )}
    </div>
  );
}

function Header({
  settings,
  onChange,
  onApply,
  tab,
  onTab,
  ready,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onApply: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  ready: boolean;
}) {
  const input: React.CSSProperties = {
    background: colors.bg.sunken,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radii.md,
    color: colors.text.primary,
    padding: "6px 10px",
    fontSize: fontSize.md,
    fontFamily: "inherit",
    outline: "none",
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: spacing.sm,
        padding: spacing.md,
        borderBottom: `1px solid ${colors.border.default}`,
        flexWrap: "wrap",
      }}
    >
      <strong style={{ fontSize: fontSize.md }}>Lookout SDK</strong>
      <input
        style={{ ...input, width: 260 }}
        value={settings.apiBaseUrl}
        placeholder="https://lookout-stage.dino.icu"
        onChange={(e) => onChange({ ...settings, apiBaseUrl: e.target.value })}
      />
      <input
        style={{ ...input, flex: 1, minWidth: 260, fontFamily: "ui-monospace, monospace" }}
        value={settings.token}
        placeholder="64-char session token"
        spellCheck={false}
        onChange={(e) => onChange({ ...settings, token: e.target.value.trim() })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onApply();
        }}
      />
      <button onClick={onApply} style={{ ...input, cursor: "pointer", fontWeight: fontWeight.semibold }}>
        Load
      </button>

      {ready && (
        <div style={{ display: "flex", gap: 4, marginLeft: spacing.sm }}>
          {(["editor", "detail", "record"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              style={{
                ...input,
                cursor: "pointer",
                background: tab === t ? colors.bg.selected : "transparent",
                borderColor: tab === t ? colors.border.selected : colors.border.default,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: colors.text.secondary,
        fontSize: fontSize.lg,
        textAlign: "center",
        padding: spacing.xxl,
        lineHeight: 1.6,
      }}
    >
      Paste a session token to begin.
      <br />
      <span style={{ fontSize: fontSize.md, color: colors.text.tertiary }}>
        Stop it with an edit hold first, or the editor will report it published.
      </span>
    </div>
  );
}

/**
 * The editor inside a box you can resize to arbitrary dimensions.
 *
 * The clipping bug was only visible at particular window shapes, and a
 * maximised browser window never reproduces it. Presets cover the corners:
 * short (the dock must survive), narrow (the action row must wrap), and
 * the real desktop window's minimum.
 */
function ResizableEditor({
  settings,
  onCuts,
}: {
  settings: Settings;
  onCuts: (cuts: CutInterval[]) => void;
}) {
  const [size, setSize] = useState({ w: 900, h: 620 });
  const presets: Array<[string, number, number]> = [
    ["desktop default", 900, 620],
    ["desktop minimum", 620, 480],
    ["short", 900, 360],
    ["narrow", 480, 620],
    ["tiny", 420, 320],
  ];

  return (
    <div style={{ padding: spacing.md }}>
      <div style={{ display: "flex", gap: 6, marginBottom: spacing.md, flexWrap: "wrap" }}>
        {presets.map(([label, w, h]) => (
          <button
            key={label}
            onClick={() => setSize({ w, h })}
            style={{
              background: size.w === w && size.h === h ? colors.bg.selected : "transparent",
              border: `1px solid ${colors.border.default}`,
              borderRadius: radii.md,
              color: colors.text.secondary,
              padding: "4px 10px",
              fontSize: fontSize.sm,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {label} · {w}×{h}
          </button>
        ))}
        <span style={{ fontSize: fontSize.sm, color: colors.text.tertiary, alignSelf: "center" }}>
          or drag the corner
        </span>
      </div>

      <div
        style={{
          width: size.w,
          height: size.h,
          maxWidth: "100%",
          resize: "both",
          overflow: "auto",
          border: `1px dashed ${colors.border.hover}`,
          borderRadius: 12,
          padding: spacing.md,
          boxSizing: "border-box",
        }}
      >
        <TimelapseEditor
          token={settings.token}
          apiBaseUrl={settings.apiBaseUrl}
          onApplied={() => console.log("[playground] published")}
          onCutsChange={(cuts, dirty) => {
            onCuts(cuts);
            console.log("[playground] cuts", { dirty, cuts });
          }}
        />
      </div>
    </div>
  );
}

/**
 * What the server actually thinks, polled live.
 *
 * Every serious bug in this feature was the client and the server
 * disagreeing — over-counted cut units, a stale hold, a status the editor
 * read as terminal. Putting the server's own numbers on screen makes those
 * disagreements visible instead of inferable from a 400.
 */
function ServerTruth({
  settings,
  cuts,
}: {
  settings: Settings;
  cuts: CutInterval[];
}) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [units, setUnits] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const clientRef = useRef(
    createLookoutClient({ baseUrl: settings.apiBaseUrl, token: settings.token }),
  );

  useEffect(() => {
    clientRef.current = createLookoutClient({
      baseUrl: settings.apiBaseUrl,
      token: settings.token,
    });
  }, [settings.apiBaseUrl, settings.token]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [s, u] = await Promise.all([
          fetch(`${settings.apiBaseUrl}/api/sessions/${settings.token}/status`).then((r) =>
            r.json(),
          ),
          fetch(`${settings.apiBaseUrl}/api/sessions/${settings.token}/units`).then((r) =>
            r.json(),
          ),
        ]);
        if (cancelled) return;
        setError(null);
        setStatus(s);
        // The unit list is long and not the interesting part.
        const { units: list, originalVideoUrl, ...rest } = u as Record<string, unknown>;
        setUnits({ ...rest, unitCount: Array.isArray(list) ? list.length : 0 });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settings.apiBaseUrl, settings.token]);

  // Dry-run the cut list the editor most recently reported, so the
  // server's own arithmetic sits next to the editor's footer.
  const dryRun = useCallback(async (cuts: CutInterval[]) => {
    try {
      setPreview({ ...(await clientRef.current.setCuts(cuts)) });
    } catch (e) {
      setPreview({ error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const box: React.CSSProperties = {
    background: colors.bg.sunken,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radii.md,
    padding: spacing.sm,
    fontSize: 11,
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    color: colors.text.secondary,
  };

  return (
    <div
      style={{
        flex: "0 0 320px",
        borderLeft: `1px solid ${colors.border.default}`,
        padding: spacing.md,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: spacing.sm,
      }}
    >
      <div style={{ fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
        Server truth
      </div>
      <div style={{ fontSize: fontSize.xs, color: colors.text.tertiary, lineHeight: 1.5 }}>
        Polled every 2s. Compare <code>editable</code> and the tracked-time
        pair against what the editor shows.
      </div>

      {error && <div style={{ ...box, color: colors.text.error }}>{error}</div>}

      <Label>GET /status</Label>
      <div style={box}>{JSON.stringify(status, null, 1)}</div>

      <Label>GET /units</Label>
      <div style={box}>{JSON.stringify(units, null, 1)}</div>

      <Label>PUT /cuts</Label>
      <button
        onClick={() => void dryRun(cuts)}
        style={{
          background: "transparent",
          border: `1px solid ${colors.border.hover}`,
          borderRadius: radii.md,
          color: colors.text.primary,
          padding: "6px 10px",
          fontSize: fontSize.sm,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        Verify {cuts.length} interval{cuts.length === 1 ? "" : "s"} against server
      </button>
      <div style={{ fontSize: fontSize.xs, color: colors.text.tertiary, lineHeight: 1.5 }}>
        Sends the editor's current list and shows what the server counts.
        <strong> unitsCut here must match the editor's "removed"</strong> — a
        mismatch is the class of bug that made Save fail with "would remove
        the entire timelapse". This writes the cut list (it does not
        publish).
      </div>
      {preview && <div style={box}>{JSON.stringify(preview, null, 1)}</div>}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: fontSize.xs,
        color: colors.text.tertiary,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        marginTop: spacing.xs,
      }}
    >
      {children}
    </div>
  );
}
