/**
 * Publish, inspect, or clear the desktop app's tip sheet.
 *
 *   npm run tip -- --show
 *   npm run tip -- --clear
 *   npm run tip -- --title "..." --body "..." --badge "NEW!" \
 *                  --image https://... --program lapse --trigger deep-link \
 *                  --require-unlinked
 *
 * Lives under src/ so `tsc` compiles it into dist/, which is the only thing
 * the runtime image copies (Dockerfile.server). In a deployed container there
 * is no source tree, so run it as:
 *
 *   node dist/scripts/tip.js --show
 *
 * Publishing deactivates the previous tip, so at most one is live; old rows
 * stay as history. Needs DATABASE_URL (a repo-root .env is picked up in dev;
 * a container already has it in the environment).
 */
import { eq, desc } from "drizzle-orm";

// Imported lazily: the db module throws at import time without DATABASE_URL,
// which would make --help fail with a connection error instead of printing.
const openDb = () => import("../db/index.js");

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | null {
  const v = flags[key];
  if (typeof v !== "string") return null;
  return v.trim() || null;
}

const USAGE = `
Publish the desktop tip sheet.

  --title <text>          Headline. Required to publish.
  --body <text>           Supporting paragraph. Required to publish.
  --badge <text>          Small pill above the headline, e.g. "NEW!".
  --image <url>           https hero image across the top of the sheet.

Targeting (all evaluated on the client):
  --program <name>        Program registry name, e.g. "lapse".
  --trigger <any|deep-link>
                          "deep-link" restricts it to users who opened one of
                          that program's timelapses through a lookout:// link.
  --require-unlinked      Skip users who already paired --program.
  --min-version <v>       Inclusive client version bounds, e.g. 0.3.11.
  --max-version <v>

Other modes:
  --show                  Print the active tip and exit.
  --clear                 Deactivate the active tip and exit.
`.trimStart();

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }

  const { db, schema } = await openDb();

  if (flags.show) {
    const [active] = await db
      .select()
      .from(schema.tips)
      .where(eq(schema.tips.active, true))
      .orderBy(desc(schema.tips.updatedAt))
      .limit(1);
    console.log(active ? JSON.stringify(active, null, 2) : "No active tip.");
    return;
  }

  if (flags.clear) {
    const result = await db
      .update(schema.tips)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.tips.active, true))
      .returning({ id: schema.tips.id });
    console.log(result.length ? `Cleared tip ${result[0].id}.` : "Nothing to clear.");
    return;
  }

  const title = str(flags, "title");
  const body = str(flags, "body");
  if (!title || !body) {
    console.error("--title and --body are required to publish.\n");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const imageUrl = str(flags, "image");
  // An http image would be blocked as mixed content in the webview.
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    console.error("--image must be an https URL.");
    process.exitCode = 1;
    return;
  }

  const rawTrigger = str(flags, "trigger") ?? "any";
  const trigger = rawTrigger === "deep-link" ? "deep_link" : rawTrigger;
  if (trigger !== "any" && trigger !== "deep_link") {
    console.error(`--trigger must be "any" or "deep-link" (got "${rawTrigger}").`);
    process.exitCode = 1;
    return;
  }

  const program = str(flags, "program");
  const requireUnlinked = flags["require-unlinked"] === true;
  // Ignoring these silently would publish to everyone a tip the author
  // believed was targeted.
  if (!program && (trigger === "deep_link" || requireUnlinked)) {
    console.error("--trigger deep-link and --require-unlinked both need --program.");
    process.exitCode = 1;
    return;
  }

  const created = await db.transaction(async (tx) => {
    await tx
      .update(schema.tips)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.tips.active, true));
    const [row] = await tx
      .insert(schema.tips)
      .values({
        badge: str(flags, "badge"),
        title,
        body,
        imageUrl,
        program,
        trigger,
        requireUnlinked,
        minVersion: str(flags, "min-version"),
        maxVersion: str(flags, "max-version"),
      })
      .returning();
    return row;
  });

  console.log(`Published tip ${created.id}.`);
  console.log(JSON.stringify(created, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // The db module opens a pg pool at import, keeping the process alive.
  .finally(() => process.exit(process.exitCode ?? 0));
