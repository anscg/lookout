// Inject CSS custom properties for light/dark theme.
// Deduped: only injects once even if multiple modules import this file.
if (typeof document !== "undefined" && !document.querySelector("style[data-lookout-theme]")) {
  const style = document.createElement("style");
  style.setAttribute("data-lookout-theme", "");
  style.textContent = `
    :root {
      /* Dark theme (default/fallback).

         These are Adwaita's surfaces — GNOME's own #242424 window over
         #1e1e1e views — used as the app's baseline on every platform, not
         just the one that ships them.

         Not pure black, and the reason matters: on macOS and Windows the
         window is usually wearing vibrancy or mica and this colour never
         shows, but those materials drop out (remote sessions, transparency
         disabled, an unsupported compositor) and the flat colour underneath
         is what the user is left with. #000 as that fallback reads as a hole
         in the screen rather than a surface. */
      --color-bg-body: #242424;
      --color-bg-panel: #1e1e1e;
      --color-modal-backdrop: rgba(0, 0, 0, 0.55);
      --color-bg-surface: rgba(255, 255, 255, 0.08);
      --color-bg-sunken: rgba(255, 255, 255, 0.04);
      --color-text-primary: #ffffff;
      --color-text-inverse: #000000;
      --color-text-secondary: rgba(255, 255, 255, 0.7);
      --color-text-tertiary: rgba(255, 255, 255, 0.5);
      --color-text-quaternary: rgba(255, 255, 255, 0.28);
      --color-text-error: #fca5a5;
      --color-border-default: rgba(255, 255, 255, 0.12);
      --color-border-hover: rgba(255, 255, 255, 0.22);
      --color-bg-selected: rgba(255, 255, 255, 0.12);
      --color-border-selected: rgba(255, 255, 255, 0.3);
      --color-icon-selected: rgba(255, 255, 255, 0.8);
      --color-status-neutral: rgba(255, 255, 255, 0.2);
      --color-spinner-base: rgba(255, 255, 255, 0.1);
      --color-spinner-track: rgba(255, 255, 255, 0.8);
      --color-skeleton-bg: rgba(255, 255, 255, 0.06);
      --color-skeleton-shimmer: rgba(255, 255, 255, 0.12);
      --color-badge-primary-bg: #22c55e26;
      --color-badge-primary-text: #22c55e;
      --color-badge-overlay-bg: rgba(0, 0, 0, 0.7);
      --color-badge-overlay-text: #ffffff;
      --color-archive-bg: rgba(0, 0, 0, 0.6);
      --color-archive-icon: #ffffff;
      --color-archive-border: rgba(255, 255, 255, 0.1);
      --color-archive-hover-bg: rgba(255, 255, 255, 0.1);
      --color-archive-hover-border: rgba(255, 255, 255, 0.2);
      /* Editor: a recessed well the footage sits in, and the removed-region
         vocabulary. Deliberately translucent so the window's vibrancy still
         reads through the chrome. */
      --color-well: rgba(0, 0, 0, 0.32);
      --color-well-border: rgba(255, 255, 255, 0.1);
      --color-cut-fill: rgba(248, 113, 113, 0.26);
      --color-cut-fill-hover: rgba(248, 113, 113, 0.36);
      --color-cut-border: #f87171;
      --color-cut-stripe: rgba(248, 113, 113, 0.13);
      --color-track: rgba(255, 255, 255, 0.1);
      /* Accent: the one colour an embedding program can replace. Drives
         primary buttons, focus rings, and progress. Semantic status
         colours (success/warning/danger) stay put — those carry meaning,
         not brand. */
      --color-accent: #3b82f6;
      --color-accent-hover: #2f6fd0;
      --color-accent-hover: color-mix(in oklab, var(--color-accent) 88%, black);
      --color-on-accent: #ffffff;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --color-bg-body: #fafafa;
        --color-bg-panel: #ffffff;
        --color-modal-backdrop: rgba(0, 0, 0, 0.35);
        --color-bg-surface: #ffffff;
        --color-bg-sunken: rgba(0, 0, 0, 0.04);
        --color-text-primary: rgba(0, 0, 0, 0.85);
        --color-text-inverse: #ffffff;
        --color-text-secondary: rgba(0, 0, 0, 0.65);
        --color-text-tertiary: rgba(0, 0, 0, 0.45);
        --color-text-quaternary: rgba(0, 0, 0, 0.25);
        --color-text-error: #ef4444;
        --color-border-default: rgba(0, 0, 0, 0.12);
        --color-border-hover: rgba(0, 0, 0, 0.22);
        --color-bg-selected: rgba(0, 0, 0, 0.1);
        --color-border-selected: rgba(0, 0, 0, 0.3);
        --color-icon-selected: rgba(0, 0, 0, 0.8);
        --color-status-neutral: #000000;
        --color-spinner-base: rgba(0, 0, 0, 0.1);
        --color-spinner-track: rgba(0, 0, 0, 0.8);
        --color-skeleton-bg: rgba(0, 0, 0, 0.05);
        --color-skeleton-shimmer: rgba(0, 0, 0, 0.08);
        --color-badge-primary-bg: #22c55e;
        --color-badge-primary-text: #ffffff;
        --color-badge-overlay-bg: #000000;
        --color-badge-overlay-text: #ffffff;
        --color-archive-bg: rgba(255, 255, 255, 0.9);
        --color-archive-icon: #000000;
        --color-archive-border: rgba(0, 0, 0, 0.1);
        --color-archive-hover-bg: rgba(255, 255, 255, 1);
        --color-archive-hover-border: rgba(0, 0, 0, 0.2);
        --color-well: rgba(0, 0, 0, 0.08);
        --color-well-border: rgba(0, 0, 0, 0.1);
        --color-cut-fill: rgba(220, 38, 38, 0.20);
        --color-cut-fill-hover: rgba(220, 38, 38, 0.30);
        --color-cut-border: #dc2626;
        --color-cut-stripe: rgba(220, 38, 38, 0.12);
        --color-track: rgba(0, 0, 0, 0.08);
        --color-accent: #3b82f6;
        --color-accent-hover: #2f6fd0;
      --color-accent-hover: color-mix(in oklab, var(--color-accent) 88%, black);
        --color-on-accent: #ffffff;
      }
    }
    :root[data-theme="light"] {
      --color-bg-body: #fafafa;
      --color-bg-panel: #ffffff;
      --color-modal-backdrop: rgba(0, 0, 0, 0.35);
      --color-bg-surface: #ffffff;
      --color-bg-sunken: rgba(0, 0, 0, 0.04);
      --color-text-primary: rgba(0, 0, 0, 0.85);
      --color-text-inverse: #ffffff;
      --color-text-secondary: rgba(0, 0, 0, 0.65);
      --color-text-tertiary: rgba(0, 0, 0, 0.45);
      --color-text-quaternary: rgba(0, 0, 0, 0.25);
      --color-text-error: #ef4444;
      --color-border-default: rgba(0, 0, 0, 0.12);
      --color-border-hover: rgba(0, 0, 0, 0.22);
      --color-bg-selected: rgba(0, 0, 0, 0.1);
      --color-border-selected: rgba(0, 0, 0, 0.3);
      --color-icon-selected: rgba(0, 0, 0, 0.8);
      --color-status-neutral: #000000;
      --color-spinner-base: rgba(0, 0, 0, 0.1);
      --color-spinner-track: rgba(0, 0, 0, 0.8);
      --color-skeleton-bg: rgba(0, 0, 0, 0.05);
      --color-skeleton-shimmer: rgba(0, 0, 0, 0.08);
      --color-badge-primary-bg: #22c55e;
      --color-badge-primary-text: #ffffff;
      --color-badge-overlay-bg: #000000;
      --color-badge-overlay-text: #ffffff;
      --color-archive-bg: rgba(255, 255, 255, 0.9);
      --color-archive-icon: #000000;
      --color-archive-border: rgba(0, 0, 0, 0.1);
      --color-archive-hover-bg: rgba(255, 255, 255, 1);
      --color-archive-hover-border: rgba(0, 0, 0, 0.2);
      --color-well: rgba(0, 0, 0, 0.08);
      --color-well-border: rgba(0, 0, 0, 0.1);
      --color-cut-fill: rgba(220, 38, 38, 0.20);
      --color-cut-fill-hover: rgba(220, 38, 38, 0.30);
      --color-cut-border: #dc2626;
      --color-cut-stripe: rgba(220, 38, 38, 0.12);
      --color-track: rgba(0, 0, 0, 0.08);
      --color-accent: #3b82f6;
      --color-accent-hover: #2f6fd0;
      --color-accent-hover: color-mix(in oklab, var(--color-accent) 88%, black);
      --color-on-accent: #ffffff;
    }`;
  document.head.appendChild(style);
}

