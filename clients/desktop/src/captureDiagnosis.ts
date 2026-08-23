/**
 * Turning a capture failure into something a person can act on.
 *
 * Screen capture on Linux fails through system software the app doesn't
 * ship: the XDG desktop portal, a portal backend implementing ScreenCast,
 * PipeWire, and PipeWire's GStreamer element. When one is missing, what
 * reaches the UI is a D-Bus or GStreamer string — `The name
 * org.freedesktop.portal.Desktop was not provided by any .service files` —
 * which names an interface, not a package, and not a fix.
 *
 * `diagnoseCaptureError` matches the failure against the environment probe
 * from Rust (`capture_environment`) and returns plain-language steps plus
 * the install command for *this* desktop on *this* distro. Anything it
 * can't place returns `null`, and the dialog falls back to showing the raw
 * error with a copy button — which is still better than a card that says
 * "Failed to detect displays" when nothing was ever detected.
 */

import { getReport } from "./logger.js";

export interface CaptureEnvironment {
  os: string;
  sessionType: string | null;
  desktop: string | null;
  distroId: string | null;
  distroIdLike: string | null;
  distroName: string | null;
  portalInstalled: boolean | null;
  screencastAvailable: boolean | null;
  portalBackends: string[];
  pipewireRunning: boolean | null;
  pipewireGstElement: boolean | null;
  /** GStreamer element the per-minute clips are encoded with on this
   *  machine (`x264enc`, `vah264enc`, `vp9enc`, `openh264enc`), or null when
   *  none is installed and the session records one JPEG a minute. The
   *  candidates are not equal in quality, and which one a machine gets is a
   *  packaging accident, so this is the first thing to check when a Linux
   *  recording looks softer than the same machine's on another OS. */
  clipEncoder: string | null;
}

export interface CaptureDiagnosis {
  /** Replaces the dialog's title — says what's missing, not what failed. */
  title: string;
  /** One or two sentences of plain language. No interface names. */
  summary: string;
  /** Ordered things to do. Keep each one a single action. */
  steps: string[];
  /** A command the user can copy, when there is exactly one to give. */
  command?: string;
}

// ---------------------------------------------------------------------------
// Package naming
// ---------------------------------------------------------------------------

type PackageFamily = "apt" | "dnf" | "pacman" | "zypper" | "apk" | "nix";

/** Distro id (or ID_LIKE token) to the tool that installs things there. */
const FAMILY_BY_DISTRO: Record<string, PackageFamily> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  pop: "apt",
  elementary: "apt",
  zorin: "apt",
  raspbian: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  nobara: "dnf",
  arch: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
  cachyos: "pacman",
  garuda: "pacman",
  opensuse: "zypper",
  "opensuse-tumbleweed": "zypper",
  "opensuse-leap": "zypper",
  sles: "zypper",
  alpine: "apk",
  nixos: "nix",
};

function packageFamily(env: CaptureEnvironment | null): PackageFamily | null {
  if (!env) return null;
  const candidates = [env.distroId ?? "", ...(env.distroIdLike ?? "").split(/\s+/)];
  for (const candidate of candidates) {
    const family = FAMILY_BY_DISTRO[candidate.toLowerCase()];
    if (family) return family;
  }
  return null;
}

function installCommand(env: CaptureEnvironment | null, packages: Partial<Record<PackageFamily, string>>): string | undefined {
  const family = packageFamily(env);
  if (!family) return undefined;
  const name = packages[family];
  if (!name) return undefined;
  switch (family) {
    case "apt": return `sudo apt install ${name}`;
    case "dnf": return `sudo dnf install ${name}`;
    case "pacman": return `sudo pacman -S ${name}`;
    case "zypper": return `sudo zypper install ${name}`;
    case "apk": return `sudo apk add ${name}`;
    // NixOS installs nothing imperatively — the package name alone would be
    // misleading advice, so the steps carry the config snippet instead.
    case "nix": return undefined;
  }
}

/**
 * Which portal backend implements ScreenCast for the session the user is
 * actually in. Getting this wrong is worse than not guessing: installing
 * `-gnome` on Plasma pulls in half of GNOME and still doesn't work.
 */
function backendFor(env: CaptureEnvironment | null): { pkg: string; label: string } | null {
  const desktop = (env?.desktop ?? "").toLowerCase();
  if (!desktop) return null;
  if (/gnome|cinnamon|budgie|unity|pantheon/.test(desktop)) {
    return { pkg: "xdg-desktop-portal-gnome", label: "GNOME" };
  }
  if (/kde|plasma/.test(desktop)) {
    return { pkg: "xdg-desktop-portal-kde", label: "KDE Plasma" };
  }
  if (/hyprland/.test(desktop)) {
    return { pkg: "xdg-desktop-portal-hyprland", label: "Hyprland" };
  }
  if (/sway|wlroots|river|wayfire|labwc/.test(desktop)) {
    return { pkg: "xdg-desktop-portal-wlr", label: "wlroots compositors" };
  }
  if (/cosmic/.test(desktop)) {
    return { pkg: "xdg-desktop-portal-cosmic", label: "COSMIC" };
  }
  return null;
}

