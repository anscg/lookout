import type { FastifyInstance } from "fastify";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { announcementMatchesVersion } from "../lib/announcementTargeting.js";

// Public endpoint the desktop app polls for the active tip sheet, or null.
//
// Version bounds are applied here; `program` / `trigger` / `requireUnlinked`
// ship to the client, which is the only place that knows whether a deep link
// landed or a program is already paired. The payload is identical for every
// client on a given version, so there's nothing to authenticate.
export async function tipRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { version?: string; client?: string } }>(
    "/api/tip",
    {
      schema: {
        querystring: {
          type: "object" as const,
          properties: {
            version: { type: "string" as const, maxLength: 64 },
            client: { type: "string" as const, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const [t] = await db
        .select({
          id: schema.tips.id,
          badge: schema.tips.badge,
          title: schema.tips.title,
          body: schema.tips.body,
          imageUrl: schema.tips.imageUrl,
          program: schema.tips.program,
          trigger: schema.tips.trigger,
          requireUnlinked: schema.tips.requireUnlinked,
          minVersion: schema.tips.minVersion,
          maxVersion: schema.tips.maxVersion,
        })
        .from(schema.tips)
        .where(eq(schema.tips.active, true))
        .orderBy(desc(schema.tips.updatedAt))
        .limit(1);

      if (!t || !announcementMatchesVersion(t, request.query.version)) {
        return { tip: null };
      }
      // Clients key "already shown" off `id`, so editing copy means a new row
      // — and a new row is a new tip that shows again.
      return {
        tip: {
          id: t.id,
          badge: t.badge,
          title: t.title,
          body: t.body,
          imageUrl: t.imageUrl,
          program: t.program,
          trigger: t.trigger,
          requireUnlinked: t.requireUnlinked,
        },
      };
    },
  );
}
