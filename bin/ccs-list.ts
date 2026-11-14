#!/usr/bin/env tsx
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
 * Look (`--ui=`):
 *   classic (default) the rows above, byte-for-byte as before v0.3.0
 *   simple            the friendly look (Japanese): groups (`launch: false`
 *                     headers and what is inside them) first, then the other
 *                     projects, then past conversations, each under a heading
 *                     row; no badge column, no tree glyphs, plain-word times
 *
 *   --print-ui        print the `defaults.ui` the last scan stored, then exit
 *   --print-settings  print `ui=<mode>` and `update_check=<on|off>` as the
 *                     last scan stored them, then exit
 */

import { homedir } from "node:os";
import { openDb, getMeta, reposV3Columns } from "./ccs-db.ts";
import { groupsFromMeta } from "./ccs-groups.ts";
import { getPaths } from "./ccs-config.ts";
import { SHELL_METACHARS } from "./ccs-sanitize.ts";
import {
  displayIcon,
  truncate,
  formatRelativeTime,
  formatDateTime,
  formatFriendlyTime,
  repoDisplayName,
  findParentRepo,
  displayWidth,
  padDisplay,
  tildePath,
  isUiMode,
  uiFromArgv,
  type UiMode,
} from "./ccs-utils.ts";
import { pathToFileURL } from "node:url";

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
  ui: UiMode;
  printUi: boolean;
  printSettings: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    currentOnly: argv.includes("--current-only"),
    reposOnly: argv.includes("--repos-only"),
    sessionsOnly: argv.includes("--sessions-only"),
    ui: uiFromArgv(argv),
    printUi: argv.includes("--print-ui"),
    printSettings: argv.includes("--print-settings"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// truncate / formatRelativeTime / formatDateTime come from ccs-utils.ts —
// the single source shared with the preview pane (review A-1/A-3/K-8), so
// list badges and preview text can no longer drift in thresholds or language.

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

function buildRepoBadges(r: RepoRowFull): string {
  const badges: string[] = [];

  // scan: false repos keep their last-scanned stats forever — flag the
  // staleness so the user doesn't read a frozen badge as current state
  // (audit logic M-2).
  if (r.scan_enabled === 0) {
    badges.push(`[scan off]`);
  }

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
    const ht = formatRelativeTime(r.session_last_at, "");
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

interface GroupedRepo {
  repo: RepoRowFull;
  parent: RepoRowFull | null;
  /** Tree glyphs drawn before the icon ("" at the top level). */
  prefix: string;
}

// Nest each repo under the listed repo whose path most deeply contains its
// own — the same deepest-path-wins rule buildRepoResolver uses for sessions
// (findParentRepo), so no repos.yml key is needed. Children follow their
// parent, siblings keep the incoming (SQL, name-sorted) order. A disabled
// parent is not in the list, so its children move up to the next listed
// ancestor (or the top level).
//
// Children are drawn as a tree: `├ ` for a sibling with more after it, `└ `
// for the last one, and for every ancestor level below the top a `│ ` rail
// while that ancestor still has later siblings (blank once it was the last).
//
// A child marked `lead: true` (the group's director / coordinator) comes
// first among its siblings; the rest keep name order. Top-level repos are
// never reordered — a lead only means something inside a group.
function leadFirst<T extends { lead?: number }>(kids: T[]): T[] {
  return [...kids.filter((k) => k.lead === 1), ...kids.filter((k) => k.lead !== 1)];
}

function groupRepos(repos: RepoRowFull[]): GroupedRepo[] {
  const children = new Map<RepoRowFull | null, RepoRowFull[]>();
  for (const r of repos) {
    const parent = findParentRepo(r, repos);
    const siblings = children.get(parent) ?? [];
    siblings.push(r);
    children.set(parent, siblings);
  }
  const out: GroupedRepo[] = [];
  const walk = (parent: RepoRowFull | null, rails: string): void => {
    const kids = parent ? leadFirst(children.get(parent) ?? []) : (children.get(parent) ?? []);
    kids.forEach((r, i) => {
      const last = i === kids.length - 1;
      const prefix = parent ? `  ${rails}${last ? "└ " : "├ "}` : "";
      out.push({ repo: r, parent, prefix });
      // Top-level repos draw no glyph of their own, so they add no rail.
      walk(r, parent ? rails + (last ? "  " : "│ ") : "");
    });
  };
  walk(null, "");
  return out;
}

function repoToRow({ repo: r, parent, prefix }: GroupedRepo): string {
  // Rows show the repos.yml `label` when set (repoDisplayName); `name` stays
  // the row key. The dim ‹parent› suffix keeps the relation readable when a
  // fzf query hides the parent row, and lets a query for the parent's name
  // match its children too. It is dropped when it would only repeat the
  // row's own name (an entry labelled `Studio` under a `Studio` header).
  const displayName = repoDisplayName(r);
  const parentName = parent ? repoDisplayName(parent) : null;
  const parentHint =
    parentName && parentName !== displayName
      ? `  \x1b[2m‹${parentName}›\x1b[0m`
      : "";
  const label = `${prefix}${displayIcon(r.icon)} ${displayName}${parentHint}${LABEL_SEP}`;
  const desc = truncate(r.description || "", DESC_MAX);
  if (r.launch === 0) {
    // Group header (`launch: false`): display-only, so no badges (the header
    // is not scanned) and no COMMAND. CWD carries the path for ^I and the
    // preview; bin/ccs never launches a `group:` row.
    return [label, desc, "", `group:${r.name}`, r.path, ""].join("\t");
  }
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

function isWellFormedRow(row: string): boolean {
  return row.split("\t").length === 6 && !/[\n\r\x1f]/.test(row);
}

function sessionToRow(s: SessionRowFull, defaultCommand: string): string {
  // Mapped sessions use the registered repo icon + name — the unique `name`,
  // deliberately not the repos.yml `label`, so session rows read the same as
  // before labels existed.
  // Unmapped sessions get ❓ as a visible reminder: either a one-off run
  // or a repo that hasn't been added to repos.yml yet.
  // Ternary tests s.repo_display directly so TS narrows string|null → string
  // without a non-null assertion.
  // Unmapped sessions fall back to showing their cwd. That value is gated at
  // scan time, but route it through truncate() anyway so the label column
  // gets the same control-char stripping as every other column (audit NEW-1
  // defense-in-depth; fzf renders this column with --ansi).
  const displayName = s.repo_display
    ? s.repo_display
    : s.cwd
      ? truncate(s.cwd.replace(homedir(), "~"), DESC_MAX)
      : "(unknown)";
  const mapIcon = s.repo_display ? displayIcon(s.repo_icon) : "❓";
  const label = `🔄 ${mapIcon} ${displayName}${LABEL_SEP}`;
  const desc = truncate(s.topic || "", DESC_MAX);
  const badges = `[${formatDateTime(s.last_activity_at)}]`;
  // Unmapped sessions fall back to the scan-time resolved default
  // (defaults.command > CCS_CMD > "claude"), not a hardcoded "claude" — the
  // documented priority chain applies to every launchable row (review A-8).
  const command = s.repo_command || defaultCommand;
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
// ui: simple — row builders
// ---------------------------------------------------------------------------
//
// Same 6-column TSV contract as the classic rows (bin/ccs reads KIND:KEY, CWD
// and COMMAND from columns 4-6 and never the LABEL), but the whole visible
// line lives in column 1 — bin/ccs shows only that column in the simple look
// (`--with-nth=1`), and fzf can only search what it shows. That is why a
// row inside a group carries the group's name (dim, after the description):
// typing the group's name narrows the list to the group, its projects and
// their conversations.

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
/** Indent per nesting level, in place of the classic tree glyphs. */
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
 * The classic nesting (findParentRepo, name order) flattened with depths,
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

/** Marks a group's lead entry (repos.yml `lead: true`) in the simple look. */
const LEAD_ICON = "👑";

/**
 * The icon as drawn in the simple look: control characters stripped, a lead
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
      ? `  ${DIM}（${parentName}）${RESET}`
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

/**
 * Classic rows of the logical groups: a display-only header (KIND=group, key
 * `@<id>`, so the preview looks in the logical groups first) and the members
 * under it, drawn as a tree.
 */
function logicalGroupRows(groups: LogicalView[]): string[] {
  const lines: string[] = [];
  for (const g of groups) {
    const label = `${displayIcon(LOGICAL_ICON)} ${truncate(g.label, 40)}${LABEL_SEP}`;
    lines.push([label, "", "", `group:@${g.id}`, "", ""].join("\t"));
    g.members.forEach((r, i) => {
      const last = i === g.members.length - 1;
      lines.push(repoToRow({ repo: r, parent: null, prefix: `  ${last ? "└ " : "├ "}` }));
    });
  }
  return lines;
}

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
    lines.push(simpleHeading("グループ"));
    for (const n of groups) lines.push(simpleRepoRow(n, nameCol));
    // After the launch: false headers.
    for (const g of logical) lines.push(...simpleLogicalRows(g, nameCol));
  }
  if (projects.length > 0) {
    lines.push(simpleHeading("プロジェクト"));
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
      : "（フォルダ不明）";
  }
  const own = repoDisplayName(repo);
  const parent = findParentRepo(repo, listed);
  const parentName = parent ? repoDisplayName(parent) : null;
  return parentName && parentName !== own ? `${parentName}・${own}` : own;
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
    const topic = truncate(s.topic || "（話題なし）", DESC_MAX);
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
 * `--print-ui`: the `defaults.ui` the last scan stored (meta table). Any
 * failure — no cache yet, a cache older than the setting, an unknown value —
 * prints "classic": the launcher must always get an answer it can use.
 */
function printUi(stateDb: string): number {
  let ui: UiMode = "classic";
  try {
    const handle = openDb(stateDb, { readonly: true, skipMigrate: true });
    try {
      const v = getMeta(handle.db, "defaults_ui");
      if (isUiMode(v)) ui = v;
    } finally {
      handle.close();
    }
  } catch {
    // keep classic
  }
  process.stdout.write(`${ui}\n`);
  return 0;
}

/**
 * `--print-settings`: what the last scan stored, as the pre-scan prints it
 * (`ui=<mode>` and `update_check=<on|off>`). Any failure prints the defaults
 * (classic, on): the launcher must always get an answer it can use.
 */
function printSettings(stateDb: string): number {
  let ui: UiMode = "classic";
  let updateCheck = "on";
  try {
    const handle = openDb(stateDb, { readonly: true, skipMigrate: true });
    try {
      const v = getMeta(handle.db, "defaults_ui");
      if (isUiMode(v)) ui = v;
      if (getMeta(handle.db, "defaults_update_check") === "off") updateCheck = "off";
    } finally {
      handle.close();
    }
  } catch {
    // keep the defaults
  }
  process.stdout.write(`ui=${ui}\nupdate_check=${updateCheck}\n`);
  return 0;
}

function main(): number {
  const flags = parseArgs(process.argv.slice(2));
  const paths = getPaths();
  if (flags.printUi) return printUi(paths.stateDb);
  if (flags.printSettings) return printSettings(paths.stateDb);
  const simple = flags.ui === "simple";
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
      if (simple) {
        lines.push(...simpleRepoRows(repos, logical));
      } else {
        for (const g of groupRepos(repos)) {
          lines.push(repoToRow(g));
        }
        // After every project row, before the conversations.
        lines.push(...logicalGroupRows(logical));
      }
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
      if (simple) {
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
      } else {
        for (const s of rows) {
          sessionRows.push(sessionToRow(s, defaultCommand));
        }
      }
      // Insert a section separator between NEW repos and RESUME sessions
      // when both are present. The separator row uses KIND=separator so
      // bin/ccs recognises it and exits cleanly if the user selects it.
      // Guard uses the explicit wantRepos flag (not lines.length) so future
      // additions to `lines` before this block can't spuriously trigger it.
      if (simple && sessionRows.length > 0) {
        lines.push(simpleHeading("前の会話のつづき"));
      } else if (wantRepos && sessionRows.length > 0) {
        const bar = "─".repeat(20);
        const label = `\x1b[2m${bar}\x1b[0m \x1b[1;90m Past Sessions \x1b[0m\x1b[2m${bar}\x1b[0m`;
        lines.push([label, "", "", "separator:-", "", ""].join("\t"));
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
