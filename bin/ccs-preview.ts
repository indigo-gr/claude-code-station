#!/usr/bin/env tsx
/**
 * ccs-preview.ts — fzf preview pane dispatcher for ccs v0.2.0
 *
 * Invoked by fzf as: tsx bin/ccs-preview.ts <KIND:KEY> <CWD>
 *   KIND=new     → render repo preview (DB-backed state summary)
 *   KIND=resume  → delegate to renderSessionPreview (conversation history)
 *
 * All errors print to stdout (fzf reads stdout for preview) and exit 0.
 */

import { existsSync } from "node:fs";
import { getPaths } from "./ccs-config.ts";
import { openDb, type DbHandle } from "./ccs-db.ts";
import { renderSessionPreview } from "./ccs-preview-session.ts";

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

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  const t = then.getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return "<1m ago";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  const diffW = Math.floor(diffD / 7);
  if (diffW < 4) return `${diffW}w ago`;
  // YYYY-MM-DD
  return then.toISOString().slice(0, 10);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// DB row types (narrow views)
// ---------------------------------------------------------------------------

interface RepoView {
  name: string;
  path: string;
  description: string;
  icon: string;
  tags_json: string;
  custom_json: string;
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
        `SELECT name, path, description, icon, tags_json, custom_json
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
    console.log(`${hdr(`${repo.icon || "📁"} ${repo.name}`)}`);
    console.log(dim(repo.path));
    if (repo.description) console.log(repo.description);
    console.log("");

    // --- Git ---
    if (stats && stats.is_git === 1) {
      console.log(divider("Git"));
      const branch = stats.branch || "(detached)";
      console.log(`${label("Branch:".padEnd(14))} ${branch}`);
      if (stats.last_commit_hash) {
        const rel = relativeTime(stats.last_commit_at);
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
          console.log(`  • ${truncate(r.filename, 50)} (${relativeTime(r.mtime)})`);
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
          console.log(`  • ${truncate(r.filename, 50)} (${relativeTime(r.mtime)})`);
        }
      }

      if (stats.claude_room_latest) {
        const latest = truncate(stats.claude_room_latest, 40);
        const when = relativeTime(stats.claude_room_latest_at);
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
      console.log(`${label("Last activity:".padEnd(14))} ${relativeTime(stats.session_last_at)}`);
      const rows = db
        .prepare(
          `SELECT last_activity_at, topic FROM sessions
           WHERE repo_name = ? OR cwd = ?
           ORDER BY last_activity_at DESC LIMIT 3`,
        )
        .all(name, repo.path) as SessionRow[];
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
        console.log(tags.map(String).join(", "));
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

  try {
    if (kind === "resume") {
      await renderSessionPreview(key);
    } else if (kind === "new") {
      renderRepoPreview(key, cwd);
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
