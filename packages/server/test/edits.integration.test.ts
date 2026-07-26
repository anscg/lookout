/**
 * Integration tests for the edit (cuts) endpoints against a real Postgres:
 * GET /units, PUT /cuts, POST /compile, the timings filtering, and the
 * post-cut trackedSeconds reporting.
 *
 * Requires the test docker postgres running on port 5434 (see
 * test/setup.ts for the connection string).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { db, schema } from "../src/db/index.js";

let app: FastifyInstance;

const T0 = new Date("2026-07-01T10:00:00.000Z");
const minute = (i: number) => new Date(T0.getTime() + i * 60_000);
const iso = (i: number) => minute(i).toISOString();

beforeEach(async () => {
  await db.execute(sql`TRUNCATE screenshots, sessions RESTART IDENTITY CASCADE`);
  if (!app) {
    app = await buildApp();
  }
});

afterAll(async () => {
  if (app) await app.close();
  await (db.$client as any).end?.();
});

/**
 * Seed a completed, editable session: 10 capture units a minute apart,
 * credit-mode with 540 raw tracked seconds (seed capture credits 0), a
 * compiled original video, and the unit map the compile would have written.
 */
async function seedCompleteSession(overrides: Partial<typeof schema.sessions.$inferInsert> = {}) {
  const [s] = await db
    .insert(schema.sessions)
    .values({
      name: "edit-test",
      status: "complete",
      trackingMode: "credit",
      trackedSeconds: 540,
      startedAt: minute(0),
      stoppedAt: minute(10),
      videoR2Key: "timelapses/x/original.mp4",
      originalVideoR2Key: "timelapses/x/original.mp4",
      videoCopyAligned: true,
      videoUnits: Array.from({ length: 10 }, (_, i) => ({
        capturedAt: iso(i),
        screenshotId: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
      })),
      ...overrides,
    })
    .returning({ id: schema.sessions.id, token: schema.sessions.token });

  await db.insert(schema.screenshots).values(
    Array.from({ length: 10 }, (_, i) => ({
      sessionId: s.id,
      r2Key: `screenshots/${s.id}/${i}.jpg`,
      requestedAt: minute(i),
      capturedAt: minute(i),
      minuteBucket: i,
      confirmed: true,
      sampled: true,
      creditedSeconds: i === 0 ? 0 : 60,
    })),
  );

  return s;
}

async function putCuts(token: string, cuts: unknown) {
  const r = await app.inject({
    method: "PUT",
    url: `/api/sessions/${token}/cuts`,
    payload: { cuts },
  });
  return { status: r.statusCode, body: r.json() };
}

