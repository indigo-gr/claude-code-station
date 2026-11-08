#!/usr/bin/env tsx
/**
 * ccs-preview.ts — fzf preview pane dispatcher for ccs v0.2.0
 *
 * Invoked by fzf as: tsx bin/ccs-preview.ts <KIND:KEY> <CWD>
 *   KIND=new     → render repo preview (DB-backed state summary)
 *   KIND=group   → render group-header preview (path + nested entries)
 *   KIND=resume  → delegate to renderSessionPreview (conversation history)
 *
 * An optional third argument `--ui=simple` draws the friendly "card" for each
 * kind instead (Japanese, plain words, no git/handoff jargon in the headings).
 *
 * All errors print to stdout (fzf reads stdout for preview) and exit 0.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import { getPaths } from "./ccs-config.ts";
import { openDb, reposV3Columns, type DbHandle } from "./ccs-db.ts";
import { renderSessionPreview } from "./ccs-preview-session.ts";
import {
  displayIcon,
  formatRelativeTime,
  formatDateTime,
  formatFriendlyTime,
  truncate,
  repoDisplayName,
  findParentRepo,
  tildePath,
  uiFromArgv,
} from "./ccs-utils.ts";
import { stripControlChars, stripControlCharsKeepLines } from "./ccs-sanitize.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  headerName: "\x1b[1;36m", // bold cyan
  divider: "\x1b[1;90m",     // bold gray
};

function hdr(name: string): string {
  return `${C.headerName}${name}${C.reset}`;
}
function dim(s: string): string {
  return `${C.dim}${s}${C.reset}`;
}
function label(s: string): string {
  return `${C.bold}${s}${C.reset}`;
}
function divider(title: string): string {
  // ─── Title ──── (bold gray)
  const base = `─── ${title} `;
  const pad = Math.max(0, 40 - base.length);
  return `${C.divider}${base}${"─".repeat(pad)}${C.reset}`;
}

// Time formatting and truncation come from ccs-utils.ts — the single source
// shared with the list renderer (review A-1/A-3/K-8). Unparseable timestamps
// render as "-" (the utils default), never as the raw DB string.

// ---------------------------------------------------------------------------
// DB row types (narrow views)
// ---------------------------------------------------------------------------

interface RepoView {
  name: string;
  path: string;
  description: string;
  icon: string;
  label: string;
  lead?: number;
  tags_json: string;
  custom_json: string;
}

interface GroupMemberView {
  name: string;
  path: string;
  description: string;
  icon: string;
  launch: number;
  label: string;
  lead?: number;
}

/** A group's lead entry (`lead: true`) first, the rest in their given order — as in the list. */
function leadFirst<T extends { lead?: number }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.lead === 1), ...rows.filter((r) => r.lead !== 1)];
}

interface StatsView {
  is_git: number;
  branch: string | null;
  last_commit_hash: string | null;
  last_commit_subject: string | null;
  last_commit_at: string | null;
  uncommitted_files: number;
  uncommitted_insertions: number;
  uncommitted_deletions: number;
  handoff_count: number;
  pending_count: number;
  claude_room_latest: string | null;
  claude_room_latest_at: string | null;
  session_count_total: number;
  session_last_at: string | null;
}

interface FileRow {
  filename: string;
  mtime: string;
}

interface SessionRow {
  last_activity_at: string;
  topic: string | null;
}

// ---------------------------------------------------------------------------
// Integrations rendering
// ---------------------------------------------------------------------------

const KNOWN_INTEGRATIONS: { key: string; label: string; format?: (v: string) => string }[] = [
  { key: "plane_project_id", label: "Plane" },
  { key: "attio_workspace", label: "Attio" },
  { key: "notion_db", label: "Notion" },
  { key: "linear_team", label: "Linear" },
  {
    key: "slack_channel",
    label: "Slack",
    format: (v) => (v.startsWith("#") ? v : `#${v}`),
  },
  { key: "github_repo", label: "GitHub" },
  { key: "figma_file", label: "Figma" },
];
const KNOWN_KEYS = new Set(KNOWN_INTEGRATIONS.map((i) => i.key));
// Secondary keys that exist only to augment known ones — not shown standalone
const AUX_KEYS = new Set(["plane_url"]);

