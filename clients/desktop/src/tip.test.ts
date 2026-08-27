// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  deepLinkSessionFor,
  explainTip,
  markTipMoment,
  recordDeepLinkSession,
  shouldShowTip,
  type Tip,
} from "./tip.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

const baseTip: Tip = {
  id: "tip-1",
  badge: "NEW!",
  title: "Start a Lapse session straight from Lookout!",
  body: "Link Lapse once from the + menu.",
  imageUrl: null,
  program: "lapse",
  trigger: "deep_link",
  requireUnlinked: false,
};

/** Plant a program link the way completePairing would. */
function planLink(program: string) {
  localStorage.setItem(
    "lookout-program-links",
    JSON.stringify({
      [program]: {
        program,
        origin: "https://lapse.example.com",
        pairUrl: "https://lapse.example.com/pair",
        startUrl: "https://lapse.example.com/start",
        pairedAt: new Date(0).toISOString(),
        deviceLabel: "Lookout Desktop (Linux)",
      },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("recordDeepLinkSession", () => {
  it("remembers the token per program", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    expect(deepLinkSessionFor("lapse")).toBe(TOKEN_A);
    expect(deepLinkSessionFor("other")).toBeNull();
  });

  it("keeps only the newest session for a program", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    recordDeepLinkSession("lapse", TOKEN_B);
    expect(deepLinkSessionFor("lapse")).toBe(TOKEN_B);
  });

  it("ignores sessions with no program", () => {
    recordDeepLinkSession(null, TOKEN_A);
    expect(localStorage.getItem("lookout-deeplink-sessions")).toBeNull();
  });
});

describe("shouldShowTip", () => {
  it("shows on a session the deep link brought us to", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    expect(shouldShowTip(baseTip, "source", TOKEN_A)).toBe(true);
  });

  it("stays shut for a session opened any other way", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    expect(shouldShowTip(baseTip, "source", TOKEN_B)).toBe(false);
  });

  it("stays shut when no deep link has ever landed", () => {
    expect(shouldShowTip(baseTip, "source", TOKEN_A)).toBe(false);
  });

  it("ignores the deep-link gate when the trigger is `any`", () => {
    expect(shouldShowTip({ ...baseTip, trigger: "any" }, "source", TOKEN_A)).toBe(true);
  });

  it("shows to everyone when the tip targets no program", () => {
    const untargeted: Tip = { ...baseTip, program: null, trigger: "any" };
    expect(shouldShowTip(untargeted, "source", TOKEN_A)).toBe(true);
  });

  it("skips users who already linked the program", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    planLink("lapse");
    const tip = { ...baseTip, requireUnlinked: true };
    expect(shouldShowTip(tip, "source", TOKEN_A)).toBe(false);
    // A link to another program is none of this tip's business.
    localStorage.removeItem("lookout-program-links");
    planLink("something-else");
    expect(shouldShowTip(tip, "source", TOKEN_A)).toBe(true);
  });

  it("is false for no tip and for no token", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    expect(shouldShowTip(null, "source", TOKEN_A)).toBe(false);
    expect(shouldShowTip(baseTip, "source", null)).toBe(false);
  });
});

describe("markTipMoment", () => {
  it("fires each moment once, for a total of two on one session", () => {
    recordDeepLinkSession("lapse", TOKEN_A);

    expect(shouldShowTip(baseTip, "source", TOKEN_A)).toBe(true);
    markTipMoment(baseTip, "source", TOKEN_A);
    expect(shouldShowTip(baseTip, "source", TOKEN_A)).toBe(false);

    expect(shouldShowTip(baseTip, "panel-done", TOKEN_A)).toBe(true);
    markTipMoment(baseTip, "panel-done", TOKEN_A);
    expect(shouldShowTip(baseTip, "panel-done", TOKEN_A)).toBe(false);
  });

  it("does not start over on the next deep-linked session", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    markTipMoment(baseTip, "source", TOKEN_A);

    recordDeepLinkSession("lapse", TOKEN_B);
    expect(shouldShowTip(baseTip, "source", TOKEN_B)).toBe(false);
    expect(shouldShowTip(baseTip, "panel-done", TOKEN_B)).toBe(false);
  });

  it("gives a newly published tip its own two moments", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    markTipMoment(baseTip, "source", TOKEN_A);
    markTipMoment(baseTip, "panel-done", TOKEN_A);

    const next: Tip = { ...baseTip, id: "tip-2" };
    expect(shouldShowTip(next, "source", TOKEN_A)).toBe(true);
  });

  it("survives a corrupt store by re-showing rather than throwing", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    localStorage.setItem("lookout-tip-moments", "{not json");
    expect(() => shouldShowTip(baseTip, "source", TOKEN_A)).not.toThrow();
    expect(shouldShowTip(baseTip, "source", TOKEN_A)).toBe(true);
  });
});

describe("explainTip", () => {
  // The debug surface's value is naming WHICH gate stopped it, so the failing
  // gate must be the only false one.
  it("blames the already-linked gate and nothing else", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    planLink("lapse");
    const g = explainTip({ ...baseTip, requireUnlinked: true }, "source", TOKEN_A);
    expect(g.show).toBe(false);
    expect(g.unlinked).toBe(false);
    expect(g.deepLinkMatches).toBe(true);
    expect(g.momentUnused).toBe(true);
    expect(g.boundToThisSession).toBe(true);
  });

  it("blames the spent moment, leaving the other one still owed", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    markTipMoment(baseTip, "source", TOKEN_A);
    expect(explainTip(baseTip, "source", TOKEN_A)).toMatchObject({
      show: false,
      momentUnused: false,
    });
    expect(explainTip(baseTip, "panel-done", TOKEN_A).show).toBe(true);
  });

  it("blames the session binding when a later deep link asks", () => {
    recordDeepLinkSession("lapse", TOKEN_A);
    markTipMoment(baseTip, "source", TOKEN_A);
    recordDeepLinkSession("lapse", TOKEN_B);
    const g = explainTip(baseTip, "panel-done", TOKEN_B);
    expect(g.show).toBe(false);
    expect(g.boundToThisSession).toBe(false);
    expect(g.momentUnused).toBe(true);
  });

  it("marks inapplicable gates null rather than passing them", () => {
    const g = explainTip(
      { ...baseTip, trigger: "any", requireUnlinked: false },
      "source",
      TOKEN_A,
    );
    expect(g.deepLinkMatches).toBeNull();
    expect(g.unlinked).toBeNull();
    expect(g.show).toBe(true);
  });
});
