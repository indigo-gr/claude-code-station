#!/usr/bin/env tsx
/**
 * ccs-scan.ts - Parallel repository scan engine for ccs v0.2.0
 *
 * Responsibilities:
 *   A. Sync repos.yml -> DB (repos table)
 *   B. Parallel repo_stats scan with TTL-based invalidation, git/workspace data
 *   C. Sessions scan (~/.claude/projects/) with mtime-based caching
 *   D. CLI entrypoint with --force / --no-sessions / --quiet flags
 *
 * Source of truth: docs/design/sqlite-schema.md
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

import { loadConfig, getPaths, type RepoEntry } from "./ccs-config.ts";
import {
  openDb,
  upsertRepo,
  getAllRepos,
  deleteReposNotIn,
  type RepoRow,
} from "./ccs-db.ts";
import { maskSecrets } from "./ccs-secrets.ts";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanOptions {
  force?: boolean;
  ttlSeconds?: number;
  parallelism?: number;
  scanSessions?: boolean;
}

export interface ScanResult {
  reposScanned: number;
  reposSkipped: number;
  reposErrored: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 10;
const DEFAULT_PARALLELISM = 8;
const GIT_TIMEOUT_MS = 5000;
const MAX_JSONL_SIZE = 50 * 1024 * 1024;
const MAX_FIRST_LINE_LEN = 100;
const MAX_TOPIC_LEN = 200;
const MAX_SUMMARY_LEN = 1000;
const PREVIEW_FILE_LIMIT = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUMMARY_RE =
  /<!--\s*ECC:SUMMARY:START\s*-->([\s\S]*?)<!--\s*ECC:SUMMARY:END\s*-->/;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const res = await execFileP("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: res.stdout, stderr: res.stderr };
  } catch {
    return null;
  }
}

/** Simple semaphore for bounded parallelism. */
function makeLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// A. repos.yml -> DB sync
// ---------------------------------------------------------------------------

function syncReposToDb(
  db: Database.Database,
  entries: RepoEntry[],
): void {
  const tx = db.transaction(() => {
    for (const r of entries) {
      upsertRepo(db, {
        name: r.name,
        path: r.path,
        description: r.description,
        command: r.command,
        cwd: r.cwd && r.cwd !== r.path ? r.cwd : null,
        tags_json: JSON.stringify(r.tags),
        icon: r.icon,
        disabled: r.disabled ? 1 : 0,
        scan_enabled: r.scan ? 1 : 0,
        custom_json: JSON.stringify(r.custom),
        config_hash: r.configHash,
      });
    }
    deleteReposNotIn(
      db,
      entries.map((e) => e.name),
    );
  });
  tx();
}

// ---------------------------------------------------------------------------
// B. Per-repo scan
// ---------------------------------------------------------------------------

interface PreviewFile {
  filename: string;
  size: number;
  mtime: string;
  first_line: string | null;
}

interface RepoStatsRow {
  name: string;
  is_git: 0 | 1;
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
  scanned_at: string;
  scan_duration_ms: number;
  scan_error: string | null;
}

async function listDirPreview(
  dirPath: string,
): Promise<{ count: number; previews: PreviewFile[] }> {
  if (!existsSync(dirPath)) return { count: 0, previews: [] };
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return { count: 0, previews: [] };
  }
  const visible = entries.filter((n) => !n.startsWith("."));

  const statted: PreviewFile[] = [];
  for (const name of visible) {
    const full = join(dirPath, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      let firstLine: string | null = null;
      try {
        const buf = await readFile(full, { encoding: "utf-8" });
        const line = buf.split("\n", 1)[0] ?? "";
        firstLine = maskSecrets(line).slice(0, MAX_FIRST_LINE_LEN);
      } catch {
        // binary or unreadable; leave null
      }
      statted.push({
        filename: name,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        first_line: firstLine,
      });
    } catch {
      // skip
    }
  }

  statted.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return {
    count: statted.length,
    previews: statted.slice(0, PREVIEW_FILE_LIMIT),
  };
}

