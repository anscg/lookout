/**
 * Client version analytics: who runs what, on which OS, and when they moved.
 *
 *   npm run versions -- --days 30 --recent 7
 *   npm run versions -- --type all --json > versions.json
 *   node dist/scripts/versions.js --days 45     # in a deployed container
 *
 * The admin dashboard's "top app versions" is an ALL-TIME tally over every
 * session ever recorded, so a two-week-old release can never look big there.
 * Everything here is windowed and dated, which is what a rollout looks like.
 *
 * The unit is a session, dated by its start and attributed to the first
 * clientInfo it reported (same rule as the dashboard). Needs DATABASE_URL —
 * a repo-root .env in dev, already in the environment in a container.
 */
import pg from "pg";
import { parseClientInfo } from "@lookout/shared";

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

const USAGE = `Client version analytics.

  --days N      window to analyse, in days (default 30)
  --recent N    window for the "right now" tables (default 7)
  --type T      desktop | web | sdk | all (default desktop)
  --top N       how many recent versions get their own column (default 6)
  --json        dump the raw day/version/os records instead of tables
`;

const flags = parseArgs(process.argv.slice(2));
if (flags.help || flags.h) {
  console.log(USAGE);
  process.exit(0);
}

const days = Number(flags.days ?? 30);
const recentDays = Number(flags.recent ?? 7);
const wantType = String(flags.type ?? "desktop").toLowerCase();
const topN = Number(flags.top ?? 6);

/** Compares dotted versions, tolerating a leading v and any suffix. */
function vcmp(a: string, b: string): number {
  const key = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.\-+]/)
      .map((x) => Number(x) || 0);
  const [A, B] = [key(a), key(b)];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Desktop reports the distro ("Arch Linux", "Ubuntu 24.04"), not "Linux". */
function osFamily(type: string, os: string | undefined): string {
  if (!os) return "Unknown";
  if (/^mac/i.test(os)) return "macOS";
  if (/^windows/i.test(os)) return "Windows";
  if (os === "Android" || os === "iOS") return os;
  return type === "desktop" ? "Linux" : os;
}

interface Rec {
  day: string;
  type: string;
  version: string;
  osFamily: string;
  osType: string;
  osVersion: string;
  n: number;
}

const sum = (rs: Rec[]) => rs.reduce((t, r) => t + r.n, 0);

function group<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");

function heading(text: string): void {
  console.log(`\n== ${text}`);
}

