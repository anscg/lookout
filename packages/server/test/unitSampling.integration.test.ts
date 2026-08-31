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
 *  - Motion beats stills within a bucket (a resume seed must not freeze its
 *    minute of timelapse).
 *  - Neither the pause/stop flush nor a seed is a unit at all. A capture
 *    earns a video second exactly when it earned a full minute of tracked
 *    time, which is what the editor's video-time map assumes.
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
    isFinal?: boolean;
    /** Credit-mode columns. Omitted = a bucket-mode row (both NULL). */
    creditedSeconds?: number;
    expectedAtS?: number | null;
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
      isFinal: opts.isFinal ?? false,
      creditedSeconds: opts.creditedSeconds ?? null,
      expectedAt:
        opts.expectedAtS === undefined || opts.expectedAtS === null
          ? null
          : at(opts.expectedAtS),
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
      SELECT *, bool_or(NOT skipped) OVER () AS has_ordinary_unit
      FROM (
        SELECT id, r2_key, requested_at, captured_at, format,
          (is_final OR (credited_seconds = 0 AND expected_at IS NULL))
            IS TRUE AS skipped,
          FLOOR(EXTRACT(EPOCH FROM (
            COALESCE(captured_at, requested_at) - ${T0}::timestamptz
          )) / 60)::int AS sample_bucket
        FROM screenshots
        WHERE session_id = ${sessionId} AND confirmed = true
      ) base
    ) units
    WHERE NOT skipped OR NOT has_ordinary_unit
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

  it("a resume seed never displaces its minute's motion clip", async () => {
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 120, requestedAtS: 123, label: "clip" });
    // Resume at 2:30: the seed JPEG shares capture-bucket 2 with the clip
    // and sits closer to the bucket midpoint — the distance tiebreak alone
    // would pick it and freeze the minute to a still.
    await insertUnit(sess, { capturedAtS: 150, requestedAtS: 151, format: "jpeg", label: "seed" });

    const rows = await sampleUnits(sess);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(clip);
  });

  it("a pause flush alone in the last minute is not a unit", async () => {
    // The reported bug: pause at 2:10 gives the flush bucket 2 to itself,
    // so the format tiebreak above never sees it and it became a frozen
    // last second duplicating the end of the previous clip.
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 62, label: "clip" });
    await insertUnit(sess, {
      capturedAtS: 130, requestedAtS: 131, format: "jpeg", isFinal: true, label: "flush",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([clip]);
  });

  it("a CLIP flush never displaces its minute's real clip", async () => {
    // The web client's flush cuts the in-progress clip instead of grabbing
    // a JPEG, so the format tiebreak is blind to it — both rows are clips
    // and the flush sits nearer the midpoint, which is enough to win.
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 120, requestedAtS: 123, label: "clip" });
    await insertUnit(sess, {
      capturedAtS: 150, requestedAtS: 151, isFinal: true, label: "clip-flush",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([clip]);
  });

  it("a jpeg-fallback session keeps every per-minute still", async () => {
    // A client that can't encode video uploads one JPEG per minute; those
    // are whole minutes. The flag is the only thing separating them here.
    const sess = await createSession();
    const stills: string[] = [];
    for (let m = 0; m < 4; m++) {
      stills.push(
        await insertUnit(sess, {
          capturedAtS: m * 60, requestedAtS: m * 60 + 1, format: "jpeg", label: `still-${m}`,
        }),
      );
    }
    await insertUnit(sess, {
      capturedAtS: 245, requestedAtS: 246, format: "jpeg", isFinal: true, label: "flush",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual(stills);
  });

  it("an unflagged flush from an old client still becomes a unit", async () => {
    // Nothing in a pre-0031 row identifies the flush and there is no
    // backfill, so old sessions recompile exactly as they did before.
    const sess = await createSession();
    const clip = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 62, label: "clip" });
    const flush = await insertUnit(sess, { capturedAtS: 130, requestedAtS: 131, format: "jpeg", label: "flush" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([clip, flush]);
  });

  it("a session of nothing but flushes keeps them", async () => {
    // Start, pause immediately, seed confirm never landed. Same escape as
    // dropSeedUnit's single-unit case — a rough video beats a failed one.
    const sess = await createSession();
    const only = await insertUnit(sess, {
      capturedAtS: 12, requestedAtS: 13, format: "jpeg", isFinal: true, label: "flush",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([only]);
  });

  it("a resume seed is not a unit either", async () => {
    // Every resume plants a fresh seed: credit 0, no expected mark, and a
    // plain JPEG on both clients. dropSeedUnit only ever caught the FIRST
    // one, so this became a frozen second wherever no clip shared its
    // bucket — the same bug as the flush, one row later.
    const sess = await createSession();
    const seed = await insertUnit(sess, {
      capturedAtS: 0, requestedAtS: 1, format: "jpeg", creditedSeconds: 0, label: "seed",
    });
    const clip = await insertUnit(sess, {
      capturedAtS: 60, requestedAtS: 62, creditedSeconds: 60, expectedAtS: 60, label: "clip",
    });
    // Pause at 1:30, resume at 2:05 — the resume seed has bucket 2 alone.
    await insertUnit(sess, {
      capturedAtS: 90, requestedAtS: 91, format: "jpeg", isFinal: true,
      creditedSeconds: 30, expectedAtS: 120, label: "flush",
    });
    const resumeSeed = await insertUnit(sess, {
      capturedAtS: 125, requestedAtS: 126, format: "jpeg", creditedSeconds: 0, label: "resume-seed",
    });
    const clip2 = await insertUnit(sess, {
      capturedAtS: 185, requestedAtS: 187, creditedSeconds: 60, expectedAtS: 185, label: "clip2",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([clip, clip2]);
    expect(rows.map((r) => r.id)).not.toContain(seed);
    expect(rows.map((r) => r.id)).not.toContain(resumeSeed);
  });

  it("a drift reset keeps its second", async () => {
    // A capture that lands outside the streak window credits 0 like a seed,
    // but it covers real screen time and records the mark it missed. Only
    // the missing expected_at separates the two, so this is the row the
    // exclusion must not touch.
    const sess = await createSession();
    const seed = await insertUnit(sess, {
      capturedAtS: 0, requestedAtS: 1, format: "jpeg", creditedSeconds: 0, label: "seed",
    });
    const drifted = await insertUnit(sess, {
      capturedAtS: 95, requestedAtS: 96, creditedSeconds: 0, expectedAtS: 60, label: "reset",
    });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([drifted]);
    expect(rows.map((r) => r.id)).not.toContain(seed);
  });

  it("bucket-mode rows match neither exclusion", async () => {
    // credited_seconds and expected_at are NULL for the whole legacy path,
    // and a NULL comparison must not quietly exclude every row. The seed is
    // still dropped, but positionally, by dropSeedUnit in the worker.
    const sess = await createSession();
    const a = await insertUnit(sess, { capturedAtS: 0, requestedAtS: 1, format: "jpeg", label: "old-seed" });
    const b = await insertUnit(sess, { capturedAtS: 60, requestedAtS: 61, format: "jpeg", label: "old-b" });
    const c = await insertUnit(sess, { capturedAtS: 120, requestedAtS: 121, format: "jpeg", label: "old-c" });

    const rows = await sampleUnits(sess);
    expect(rows.map((r) => r.id)).toEqual([a, b, c]);
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
