/**
 * ccs-sessions.ts — `ccs sessions --json [--project <name>] [--limit <n>]
 * [--with-titles] [--no-scan]`.
 *
 * Past conversations per project, newest first, at most --limit each. Only
 * what a screen needs to offer "resume": the project's name, the time, the
 * UUID to hand to `ccs open --session`, and (only with --with-titles) the
 * first request's one line. Never the summary, the working folder, the
 * branch or the conversation itself. Contract:
 * docs/design/machine-interface.md 2.3.
 *
 * Before reading, the same incremental scan the list runs refreshes the cache
 * (not with --no-scan, not without a repos.yml). Its stderr is held: the
 * scan's lines can name repos and paths.
 */

import { existsSync } from "node:fs";

import { getPaths, readConfig } from "./ccs-config.ts";
import {
  cliOutcome,
  configFailure,
  okOutcome,
  parseFlags,
  type Outcome,
} from "./ccs-machine.ts";
import { maskSecrets } from "./ccs-secrets.ts";
import { stripControlChars } from "./ccs-sanitize.ts";

const LIMIT_DEFAULT = 5;
const LIMIT_MAX = 50;
const TITLE_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One line, no control or reordering characters, at most 80 code points (+ …). */
export function sessionTitle(topic: string | null): string | null {
  if (topic === null) return null;
  const clean = stripControlChars(maskSecrets(stripControlChars(topic)));
  if (clean === "") return null;
  const points = [...clean];
  return points.length > TITLE_MAX ? points.slice(0, TITLE_MAX).join("") + "…" : clean;
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Run the list's scan in this process with stderr and console.warn held back. */
async function quietScan(): Promise<boolean> {
  const write = process.stderr.write;
  const warn = console.warn;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  console.warn = () => {};
  try {
    const { scan } = await import("./ccs-scan.ts");
    const res = await scan({ quietConfig: true });
    return !res.lockSkipped;
  } catch {
    return false;
  } finally {
    process.stderr.write = write;
    console.warn = warn;
  }
}

interface Row {
  uuid: string;
  repo_name: string | null;
  last_activity_at: string | null;
  topic: string | null;
  mapped: number;
  disabled: number | null;
}

export async function sessionsOutcome(args: readonly string[]): Promise<Outcome> {
  const flags = parseFlags(args, {
    booleans: ["--json", "--with-titles", "--no-scan"],
    values: ["--project", "--limit"],
  });
  if (!flags.ok) return cliOutcome(flags.code);
  if (flags.positionals.length > 0 || flags.rest.length > 0) return cliOutcome("extra_argument");
  if (!flags.booleans.has("--json")) {
    return cliOutcome("json_required", {}, "`ccs sessions` needs --json (to pick a conversation by hand, run ccs --resume)");
  }
  let limit = LIMIT_DEFAULT;
  const rawLimit = flags.values.get("--limit");
  if (rawLimit !== undefined) {
    if (!/^[0-9]{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > LIMIT_MAX) {
      return cliOutcome("invalid_argument", {}, `--limit takes 1–${LIMIT_MAX}`);
    }
    limit = Number(rawLimit);
  }
  const project = flags.values.get("--project");
  const withTitles = flags.booleans.has("--with-titles");
  const paths = getPaths();

  // --project must name an entry of repos.yml as it is now.
  if (project !== undefined) {
    try {
      const result = readConfig();
      if (!result.found) {
        return cliOutcome("config_missing", {}, "no repos.yml yet (config_missing)");
      }
      if (!result.config.repos.some((r) => r.name === project)) {
        return cliOutcome("repo_not_found");
      }
    } catch (err) {
      return configFailure(err);
    }
  }

  let fresh = false;
  if (!flags.booleans.has("--no-scan") && existsSync(paths.reposYml)) {
    fresh = await quietScan();
  }

  if (!existsSync(paths.stateDb)) {
    return cliOutcome("cache_missing", {}, "no cache yet (cache_missing); open the list once, or run ccs --refresh");
  }
  let rows: Row[];
  try {
    const { openDb } = await import("./ccs-db.ts");
    const handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
    try {
      rows = handle.db
        .prepare(
          `SELECT s.uuid, s.repo_name, s.last_activity_at, s.topic,
                  (r.name IS NOT NULL) AS mapped, r.disabled
             FROM sessions s
             LEFT JOIN repos r ON r.name = s.repo_name
            ORDER BY s.last_activity_at DESC`,
        )
        .all() as Row[];
    } finally {
      handle.db.close();
    }
  } catch {
    return cliOutcome("cache_not_readable", {}, "cannot open the cache (cache_not_readable)");
  }

  let unmapped = 0;
  const byProject = new Map<string, Row[]>();
  for (const row of rows) {
    if (!UUID_RE.test(row.uuid)) continue;
    if (!row.mapped || !row.repo_name) {
      unmapped++;
      continue;
    }
    if (row.disabled) continue;
    if (project !== undefined && row.repo_name !== project) continue;
    const list = byProject.get(row.repo_name) ?? [];
    list.push(row);
    byProject.set(row.repo_name, list);
  }

  // Rows come newest first, so the Map's insertion order is already the
  // projects' order by their newest conversation.
  const projects = [...byProject.entries()].map(([name, list]) => ({
    name,
    sessions: list.slice(0, limit).map((s) => {
      const item: Record<string, unknown> = {
        uuid: s.uuid,
        last_activity_at: isoOrNull(s.last_activity_at),
      };
      if (withTitles) item.title = sessionTitle(s.topic);
      return item;
    }),
    more: Math.max(0, list.length - limit),
  }));

  return okOutcome({ stale: !fresh, limit, projects, unmapped });
}