function table(head: string[], rows: (string | number)[][]): void {
  if (!rows.length) {
    console.log("  (no data)");
    return;
  }
  const body = rows.map((r) => r.map((c) => String(c)));
  const w = head.map((h, i) =>
    Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: string[]) =>
    "  " +
    r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log("  " + w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(line(r));
}

// ---- load ----------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

const { rows: raw } = await client.query<{
  day: string;
  client_info: string | null;
  n: number;
}>(
  `select (se.created_at at time zone 'UTC')::date::text as day,
          f.client_info,
          count(*)::int as n
     from sessions se
     left join lateral (
       select sc.client_info
         from screenshots sc
        where sc.session_id = se.id
          and sc.client_info is not null
        order by sc.requested_at asc
        limit 1
     ) f on true
    where se.created_at >= now() - make_interval(days => $1::int)
    group by 1, 2
    order by 1`,
  [days],
);
await client.end();

const recs: Rec[] = [];
let noInfo = 0;
let unparsed = 0;
for (const r of raw) {
  if (!r.client_info) {
    noInfo += r.n;
    continue;
  }
  const p = parseClientInfo(r.client_info);
  if (!p) {
    unparsed += r.n;
    continue;
  }
  recs.push({
    day: r.day,
    type: p.type,
    version: p.version,
    osFamily: osFamily(p.type, p.osType),
    osType: p.osType ?? "?",
    osVersion: p.osVersion ?? "",
    n: r.n,
  });
}

if (flags.json) {
  console.log(JSON.stringify({ noInfo, unparsed, records: recs }, null, 2));
  process.exit(0);
}

const rs = wantType === "all" ? recs : recs.filter((r) => r.type === wantType);
const allDays = [...new Set(recs.map((r) => r.day))].sort();
const firstDay = allDays[0] ?? "-";
const lastDay = allDays[allDays.length - 1] ?? "-";
const recentFrom = allDays[Math.max(0, allDays.length - recentDays)] ?? firstDay;
const recentRs = rs.filter((r) => r.day >= recentFrom);

/** Versions seen in the window, oldest first — the release ladder. */
const ladder = [...new Set(rs.map((r) => r.version))].sort(vcmp);
const rank = new Map(ladder.map((v, i) => [v, i]));
const latest = ladder[ladder.length - 1] ?? "-";
const newest = [...ladder].reverse().slice(0, topN);

const firstSeen = new Map<string, string>();
const lastSeen = new Map<string, string>();
for (const r of rs) {
  const f = firstSeen.get(r.version);
  if (!f || r.day < f) firstSeen.set(r.version, r.day);
  const l = lastSeen.get(r.version);
  if (!l || r.day > l) lastSeen.set(r.version, r.day);
}

const families = [...group(rs, (r) => r.osFamily).entries()]
  .sort((a, b) => sum(b[1]) - sum(a[1]))
  .map(([f]) => f);

// ---- 1. coverage ---------------------------------------------------------

heading(`Coverage - sessions started ${firstDay} -> ${lastDay} UTC (last ${days}d)`);
const byType = [...group(recs, (r) => r.type).entries()].sort(
  (a, b) => sum(b[1]) - sum(a[1]),
);
const grand = sum(recs) + noInfo + unparsed;
table(
  ["bucket", "sessions", "share"],
  [
    ...byType.map(([t, list]) => [t, sum(list), pct(sum(list), grand)]),
    ["no clientInfo (never captured)", noInfo, pct(noInfo, grand)],
    ["unparsed clientInfo", unparsed, pct(unparsed, grand)],
    ["total", grand, "100%"],
  ],
);
console.log(
  `\n  type=${wantType}: ${sum(rs)} sessions, ${ladder.length} distinct versions, ` +
    `newest seen ${latest}.`,
);

// ---- 2. daily version mix ------------------------------------------------

heading(`Daily version mix (${wantType}) - share of sessions started that day`);
{
  const cols = newest;
  const rows = allDays.map((day) => {
    const dayRs = rs.filter((r) => r.day === day);
    const total = sum(dayRs);
    const cells = cols.map((v) =>
      pct(sum(dayRs.filter((r) => r.version === v)), total),
    );
    const older = sum(dayRs.filter((r) => !cols.includes(r.version)));
    return [day, total, ...cells, pct(older, total)];
  });
  table(["day", "n", ...cols, "older"], rows);
}

// ---- 3. newest-build share by OS ----------------------------------------

heading(`Share running ${latest} (newest seen), by OS and day`);
{
  const rows = allDays.map((day) => {
    const dayRs = rs.filter((r) => r.day === day);
    const cells: (string | number)[] = [];
    for (const f of families) {
      const famRs = dayRs.filter((r) => r.osFamily === f);
      cells.push(sum(famRs));
      cells.push(pct(sum(famRs.filter((r) => r.version === latest)), sum(famRs)));
    }
    return [day, sum(dayRs), ...cells];
  });
  table(["day", "n", ...families.flatMap((f) => [`${f} n`, `${f} on ${latest}`])], rows);
}

// ---- 4. current mix ------------------------------------------------------

heading(`Version x OS - last ${recentDays}d (${recentFrom} -> ${lastDay})`);
{
  const total = sum(recentRs);
  const rows = [...ladder]
    .reverse()
    .map((v) => {
      const vRs = recentRs.filter((r) => r.version === v);
      return [
        v,
        ...families.map((f) => sum(vRs.filter((r) => r.osFamily === f))),
        sum(vRs),
        pct(sum(vRs), total),
      ];
    })
    .filter((row) => Number(row[row.length - 2]) > 0);
  table(["version", ...families, "total", "share"], rows);
}

// ---- 5. version lifetime -------------------------------------------------

heading("Version lifetime - first and last session seen in the window");
{
  const rows = [...ladder].reverse().map((v) => {
    const vRs = rs.filter((r) => r.version === v);
    return [
      v,
      firstSeen.get(v) ?? "-",
      lastSeen.get(v) ?? "-",
      sum(vRs),
      pct(sum(vRs), sum(rs)),
      lastSeen.get(v) === lastDay ? "yes" : "no",
    ];
  });
  table(
    ["version", "first seen", "last seen", "sessions", "share", `alive ${lastDay}`],
    rows,
  );
}

// ---- 6. adoption ramp ----------------------------------------------------

heading(
  "Adoption ramp - % of that OS's sessions on the version OR NEWER, N days after it first appeared",
);
console.log("  A healthy rollout climbs. A flat row is a release that never reached people.");
{
  const offsets = [0, 1, 2, 3, 5, 7, 10, 14];
  const rows: (string | number)[][] = [];
  for (const v of [...ladder].reverse().slice(0, topN)) {
    const start = firstSeen.get(v);
    if (!start) continue;
    for (const f of families) {
      const cells = offsets.map((off) => {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + off);
        const day = d.toISOString().slice(0, 10);
        if (day > lastDay) return "-";
        const famRs = rs.filter((r) => r.day === day && r.osFamily === f);
        if (!famRs.length) return "-";
        return pct(sum(famRs.filter((r) => vcmp(r.version, v) >= 0)), sum(famRs));
      });
      rows.push([v, f, start, ...cells]);
    }
  }
  table(["version", "os", "first seen", ...offsets.map((o) => `d+${o}`)], rows);
}