export const colors = {
  bg: { body: "var(--color-bg-body)", panel: "var(--color-bg-panel)", backdrop: "var(--color-modal-backdrop)", surface: "var(--color-bg-surface)", sunken: "var(--color-bg-sunken)", selected: "var(--color-bg-selected)" },
  text: { primary: "var(--color-text-primary)", inverse: "var(--color-text-inverse)", secondary: "var(--color-text-secondary)", tertiary: "var(--color-text-tertiary)", quaternary: "var(--color-text-quaternary)", error: "var(--color-text-error)" },
  border: { default: "var(--color-border-default)", hover: "var(--color-border-hover)", selected: "var(--color-border-selected)" },
  icon: { selected: "var(--color-icon-selected)" },
  spinner: { base: "var(--color-spinner-base)", track: "var(--color-spinner-track)" },
  /** The brand accent. Replaceable per-app via `<LookoutProvider
   *  accentColor>` or {@link setAccentColor}. */
  accent: {
    base: "var(--color-accent)",
    hover: "var(--color-accent-hover)",
    /** Text/icon colour that sits ON the accent. */
    on: "var(--color-on-accent)",
  },
  /** Editor surfaces: the recessed well footage sits in, the timeline
   *  track, and the removed-region vocabulary. */
  editor: {
    well: "var(--color-well)",
    wellBorder: "var(--color-well-border)",
    track: "var(--color-track)",
    cutFill: "var(--color-cut-fill)",
    cutFillHover: "var(--color-cut-fill-hover)",
    cutBorder: "var(--color-cut-border)",
    cutStripe: "var(--color-cut-stripe)",
  },
  skeleton: { bg: "var(--color-skeleton-bg)", shimmer: "var(--color-skeleton-shimmer)" },
  badge: { 
    primaryBg: "var(--color-badge-primary-bg)", 
    primaryText: "var(--color-badge-primary-text)",
    overlayBg: "var(--color-badge-overlay-bg)",
    overlayText: "var(--color-badge-overlay-text)",
  },
  status: {
    success: "#22c55e",
    info: "#3b82f6",
    warning: "#f59e0b",
    danger: "#ef4444",
    neutral: "var(--color-status-neutral)",
  },
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radii = { sm: 6, md: 8, lg: 10 } as const;
export const fontSize = { xs: 11, sm: 12, md: 13, lg: 14, xl: 16, xxl: 18, heading: 20, display: 24, timer: 32 } as const;
export const fontWeight = { normal: 400, medium: 500, semibold: 600, bold: 700 } as const;

// Unified status config - replaces duplicates in SessionCard and SessionDetail
export const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: colors.status.neutral },
  active: { label: "Recording", color: colors.status.success },
  paused: { label: "Paused", color: colors.status.warning },
  stopped: { label: "Processing", color: colors.status.info },
  compiling: { label: "Compiling", color: colors.status.info },
  complete: { label: "Complete", color: colors.status.success },
  failed: { label: "Failed", color: colors.status.danger },
};

/**
 * Replace the accent colour for every Lookout surface on the page.
 *
 * Set on the document root rather than a wrapper, because the overlays
 * portal to `document.body` and would otherwise fall outside a scoped
 * subtree. `null` restores the default.
 *
 * `on` is the colour drawn on top of the accent (button labels). It can't
 * be derived reliably in CSS, so pass it when the brand colour is light
 * enough that white text would be unreadable.
 */
export function setAccentColor(
  accent: string | null,
  on?: string | null,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (accent) root.style.setProperty("--color-accent", accent);
  else root.style.removeProperty("--color-accent");
  if (on) root.style.setProperty("--color-on-accent", on);
  else root.style.removeProperty("--color-on-accent");
}
