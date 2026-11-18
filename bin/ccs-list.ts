#!/usr/bin/env node
/**
 * ccs-list.ts — SQL-driven row builder for the ccs fzf launcher (v0.2.0)
 *
 * Outputs tab-separated rows for fzf consumption:
 *   <LABEL>\t<DESCRIPTION>\t<BADGES>\t<KIND>:<KEY>\t<CWD>\t<COMMAND>
 *
 * KIND is `new` (launchable repo), `group` (display-only header, repos.yml
 * `launch: false`), `resume` (past session) or `separator`.
 *
 * Modes:
 *   --current-only    sessions whose cwd matches CCS_CWD (else process.cwd())
 *   --repos-only      only NEW repo rows (and group headers)
 *   --sessions-only   only RESUME session rows
 *   (default)         NEW first (alpha, nested repos in a tree under their
 *                     parent), then RESUME (last_activity_at DESC)
 *
 * Look: groups (`launch: false` headers and what is inside them) first,
 * then the other projects, then past conversations, each under a heading row
 * (Japanese); the whole visible line lives in column 1 (fzf shows only that
 * column), column 3 stays empty.
 *
 *   --print-settings  print `update_check=<on|off>` as the last scan stored
 *                     it, then exit
 */

import { homedir } from "node:os";
import { openDb, getMeta, reposV3Columns } from "./ccs-db.ts";
import { groupsFromMeta } from "./ccs-groups.ts";
import { getPaths } from "./ccs-config.ts";
import { SHELL_METACHARS } from "./ccs-sanitize.ts";
import {
  truncate,
  formatFriendlyTime,
  repoDisplayName,
  findParentRepo,
  displayWidth,
  padDisplay,
  tildePath,
} from "./ccs-utils.ts";
import { pathToFileURL } from "node:url";
import { t } from "./ccs-i18n.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESC_MAX = 60;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Flags {
  currentOnly: boolean;
  reposOnly: boolean;
  sessionsOnly: boolean;
  printSettings: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    currentOnly: argv.includes("--current-only"),
    reposOnly: argv.includes("--repos-only"),
    sessionsOnly: argv.includes("--sessions-only"),
    printSettings: argv.includes("--print-settings"),
  };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface RepoRowFull {
  name: string;
  path: string;
  description: string;
  command: string;
  cwd: string | null;
  icon: string;
  disabled: number;
  scan_enabled: number;
  launch: number;
  label: string;
  lead: number;
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

// A child marked `lead: true` (the group's director / coordinator) comes
// first among its siblings; the rest keep name order. Top-level repos are
// never reordered — a lead only means something inside a group.
function leadFirst<T extends { lead?: number }>(kids: T[]): T[] {
  return [...kids.filter((k) => k.lead === 1), ...kids.filter((k) => k.lead !== 1)];
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

function isWellFormedRow(row: string): boolean {
  return row.split("\t").length === 6 && !/[\n\r\x1f]/.test(row);
}

// ---------------------------------------------------------------------------
// Row builders (the list's look)
// ---------------------------------------------------------------------------
//
// A 6-column TSV (bin/ccs reads KIND:KEY, CWD and COMMAND from columns 4-6
// and never the LABEL); the whole visible line lives in column 1 — bin/ccs
// shows only that column (`--with-nth=1`), and fzf can only search what it shows. That is why a
// row inside a group carries the group's name (dim, after the description):
// typing the group's name narrows the list to the group, its projects and
// their conversations.

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
/** Indent per nesting level. */
const SIMPLE_INDENT = "   ";
/** The description column starts here at most (longer names push it). */
const SIMPLE_NAME_COL_MAX = 34;
const SIMPLE_TIME_COL = 10;
const SIMPLE_PROJECT_COL_MAX = 26;

/** A heading row: KIND=separator, so Enter on it never launches anything. */
function simpleHeading(title: string): string {
  const bar = "─".repeat(8);
  const label = `${DIM}${bar}${RESET} ${BOLD}${title}${RESET} ${DIM}${bar}${RESET}`;
  return [label, "", "", "separator:-", "", ""].join("\t");
}

interface SimpleNode {
  repo: RepoRowFull;
  parent: RepoRowFull | null;
  depth: number;
}

/**
 * The nesting (findParentRepo, name order) flattened with depths,
 * split into the two simple sections: top-level `launch: false` headers with
 * everything under them, then every other top-level repo with its subtree.
 */
function simpleSections(repos: RepoRowFull[]): {
  groups: SimpleNode[];
  projects: SimpleNode[];
} {
  const children = new Map<RepoRowFull | null, RepoRowFull[]>();
  for (const r of repos) {
    const parent = findParentRepo(r, repos);
    const siblings = children.get(parent) ?? [];
    siblings.push(r);
    children.set(parent, siblings);
  }
  const walk = (
    node: RepoRowFull,
    parent: RepoRowFull | null,
    depth: number,
    out: SimpleNode[],
  ): void => {
    out.push({ repo: node, parent, depth });
    for (const kid of leadFirst(children.get(node) ?? [])) walk(kid, node, depth + 1, out);
  };
  const groups: SimpleNode[] = [];
  const projects: SimpleNode[] = [];
  for (const root of children.get(null) ?? []) {
    walk(root, null, 0, root.launch === 0 ? groups : projects);
  }
  return { groups, projects };
}

/** Marks a group's lead entry (repos.yml `lead: true`) in the list. */
const LEAD_ICON = "👑";

/**
 * The icon as drawn in the list: control characters stripped, a lead
 * shown as 👑, and always two columns wide — an emoji without emoji
 * presentation (🛰, ✍️, 🛠️) is one column for fzf and the terminal, and its
 * glyph would otherwise run into the name.
 */
function simpleIcon(repo: { icon: string; lead?: number }): string {
  const icon = repo.lead === 1 ? LEAD_ICON : truncate(repo.icon || "", 8) || "📁";
  return padDisplay(icon, 2);
}

function simpleHead(n: SimpleNode): string {
  return `${SIMPLE_INDENT.repeat(n.depth)}${simpleIcon(n.repo)} ${repoDisplayName(n.repo)}`;
}

function simpleRepoRow(n: SimpleNode, nameCol: number): string {
  const r = n.repo;
  const displayName = repoDisplayName(r);
  const head = simpleHead(n);
  const gap = " ".repeat(Math.max(0, nameCol - displayWidth(head)));
  // Bold only the name of a group header; the padding is computed on the
  // plain text, so the styling does not shift the description column.
  const styled =
    r.launch === 0
      ? `${SIMPLE_INDENT.repeat(n.depth)}${simpleIcon(r)} ${BOLD}${displayName}${RESET}${gap}`
      : `${head}${gap}`;
  const desc = truncate(r.description || "", DESC_MAX);
  const parentName = n.parent ? repoDisplayName(n.parent) : null;
  const hint =
    parentName && parentName !== displayName
      ? `  ${DIM}${t("list_parent_hint", { parent: parentName })}${RESET}`
      : "";
  const label = `${styled}  ${desc}${hint}`;
  if (r.launch === 0) {
    return [label, desc, "", `group:${r.name}`, r.path, ""].join("\t");
  }
  const cwd = r.cwd && r.cwd.length > 0 ? r.cwd : r.path;
  return [label, desc, "", `new:${r.name}`, cwd, r.command || "claude"].join("\t");
}

/** A logical group (defaults.groups_dir) with the listed repos it holds. */
interface LogicalView {
  id: string;
  label: string;
  members: RepoRowFull[];
}

/** Match the stored groups to the listed (enabled) repos; empty groups go. */
function logicalGroupsOf(
  groups: { id: string; label: string; members: string[] }[],
  repos: RepoRowFull[],
): LogicalView[] {
  const byName = new Map(repos.map((r) => [r.name, r]));
  return groups
    .map((g) => ({
      id: g.id,
      label: g.label,
      members: g.members.map((n) => byName.get(n)).filter((r): r is RepoRowFull => r !== undefined),
    }))
    .filter((g) => g.members.length > 0);
}

/** The icon of a logical group's header (not a repos.yml entry, so no icon of its own). */
const LOGICAL_ICON = "🗂";

/** Simple rows of a logical group: the bold header, then its members one level in. */
function simpleLogicalRows(g: LogicalView, nameCol: number): string[] {
  const head = `${padDisplay(LOGICAL_ICON, 2)} ${truncate(g.label, 40)}`;
  const gap = " ".repeat(Math.max(0, nameCol - displayWidth(head)));
  const styled = `${padDisplay(LOGICAL_ICON, 2)} ${BOLD}${truncate(g.label, 40)}${RESET}${gap}`;
  return [
    [`${styled}  `, "", "", `group:@${g.id}`, "", ""].join("\t"),
    ...g.members.map((r) => simpleRepoRow({ repo: r, parent: null, depth: 1 }, nameCol)),
  ];
}

function simpleRepoRows(repos: RepoRowFull[], logical: LogicalView[] = []): string[] {
  const { groups, projects } = simpleSections(repos);
  const all = [...groups, ...projects];
  const logicalHeads = logical.flatMap((g) => [
    `${padDisplay(LOGICAL_ICON, 2)} ${truncate(g.label, 40)}`,
    ...g.members.map((r) => simpleHead({ repo: r, parent: null, depth: 1 })),
  ]);
  const nameCol = Math.min(
    SIMPLE_NAME_COL_MAX,
    Math.max(0, ...all.map((n) => displayWidth(simpleHead(n))), ...logicalHeads.map(displayWidth)),
  );
  const lines: string[] = [];
  if (groups.length > 0 || logical.length > 0) {
    lines.push(simpleHeading(t("list_heading_groups")));
    for (const n of groups) lines.push(simpleRepoRow(n, nameCol));
    // After the launch: false headers.
    for (const g of logical) lines.push(...simpleLogicalRows(g, nameCol));
  }
  if (projects.length > 0) {
    lines.push(simpleHeading(t("list_heading_projects")));
    for (const n of projects) lines.push(simpleRepoRow(n, nameCol));
  }
  return lines;
}

interface RepoNameView {
  name: string;
  path: string;
  label: string;
  launch: number;
}

/**
 * "Studio・Web team" for a project inside a group, else its display
 * name — a seat's own label ("Director") repeats across groups. Unmapped
 * sessions show their cwd with $HOME as ~.
 */
function simpleProjectName(
  s: SessionRowFull,
  repos: Map<string, RepoNameView>,
  listed: RepoNameView[],
): string {
  const repo = s.repo_name ? repos.get(s.repo_name) : undefined;
  if (!repo) {
    return s.cwd
      ? truncate(tildePath(s.cwd, homedir()), SIMPLE_PROJECT_COL_MAX)
      : t("list_folder_unknown");
  }
  const own = repoDisplayName(repo);
  const parent = findParentRepo(repo, listed);
  const parentName = parent ? repoDisplayName(parent) : null;
  return parentName && parentName !== own ? t("list_project_in_parent", { parent: parentName, name: own }) : own;
}

function simpleSessionRows(
  sessions: SessionRowFull[],
  defaultCommand: string,
  repoViews: RepoNameView[],
): string[] {
  const byName = new Map(repoViews.map((r) => [r.name, r]));
  const projects = sessions.map((s) =>
    truncate(simpleProjectName(s, byName, repoViews), SIMPLE_PROJECT_COL_MAX),
  );
  const projectCol = Math.min(
    SIMPLE_PROJECT_COL_MAX,
    Math.max(0, ...projects.map(displayWidth)),
  );
  return sessions.map((s, i) => {
    const when = formatFriendlyTime(s.last_activity_at);
    const topic = truncate(s.topic || t("list_no_topic"), DESC_MAX);
    const label = `💬 ${padDisplay(when, SIMPLE_TIME_COL)}  ${padDisplay(projects[i], projectCol)}  ${topic}`;
    return [
      label,
      truncate(s.topic || "", DESC_MAX),
      "",
      `resume:${s.uuid}`,
      s.cwd,
      s.repo_command || defaultCommand,
    ].join("\t");
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `--print-settings`: what the last scan stored, as the pre-scan prints it
 * (`update_check=<on|off>`). Any failure prints the default (on): the
 * launcher must always get an answer it can use.
 */
function printSettings(stateDb: string): number {
  let updateCheck = "on";
  try {
    const handle = openDb(stateDb, { readonly: true, skipMigrate: true });
    try {
      if (getMeta(handle.db, "defaults_update_check") === "off") updateCheck = "off";
    } finally {
      handle.close();
    }
  } catch {
    // keep the defaults
  }
  process.stdout.write(`update_check=${updateCheck}\n`);
  return 0;
}

function main(): number {
  const flags = parseArgs(process.argv.slice(2));
  const paths = getPaths();
  if (flags.printSettings) return printSettings(paths.stateDb);
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
      // launch/label come from schema v3; reposV3Columns() synthesizes the
      // defaults when this readonly connection meets a v2 cache.
      const repos = db
        .prepare(
          `SELECT r.name, r.path, r.description, r.command, r.cwd, r.icon,
                  r.disabled, r.scan_enabled, ${reposV3Columns(db, "r")}, r.custom_json,
                  s.is_git, s.branch, s.uncommitted_insertions,
                  s.uncommitted_deletions, s.handoff_count, s.pending_count,
                  s.session_last_at
             FROM repos r
             LEFT JOIN repo_stats s ON s.name = r.name
            WHERE r.disabled = 0
            ORDER BY r.name COLLATE NOCASE ASC`,
        )
        .all() as RepoRowFull[];
      // defaults.groups_dir: logical groups the last scan matched to these
      // repos (none when the setting is off).
      const logical = logicalGroupsOf(groupsFromMeta(getMeta(db, "logical_groups")), repos);
      lines.push(...simpleRepoRows(repos, logical));
    }

    if (wantSessions) {
      // Launch-command fallback for unmapped sessions (review A-8), written
      // by ccs-scan at sync time. getMeta returns null on a schema-v1 cache
      // that predates the meta table — degrade to "claude". The metachar
      // check is display-side defense in depth: the value was validated at
      // config load, but this row is re-executed unquoted by bin/ccs.
      const metaCommand = getMeta(db, "defaults_command");
      const defaultCommand =
        metaCommand && !SHELL_METACHARS.test(metaCommand)
          ? metaCommand
          : "claude";

      // CCS_CWD: the folder ccs was run in (bin/ccs starts this module from
      // its own folder; see ccs-tsx.sh).
      const filterCwd = flags.currentOnly ? process.env.CCS_CWD || process.cwd() : null;
      const baseSelect = `SELECT s.uuid, s.repo_name, s.cwd, s.last_activity_at, s.topic,
                  r.name AS repo_display, r.icon AS repo_icon, r.command AS repo_command
             FROM sessions s
             LEFT JOIN repos r ON r.name = s.repo_name`;
      // --current-only filters in SQL so idx_sessions_cwd is usable
      // (review A-10). The prefix match is expressed as a half-open range
      // [cwd + "/", cwd + "0") — "0" is the code point after "/" — because
      // LIKE is case-insensitive by default and would bypass the index.
      const rows = (
        filterCwd
          ? db
              .prepare(
                `${baseSelect}
            WHERE s.cwd = ? OR (s.cwd >= ? AND s.cwd < ?)
            ORDER BY s.last_activity_at DESC`,
              )
              .all(filterCwd, filterCwd + "/", filterCwd + "0")
          : db
              .prepare(`${baseSelect}
            ORDER BY s.last_activity_at DESC`)
              .all()
      ) as SessionRowFull[];
      const sessionRows: string[] = [];
      // Labels and nesting for the project column (all enabled repos, the
      // same population as the list's tree).
      const repoViews = db
        .prepare(
          `SELECT r.name, r.path, ${reposV3Columns(db, "r")}
             FROM repos r WHERE r.disabled = 0
            ORDER BY r.name COLLATE NOCASE ASC`,
        )
        .all() as RepoNameView[];
      sessionRows.push(...simpleSessionRows(rows, defaultCommand, repoViews));
      // The conversations go under their own heading row (KIND=separator, so
      // bin/ccs moves off it and exits cleanly if it is ever picked).
      if (sessionRows.length > 0) {
        lines.push(simpleHeading(t("list_heading_sessions")));
      }
      lines.push(...sessionRows);
    }

    // Last check: bin/ccs takes the columns by position and runs column 6, so a
    // row of any other shape is dropped, never handed over.
    const rows = lines.filter(isWellFormedRow);
    if (rows.length !== lines.length) {
      process.stderr.write(`[ccs-list] skipped ${lines.length - rows.length} malformed row(s)\n`);
    }
    process.stdout.write(rows.join("\n") + (rows.length > 0 ? "\n" : ""));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Cold-start case: state.db not yet built by the scanner.
    // The readonly path in openDb() raises its own "[ccs-db] state.db not
    // found" message BEFORE better-sqlite3 ever runs (review C-5) — that
    // pattern must be matched here or the friendly hint below is dead code.
    // The better-sqlite3 native patterns stay as a guard for races where the
    // file disappears between the existsSync check and the open.
    const isMissing =
      /state\.db not found/i.test(msg) ||
      /unable to open database file/i.test(msg) ||
      /database (file )?does not exist/i.test(msg) ||
      /ENOENT/.test(msg);
    if (isMissing) {
      process.stderr.write(
        `${t("list_no_cache")}\n`,
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

// pathToFileURL, not `file://${argv[1]}`: a folder with a space (or any
// character a URL escapes) in its name would never match.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // exitCode, not process.exit(): stdout is a pipe into fzf, and pipe writes
  // are async on macOS. Exiting right after the write dropped everything past
  // the pipe buffer — as little as 512 bytes, so the list ended after 3 repos
  // (2026-10-07). Returning lets Node flush the whole list first.
  //
  // The flip side: fzf may exit (pick / Esc) before reading every row, and
  // the pending write then fails with EPIPE. Those rows have no reader, so
  // end quietly with main()'s status — an unhandled EPIPE would print a stack
  // trace and exit 1, which pipefail in bin/ccs turns into a dropped launch.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw err;
  });
  process.exitCode = main();
}