// ---- 7. staleness --------------------------------------------------------

heading(`How far behind, by OS - last ${recentDays}d`);
{
  const latestRank = rank.get(latest) ?? 0;
  const rows = families.map((f) => {
    const famRs = recentRs.filter((r) => r.osFamily === f);
    const total = sum(famRs);
    const behind = (lo: number, hi: number) =>
      sum(
        famRs.filter((r) => {
          const b = latestRank - (rank.get(r.version) ?? 0);
          return b >= lo && b <= hi;
        }),
      );
    // Median age of the build in use: days between the session and the day
    // that build first appeared. Bounded by the window, so a long-lived old
    // build reads as at most --days old.
    const ages: number[] = [];
    for (const r of famRs) {
      const start = firstSeen.get(r.version);
      if (!start) continue;
      const age =
        (Date.parse(`${r.day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000;
      for (let i = 0; i < r.n; i++) ages.push(age);
    }
    ages.sort((a, b) => a - b);
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
    return [
      f,
      total,
      pct(behind(0, 0), total),
      pct(behind(1, 1), total),
      pct(behind(2, 2), total),
      pct(behind(3, Number.MAX_SAFE_INTEGER), total),
      `${median.toFixed(0)}d`,
    ];
  });
  table(
    [
      "os",
      "n",
      "on latest",
      "1 behind",
      "2 behind",
      "3+ behind",
      "median build age",
    ],
    rows,
  );
}

// ---- 8. where the stuck installs are ------------------------------------

heading(`Stuck installs - last ${recentDays}d, sessions NOT on ${latest}, by OS build`);
{
  const stale = recentRs.filter((r) => r.version !== latest);
  const rows = [...group(stale, (r) => `${r.osType} ${r.osVersion}`).entries()]
    .map(([k, list]) => {
      const [osType, osVersion] = k.split(" ");
      const top = [...group(list, (r) => r.version).entries()]
        .sort((a, b) => sum(b[1]) - sum(a[1]))
        .slice(0, 3)
        .map(([v, l]) => `${v} (${sum(l)})`)
        .join(", ");
      const buildTotal = sum(
        recentRs.filter((r) => r.osType === osType && r.osVersion === osVersion),
      );
      return {
        n: sum(list),
        row: [
          `${osType} ${osVersion}`.trim(),
          sum(list),
          buildTotal,
          pct(sum(list), buildTotal),
          top,
        ] as (string | number)[],
      };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 20)
    .map((x) => x.row);
  table(["os build", "stale", "total", "stale %", "top stale versions"], rows);
}

console.log("");
