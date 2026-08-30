import { describe, it, expect } from "vitest";
import { instructionsFor, type LinuxInstall } from "./updateCommand.js";

const install = (o: Partial<LinuxInstall>): LinuxInstall => ({
  manager: "unknown",
  enrolled: false,
  helper: null,
  ...o,
});

describe("instructionsFor", () => {
  it("gives apt users the apt command once enrolled", () => {
    expect(instructionsFor(install({ manager: "apt", enrolled: true })).command).toBe(
      "sudo apt update && sudo apt install lookout",
    );
  });

  it("gives dnf users the dnf command once enrolled", () => {
    expect(instructionsFor(install({ manager: "rpm", enrolled: true })).command).toBe(
      "sudo dnf upgrade lookout",
    );
  });

  it("uses whichever AUR helper is present", () => {
    expect(instructionsFor(install({ manager: "pacman", helper: "paru" })).command).toBe(
      "paru -S lookout-bin",
    );
    expect(instructionsFor(install({ manager: "pacman", helper: "yay" })).command).toBe(
      "yay -S lookout-bin",
    );
  });

  // The whole point of detecting the manager: a command that fails is worse
  // than being sent to the downloads page.
  it("offers no command when there is nothing that would work", () => {
    const cases: LinuxInstall[] = [
      // Owned by a package manager, but our repository was never added, so
      // there is no candidate to upgrade to.
      install({ manager: "apt", enrolled: false }),
      install({ manager: "rpm", enrolled: false }),
      // Arch without a helper: plain pacman cannot build from the AUR.
      install({ manager: "pacman", helper: null }),
      // Built from source, extracted by hand, or something we don't know.
      install({ manager: "unknown" }),
    ];
    for (const c of cases) {
      const r = instructionsFor(c);
      expect(r.command, JSON.stringify(c)).toBeNull();
      expect(r.fallback, JSON.stringify(c)).toBeTruthy();
    }
  });

  it("never returns both or neither", () => {
    const managers: LinuxInstall["manager"][] = ["apt", "rpm", "pacman", "unknown"];
    for (const manager of managers) {
      for (const enrolled of [true, false]) {
        for (const helper of [null, "paru"]) {
          const r = instructionsFor(install({ manager, enrolled, helper }));
          expect(Boolean(r.command) !== Boolean(r.fallback), `${manager}/${enrolled}/${helper}`).toBe(true);
        }
      }
    }
  });
});
