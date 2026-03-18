import PgBoss from "pg-boss";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { compileTimelapse } from "./compile.js";
import * as schema from "./schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://collapse:collapse@localhost:5433/collapse";

const COMPILE_JOB = "compile-timelapse";
const RETRY_LIMIT = 3;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool, { schema });

const boss = new PgBoss({
  connectionString: DATABASE_URL,
});

await boss.start();

console.log("Worker started, listening for compilation jobs...");

await boss.work<{ sessionId: string }>(
  COMPILE_JOB,
  async (jobs) => {
    for (const job of jobs) {
      const { sessionId } = job.data;
      console.log(`Compiling timelapse for session ${sessionId}...`);

      try {
        const result = await compileTimelapse(sessionId);
        console.log(
          `Compilation complete for session ${sessionId}: ${result.videoR2Key}`,
        );
      } catch (error) {
        console.error(
          `Compilation failed for session ${sessionId}:`,
          error,
        );
        // On final retry, mark session as failed immediately
        // instead of waiting for the 60-min stuck-compiling timeout
        const retryCount = ((job as unknown as Record<string, unknown>).retrycount as number) ?? 0;
        if (retryCount >= RETRY_LIMIT - 1) {
          console.error(`Final retry exhausted for session ${sessionId}, marking as failed`);
          await db
            .update(schema.sessions)
            .set({ status: "failed", updatedAt: new Date() })
            .where(eq(schema.sessions.id, sessionId))
            .catch((e) => console.error("Failed to mark session as failed:", e));
        }
        throw error; // pgBoss will retry (or complete if final)
      }
    }
  },
);

// Graceful shutdown
const shutdown = async () => {
  console.log("Worker shutting down...");
  await boss.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
