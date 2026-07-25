import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import {
  buildSegment,
  SEGMENT_CONCURRENCY,
  SEGMENT_FPS,
  ASSEMBLE_TIMEOUT_MS,
} from "./segments.js";

const execFileAsync = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set");
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool, { schema });

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const R2_BUCKET = process.env.R2_BUCKET_NAME || "lookout";
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || "";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify a video file with ffprobe: check file size > 0 and frame count within tolerance. */
async function verifyVideo(
  filePath: string,
  expectedInputFrames: number,
  outputFps: number,
  label: string,
): Promise<number> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0)
    throw new Error(`${label}: ffmpeg produced empty output`);

  const { stdout: frameCountStr } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_packets",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      filePath,
    ],
    { timeout: 60_000 },
  );

  const frameCount = parseInt(frameCountStr.trim(), 10);
  const expectedFrames = expectedInputFrames * outputFps;
  const tolerance = Math.max(outputFps, Math.round(expectedFrames * 0.02));
  if (isNaN(frameCount) || Math.abs(frameCount - expectedFrames) > tolerance) {
    throw new Error(
      `${label}: frame count mismatch: expected ~${expectedFrames} (±${tolerance}), got ${frameCount}`,
    );
  }

  return stat.size;
}

/** Upload a file to R2 and verify the upload with HeadObject. */
async function uploadAndVerify(
  localPath: string,
  r2Key: string,
  contentType: string,
  expectedSize: number,
  label: string,
): Promise<void> {
  const bytes = await fs.readFile(localPath);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: bytes,
      ContentType: contentType,
    }),
  );

  const headResponse = await r2Client.send(
    new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
  );
  if (headResponse.ContentLength !== expectedSize) {
    throw new Error(
      `${label}: R2 upload size mismatch: expected ${expectedSize}, got ${headResponse.ContentLength}`,
    );
  }
}