async function getClaudeRoomLatest(
  roomDir: string,
): Promise<{ path: string | null; mtime: string | null }> {
  if (!existsSync(roomDir)) return { path: null, mtime: null };
  let entries: string[];
  try {
    entries = await readdir(roomDir);
  } catch {
    return { path: null, mtime: null };
  }
  let latest: { name: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const st = await stat(join(roomDir, name));
      if (!st.isFile()) continue;
      if (!latest || st.mtimeMs > latest.mtimeMs) {
        latest = { name, mtimeMs: st.mtimeMs };
      }
    } catch {
      // skip
    }
  }
  if (!latest) return { path: null, mtime: null };
  return {
    path: join(roomDir, latest.name),
    mtime: new Date(latest.mtimeMs).toISOString(),
  };
}

async function scanOneRepo(
  db: Database.Database,
  repo: RepoRow,
): Promise<void> {
  const start = Date.now();
  const stats: RepoStatsRow = {
    name: repo.name,
    is_git: 0,
    branch: null,
    last_commit_hash: null,
    last_commit_subject: null,
    last_commit_at: null,
    uncommitted_files: 0,
    uncommitted_insertions: 0,
    uncommitted_deletions: 0,
    handoff_count: 0,
    pending_count: 0,
    claude_room_latest: null,
    claude_room_latest_at: null,
    session_count_total: 0,
    session_last_at: null,
    scanned_at: nowIso(),
    scan_duration_ms: 0,
    scan_error: null,
  };

  let handoffPreviews: PreviewFile[] = [];
  let pendingPreviews: PreviewFile[] = [];

  try {
    if (!existsSync(repo.path)) {
      throw new Error(`path not found: ${repo.path}`);
    }

    // --- Git data (all best-effort) ---
    const isGit = await runGit(repo.path, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (isGit && isGit.stdout.trim() === "true") {
      stats.is_git = 1;

      const branch = await runGit(repo.path, ["branch", "--show-current"]);
      if (branch) stats.branch = branch.stdout.trim() || null;

      const log = await runGit(repo.path, [
        "log",
        "-1",
        "--format=%H%x09%s%x09%cI",
      ]);
      if (log && log.stdout.trim()) {
        const [hash, subject, at] = log.stdout.trim().split("\t");
        stats.last_commit_hash = hash ?? null;
        stats.last_commit_subject = subject ?? null;
        stats.last_commit_at = at ?? null;
      }

      const status = await runGit(repo.path, ["status", "--porcelain"]);
      if (status) {
        const lines = status.stdout
          .split("\n")
          .filter((l) => l.length > 0);
        stats.uncommitted_files = lines.length;
      }

      // shortstat needs HEAD; may fail on "no commits yet" -> leave zeros
      const shortstat = await runGit(repo.path, [
        "diff",
        "--shortstat",
        "HEAD",
      ]);
      if (shortstat && shortstat.stdout.trim()) {
        const text = shortstat.stdout;
        const ins = /(\d+) insertion/.exec(text);
        const del = /(\d+) deletion/.exec(text);
        if (ins) stats.uncommitted_insertions = parseInt(ins[1], 10);
        if (del) stats.uncommitted_deletions = parseInt(del[1], 10);
      }
    }

    // --- Workspace dirs ---
    const handoff = await listDirPreview(join(repo.path, "handoff"));
    stats.handoff_count = handoff.count;
    handoffPreviews = handoff.previews;

    const pending = await listDirPreview(join(repo.path, "pendings"));
    stats.pending_count = pending.count;
    pendingPreviews = pending.previews;

    const room = await getClaudeRoomLatest(join(repo.path, "claude-room"));
    stats.claude_room_latest = room.path;
    stats.claude_room_latest_at = room.mtime;

    // --- Sessions aggregation ---
    const sessRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt, MAX(last_activity_at) AS last_at
         FROM sessions WHERE repo_name = ?`,
      )
      .get(repo.name) as { cnt: number; last_at: string | null };
    stats.session_count_total = sessRow?.cnt ?? 0;
    stats.session_last_at = sessRow?.last_at ?? null;
  } catch (err) {
    stats.scan_error = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[ccs-scan] ${repo.name}: ${stats.scan_error}\n`,
    );
  }

  stats.scan_duration_ms = Date.now() - start;

  // --- Single transaction: upsert stats + refresh preview tables ---
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO repo_stats (
         name, is_git, branch, last_commit_hash, last_commit_subject,
         last_commit_at, uncommitted_files, uncommitted_insertions,
         uncommitted_deletions, handoff_count, pending_count,
         claude_room_latest, claude_room_latest_at,
         session_count_total, session_last_at,
         scanned_at, scan_duration_ms, scan_error
       ) VALUES (
         @name, @is_git, @branch, @last_commit_hash, @last_commit_subject,
         @last_commit_at, @uncommitted_files, @uncommitted_insertions,
         @uncommitted_deletions, @handoff_count, @pending_count,
         @claude_room_latest, @claude_room_latest_at,
         @session_count_total, @session_last_at,
         @scanned_at, @scan_duration_ms, @scan_error
       )
       ON CONFLICT(name) DO UPDATE SET
         is_git = excluded.is_git,
         branch = excluded.branch,
         last_commit_hash = excluded.last_commit_hash,
         last_commit_subject = excluded.last_commit_subject,
         last_commit_at = excluded.last_commit_at,
         uncommitted_files = excluded.uncommitted_files,
         uncommitted_insertions = excluded.uncommitted_insertions,
         uncommitted_deletions = excluded.uncommitted_deletions,
         handoff_count = excluded.handoff_count,
         pending_count = excluded.pending_count,
         claude_room_latest = excluded.claude_room_latest,
         claude_room_latest_at = excluded.claude_room_latest_at,
         session_count_total = excluded.session_count_total,
         session_last_at = excluded.session_last_at,
         scanned_at = excluded.scanned_at,
         scan_duration_ms = excluded.scan_duration_ms,
         scan_error = excluded.scan_error`,
    ).run(stats);

    db.prepare(`DELETE FROM handoff_files WHERE repo_name = ?`).run(
      repo.name,
    );
    db.prepare(`DELETE FROM pending_items WHERE repo_name = ?`).run(
      repo.name,
    );

    const hInsert = db.prepare(
      `INSERT INTO handoff_files (repo_name, filename, size, mtime, first_line)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of handoffPreviews) {
      hInsert.run(repo.name, p.filename, p.size, p.mtime, p.first_line);
    }
    const pInsert = db.prepare(
      `INSERT INTO pending_items (repo_name, filename, size, mtime, first_line)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of pendingPreviews) {
      pInsert.run(repo.name, p.filename, p.size, p.mtime, p.first_line);
    }
  });
  tx();
}

interface ReposScanSummary {
  scanned: number;
  skipped: number;
  errored: number;
}

async function scanAllRepos(
  db: Database.Database,
  opts: {
    force: boolean;
    ttlSeconds: number;
    parallelism: number;
  },
): Promise<ReposScanSummary> {
  const allRepos = getAllRepos(db).filter(
    (r) => r.disabled === 0 && r.scan_enabled === 1,
  );

  // TTL check: read existing scanned_at per repo
  const ttlMs = opts.ttlSeconds * 1000;
  const nowMs = Date.now();
  const skipSet = new Set<string>();
  if (!opts.force) {
    const rows = db
      .prepare(`SELECT name, scanned_at FROM repo_stats`)
      .all() as Array<{ name: string; scanned_at: string }>;
    for (const r of rows) {
      const t = Date.parse(r.scanned_at);
      if (!isNaN(t) && nowMs - t < ttlMs) skipSet.add(r.name);
    }
  }

  const toScan = allRepos.filter((r) => !skipSet.has(r.name));
  const limit = makeLimiter(opts.parallelism);

  const results = await Promise.allSettled(
    toScan.map((r) => limit(() => scanOneRepo(db, r))),
  );

  let errored = 0;
  for (const res of results) {
    if (res.status === "rejected") {
      errored++;
      process.stderr.write(
        `[ccs-scan] unexpected rejection: ${String(res.reason)}\n`,
      );
    }
  }

  return {
    scanned: toScan.length,
    skipped: skipSet.size,
    errored,
  };
}

// ---------------------------------------------------------------------------
// C. Sessions scan
// ---------------------------------------------------------------------------

interface SessionParseResult {
  uuid: string;
  project_dir: string;
  cwd: string;
  branch: string | null;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  topic: string | null;
  summary: string | null;
  jsonl_size: number;
  jsonl_mtime: string;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return "";
}

async function parseSessionJsonl(
  filePath: string,
  projectDir: string,
  size: number,
  mtimeIso: string,
): Promise<SessionParseResult | null> {
  const fileBase = basename(filePath).replace(/\.jsonl$/, "");
  if (!UUID_RE.test(fileBase)) return null;
  if (size === 0 || size > MAX_JSONL_SIZE) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let cwd = "";
  let branch: string | null = null;
  let firstTs = "";
  let lastTs = "";
  let firstUserMsg = "";
  let msgCount = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    msgCount++;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!branch && typeof entry.gitBranch === "string") {
      branch = entry.gitBranch || null;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (
      !firstUserMsg &&
      entry.type === "user" &&
      entry.message &&
      typeof entry.message === "object"
    ) {
      const raw = extractUserText(
        (entry.message as { content?: unknown }).content,
      );
      if (raw && !raw.includes("[Request interrupted by user")) {
        firstUserMsg = raw
          .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  // summary: search whole content
  let summary: string | null = null;
  const summaryMatch = SUMMARY_RE.exec(content);
  if (summaryMatch) {
    summary = summaryMatch[1].trim().slice(0, MAX_SUMMARY_LEN);
  }

  const topic = firstUserMsg
    ? firstUserMsg.slice(0, MAX_TOPIC_LEN)
    : null;

  return {
    uuid: fileBase,
    project_dir: projectDir,
    cwd: cwd || "unknown",
    branch,
    started_at: firstTs || mtimeIso,
    last_activity_at: lastTs || mtimeIso,
    message_count: msgCount,
    topic,
    summary,
    jsonl_size: size,
    jsonl_mtime: mtimeIso,
  };
}

async function scanSessions(
  db: Database.Database,
): Promise<{ indexed: number; skipped: number }> {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return { indexed: 0, skipped: 0 };

  // Build lookup: cwd -> repo_name
  const repos = getAllRepos(db);
  const cwdToName = new Map<string, string>();
  for (const r of repos) {
    cwdToName.set(r.path, r.name);
    if (r.cwd) cwdToName.set(r.cwd, r.name);
  }

  // Existing session mtimes
  const existing = new Map<string, string>();
  for (const row of db
    .prepare(`SELECT uuid, jsonl_mtime FROM sessions`)
    .all() as Array<{ uuid: string; jsonl_mtime: string }>) {
    existing.set(row.uuid, row.jsonl_mtime);
  }

  const validUuids = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return { indexed: 0, skipped: 0 };
  }

  const upsertStmt = db.prepare(
    `INSERT INTO sessions (
       uuid, repo_name, project_dir, cwd, branch,
       started_at, last_activity_at, message_count,
       topic, summary, jsonl_size, jsonl_mtime, indexed_at
     ) VALUES (
       @uuid, @repo_name, @project_dir, @cwd, @branch,
       @started_at, @last_activity_at, @message_count,
       @topic, @summary, @jsonl_size, @jsonl_mtime, datetime('now')
     )
     ON CONFLICT(uuid) DO UPDATE SET
       repo_name = excluded.repo_name,
       project_dir = excluded.project_dir,
       cwd = excluded.cwd,
       branch = excluded.branch,
       started_at = excluded.started_at,
       last_activity_at = excluded.last_activity_at,
       message_count = excluded.message_count,
       topic = excluded.topic,
       summary = excluded.summary,
       jsonl_size = excluded.jsonl_size,
       jsonl_mtime = excluded.jsonl_mtime,
       indexed_at = datetime('now')`,
  );

  for (const projName of projectDirs) {
    const projPath = join(projectsDir, projName);
    let projStat;
    try {
      projStat = await stat(projPath);
    } catch {
      continue;
    }
    if (!projStat.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const uuid = f.replace(/\.jsonl$/, "");
      if (!UUID_RE.test(uuid)) continue;
      const full = join(projPath, f);

      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      validUuids.add(uuid);
      const mtimeIso = new Date(st.mtimeMs).toISOString();

      if (existing.get(uuid) === mtimeIso) {
        skipped++;
        continue;
      }

      try {
        const parsed = await parseSessionJsonl(
          full,
          projName,
          st.size,
          mtimeIso,
        );
        if (!parsed) {
          skipped++;
          continue;
        }
        const repoName = cwdToName.get(parsed.cwd) ?? null;
        upsertStmt.run({
          uuid: parsed.uuid,
          repo_name: repoName,
          project_dir: parsed.project_dir,
          cwd: parsed.cwd,
          branch: parsed.branch,
          started_at: parsed.started_at,
          last_activity_at: parsed.last_activity_at,
          message_count: parsed.message_count,
          topic: parsed.topic,
          summary: parsed.summary,
          jsonl_size: parsed.jsonl_size,
          jsonl_mtime: parsed.jsonl_mtime,
        });
        indexed++;
      } catch (err) {
        process.stderr.write(
          `[ccs-scan] session ${uuid}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // Delete sessions whose JSONL no longer exists (chunked).
  const allExisting = Array.from(existing.keys());
  const toDelete = allExisting.filter((u) => !validUuids.has(u));
  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM sessions WHERE uuid IN (${ph})`).run(...chunk);
  }

  return { indexed, skipped };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const force = opts.force ?? false;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const parallelism = opts.parallelism ?? DEFAULT_PARALLELISM;
  const scanSessionsFlag = opts.scanSessions ?? true;

  const config = loadConfig();
  const paths = getPaths();
  const handle = openDb(paths.stateDb);

  try {
    syncReposToDb(handle.db, config.repos);

    const repoSummary = await scanAllRepos(handle.db, {
      force,
      ttlSeconds,
      parallelism,
    });

    let sessionsIndexed = 0;
    let sessionsSkipped = 0;
    if (scanSessionsFlag) {
      const s = await scanSessions(handle.db);
      sessionsIndexed = s.indexed;
      sessionsSkipped = s.skipped;
    }

    return {
      reposScanned: repoSummary.scanned,
      reposSkipped: repoSummary.skipped,
      reposErrored: repoSummary.errored,
      sessionsIndexed,
      sessionsSkipped,
      durationMs: Date.now() - started,
    };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  force: boolean;
  noSessions: boolean;
  quiet: boolean;
} {
  return {
    force: argv.includes("--force"),
    noSessions: argv.includes("--no-sessions"),
    quiet: argv.includes("--quiet"),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const res = await scan({
      force: args.force,
      scanSessions: !args.noSessions,
    });
    if (!args.quiet) {
      const secs = (res.durationMs / 1000).toFixed(1);
      process.stderr.write(
        `[ccs-scan] ${res.reposScanned} repos scanned ` +
          `(${res.reposSkipped} skipped, ${res.reposErrored} errors), ` +
          `${res.sessionsIndexed} sessions indexed ` +
          `(${res.sessionsSkipped} cached) in ${secs}s\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `[ccs-scan] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