/** The "pick the one for your desktop" line, for when we can't tell. */
const BACKEND_MENU =
  "Install the portal backend for your desktop: xdg-desktop-portal-gnome (GNOME, Cinnamon, Budgie), " +
  "xdg-desktop-portal-kde (KDE Plasma), xdg-desktop-portal-hyprland (Hyprland), or " +
  "xdg-desktop-portal-wlr (sway and other wlroots compositors).";

function backendSteps(env: CaptureEnvironment | null): { steps: string[]; command?: string } {
  const backend = backendFor(env);
  const isNix = packageFamily(env) === "nix";

  if (isNix) {
    const pkg = backend?.pkg ?? "xdg-desktop-portal-gnome";
    return {
      steps: [
        "Add the portal to your NixOS configuration:",
        `xdg.portal = { enable = true; extraPortals = [ pkgs.${pkg} ]; };`,
        "Rebuild with `sudo nixos-rebuild switch`, then log out and back in.",
        "Try casting again.",
      ],
    };
  }

  if (!backend) {
    return { steps: [BACKEND_MENU, "Log out and back in so the new backend registers.", "Try casting again."] };
  }

  const command = installCommand(env, {
    apt: backend.pkg,
    dnf: backend.pkg,
    pacman: backend.pkg,
    zypper: backend.pkg,
    apk: backend.pkg,
  });

  return {
    steps: [
      command
        ? `Install ${backend.pkg} — the portal backend for ${backend.label}.`
        : `Install ${backend.pkg} (the portal backend for ${backend.label}) with your package manager.`,
      "Log out and back in so the new backend registers with D-Bus.",
      "Try casting again.",
    ],
    command,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Dismissing the portal's own source picker comes back as an error. It isn't
 * one — the user said no — so nothing should pop up.
 */
export function isCancelledCaptureError(raw: string): boolean {
  return /cancell?ed|response error: cancelled|user dismissed/i.test(raw);
}

const PORTAL_MISSING = /not provided by any \.service files|ServiceUnknown|NameHasNoOwner|Failed to connect to screencast portal|org\.freedesktop\.portal\.Desktop/i;
const BACKEND_MISSING = /No such interface|UnknownMethod|UnknownObject|NoReply|Failed to (select sources|start screencast|create screencast session)/i;
const GST_MISSING = /no element ["']?pipewiresrc|Failed to create pipeline|Failed to init gstreamer|Failed to load plugin/i;
const NO_FRAMES = /Failed to pull sample within timeout|Sample has no buffer/i;
const X11_ENUMERATION = /Failed to list (monitors|windows)|XOpenDisplay|Can't open display/i;

export function diagnoseCaptureError(raw: string, env: CaptureEnvironment | null): CaptureDiagnosis | null {
  const linux = (env?.os ?? "").toLowerCase() === "linux" || /linux/i.test(navigator.userAgent);
  if (!linux) return diagnoseNonLinux(raw);

  // The probe is more trustworthy than string matching, so it goes first:
  // it reports what's actually installed rather than how the failure was
  // worded. String matches below cover the case where the probe itself
  // couldn't run.
  if (env?.portalInstalled === false || (env?.portalInstalled !== true && PORTAL_MISSING.test(raw) && !BACKEND_MISSING.test(raw))) {
    const backend = backendFor(env);
    // The portal and its backend are two packages, and installing one
    // without the other leaves capture just as broken — so they go in one
    // command whenever we know which backend belongs here.
    const pkgs = backend ? `xdg-desktop-portal ${backend.pkg}` : "xdg-desktop-portal";
    const command = installCommand(env, { apt: pkgs, dnf: pkgs, pacman: pkgs, zypper: pkgs, apk: pkgs });
    return {
      title: "Screen capture needs the desktop portal",
      summary:
        "Wayland only lets an app record what you explicitly hand it, through a system component called the XDG desktop portal. " +
        "It isn't installed here, so there's nothing to ask permission with.",
      steps: command
        ? [
            backend
              ? `Install xdg-desktop-portal and ${backend.pkg} (the backend for ${backend.label}).`
              : "Install xdg-desktop-portal.",
            ...(backend ? [] : [BACKEND_MENU]),
            "Log out and back in so the portal registers with D-Bus.",
            "Try casting again.",
          ]
        : ["Install xdg-desktop-portal with your package manager.", ...backendSteps(env).steps],
      command,
    };
  }

  if (env?.screencastAvailable === false || BACKEND_MISSING.test(raw)) {
    const backend = backendSteps(env);
    const known = backendFor(env);
    return {
      title: known ? `No screen-sharing backend for ${known.label}` : "No screen-sharing backend installed",
      summary:
        "The desktop portal is running, but nothing on this system implements screen sharing for it. " +
        "The portal itself is just a front door — the backend that matches your desktop does the actual capturing." +
        (env && env.portalBackends.length > 0
          ? ` Installed backends: ${env.portalBackends.join(", ")}.`
          : ""),
      steps: backend.steps,
      command: backend.command,
    };
  }

  // Ahead of the GStreamer plugin check: when PipeWire isn't installed at
  // all both probes come back false, and the daemon is the thing to fix
  // first — its plugin is no use without it.
  if (env?.pipewireRunning === false) {
    return {
      title: "PipeWire isn't running",
      summary:
        "Screen capture on Wayland streams through PipeWire, and its socket isn't there — the service is stopped or not installed.",
      steps: [
        "Check the service: `systemctl --user status pipewire`",
        "Start it: `systemctl --user enable --now pipewire pipewire-pulse`",
        "If the command isn't found, install the `pipewire` package first.",
      ],
      command: "systemctl --user enable --now pipewire pipewire-pulse",
    };
  }

  if (env?.pipewireGstElement === false || GST_MISSING.test(raw)) {
    const command = installCommand(env, {
      apt: "gstreamer1.0-pipewire",
      dnf: "pipewire-gstreamer",
      pacman: "gst-plugin-pipewire",
      zypper: "gstreamer-plugin-pipewire",
      apk: "gst-plugin-pipewire",
    });
    return {
      title: "PipeWire's GStreamer plugin is missing",
      summary:
        "You granted the capture, but the app can't read the video stream: the piece that bridges PipeWire to GStreamer " +
        "ships as its own package and isn't installed.",
      steps: [
        command
          ? "Install the PipeWire GStreamer plugin."
          : "Install the PipeWire GStreamer plugin (gstreamer1.0-pipewire, pipewire-gstreamer, or gst-plugin-pipewire, depending on your distro).",
        "Restart Lookout.",
        "Try casting again.",
      ],
      command,
    };
  }

  if (NO_FRAMES.test(raw)) {
    return {
      title: "The capture started but no frames arrived",
      summary:
        "The stream was set up and then stayed empty. This usually means the selected window was closed or minimised, " +
        "or the compositor dropped the share.",
      steps: [
        "Make sure the window or screen you picked is still open and not minimised.",
        "Pick the source again from the Cast tab to start a fresh share.",
        "If it keeps happening, capture a whole screen instead of a single window.",
      ],
    };
  }

  if (X11_ENUMERATION.test(raw) && (env?.sessionType ?? "").toLowerCase() === "wayland") {
    return {
      title: "Screens can't be listed on Wayland",
      summary:
        "Wayland deliberately hides the list of windows and monitors from apps. Use the Cast tab, which asks your desktop " +
        "for permission and lets you choose the source there.",
      steps: ["Switch to the Cast tab.", "Choose the screen or window you want to record."],
    };
  }

  return null;
}

/** The couple of non-Linux failures worth explaining rather than dumping. */
function diagnoseNonLinux(raw: string): CaptureDiagnosis | null {
  if (/not authorized|screen recording|TCC|permission/i.test(raw) && /darwin|mac/i.test(navigator.userAgent)) {
    return {
      title: "Screen Recording permission is off",
      summary: "macOS blocks screen capture until Lookout is allowed in System Settings.",
      steps: [
        "Open System Settings → Privacy & Security → Screen & System Audio Recording.",
        "Turn on Lookout.",
        "Quit and reopen Lookout — macOS only applies the change on relaunch.",
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copyable report
// ---------------------------------------------------------------------------

/**
 * What the Copy button puts on the clipboard: the error, what we concluded,
 * the machine's answers, then the log. Ordered so someone reading a pasted
 * report in a chat sees the useful part before scrolling.
 */
export function buildCaptureReport(
  raw: string,
  env: CaptureEnvironment | null,
  diagnosis: CaptureDiagnosis | null,
): string {
  const lines: string[] = [];
  if (diagnosis) {
    lines.push(`Diagnosis: ${diagnosis.title}`);
    if (diagnosis.command) lines.push(`Suggested fix: ${diagnosis.command}`);
    lines.push("");
  }
  if (env) {
    lines.push("--- CAPTURE ENVIRONMENT ---");
    lines.push(`os: ${env.os}`);
    lines.push(`session: ${env.sessionType ?? "unknown"}`);
    lines.push(`desktop: ${env.desktop ?? "unknown"}`);
    lines.push(`distro: ${env.distroName ?? env.distroId ?? "unknown"}`);
    lines.push(`portal installed: ${fmt(env.portalInstalled)}`);
    lines.push(`screencast available: ${fmt(env.screencastAvailable)}`);
    lines.push(`portal backends: ${env.portalBackends.length > 0 ? env.portalBackends.join(", ") : "none found"}`);
    lines.push(`pipewire running: ${fmt(env.pipewireRunning)}`);
    lines.push(`pipewiresrc element: ${fmt(env.pipewireGstElement)}`);
    lines.push(`clip encoder: ${env.clipEncoder ?? "none (recording one JPEG per minute)"}`);
    lines.push("");
  }
  lines.push(getReport(raw));
  return lines.join("\n");
}

function fmt(value: boolean | null): string {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}
