/**
 * ccs-db.ts - SQLite initialization & migration module for ccs v0.2.0
 *
 * Responsibilities:
 *   - Open better-sqlite3 connection with secure defaults
 *   - Apply idempotent schema migrations inside per-migration transactions
 *   - Provide prepared-statement helpers for repo sync (upsert/list/delete)
 *
 * Source of truth: docs/design/sqlite-schema.md
 */

import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const CURRENT_SCHEMA_VERSION = 1;

export interface DbHandle {
  db: Database.Database;
  close(): void;
}

export interface OpenDbOptions {
  /** Skip migrate() — useful for hot preview paths on an already-initialized DB. */
  skipMigrate?: boolean;
  /** Open the SQLite connection in read-only mode. */
  readonly?: boolean;
}

export interface RepoRow {
  name: string;
  path: string;
  description: string;
  command: string;
  cwd: string | null;
  tags_json: string;
  icon: string;
  disabled: 0 | 1;
  scan_enabled: 0 | 1;
  custom_json: string;
  config_hash: string;
  created_at: string;
  updated_at: string;
}

interface Migration {
  version: number;
  up: string;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  name            TEXT PRIMARY KEY,
  path            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  command         TEXT NOT NULL DEFAULT '',
  cwd             TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  icon            TEXT NOT NULL DEFAULT '📁',
  disabled        INTEGER NOT NULL DEFAULT 0,
  scan_enabled    INTEGER NOT NULL DEFAULT 1,
  custom_json     TEXT NOT NULL DEFAULT '{}',
  config_hash     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repos_path ON repos(path);
CREATE INDEX IF NOT EXISTS idx_repos_disabled ON repos(disabled);

CREATE TABLE IF NOT EXISTS repo_stats (
  name                   TEXT PRIMARY KEY,
  is_git                 INTEGER NOT NULL DEFAULT 0,
  branch                 TEXT,
  last_commit_hash       TEXT,
  last_commit_subject    TEXT,
  last_commit_at         TEXT,
  uncommitted_files      INTEGER NOT NULL DEFAULT 0,
  uncommitted_insertions INTEGER NOT NULL DEFAULT 0,
  uncommitted_deletions  INTEGER NOT NULL DEFAULT 0,
  handoff_count          INTEGER NOT NULL DEFAULT 0,
  pending_count          INTEGER NOT NULL DEFAULT 0,
  claude_room_latest     TEXT,
  claude_room_latest_at  TEXT,
  session_count_total    INTEGER NOT NULL DEFAULT 0,
  session_last_at        TEXT,
  scanned_at             TEXT NOT NULL DEFAULT (datetime('now')),
  scan_duration_ms       INTEGER NOT NULL DEFAULT 0,
  scan_error             TEXT,
  FOREIGN KEY (name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_repo_stats_scanned_at ON repo_stats(scanned_at);
CREATE INDEX IF NOT EXISTS idx_repo_stats_session_last_at ON repo_stats(session_last_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  uuid             TEXT PRIMARY KEY,
  repo_name        TEXT,
  project_dir      TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  branch           TEXT,
  started_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 0,
  topic            TEXT,
  summary          TEXT,
  jsonl_size       INTEGER NOT NULL DEFAULT 0,
  jsonl_mtime      TEXT NOT NULL,
  indexed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_name, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);

CREATE TABLE IF NOT EXISTS handoff_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name  TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  mtime      TEXT NOT NULL,
  first_line TEXT,
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_handoff_repo ON handoff_files(repo_name, mtime DESC);

CREATE TABLE IF NOT EXISTS pending_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name  TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  mtime      TEXT NOT NULL,
  first_line TEXT,
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_repo ON pending_items(repo_name, mtime DESC);
`;

const migrations: Migration[] = [
  { version: 1, up: MIGRATION_V1 },
  // future: { version: 2, up: `...` },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export function getCurrentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
    )
    .get() as { name?: string } | undefined;
  if (!row) return 0;
  const v = db
    .prepare(`SELECT MAX(version) AS v FROM schema_version`)
    .get() as { v: number | null } | undefined;
  return v?.v ?? 0;
}

export function migrate(db: Database.Database): void {
  const current = getCurrentSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current);
  for (const m of pending) {
    try {
      db.transaction(() => {
        db.exec(m.up);
        db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(
          m.version,
        );
      })();
      process.stderr.write(`[ccs] applied migration v${m.version}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[ccs-db] migration v${m.version} failed: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export function openDb(
  stateDbPath: string,
  opts: OpenDbOptions = {},
): DbHandle {
  const readOnly = opts.readonly === true;

  if (readOnly) {
    if (!existsSync(stateDbPath)) {
      throw new Error(
        `[ccs-db] state.db not found at ${stateDbPath} — run \`ccs --refresh\` first`,
      );
    }
  } else {
    // Ensure parent directory exists with restrictive permissions.
    const parent = dirname(stateDbPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  const db = readOnly
    ? new Database(stateDbPath, { readonly: true })
    : new Database(stateDbPath);

  // PRAGMAs: foreign keys must be ON before migrations.
  // journal_mode/synchronous are session-scoped write pragmas — skip on readonly.
  if (!readOnly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("foreign_keys = ON");

  if (!readOnly) {
    // Tighten file permissions (best-effort; ignore on Windows / unsupported FS).
    try {
      chmodSync(stateDbPath, 0o600);
    } catch {
      // ignore
    }
  }

  if (!opts.skipMigrate && !readOnly) {
    migrate(db);
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Repo helpers (used by ccs-scan.ts to sync repos.yml -> DB)
// ---------------------------------------------------------------------------

type RepoInsert = Omit<RepoRow, "created_at" | "updated_at">;

export function upsertRepo(db: Database.Database, row: RepoInsert): void {
  // Update updated_at only when config_hash changes; created_at is preserved
  // on conflict via excluded.created_at being ignored.
  const stmt = db.prepare(`
    INSERT INTO repos (
      name, path, description, command, cwd, tags_json, icon,
      disabled, scan_enabled, custom_json, config_hash,
      created_at, updated_at
    ) VALUES (
      @name, @path, @description, @command, @cwd, @tags_json, @icon,
      @disabled, @scan_enabled, @custom_json, @config_hash,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(name) DO UPDATE SET
      path         = excluded.path,
      description  = excluded.description,
      command      = excluded.command,
      cwd          = excluded.cwd,
      tags_json    = excluded.tags_json,
      icon         = excluded.icon,
      disabled     = excluded.disabled,
      scan_enabled = excluded.scan_enabled,
      custom_json  = excluded.custom_json,
      config_hash  = excluded.config_hash,
      updated_at   = CASE
        WHEN repos.config_hash != excluded.config_hash
          THEN datetime('now')
        ELSE repos.updated_at
      END
  `);
  stmt.run(row);
}

export function getAllRepos(db: Database.Database): RepoRow[] {
  return db
    .prepare(
      `SELECT name, path, description, command, cwd, tags_json, icon,
              disabled, scan_enabled, custom_json, config_hash,
              created_at, updated_at
       FROM repos
       ORDER BY name`,
    )
    .all() as RepoRow[];
}

export function deleteReposNotIn(
  db: Database.Database,
  names: string[],
): number {
  if (names.length === 0) {
    // Preserve existing semantic: empty array deletes all repos.
    const res = db.prepare(`DELETE FROM repos`).run();
    return res.changes;
  }
  // Use json_each(JSON array) to avoid SQLite's 999-variable bind limit
  // when syncing large numbers of repos. JSON1 is default-enabled since
  // SQLite 3.38 (bundled with better-sqlite3).
  const res = db
    .prepare(
      `DELETE FROM repos
       WHERE name NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(JSON.stringify(names));
  return res.changes;
}
