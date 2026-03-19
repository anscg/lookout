/**
 * Centralized logger for the Collapse desktop app.
 *
 * - Captures all console.log/warn/error/debug output
 * - Renders to the #debug panel (toggled with backtick)
 * - Provides getReport() for copy-paste error reports
 * - Re-exports a logged `invoke` wrapper for Tauri IPC
 * - Listens for "capture-progress" Tauri events from the Rust pipeline
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogEntry {
  time: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

// ---------------------------------------------------------------------------
// Circular buffer
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];

function push(level: LogEntry["level"], message: string) {
  entries.push({ time: Date.now(), level, message });
  if (entries.length > MAX_ENTRIES) entries.shift();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Monkey-patch console so EVERY console call flows into the debug panel
// ---------------------------------------------------------------------------

const _log = console.log.bind(console);
const _debug = console.debug.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

function argsToString(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

console.log = (...args: unknown[]) => {
  _log(...args);
  push("info", argsToString(args));
};
console.debug = (...args: unknown[]) => {
  _debug(...args);
  push("debug", argsToString(args));
};
console.warn = (...args: unknown[]) => {
  _warn(...args);
  push("warn", argsToString(args));
};
console.error = (...args: unknown[]) => {
  _error(...args);
  push("error", argsToString(args));
};

// ---------------------------------------------------------------------------
// Global error handlers (supersede the inline script in index.html)
// ---------------------------------------------------------------------------

window.onerror = (msg, src, line) => {
  push("error", `UNCAUGHT: ${msg} (${src}:${line})`);
};
window.onunhandledrejection = (e) => {
  const reason = e.reason instanceof Error ? e.reason.message + (e.reason.stack ? "\n" + e.reason.stack : "") : String(e.reason);
  push("error", `UNHANDLED REJECTION: ${reason}`);
};

// ---------------------------------------------------------------------------
// Listen for Tauri events from Rust pipeline
// ---------------------------------------------------------------------------

listen<string>("capture-progress", (event) => {
  console.log(`[capture] ${event.payload}`);
}).catch(() => {
  // If listen fails (e.g. Tauri not ready yet), that's fine
});

// ---------------------------------------------------------------------------
// Debug panel rendering
// ---------------------------------------------------------------------------

const LEVEL_COLORS: Record<LogEntry["level"], string> = {
  debug: "#888",
  info: "#0f0",
  warn: "#ff0",
  error: "#f44",
};

let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(render);
}

function render() {
  renderScheduled = false;
  const el = document.getElementById("debug");
  if (!el) return;

  // Build HTML
  let html =
    '<div style="position:sticky;top:0;background:#111;padding:4px 8px;border-bottom:1px solid #333;display:flex;gap:8px;z-index:1;">' +
    '<button id="dbg-copy" style="background:#333;color:#0f0;border:1px solid #555;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;">Copy Log</button>' +
    '<button id="dbg-clear" style="background:#333;color:#ff0;border:1px solid #555;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;">Clear</button>' +
    "</div>";

  for (const entry of entries) {
    const t = new Date(entry.time).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const color = LEVEL_COLORS[entry.level];
    const levelTag = entry.level.toUpperCase().padEnd(5);
    // Escape HTML in message
    const safe = entry.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html += `<div style="color:${color};white-space:pre-wrap;word-break:break-all;">${t} ${levelTag} ${safe}</div>`;
  }

  el.innerHTML = html;

  // Auto-scroll to bottom
  el.scrollTop = el.scrollHeight;

  // Wire up buttons (re-attached each render since innerHTML replaces them)
  document.getElementById("dbg-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(getReport()).then(
      () => { document.getElementById("dbg-copy")!.textContent = "Copied!"; setTimeout(() => { const b = document.getElementById("dbg-copy"); if (b) b.textContent = "Copy Log"; }, 1500); },
      () => {},
    );
  });
  document.getElementById("dbg-clear")?.addEventListener("click", () => {
    entries.length = 0;
    render();
  });
}

// ---------------------------------------------------------------------------
// Report generation (for copy-paste)
// ---------------------------------------------------------------------------

export function getReport(): string {
  const now = new Date().toISOString();
  const platform = navigator.platform || "unknown";
  const ua = navigator.userAgent || "";

  const lines = [`Collapse Desktop | ${platform} | ${now}`, `UA: ${ua}`, "---"];

  // Last 100 entries
  const recent = entries.slice(-100);
  for (const entry of recent) {
    const t = new Date(entry.time).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const levelTag = entry.level.toUpperCase().padEnd(5);
    lines.push(`${t} ${levelTag} ${entry.message}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Logged invoke wrapper — drop-in replacement for @tauri-apps/api/core invoke
// ---------------------------------------------------------------------------

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  console.log(`[ipc] → ${cmd}`, args ?? "");
  try {
    const result = await tauriInvoke<T>(cmd, args);
    console.debug(`[ipc] ← ${cmd} ok`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ipc] ← ${cmd} FAILED: ${msg}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Init log
// ---------------------------------------------------------------------------

console.log("[logger] initialized");