function renderIntegrations(customJson: string): string[] {
  let custom: Record<string, unknown>;
  try {
    custom = JSON.parse(customJson || "{}");
  } catch {
    return [];
  }
  const keys = Object.keys(custom).filter((k) => !AUX_KEYS.has(k));
  if (keys.length === 0) return [];

  const lines: string[] = [];
  lines.push(divider("🔗 Integrations"));

  for (const { key, label: lbl, format } of KNOWN_INTEGRATIONS) {
    if (!(key in custom)) continue;
    const raw = custom[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const val = format ? format(String(raw)) : String(raw);
    lines.push(`  ${label(lbl + ":").padEnd(10)} ✅ ${truncate(val, 50)}`);
  }

  const unknown = keys.filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    lines.push(`  ${label("Other:")}`);
    for (const k of unknown) {
      const v = custom[k];
      if (v === null || v === undefined) continue;
      const vs = typeof v === "string" ? v : JSON.stringify(v);
      lines.push(`    ${k}: ${truncate(vs, 40)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Repo preview
// ---------------------------------------------------------------------------

function renderRepoPreview(name: string, cwd: string): void {
  const paths = getPaths();
  if (!existsSync(paths.stateDb)) {
    console.log(`${hdr("📁 " + name)}`);
    console.log(dim(cwd || ""));
    console.log("");
    console.log("No state cache yet — run `ccs --refresh` to scan.");
    return;
  }

  let handle: DbHandle | null = null;
  try {
    handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
    const db = handle.db;

    const repo = db
      .prepare(
        `SELECT name, path, description, icon, tags_json, custom_json,
                ${reposV3Columns(db)}
         FROM repos WHERE name = ?`,
      )
      .get(name) as RepoView | undefined;

    if (!repo) {
      console.log(`${hdr("📁 " + name)}`);
      console.log(dim(cwd || ""));
      console.log("");
      console.log(`Repo "${name}" not found in cache.`);
      return;
    }

    const stats = db
      .prepare(
        `SELECT is_git, branch, last_commit_hash, last_commit_subject, last_commit_at,
                uncommitted_files, uncommitted_insertions, uncommitted_deletions,
                handoff_count, pending_count, claude_room_latest, claude_room_latest_at,
                session_count_total, session_last_at
         FROM repo_stats WHERE name = ?`,
      )
      .get(name) as StatsView | undefined;

    // --- Header ---
    // Titled with the repos.yml `label` like the list row; when one is set,
    // the dim `name` after it ties the entry to its session rows, which keep
    // showing the name.
    const displayName = repoDisplayName(repo);
    const nameHint = displayName !== repo.name ? `  ${dim(`(${repo.name})`)}` : "";
    console.log(`${hdr(`${displayIcon(repo.icon)} ${displayName}`)}${nameHint}`);
    console.log(dim(repo.path));
    if (repo.description) console.log(stripControlCharsKeepLines(repo.description));
    console.log("");

    // --- Git ---
    if (stats && stats.is_git === 1) {
      console.log(divider("Git"));
      const branch = stats.branch || "(detached)";
      console.log(`${label("Branch:".padEnd(14))} ${branch}`);
      if (stats.last_commit_hash) {
        const rel = formatRelativeTime(stats.last_commit_at);
        const shortHash = stats.last_commit_hash.slice(0, 7);
        const subj = truncate(stats.last_commit_subject || "", 60);
        console.log(`${label("Last commit:".padEnd(14))} ${rel}`);
        console.log(`${"".padEnd(14)}   ${shortHash} ${subj}`);
      }
      const f = stats.uncommitted_files;
      if (f === 0 && stats.uncommitted_insertions === 0 && stats.uncommitted_deletions === 0) {
        console.log(`${label("Uncommitted:".padEnd(14))} clean`);
      } else {
        console.log(
          `${label("Uncommitted:".padEnd(14))} ${f} file(s) (+${stats.uncommitted_insertions} -${stats.uncommitted_deletions})`,
        );
      }
      console.log("");
    }

    // --- Workspace (handoff / pending / claude-room) ---
    if (
      stats &&
      (stats.handoff_count > 0 ||
        stats.pending_count > 0 ||
        stats.claude_room_latest)
    ) {
      console.log(divider("Workspace"));

      if (stats.handoff_count > 0) {
        console.log(`${label("Handoff:".padEnd(14))} ⚠️  ${stats.handoff_count} file(s)`);
        const rows = db
          .prepare(
            `SELECT filename, mtime FROM handoff_files
             WHERE repo_name = ? ORDER BY mtime DESC LIMIT 3`,
          )
          .all(name) as FileRow[];
        for (const r of rows) {
          console.log(`  • ${truncate(r.filename, 50)} (${formatRelativeTime(r.mtime)})`);
        }
      }

      if (stats.pending_count > 0) {
        console.log(`${label("Pending:".padEnd(14))} 📝 ${stats.pending_count} item(s)`);
        const rows = db
          .prepare(
            `SELECT filename, mtime FROM pending_items
             WHERE repo_name = ? ORDER BY mtime DESC LIMIT 3`,
          )
          .all(name) as FileRow[];
        for (const r of rows) {
          console.log(`  • ${truncate(r.filename, 50)} (${formatRelativeTime(r.mtime)})`);
        }
      }

      if (stats.claude_room_latest) {
        const latest = truncate(stats.claude_room_latest, 40);
        const when = formatRelativeTime(stats.claude_room_latest_at);
        console.log(`${label("Claude room:".padEnd(14))} latest: ${latest} (${when})`);
      }
      console.log("");
    }

    // --- Sessions ---
    console.log(divider("Sessions"));
    if (!stats || stats.session_count_total === 0) {
      console.log("No sessions yet — ready to start");
    } else {
      console.log(`${label("Total:".padEnd(14))} ${stats.session_count_total} sessions`);
      console.log(`${label("Last activity:".padEnd(14))} ${formatRelativeTime(stats.session_last_at)}`);
      // Same population as the Total count above (repo_stats aggregates
      // WHERE repo_name = ?) — mixing in a cwd fallback here made Total and
      // Recent disagree (audit logic H-3). Sessions under the repo path are
      // mapped to repo_name at scan time, including subdirectories.
      const rows = db
        .prepare(
          `SELECT last_activity_at, topic FROM sessions
           WHERE repo_name = ?
           ORDER BY last_activity_at DESC LIMIT 3`,
        )
        .all(name) as SessionRow[];
      if (rows.length > 0) {
        console.log(label("Recent:"));
        for (const r of rows) {
          const dt = formatDateTime(r.last_activity_at);
          const topic = truncate(r.topic || "(no topic)", 50);
          console.log(`  • ${dt} — ${topic}`);
        }
      }
    }
    console.log("");

    // --- Integrations ---
    const intLines = renderIntegrations(repo.custom_json || "{}");
    if (intLines.length > 0) {
      for (const line of intLines) console.log(line);
      console.log("");
    }

    // --- Tags ---
    try {
      const tags = JSON.parse(repo.tags_json || "[]") as unknown;
      if (Array.isArray(tags) && tags.length > 0) {
        console.log(divider("Tags"));
        console.log(tags.map((t) => stripControlChars(String(t))).join(", "));
      }
    } catch {
      // ignore
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${hdr("📁 " + name)}`);
    console.log("");
    console.log(`Preview error: ${msg}`);
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Group-header preview (repos.yml `launch: false`)
// ---------------------------------------------------------------------------

function renderGroupPreview(name: string, cwd: string): void {
  const paths = getPaths();
  if (!existsSync(paths.stateDb)) {
    console.log(`${hdr("📁 " + name)}`);
    console.log(dim(cwd || ""));
    console.log("");
    console.log("No state cache yet — run `ccs --refresh` to scan.");
    return;
  }

  let handle: DbHandle | null = null;
  try {
    handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
    const db = handle.db;

    // The listed (enabled) repos, in list order: children are resolved with
    // the same findParentRepo rule over the same population as ccs-list, so
    // the entries here are exactly the rows drawn under the header.
    const listed = db
      .prepare(
        `SELECT name, path, description, icon, ${reposV3Columns(db)}
         FROM repos WHERE disabled = 0
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as GroupMemberView[];
    const group = listed.find((r) => r.name === name);

    if (!group) {
      console.log(`${hdr("📁 " + name)}`);
      console.log(dim(cwd || ""));
      console.log("");
      console.log(`Group "${name}" not found in cache.`);
      return;
    }

    console.log(`${hdr(`${displayIcon(group.icon)} ${repoDisplayName(group)}`)}`);
    console.log(dim(group.path));
    if (group.description) console.log(truncate(group.description, 200));
    console.log("");

    console.log(divider("Group"));
    console.log("Group header (launch: false) — not launchable.");
    console.log("Pick one of the entries below to start a session.");
    console.log("");

    const entries = leadFirst(
      listed.filter((r) => r !== group && findParentRepo(r, listed) === group),
    );
    console.log(divider(`Entries (${entries.length})`));
    if (entries.length === 0) {
      console.log("No repos inside this path yet.");
      return;
    }
    const names = entries.map((r) => repoDisplayName(r));
    const width = Math.max(...names.map((n) => n.length));
    entries.forEach((r, i) => {
      const rel = truncate(relative(group.path, r.path), 60) + "/";
      const tag = r.launch === 0 ? `  ${dim("(group)")}` : "";
      console.log(`  ${displayIcon(r.icon)} ${names[i].padEnd(width)}  ${dim(rel)}${tag}`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${hdr("📁 " + name)}`);
    console.log("");
    console.log(`Preview error: ${msg}`);
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// ui: simple — cards
// ---------------------------------------------------------------------------
//
// One voice for every card: what Enter will do first, then the few facts a
// person needs to pick (folder, when it was last used, unsaved changes, notes
// left behind), then the Enter line again. No git/cache vocabulary in the
// headings; anything that went wrong is one sentence that says what to do.

function cardTitle(s: string): void {
  console.log("");
  console.log(`  ${C.bold}${s}${C.reset}`);
  console.log("");
}

function cardField(icon: string, name: string, values: string[]): void {
  console.log(`  ${icon} ${C.bold}${name}${C.reset}`);
  for (const v of values) console.log(`     ${v}`);
}

function cardFooter(s: string): void {
  console.log("");
  console.log(`  ${C.headerName}${s}${C.reset}`);
}

function cardNotice(lines: string[]): void {
  console.log("");
  for (const l of lines) console.log(`  ${l}`);
}

/** Integration display names, same table as the classic preview. */
function integrationNames(customJson: string): string[] {
  let custom: Record<string, unknown>;
  try {
    custom = JSON.parse(customJson || "{}");
  } catch {
    return [];
  }
  return KNOWN_INTEGRATIONS.filter(({ key }) => {
    const v = custom[key];
    return v !== null && v !== undefined && v !== "";
  }).map(({ label: l }) => l);
}

const NO_CACHE_LINES = [
  "まだ一覧の準備ができていません。",
  "いちど Esc でやめて、ccs --refresh と打ってください。",
];

function withDb(fn: (db: DbHandle["db"]) => void): void {
  const paths = getPaths();
  if (!existsSync(paths.stateDb)) {
    cardNotice(NO_CACHE_LINES);
    return;
  }
  let handle: DbHandle | null = null;
  try {
    handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
    fn(handle.db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cardNotice([
      "ここに中身を出せませんでした。Enter で開くことはできます。",
      dim(truncate(msg, 120)),
    ]);
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore
    }
  }
}

function renderSimpleRepoCard(name: string, cwd: string): void {
  withDb((db) => {
    const repo = db
      .prepare(
        `SELECT name, path, description, icon, tags_json, custom_json,
                ${reposV3Columns(db)}
         FROM repos WHERE name = ?`,
      )
      .get(name) as RepoView | undefined;
    if (!repo) {
      cardNotice([
        `「${truncate(name, 40)}」はまだ一覧に入っていません。`,
        "Esc でやめて、ccs --refresh と打ってください。",
      ]);
      return;
    }
    const stats = db
      .prepare(
        `SELECT is_git, branch, uncommitted_files, uncommitted_insertions,
                uncommitted_deletions, handoff_count, pending_count,
                session_last_at
         FROM repo_stats WHERE name = ?`,
      )
      .get(name) as Partial<StatsView> | undefined;
    const home = homedir();
    const folder = cwd || repo.path;
    const folderExists = folder ? existsSync(folder) : false;

    cardTitle(`✨ ${repoDisplayName(repo)} で、新しく Claude Code を始めます`);
    if (repo.lead === 1) {
      console.log("  👑 このグループの統括です");
      console.log("");
    }
    if (repo.description) {
      console.log(`  ${truncate(repo.description, 200)}`);
      console.log("");
    }

    cardField("📂", "フォルダ", [tildePath(truncate(folder, 200), home)]);
    if (!folderExists) {
      console.log(`     ⚠️  このフォルダが見つかりません。repos.yml の path を確かめてください`);
    }
    cardField("🕒", "最後に開いた", [
      stats?.session_last_at
        ? formatFriendlyTime(stats.session_last_at, { clock: true })
        : "まだ開いたことはありません",
    ]);

    if (stats && stats.is_git === 1) {
      const files = stats.uncommitted_files ?? 0;
      const changed =
        files > 0 ||
        (stats.uncommitted_insertions ?? 0) > 0 ||
        (stats.uncommitted_deletions ?? 0) > 0;
      const values = [
        changed
          ? `まだ保存（commit）していない変更が ${files} ファイルあります`
          : "保存していない変更はありません",
      ];
      const branch = stats.branch ?? "";
      if (branch && branch !== "main" && branch !== "master") {
        values.push(dim(`作業中のブランチ: ${truncate(branch, 60)}`));
      }
      cardField("📝", "変更", values);
    }
    if ((stats?.handoff_count ?? 0) > 0) {
      cardField("📌", "申し送り", [`${stats?.handoff_count} 件あります（前の作業からのメモ）`]);
    }
    if ((stats?.pending_count ?? 0) > 0) {
      cardField("🗒 ", "あとでやること", [`${stats?.pending_count} 件あります`]);
    }
    const services = integrationNames(repo.custom_json || "{}");
    if (services.length > 0) {
      cardField("🔗", "つながっているサービス", [services.join("・")]);
    }

    const recent = db
      .prepare(
        `SELECT last_activity_at, topic FROM sessions
         WHERE repo_name = ?
         ORDER BY last_activity_at DESC LIMIT 3`,
      )
      .all(name) as SessionRow[];
    if (recent.length > 0) {
      cardField(
        "💭",
        "最近の話題",
        recent.map(
          (r) =>
            `・${formatFriendlyTime(r.last_activity_at)}  ${truncate(r.topic || "（話題なし）", 50)}`,
        ),
      );
    }

    cardFooter(
      folderExists
        ? "Enter を押すと、このフォルダで Claude Code が開きます"
        : "Enter を押すと、いまいるフォルダで Claude Code が開きます",
    );
  });
}

function renderSimpleGroupCard(name: string): void {
  withDb((db) => {
    const listed = db
      .prepare(
        `SELECT name, path, description, icon, ${reposV3Columns(db)}
         FROM repos WHERE disabled = 0
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as GroupMemberView[];
    const group = listed.find((r) => r.name === name);
    if (!group) {
      cardNotice([
        `「${truncate(name, 40)}」はまだ一覧に入っていません。`,
        "Esc でやめて、ccs --refresh と打ってください。",
      ]);
      return;
    }
    cardTitle(`📂 グループ「${repoDisplayName(group)}」`);
    if (group.description) {
      console.log(`  ${truncate(group.description, 200)}`);
      console.log("");
    }
    console.log("  ここは見出しです。開くときは、下のプロジェクトをえらんでください");
    console.log("");

    const entries = leadFirst(
      listed.filter((r) => r !== group && findParentRepo(r, listed) === group),
    );
    if (entries.length === 0) {
      console.log("  このグループには、まだプロジェクトがありません");
      return;
    }
    cardField(
      "🗂 ",
      `中のプロジェクト（${entries.length}）`,
      entries.map((r) => {
        const desc = r.description ? `  ${dim(truncate(r.description, 40))}` : "";
        const tag =
          r.launch === 0
            ? `  ${dim("（グループ）")}`
            : r.lead === 1
              ? `  ${dim("（統括）")}`
              : "";
        const icon = r.lead === 1 ? "👑" : truncate(r.icon || "", 8) || "📁";
        return `${icon} ${repoDisplayName(r)}${desc}${tag}`;
      }),
    );
  });
}

interface SessionCardView {
  cwd: string;
  last_activity_at: string;
  topic: string | null;
  repo_name: string | null;
  repo_label: string | null;
}

async function renderSimpleSessionCard(uuid: string): Promise<void> {
  let row: SessionCardView | undefined;
  withDb((db) => {
    row = db
      .prepare(
        `SELECT cwd, last_activity_at, topic, repo_name, NULL AS repo_label
           FROM sessions WHERE uuid = ?`,
      )
      .get(uuid) as SessionCardView | undefined;
    if (row && row.repo_name) {
      const r = db
        .prepare(`SELECT name, ${reposV3Columns(db)} FROM repos WHERE name = ?`)
        .get(row.repo_name) as { name: string; label: string } | undefined;
      row.repo_label = r ? repoDisplayName(r) : null;
    }
  });
  if (!row) {
    // withDb already printed the reason when the cache itself is missing.
    if (existsSync(getPaths().stateDb)) {
      cardNotice([
        "この会話はまだ一覧に入っていません。",
        "Enter で開くことはできます。",
      ]);
    }
    return;
  }
  const home = homedir();
  cardTitle("↩️  前の会話のつづきから再開します");
  if (row.repo_label) cardField("🏷 ", "プロジェクト", [row.repo_label]);
  cardField("📂", "フォルダ", [tildePath(truncate(row.cwd, 200), home)]);
  cardField("🕒", "最後に話した", [
    formatFriendlyTime(row.last_activity_at, { clock: true }),
  ]);
  cardField("💭", "前の話題", [truncate(row.topic || "（話題なし）", 200)]);
  cardFooter("Enter を押すと、この会話のつづきが開きます");
  console.log("");
  await renderSessionPreview(uuid, { simple: true });
}

async function renderSimple(kind: string, key: string, cwd: string): Promise<void> {
  if (kind === "resume") {
    await renderSimpleSessionCard(key);
  } else if (kind === "new") {
    renderSimpleRepoCard(key, cwd);
  } else if (kind === "group") {
    renderSimpleGroupCard(key);
  } else if (kind === "separator") {
    cardNotice(["ここは区切りの行です。上か下の行をえらんでください"]);
  } else {
    cardNotice(["この行は開けません。ほかの行をえらんでください"]);
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const kindKey = process.argv[2] || "";
  const cwd = process.argv[3] || "";

  if (!kindKey) {
    console.log("Usage: ccs-preview <KIND:KEY> <CWD>");
    return;
  }

  const colonIdx = kindKey.indexOf(":");
  if (colonIdx < 0) {
    console.log(`Invalid argument: ${kindKey} (expected KIND:KEY)`);
    return;
  }
  const kind = kindKey.slice(0, colonIdx);
  const key = kindKey.slice(colonIdx + 1);

  if (uiFromArgv(process.argv.slice(4)) === "simple") {
    try {
      await renderSimple(kind, key, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cardNotice([
        "ここに中身を出せませんでした。Enter で開くことはできます。",
        dim(truncate(msg, 120)),
      ]);
    }
    return;
  }

  try {
    if (kind === "resume") {
      await renderSessionPreview(key);
    } else if (kind === "new") {
      renderRepoPreview(key, cwd);
    } else if (kind === "group") {
      renderGroupPreview(key, cwd);
    } else if (kind === "separator") {
      // Divider row — intentionally blank preview.
      return;
    } else {
      console.log(`Unknown kind: ${kind}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Preview error: ${msg}`);
  }
}

main().catch((err) => {
  console.log(
    `Preview fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(0);
});
