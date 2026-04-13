#!/usr/bin/env tsx
/**
 * ccs-list.ts — SQL-driven row builder for the ccs fzf launcher (v0.2.0)
 *
 * Outputs tab-separated rows for fzf consumption:
 *   <LABEL>\t<DESCRIPTION>\t<BADGES>\t<KIND>:<KEY>\t<CWD>\t<COMMAND>
 *
 * Modes:
 *   --current-only    sessions whose cwd matches process.cwd()
 *   --repos-only      only NEW repo rows
 *   --sessions-only   only RESUME session rows
 *   (default)         NEW first (alpha), then RESUME (last_activity_at DESC)
 */

import { homedir } from "node:os";
import { openDb } from "./ccs-db.ts";
import { getPaths } from "./ccs-config.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESC_MAX = 60;
const BADGES_MAX = 60;
const KNOWN_INTEGRATION_KEYS = [
  "plane_project_id",
  "attio_workspace",
  "notion_db",
  "linear_team",
  "slack_channel",
  "github_repo",
  "figma_file",
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Flags {
  currentOnly: boolean;
  reposOnly: boolean;
  sessionsOnly: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    currentOnly: argv.includes("--current-only"),
    reposOnly: argv.includes("--repos-only"),
    sessionsOnly: argv.includes("--sessions-only"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (!s) return "";
  const flat = s.replace(/[\t\n\r]+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

function humanTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "<1m前";
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "<1m前";
  if (m < 60) return `${m}m前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d前`;
  const w = Math.floor(d / 7);
  return `${w}w前`;
}

function formatSessionStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function clipBadges(badges: string[], max: number): string {
  const out: string[] = [];
  let len = 0;
  for (const b of badges) {
    const add = (out.length === 0 ? 0 : 1) + b.length;
    if (len + add > max) break;
    out.push(b);
    len += add;
  }
  return out.join(" ");
}

function parseCustom(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function integrationShortNames(custom: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of KNOWN_INTEGRATION_KEYS) {
    if (custom[key] === undefined || custom[key] === null || custom[key] === "") continue;
    // map key -> short label
    const short = key
      .replace(/_project_id$/, "")
      .replace(/_workspace$/, "")
      .replace(/_db$/, "")
      .replace(/_team$/, "")
      .replace(/_channel$/, "")
      .replace(/_repo$/, "")
      .replace(/_file$/, "");
    names.push(short);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

interface RepoRowFull {
  name: string;
  path: string;
  description: string;
  command: string;
  cwd: string | null;
  icon: string;
  disabled: number;
  custom_json: string;
  // stats (LEFT JOINed, may be null)
  is_git: number | null;
  branch: string | null;
  uncommitted_insertions: number | null;
  uncommitted_deletions: number | null;
  handoff_count: number | null;
  pending_count: number | null;
  session_last_at: string | null;
}

function buildRepoBadges(r: RepoRowFull): string {
  const badges: string[] = [];

  if (r.is_git === 1) {
    const branch = r.branch ?? "?";
    const ins = r.uncommitted_insertions ?? 0;
    const del = r.uncommitted_deletions ?? 0;
    if (ins === 0 && del === 0) {
      badges.push(`[${branch} clean]`);
    } else {
      badges.push(`[${branch} +${ins}/-${del}]`);
    }
  }

  if ((r.handoff_count ?? 0) > 0) {
    badges.push(`[⚠️ handoff×${r.handoff_count}]`);
  }
  if ((r.pending_count ?? 0) > 0) {
    badges.push(`[📝 pending×${r.pending_count}]`);
  }

  if (r.session_last_at) {
    const ht = humanTime(r.session_last_at);
    if (ht) badges.push(`[🔄 ${ht}]`);
  } else {
    badges.push(`[💤 未使用]`);
  }

  const custom = parseCustom(r.custom_json);
  const names = integrationShortNames(custom).slice(0, 3);
  if (names.length > 0) {
    badges.push(`[🔗 ${names.join(",")}]`);
  }

  return clipBadges(badges, BADGES_MAX);
}

// Dim vertical bar separator (ANSI 2 = faint) inserted between the label
// column and the description column to visually distinguish them. fzf is
// invoked with --ansi so these codes render as styling.
const LABEL_SEP = " \x1b[2m│\x1b[0m";

function repoToRow(r: RepoRowFull): string {
  const label = `${r.icon || "📁"} ${r.name}${LABEL_SEP}`;
  const desc = truncate(r.description || "", DESC_MAX);
  const badges = buildRepoBadges(r);
  const cwd = r.cwd && r.cwd.length > 0 ? r.cwd : r.path;
  const command = r.command || "claude";
  return [
    label,
    desc,
    badges,
    `new:${r.name}`,
    cwd,
    command,
  ].join("\t");
}

interface SessionRowFull {
  uuid: string;
  repo_name: string | null;
  cwd: string;
  last_activity_at: string;
  topic: string | null;
  // from repos (LEFT JOIN)
  repo_display: string | null;
  repo_icon: string | null;
  repo_command: string | null;
}

function sessionToRow(s: SessionRowFull): string {
  // Mapped sessions use the registered repo icon + name.
  // Unmapped sessions get ❓ as a visible reminder: either a one-off run
  // or a repo that hasn't been added to repos.yml yet.
  const isMapped = !!s.repo_display;
  const displayName = isMapped
    ? s.repo_display!
    : s.cwd
      ? s.cwd.replace(homedir(), "~")
      : "(unknown)";
  const mapIcon = isMapped ? s.repo_icon || "📁" : "❓";
  const label = `🔄 ${mapIcon} ${displayName}${LABEL_SEP}`;
  const desc = truncate(s.topic || "", DESC_MAX);
  const badges = `[${formatSessionStamp(s.last_activity_at)}]`;
  const command = s.repo_command || "claude";
  return [
    label,
    desc,
    badges,
    `resume:${s.uuid}`,
    s.cwd,
    command,
  ].join("\t");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const flags = parseArgs(process.argv.slice(2));
  const paths = getPaths();
  // openDb() is called INSIDE the try so that a cold-start failure (state.db
  // missing before first scan) is caught and rendered as a friendly hint
  // instead of leaking a raw stack trace to fzf.
  let close: (() => void) | undefined;
  try {
    const handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
    const db = handle.db;
    close = handle.close;

    const lines: string[] = [];

    const wantRepos = !flags.sessionsOnly && !flags.currentOnly;
    const wantSessions = !flags.reposOnly;

    if (wantRepos) {
      const repos = db
        .prepare(
          `SELECT r.name, r.path, r.description, r.command, r.cwd, r.icon,
                  r.disabled, r.custom_json,
                  s.is_git, s.branch, s.uncommitted_insertions,
                  s.uncommitted_deletions, s.handoff_count, s.pending_count,
                  s.session_last_at
             FROM repos r
             LEFT JOIN repo_stats s ON s.name = r.name
            WHERE r.disabled = 0
            ORDER BY r.name COLLATE NOCASE ASC`,
        )
        .all() as RepoRowFull[];
      for (const r of repos) {
        lines.push(repoToRow(r));
      }
    }

    if (wantSessions) {
      const filterCwd = flags.currentOnly ? process.cwd() : null;
      const rows = db
        .prepare(
          `SELECT s.uuid, s.repo_name, s.cwd, s.last_activity_at, s.topic,
                  r.name AS repo_display, r.icon AS repo_icon, r.command AS repo_command
             FROM sessions s
             LEFT JOIN repos r ON r.name = s.repo_name
            ORDER BY s.last_activity_at DESC`,
        )
        .all() as SessionRowFull[];
      const sessionRows: string[] = [];
      for (const s of rows) {
        if (filterCwd && !(s.cwd === filterCwd || s.cwd.startsWith(filterCwd + "/"))) {
          continue;
        }
        sessionRows.push(sessionToRow(s));
      }
      // Insert a section separator between NEW repos and RESUME sessions
      // when both are present. The separator row uses KIND=separator so
      // bin/ccs recognises it and exits cleanly if the user selects it.
      if (lines.length > 0 && sessionRows.length > 0) {
        const bar = "─".repeat(20);
        const label = `\x1b[2m${bar}\x1b[0m \x1b[1;90m Past Sessions \x1b[0m\x1b[2m${bar}\x1b[0m`;
        lines.push([label, "", "", "separator:-", "", ""].join("\t"));
      }
      lines.push(...sessionRows);
    }

    process.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Cold-start case: state.db not yet built by the scanner.
    // better-sqlite3 surfaces ENOENT-style failures with "unable to open
    // database file" or similar; also guard against explicit "does not exist"
    // messaging that openDb() may raise in future.
    const isMissing =
      /unable to open database file/i.test(msg) ||
      /database (file )?does not exist/i.test(msg) ||
      /ENOENT/.test(msg);
    if (isMissing) {
      process.stderr.write(
        "[ccs-list] state.db not found. Run `ccs --refresh` first to build the cache.\n",
      );
    } else {
      process.stderr.write(`[ccs-list] fatal: ${msg}\n`);
    }
    return 1;
  } finally {
    // close may be undefined if openDb() itself threw before the destructure
    // completed, so guard against it.
    close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
