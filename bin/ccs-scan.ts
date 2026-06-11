#!/usr/bin/env tsx
/**
 * ccs-scan.ts - Parallel repository scan engine for ccs v0.2.0
 *
 * Responsibilities:
 *   A. Sync repos.yml -> DB (repos table + meta defaults)
 *   B. Parallel repo_stats scan with TTL-based invalidation, git/workspace data
 *   C. CLI entrypoint with --force / --no-sessions / --quiet flags
 *
 * Session indexing (~/.claude/projects/) lives in ccs-scan-sessions.ts
 * (review A-4); scan() orchestrates it BEFORE the repo pass (audit C-1).
 *
 * Source of truth: docs/design/sqlite-schema.md
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readdir, stat } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { loadConfig, getPaths, type RepoEntry } from "./ccs-config.ts";
import {
  openDb,
  upsertRepo,
  getAllRepos,
  deleteReposNotIn,
  setMeta,
  type RepoRow,
} from "./ccs-db.ts";
import { maskSecrets } from "./ccs-secrets.ts";
import { stripControlChars } from "./ccs-sanitize.ts";
import { nowIso } from "./ccs-utils.ts";
import { scanSessions } from "./ccs-scan-sessions.ts";

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
  /** True when another scan held the advisory lock and this run did nothing. */
  lockSkipped?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 10;
const DEFAULT_PARALLELISM = 8;
const GIT_TIMEOUT_MS = 5000;
const MAX_FIRST_LINE_LEN = 100;
const PREVIEW_FILE_LIMIT = 10;

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

      // NUL separators (%x00), not tabs: a commit subject can legally contain
      // a literal TAB, which would shift the split and persist subject
      // fragments into last_commit_at (review C-1). Git forbids NUL in commit
      // messages, so the field boundaries are unambiguous.
      const log = await runGit(repo.path, [
        "log",
        "-1",
        "--format=%H%x00%s%x00%cI",
      ]);
      if (log && log.stdout.trim()) {
        const [hash, subject, at] = log.stdout.trim().split("\0");
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

  // --- Single transaction: aggregate sessions + upsert stats + previews ---
  const tx = db.transaction(() => {
    // Sessions aggregation INSIDE the write transaction (backlog: COUNT(*)
    // outside tx): a concurrent ccs process committing session changes
    // between this read and the upsert below would persist a stale count.
    // better-sqlite3 statements are synchronous, so the read is atomic with
    // the write here.
    //
    // When this scan skipped the sessions pass (--no-sessions), the sessions
    // table may be stale or empty; recomputing from it would rewind the
    // aggregates (audit logic H-1). Carry the previous repo_stats values
    // forward instead. scan() runs scanSessions BEFORE this point in the
    // normal path (audit C-1), so the recompute sees fresh data.
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
// Advisory scan lock
// ---------------------------------------------------------------------------

// Two concurrent scans (Ctrl-R right after `ccs --refresh`, or two terminals)
// can race on the sessions DELETE-not-in cleanup and the repo_stats writes
// (backlog: concurrent scan race / original H3). WAL keeps the DB consistent,
// but the UX race ("session disappears for one reload") is real — so a second
// scan simply skips while the first holds the lock.
const LOCK_STALE_MS = 5 * 60 * 1000; // scans run in seconds; 5min = crashed

function acquireScanLock(cacheDir: string): (() => void) | null {
  const lockPath = join(cacheDir, "scan.lock");
  // Two attempts: the second runs only after removing a stale lock. If yet
  // another process wins the recreate race in between, its lock is fresh and
  // we correctly yield.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // O_EXCL — fails when held
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone (stale takeover by a later process) — nothing to do
        }
      };
    } catch {
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null; // held
        unlinkSync(lockPath); // stale (crashed scan) — take over
      } catch {
        // lock vanished between open and stat — loop and retry the create
      }
    }
  }
  return null;
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

  // loadConfig() runs ensureConfigDir(), so cacheDir exists before the lock.
  const config = loadConfig();
  const paths = getPaths();

  const releaseLock = acquireScanLock(paths.cacheDir);
  if (!releaseLock) {
    process.stderr.write(
      "[ccs-scan] another scan is in progress — skipping (stale DB is fine, it self-heals on the next refresh)\n",
    );
    return {
      reposScanned: 0,
      reposSkipped: 0,
      reposErrored: 0,
      sessionsIndexed: 0,
      sessionsSkipped: 0,
      durationMs: Date.now() - started,
      lockSkipped: true,
    };
  }

  const handle = openDb(paths.stateDb);

  try {
    syncReposToDb(handle.db, config.repos);
    // Persist the resolved launch-command fallback (defaults.command >
    // CCS_CMD > "claude") so ccs-list can apply the same chain to sessions
    // that map to no repo (review A-8). Validated at load time (review A-6).
    setMeta(handle.db, "defaults_command", config.defaults.command);

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
    releaseLock();
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
