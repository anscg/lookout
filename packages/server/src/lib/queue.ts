import PgBoss from "pg-boss";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://collapse:collapse@localhost:5433/collapse";

export const boss = new PgBoss({
  connectionString: DATABASE_URL,
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInHours: 2,
});

export const COMPILE_JOB = "compile-timelapse";
export const CHECK_TIMEOUTS_JOB = "check-timeouts";
export const CLEANUP_UNCONFIRMED_JOB = "cleanup-unconfirmed";

export interface CompileJobData {
  sessionId: string;
}
