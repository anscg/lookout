/**
 * DB-backed tests for the worker's unit-sampling query (compile.ts step 1).
 *
 * The SQL here is a hand-kept MIRROR of the worker's sampler — the worker
 * has no database test harness, and this query's failure modes only exist
 * at the SQL level (DISTINCT ON collisions), exactly like the credited_
 * seconds CHECK constraint that unit tests couldn't see. If you change the
 * sampler in packages/worker/src/compile.ts, change it here too.
 *
 * What it pins:
 *  - Buckets come from CAPTURE time, so upload latency can never slide a
 *    clip into the next minute's bucket and silently drop a minute of
 *    video (the "stitching is unstable" report).
 *  - Motion beats stills within a bucket (a pause-flush JPEG must not
 *    freeze its minute of timelapse).
 *  - Legacy rows without captured_at keep the old arrival-based behavior.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";

const T0 = new Date("2025-06-01T12:00:00.000Z");
const at = (deltaS: number) => new Date(T0.getTime() + deltaS * 1000);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE screenshots, sessions RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await (db.$client as any).end?.();
});

async function createSession(): Promise<string> {
  const [s] = await db
    .insert(schema.sessions)
    .values({ name: "sampling-test", startedAt: T0 })
    .returning({ id: schema.sessions.id });
  return s.id;
}

async function insertUnit(
  sessionId: string,
  opts: {
    capturedAtS: number | null;
    requestedAtS: number;
    format?: string;
    label: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(schema.screenshots)
    .values({
      sessionId,
      r2Key: `test/${opts.label}`,
      requestedAt: at(opts.requestedAtS),
      // Stored column stays ARRIVAL-based, exactly as upload-url computes
      // it — legacy bucket-mode crediting counts it, sampling must not.
      minuteBucket: Math.floor(opts.requestedAtS / 60),
      confirmed: true,
      format: opts.format ?? "mp4",
      capturedAt: opts.capturedAtS === null ? null : at(opts.capturedAtS),
    })
    .returning({ id: schema.screenshots.id });
  return row.id;
}

/** Mirror of the worker's sampler (packages/worker/src/compile.ts step 1). */
async function sampleUnits(sessionId: string) {
  const res = await db.execute<{
    id: string;
    r2_key: string;
    minute_bucket: number | string;
    format: string;
  }>(sql`
    SELECT DISTINCT ON (sample_bucket)
      id, r2_key, sample_bucket AS minute_bucket, requested_at, captured_at, format
    FROM (
      SELECT id, r2_key, requested_at, captured_at, format,
        FLOOR(EXTRACT(EPOCH FROM (
          COALESCE(captured_at, requested_at) - ${T0}::timestamptz
        )) / 60)::int AS sample_bucket
      FROM screenshots
      WHERE session_id = ${sessionId} AND confirmed = true
    ) units
    ORDER BY sample_bucket,
      (format = 'jpeg')::int,
      ABS(EXTRACT(EPOCH FROM (COALESCE(captured_at, requested_at) - (
        ${T0}::timestamptz
        + (sample_bucket * interval '1 minute')
        + interval '30 seconds'
      ))))
  `);
  return (res as unknown as { rows: Array<{ id: string; r2_key: string; minute_bucket: number | string; format: string }> }).rows;
}

describe("unit sampling (worker compile step 1 mirror)", () => {
  it("a slow upload cannot collide with the next minute's clip", async () => {
    // The instability report: clip for minute 1 captured at t=60 but ARRIVES
    // at t=122 (62s of upload latency) — its arrival bucket is 2, same as
    // the next clip's. Arrival-based sampling dropped one of them; capture-
    // based sampling keeps both, one per captured minute.
    const sess = await createSession();
    const seed = await insertUnit(sess, { capturedAtS: 0, requestedAtS: 1, format: "jpeg", label: "seed" });
    const slow = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 122, label: "slow-clip" });
    const onTime = await insertUnit(sess, { capturedAtS: 120, requestedAtS: 123, label: "on-time-clip" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([seed, slow, onTime]);
    expect(rows.map((r) => Number(r.minute_bucket))).toEqual([0, 1, 2]);
  });

  it("a pause-flush JPEG never displaces its minute's motion clip", async () => {
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 120, requestedAtS: 123, label: "clip" });
    // Pause at 2:30: flush JPEG shares capture-bucket 2 with the clip, and
    // sits closer to the bucket midpoint — the distance tiebreak alone
    // would pick it and freeze the minute to a still.
    await insertUnit(sess, { capturedAtS: 150, requestedAtS: 151, format: "jpeg", label: "flush" });

    const rows = await sampleUnits(sess);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(clip);
  });

  it("a flush alone in its minute still becomes a unit", async () => {
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 62, label: "clip" });
    const flush = await insertUnit(sess, { capturedAtS: 130, requestedAtS: 131, format: "jpeg", label: "flush" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([clip, flush]);
  });

  it("legacy rows without captured_at keep arrival-based buckets", async () => {
    const sess = await createSession();
    const a = await insertUnit(sess, { capturedAtS: null, requestedAtS: 10, format: "jpeg", label: "old-a" });
    const b = await insertUnit(sess, { capturedAtS: null, requestedAtS: 70, format: "jpeg", label: "old-b" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  it("rows come out ordered by bucket ascending (the dropSeedUnit contract)", async () => {
    const sess = await createSession();
    // Insert out of order.
    const late = await insertUnit(sess, { capturedAtS: 180, requestedAtS: 183, label: "late" });
    const early = await insertUnit(sess, { capturedAtS: 0, requestedAtS: 1, format: "jpeg", label: "seed" });
    const mid = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 63, label: "mid" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([early, mid, late]);
  });
});