describe("GET /api/sessions/:token/units", () => {
  it("returns the unit map and a presigned original URL when editable", async () => {
    const s = await seedCompleteSession();
    const r = await app.inject({ method: "GET", url: `/api/sessions/${s.token}/units` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.editable).toBe(true);
    expect(body.units).toHaveLength(10);
    expect(body.units[3].capturedAt).toBe(iso(3));
    expect(body.originalVideoUrl).toContain("https://");
    expect(body.cuts).toEqual([]);
  });

  it("reports pre-edit-feature sessions as not editable", async () => {
    const s = await seedCompleteSession({ videoUnits: null, originalVideoR2Key: null });
    const r = await app.inject({ method: "GET", url: `/api/sessions/${s.token}/units` });
    expect(r.statusCode).toBe(200);
    expect(r.json().editable).toBe(false);
    expect(r.json().editableReason).toBe("no_original");
    expect(r.json().originalVideoUrl).toBeNull();
  });

  it("reports in-flight sessions as not editable", async () => {
    const s = await seedCompleteSession({ status: "active" });
    const r = await app.inject({ method: "GET", url: `/api/sessions/${s.token}/units` });
    expect(r.json().editable).toBe(false);
    expect(r.json().editableReason).toBe("not_complete");
  });
});

describe("PUT /api/sessions/:token/cuts", () => {
  it("persists a normalized cut list and reports the tracked-time preview", async () => {
    const s = await seedCompleteSession();
    // Two overlapping intervals covering minutes 3..5 → merged, 2 units cut
    // (units 3 and 4), each credited 60s.
    const { status, body } = await putCuts(s.token, [
      { start: iso(3), end: iso(4) },
      { start: iso(4), end: iso(5) },
    ]);
    expect(status).toBe(200);
    expect(body.cuts).toEqual([{ start: iso(3), end: iso(5) }]);
    expect(body.unitsTotal).toBe(10);
    expect(body.unitsCut).toBe(2);
    expect(body.uncutTrackedSeconds).toBe(540);
    expect(body.trackedSeconds).toBe(420);

    const row = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, s.id),
    });
    expect(row!.cuts).toEqual([{ start: iso(3), end: iso(5) }]);
    expect(row!.cutSeconds).toBe(120);
  });

  it("reflects cuts in GET /:token, /status, and /timings", async () => {
    const s = await seedCompleteSession();
    await putCuts(s.token, [{ start: iso(3), end: iso(5) }]);

    const session = (await app.inject({ method: "GET", url: `/api/sessions/${s.token}` })).json();
    expect(session.trackedSeconds).toBe(420);
    expect(session.uncutTrackedSeconds).toBe(540);
    expect(session.cutSeconds).toBe(120);
    expect(session.cuts).toEqual([{ start: iso(3), end: iso(5) }]);

    const status = (await app.inject({ method: "GET", url: `/api/sessions/${s.token}/status` })).json();
    expect(status.trackedSeconds).toBe(420);

    const timings = (await app.inject({ method: "GET", url: `/api/sessions/${s.token}/timings` })).json();
    expect(timings.count).toBe(8);
    expect(timings.timestamps).not.toContain(iso(3));
    expect(timings.timestamps).not.toContain(iso(4));
    expect(timings.timestamps).toContain(iso(5));
    expect(timings.cutCount).toBe(2);
    expect(timings.cuts).toEqual([{ start: iso(3), end: iso(5) }]);
    expect(timings.cutTimestamps).toBeUndefined();

    const withCut = (
      await app.inject({ method: "GET", url: `/api/sessions/${s.token}/timings?includeCut=true` })
    ).json();
    expect(withCut.cutTimestamps).toEqual([iso(3), iso(4)]);

    const batch = (
      await app.inject({
        method: "POST",
        url: "/api/sessions/batch",
        payload: { tokens: [s.token] },
      })
    ).json();
    expect(batch.sessions[0].trackedSeconds).toBe(420);
  });

  it("clears edits with an empty list", async () => {
    const s = await seedCompleteSession();
    await putCuts(s.token, [{ start: iso(3), end: iso(5) }]);
    const { status, body } = await putCuts(s.token, []);
    expect(status).toBe(200);
    expect(body.trackedSeconds).toBe(540);
    const row = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, s.id) });
    expect(row!.cuts).toEqual([]);
    expect(row!.cutSeconds).toBe(0);
  });

  it("rejects a list that removes the entire timelapse", async () => {
    const s = await seedCompleteSession();
    const { status, body } = await putCuts(s.token, [{ start: iso(0), end: iso(60) }]);
    expect(status).toBe(400);
    expect(body.error).toMatch(/entire timelapse/);
  });

  it("rejects malformed intervals", async () => {
    const s = await seedCompleteSession();
    expect((await putCuts(s.token, [{ start: iso(5), end: iso(3) }])).status).toBe(400);
    expect((await putCuts(s.token, [{ start: "garbage", end: iso(3) }])).status).toBe(400);
  });

  it("409s while compiling and on non-editable sessions", async () => {
    const compiling = await seedCompleteSession({ status: "compiling" });
    expect((await putCuts(compiling.token, [])).status).toBe(409);

    const legacy = await seedCompleteSession({ videoUnits: null, originalVideoR2Key: null });
    expect((await putCuts(legacy.token, [])).status).toBe(409);
  });
});

describe("POST /api/sessions/:token/compile", () => {
  it("is an instant no-op when there are no cuts and the original is published", async () => {
    const s = await seedCompleteSession();
    const r = await app.inject({ method: "POST", url: `/api/sessions/${s.token}/compile` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "complete", instant: true });
    const row = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, s.id) });
    expect(row!.status).toBe("complete");
    expect(row!.recompileCount).toBe(0);
  });

  it("claims complete → compiling and burns one recompile when cuts exist", async () => {
    const s = await seedCompleteSession();
    await putCuts(s.token, [{ start: iso(3), end: iso(5) }]);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${s.token}/compile` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "compiling", instant: false });
    const row = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, s.id) });
    expect(row!.status).toBe("compiling");
    expect(row!.recompileCount).toBe(1);
  });

  it("enqueues an un-cut recompile when cuts were cleared but an edited video is published", async () => {
    const s = await seedCompleteSession({
      videoR2Key: "timelapses/x/edited.mp4",
      cuts: [],
      cutSeconds: 0,
    });
    const r = await app.inject({ method: "POST", url: `/api/sessions/${s.token}/compile` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "compiling", instant: false });
  });

  it("202s while already compiling (idempotent client retries)", async () => {
    const s = await seedCompleteSession({ status: "compiling" });
    const r = await app.inject({ method: "POST", url: `/api/sessions/${s.token}/compile` });
    expect(r.statusCode).toBe(202);
  });

  it("409s once the recompile budget is exhausted", async () => {
    const s = await seedCompleteSession({ recompileCount: 5 });
    const r = await app.inject({ method: "POST", url: `/api/sessions/${s.token}/compile` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/recompiles_exhausted/);
  });
});
