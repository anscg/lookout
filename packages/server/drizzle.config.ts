import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Dev-only fallback: drizzle-kit is a CLI tool for migrations, not the runtime server.
  // The server itself (db/index.ts) requires DATABASE_URL to be set explicitly.
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://lookout:lookout@localhost:5433/lookout",
  },
});