export async function compileTimelapse(sessionId: string): Promise<{
  videoUrl: string;
  videoR2Key: string;
  thumbnailUrl: string;
  thumbnailR2Key: string;
}> {
  // Validate sessionId is a proper UUID to prevent path traversal
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId}`);
  }

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });

  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Atomically claim the compilation (concurrency guard).
  // Allow re-entry from 'compiling' so pg-boss retries can re-claim after a crash.
  const [claimed] = await db
    .update(schema.sessions)
    .set({ status: "compiling", updatedAt: new Date() })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        sql`${schema.sessions.status} IN ('stopped', 'compiling')`,
      ),
    )
    .returning({ id: schema.sessions.id });

  if (!claimed) {
    throw new Error(
      `Session ${sessionId} cannot be compiled (status: ${session.status})`,
    );
  }

  const tmpDir = `/tmp/compile-${sessionId}`;
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Step 1: Sample selection — pick best screenshot per minute bucket
    // Using raw SQL for DISTINCT ON which Drizzle doesn't support directly
    const sampledScreenshots = await db.execute<{
      id: string;
      r2_key: string;
      minute_bucket: number;
      requested_at: Date;
      format: string;
    }>(sql`
      SELECT DISTINCT ON (minute_bucket) id, r2_key, minute_bucket, requested_at, format
      FROM screenshots
      WHERE session_id = ${sessionId} AND confirmed = true
      ORDER BY minute_bucket,
        ABS(EXTRACT(EPOCH FROM (requested_at - (
          ${session.startedAt!}::timestamptz
          + (minute_bucket * interval '1 minute')
          + interval '30 seconds'
        ))))
    `);

    if (sampledScreenshots.rows.length === 0) {
      // No screenshots — mark failed (no video possible)
      await db
        .update(schema.sessions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(schema.sessions.id, sessionId));
      return {
        videoUrl: "",
        videoR2Key: "",
        thumbnailUrl: "",
        thumbnailR2Key: "",
      };
    }

    // Mark sampled screenshots
    const sampledIds = sampledScreenshots.rows.map((s) => s.id);
    for (const id of sampledIds) {
      await db
        .update(schema.screenshots)
        .set({ sampled: true })
        .where(eq(schema.screenshots.id, id));
    }

    // Step 2: Download sampled capture units from R2 (worker pool).
    // A unit is either a legacy single JPEG or a per-minute clip
    // (webm/mp4 holding ~20 frames captured seconds apart).
    const total = sampledScreenshots.rows.length;
    const DOWNLOAD_CONCURRENCY = 10;
    const downloaded: boolean[] = new Array(total).fill(false);
    const unitExt = (format: string) => (format === "jpeg" ? "jpg" : format);
    {
      let next = 0;
      const worker = async () => {
        while (next < total) {
          const i = next++;
          const ss = sampledScreenshots.rows[i];
          const filePath = path.join(tmpDir, `dl_${i}.${unitExt(ss.format)}`);
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await r2Client.send(
                new GetObjectCommand({ Bucket: R2_BUCKET, Key: ss.r2_key }),
              );
              const body = await response.Body!.transformToByteArray();
              await fs.writeFile(filePath, body);
              downloaded[i] = true;
              break;
            } catch {
              if (attempt === 2) {
                console.warn(
                  `Skipping unit ${i + 1}: download failed after 3 attempts (${ss.r2_key})`,
                );
              }
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, total) }, worker),
      );
    }

    const failed = downloaded.filter((d) => !d).length;
    if (failed > 5) {
      throw new Error(
        `Too many failed unit downloads: ${failed}/${total} failed`,
      );
    }
    if (failed > 0) {
      console.warn(`${failed}/${total} units failed to download, continuing`);
    }

    // Step 3: Build one normalized 1-second segment per unit, in parallel.
    // Every unit — legacy JPEG or clip — becomes exactly one second of
    // 30fps output with identical pinned encoder parameters, so the final
    // timelapse is a stream-copy concatenation instead of one giant
    // whole-session encode. Wall clock scales with units/SEGMENT_CONCURRENCY
    // (~90s for a max-length 12h session) and a corrupt unit is caught and
    // skipped here per-minute rather than poisoning the full encode.
    const segmentPaths: (string | null)[] = new Array(total).fill(null);
    {
      let next = 0;
      const builder = async () => {
        while (next < total) {
          const i = next++;
          if (!downloaded[i]) continue;
          const ss = sampledScreenshots.rows[i];
          const unitPath = path.join(tmpDir, `dl_${i}.${unitExt(ss.format)}`);
          try {
            segmentPaths[i] = await buildSegment(tmpDir, i, unitPath, ss.format);
          } catch (err) {
            console.warn(
              `Skipping unit ${i + 1}: segment build failed (${ss.r2_key})`,
              err,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SEGMENT_CONCURRENCY, total) }, builder),
      );
    }

    const segments = segmentPaths.filter((p): p is string => p !== null);
    const unitsIncluded = segments.length;
    const buildFailures = total - failed - unitsIncluded;
    if (unitsIncluded === 0) {
      throw new Error("No usable capture units after segment build");
    }
    if (buildFailures > 5) {
      throw new Error(
        `Too many failed segment builds: ${buildFailures}/${total - failed} failed`,
      );
    }
    if (buildFailures > 0) {
      console.warn(`${buildFailures} units failed segment build, continuing`);
    }

    // Step 4: Assemble — stream-copy concat of the segments, remuxed to MP4.
    // No re-encoding on the happy path: segments share pinned parameters and
    // each starts on an IDR frame, so this is I/O-bound (seconds, even for a
    // 12-hour session).
    const concatListPath = path.join(tmpDir, "segments.txt");
    await fs.writeFile(
      concatListPath,
      segments.map((p) => `file '${p}'`).join("\n") + "\n",
    );

    const mp4Path = path.join(tmpDir, "timelapse.mp4");
    let mp4Size: number;
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "concat",
          "-safe", "0",
          "-i", concatListPath,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y",
          mp4Path,
        ],
        { timeout: ASSEMBLE_TIMEOUT_MS },
      );
      mp4Size = await verifyVideo(mp4Path, unitsIncluded, SEGMENT_FPS, "MP4");
    } catch (err) {
      // Safety net: if the copied stream doesn't verify (e.g. an encoder
      // parameter drifted between segments), re-encode the already-built
      // segments into one uniform stream. One extra ffmpeg pass over 1s
      // segments — not a second pipeline.
      console.warn("Stream-copy assembly failed, re-encoding segments:", err);
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "concat",
          "-safe", "0",
          "-i", concatListPath,
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "28",
          "-pix_fmt", "yuv420p",
          "-r", String(SEGMENT_FPS),
          "-movflags", "+faststart",
          "-y",
          mp4Path,
        ],
        { timeout: ASSEMBLE_TIMEOUT_MS },
      );
      mp4Size = await verifyVideo(
        mp4Path,
        unitsIncluded,
        SEGMENT_FPS,
        "MP4 (re-encoded)",
      );
    }

    // Step 4.5: Extract thumbnail from first frame
    const thumbnailPath = path.join(tmpDir, "thumbnail.jpg");
    await execFileAsync(
      "ffmpeg",
      [
        "-i",
        mp4Path,
        "-vframes",
        "1",
        "-vf",
        "scale=480:-1",
        "-q:v",
        "5",
        "-y",
        thumbnailPath,
      ],
      { timeout: 30_000 },
    );

    // Step 5: Upload all artifacts to R2 and verify
    const thumbnailR2Key = `timelapses/${sessionId}/thumbnail.jpg`;
    const thumbnailBytes = await fs.readFile(thumbnailPath);
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbnailR2Key,
        Body: thumbnailBytes,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    const videoR2Key = `timelapses/${sessionId}/timelapse.mp4`;
    await uploadAndVerify(mp4Path, videoR2Key, "video/mp4", mp4Size, "MP4");

    // Step 6: Mark complete
    const thumbnailUrl = R2_PUBLIC_DOMAIN
      ? `https://${R2_PUBLIC_DOMAIN}/${thumbnailR2Key}`
      : thumbnailR2Key;

    const videoUrl = R2_PUBLIC_DOMAIN
      ? `https://${R2_PUBLIC_DOMAIN}/${videoR2Key}`
      : videoR2Key;

    await db
      .update(schema.sessions)
      .set({
        status: "complete",
        videoUrl,
        videoR2Key,
        thumbnailUrl,
        thumbnailR2Key,
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, sessionId));

    // Step 7: Cleanup unsampled screenshots from R2
    const unsampled = await db
      .select({ r2Key: schema.screenshots.r2Key, id: schema.screenshots.id })
      .from(schema.screenshots)
      .where(
        and(
          eq(schema.screenshots.sessionId, sessionId),
          eq(schema.screenshots.confirmed, true),
          eq(schema.screenshots.sampled, false),
        ),
      );

    for (const ss of unsampled) {
      try {
        await r2Client.send(
          new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: ss.r2Key }),
        );
      } catch {
        // Non-fatal: orphaned R2 objects can be cleaned up later
      }
    }

    // Delete unconfirmed screenshot records
    await db
      .delete(schema.screenshots)
      .where(
        and(
          eq(schema.screenshots.sessionId, sessionId),
          eq(schema.screenshots.confirmed, false),
        ),
      );

    return {
      videoUrl,
      videoR2Key,
      thumbnailUrl,
      thumbnailR2Key,
    };
  } finally {
    // Always clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
