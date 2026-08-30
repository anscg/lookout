/**
 * Which update command to show a Linux user, given how they installed.
 *
 * Pure so it can be tested: a command that looks right but fails is worse than
 * no command, and the failure only shows up on someone else's distro.
 */

export interface LinuxInstall {
  manager: "apt" | "rpm" | "pacman" | "unknown";
  /** Whether our repository is configured for that manager. */
  enrolled: boolean;
  /** The AUR helper found on PATH, when the manager is pacman. */
  helper: string | null;
}

export interface UpdateInstructions {
  /** Shell command to run, or null when there's nothing that would work. */
  command: string | null;
  /** Shown instead of the terminal block. */
  fallback: string | null;
}

export function instructionsFor(install: LinuxInstall): UpdateInstructions {
  if (install.manager === "apt") {
    if (install.enrolled) {
      return { command: "sudo apt update && sudo apt install lookout", fallback: null };
    }
    // dpkg owns it but nothing enrolled this machine — an older .deb, installed
    // before the package added the repository. `apt install` has no candidate.
    return {
      command: null,
      fallback:
        "This copy was installed before Lookout had an apt repository. Download the latest .deb once, and every update after it arrives through apt.",
    };
  }

  if (install.manager === "rpm") {
    if (install.enrolled) {
      return { command: "sudo dnf upgrade lookout", fallback: null };
    }
    return {
      command: null,
      fallback:
        "This copy was installed before Lookout had a dnf repository. Download the latest .rpm once, and every update after it arrives through dnf.",
    };
  }

  if (install.manager === "pacman") {
    // Plain pacman can't build from the AUR, so someone with neither helper
    // gets the manual route rather than a command that doesn't exist.
    if (install.helper) {
      return { command: `${install.helper} -S lookout-bin`, fallback: null };
    }
    return {
      command: null,
      fallback: "Rebuild lookout-bin from the AUR to update, or download the latest package.",
    };
  }

  return { command: null, fallback: "Download the latest version to update." };
}
