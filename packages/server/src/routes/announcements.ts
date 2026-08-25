import type { FastifyInstance } from "fastify";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { announcementMatchesVersion } from "../lib/announcementTargeting.js";

// Public, unauthenticated endpoint the desktop app polls (on open and every
// ~15 min) for an admin announcement banner. Returns the latest active
// announcement, or null when none is set. Clients must handle null gracefully.
//
// Targeting: clients MAY report their version (?version=0.3.1). An
// announcement with min/max version bounds is returned only to clients whose
// reported version falls inside them; a client that reports nothing is
// treated as version 0 (see announcementMatchesVersion), which is what old
// builds that predate version reporting are. Untargeted announcements go to
// everyone, so the response shape — and old clients' behavior — is unchanged.
export async function announcementRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { version?: string; client?: string } }>(
    "/api/announcement",
    {
      schema: {
        querystring: {
          type: "object" as const,
          properties: {
            // Reported app version, e.g. "0.3.1". Optional; old clients
            // never send it.
            version: { type: "string" as const, maxLength: 64 },
            // Reported client kind (e.g. "lookout-desktop"). Accepted for
            // forward compatibility / telemetry symmetry; not yet a filter.
            client: { type: "string" as const, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const [a] = await db
        .select({
          level: schema.announcements.level,
          message: schema.announcements.message,
          url: schema.announcements.url,
          minVersion: schema.announcements.minVersion,
          maxVersion: schema.announcements.maxVersion,
        })
        .from(schema.announcements)
        .where(eq(schema.announcements.active, true))
        .orderBy(desc(schema.announcements.updatedAt))
        .limit(1);

      if (!a || !announcementMatchesVersion(a, request.query.version)) {
        return { announcement: null };
      }
      // The bounds are targeting metadata, not banner content — keep the
      // payload exactly what clients have always rendered.
      return {
        announcement: { level: a.level, message: a.message, url: a.url },
      };
    },
  );
}
