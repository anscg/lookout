import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://collapse:collapse@localhost:5433/collapse",
});

export const db = drizzle(pool, { schema });
export { schema };
