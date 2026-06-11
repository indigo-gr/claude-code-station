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
  open,
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
import { sanitizeSessionCwd, stripControlChars } from "./ccs-sanitize.ts";

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

// Only the first line is ever displayed, so reading whole files (which can be
// large walkthrough docs) is wasted I/O — read just the head of the file.
const FIRST_LINE_READ_BYTES = 4096;

async function readFirstLine(filePath: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, FIRST_LINE_READ_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf-8");
    return text.split("\n", 1)[0] ?? "";
  } catch {
    return null;
  } finally {
    await fh.close();
  }
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

  const results = await Promise.all(
    visible.map(async (name): Promise<PreviewFile | null> => {
      const full = join(dirPath, name);
      try {
        const st = await stat(full);
        if (!st.isFile()) return null;
        const line = await readFirstLine(full);
        const firstLine =
          line === null
            ? null
            : stripControlChars(maskSecrets(line)).slice(0, MAX_FIRST_LINE_LEN);
        return {
          filename: name,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          first_line: firstLine,
        };
      } catch {
        return null;
      }
    }),
  );
  const statted = results.filter((p): p is PreviewFile => p !== null);

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
  opts: { preserveSessionAgg: boolean },
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
      // Branch names land in fzf badges (--ansi) — strip control chars so a
      // hostile branch name cannot smuggle terminal escapes (audit NEW-1).
      if (branch) stats.branch = stripControlChars(branch.stdout.trim()) || null;

      const log = await runGit(repo.path, [
        "log",
        "-1",
        "--format=%H%x09%s%x09%cI",
      ]);
      if (log && log.stdout.trim()) {
        const [hash, subject, at] = log.stdout.trim().split("\t");
        stats.last_commit_hash = hash ?? null;
        // Mask before persisting: a developer could accidentally commit a
        // secret in a commit message subject, and we must not replicate it
        // into state.db (even though the file is mode 0600). Control chars
        // are stripped because the subject is rendered in the preview pane.
        stats.last_commit_subject = subject
          ? stripControlChars(maskSecrets(subject))
          : null;
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
        // \d+ guarantees a numeric capture today; Number.isFinite guards the
        // DB write in case the regex is ever loosened (audit logic L-1).
        if (ins) {
          const n = parseInt(ins[1], 10);
          if (Number.isFinite(n)) stats.uncommitted_insertions = n;
        }
        if (del) {
          const n = parseInt(del[1], 10);
          if (Number.isFinite(n)) stats.uncommitted_deletions = n;
        }
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
    // When this scan skipped the sessions pass (--no-sessions), the sessions
    // table may be stale or empty; recomputing from it would rewind the
    // aggregates (audit logic H-1). Carry the previous repo_stats values
    // forward instead. scan() runs scanSessions BEFORE this point in the
    // normal path (audit C-1), so the recompute below sees fresh data.
    if (opts.preserveSessionAgg) {
      const prev = db
        .prepare(
          `SELECT session_count_total, session_last_at
           FROM repo_stats WHERE name = ?`,
        )
        .get(repo.name) as
        | { session_count_total: number; session_last_at: string | null }
        | undefined;
      stats.session_count_total = prev?.session_count_total ?? 0;
      stats.session_last_at = prev?.session_last_at ?? null;
    } else {
      const sessRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt, MAX(last_activity_at) AS last_at
           FROM sessions WHERE repo_name = ?`,
        )
        .get(repo.name) as { cnt: number; last_at: string | null };
      stats.session_count_total = sessRow?.cnt ?? 0;
      stats.session_last_at = sessRow?.last_at ?? null;
    }
  } catch (err) {
    // Mask before persisting AND before logging: git subprocess errors can
    // contain remote URLs with embedded credentials
    // (e.g. https://user:token@github.com/...).
    const errMsg = err instanceof Error ? err.message : String(err);
    const maskedErr = maskSecrets(errMsg);
    stats.scan_error = maskedErr;
    process.stderr.write(`[ccs-scan] ${repo.name}: ${maskedErr}\n`);
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
    preserveSessionAgg: boolean;
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
    toScan.map((r) =>
      limit(() =>
        scanOneRepo(db, r, { preserveSessionAgg: opts.preserveSessionAgg }),
      ),
    ),
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
    // Join ALL text blocks (audit logic M-5): user messages can carry the
    // real prompt in a later block (e.g. after a system-reminder block), and
    // ccs-preview-session.ts joins blocks the same way — topic extraction
    // must agree with what the preview shows.
    const texts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        texts.push((block as { text: string }).text);
      }
    }
    return texts.join(" ");
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
    // message_count means CONVERSATION messages (audit logic H-4) — JSONL
    // also carries summary/meta/tool rows which must not inflate the count.
    // Keep in sync with ccs-preview-session.ts, which counts the same way.
    if (entry.type === "user" || entry.type === "assistant") msgCount++;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!branch && typeof entry.gitBranch === "string") {
      branch = entry.gitBranch || null;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (ts) {
      // min/max by value, not by line order (audit logic M-6): sidechain rows
      // can be appended out of chronological order. ISO 8601 (always Z here)
      // sorts lexicographically, so string comparison is safe.
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
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
  // Pipeline order matters: strip control chars first so secret patterns see
  // clean text, mask BEFORE truncation so a token straddling the
  // MAX_SUMMARY_LEN/MAX_TOPIC_LEN boundary is still redacted intact.
  let summary: string | null = null;
  const summaryMatch = SUMMARY_RE.exec(content);
  if (summaryMatch) {
    summary = maskSecrets(stripControlChars(summaryMatch[1].trim())).slice(
      0,
      MAX_SUMMARY_LEN,
    );
  }

  const topic = firstUserMsg
    ? maskSecrets(stripControlChars(firstUserMsg)).slice(0, MAX_TOPIC_LEN)
    : null;

  // Trust boundary (audit H-1/M-2/NEW-1): the JSONL cwd field is attacker
  // controllable and later reaches the fzf row, the Ctrl-Y clipboard command
  // and a shell `cd`. Gate on the RAW value first — reject any shell
  // metacharacter / control char (a rejected cwd degrades to the "unknown"
  // sentinel, which bin/ccs treats as non-launchable) — then mask any secret
  // embedded in an otherwise-clean path before it is stored/displayed (M-2).
  const cleanCwd = cwd ? sanitizeSessionCwd(cwd) : null;
  const safeCwd = cleanCwd ? maskSecrets(cleanCwd) : null;

  return {
    uuid: fileBase,
    project_dir: projectDir,
    cwd: safeCwd ?? "unknown",
    branch: branch ? stripControlChars(branch) || null : null,
    started_at: firstTs || mtimeIso,
    last_activity_at: lastTs || mtimeIso,
    message_count: msgCount,
    topic,
    summary,
    jsonl_size: size,
    jsonl_mtime: mtimeIso,
  };
}

/**
 * Resolve a session cwd to a registered repo by LONGEST prefix match
 * (audit logic M-4): a session started in ~/Workspace/foo/packages/bar must
 * map to the repo registered at ~/Workspace/foo, and when repos nest, the
 * deepest path wins. Exact matches naturally win via longest-first ordering.
 */
function buildRepoResolver(
  repos: RepoRow[],
): (cwd: string) => string | null {
  const roots: Array<{ path: string; name: string }> = [];
  for (const r of repos) {
    roots.push({ path: r.path, name: r.name });
    if (r.cwd) roots.push({ path: r.cwd, name: r.name });
  }
  roots.sort((a, b) => b.path.length - a.path.length);
  return (cwd: string) => {
    for (const root of roots) {
      if (cwd === root.path || cwd.startsWith(root.path + "/")) {
        return root.name;
      }
    }
    return null;
  };
}

async function scanSessions(
  db: Database.Database,
): Promise<{ indexed: number; skipped: number }> {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return { indexed: 0, skipped: 0 };

  const repos = getAllRepos(db);
  const resolveRepoName = buildRepoResolver(repos);

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

  // indexed_at is written as an explicit ISO 8601 value rather than
  // SQLite's naive `datetime('now')` so all timestamps in state.db share one
  // format (audit logic M-1).
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (
       uuid, repo_name, project_dir, cwd, branch,
       started_at, last_activity_at, message_count,
       topic, summary, jsonl_size, jsonl_mtime, indexed_at
     ) VALUES (
       @uuid, @repo_name, @project_dir, @cwd, @branch,
       @started_at, @last_activity_at, @message_count,
       @topic, @summary, @jsonl_size, @jsonl_mtime, @indexed_at
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
       indexed_at = excluded.indexed_at`,
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
        const repoName = resolveRepoName(parsed.cwd);
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
          indexed_at: nowIso(),
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

  // Re-resolve unmapped sessions (audit logic M-3): mtime-skipped rows keep
  // the repo_name decided when they were first indexed, so a repo added to
  // repos.yml afterwards would never claim its past sessions. Cheap pass —
  // only rows still NULL are reconsidered.
  const remapTx = db.transaction(() => {
    const nullRows = db
      .prepare(`SELECT uuid, cwd FROM sessions WHERE repo_name IS NULL`)
      .all() as Array<{ uuid: string; cwd: string }>;
    const updStmt = db.prepare(
      `UPDATE sessions SET repo_name = ? WHERE uuid = ?`,
    );
    for (const row of nullRows) {
      const name = resolveRepoName(row.cwd);
      if (name) updStmt.run(name, row.uuid);
    }
  });
  remapTx();

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

    // Order matters (audit C-1): scanOneRepo aggregates session counts FROM
    // the sessions table, so sessions must be refreshed first — otherwise
    // repo_stats lags one full scan behind (all repos showed "💤 未使用" on a
    // fresh DB until the second --refresh).
    let sessionsIndexed = 0;
    let sessionsSkipped = 0;
    if (scanSessionsFlag) {
      const s = await scanSessions(handle.db);
      sessionsIndexed = s.indexed;
      sessionsSkipped = s.skipped;
    }

    const repoSummary = await scanAllRepos(handle.db, {
      force,
      ttlSeconds,
      parallelism,
      preserveSessionAgg: !scanSessionsFlag,
    });

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
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `[ccs-scan] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
