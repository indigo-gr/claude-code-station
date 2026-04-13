/**
 * Tests for bin/ccs-db.ts
 *
 * Verifies openDb() secure defaults, migrate() idempotency, schema version
 * tracking, repo upsert semantics, and foreign-key cascade behavior.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDb,
  migrate,
  getCurrentSchemaVersion,
  upsertRepo,
  getAllRepos,
  deleteReposNotIn,
  CURRENT_SCHEMA_VERSION,
  type DbHandle,
} from "../bin/ccs-db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DbSandbox {
  dir: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

async function makeDbSandbox(): Promise<DbSandbox> {
  const dir = await mkdtemp(join(tmpdir(), "ccs-db-"));
  // Parent dir is created by openDb; exercise the "nested" case.
  const dbPath = join(dir, "nested", "state.db");
  return {
    dir,
    dbPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function baseRepoInsert(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "alpha",
    path: "/home/u/alpha",
    description: "",
    command: "claude",
    cwd: null,
    tags_json: "[]",
    icon: "📁",
    disabled: 0 as 0 | 1,
    scan_enabled: 1 as 0 | 1,
    custom_json: "{}",
    config_hash: "hash-v1",
    ...overrides,
  };
}

const openHandles: DbHandle[] = [];
afterEach(() => {
  while (openHandles.length) {
    const h = openHandles.pop();
    try {
      h?.close();
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// openDb()
// ---------------------------------------------------------------------------

describe("openDb()", () => {
  test("creates parent dir, sets WAL + foreign_keys ON, chmod 0600", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      const jm = h.db.pragma("journal_mode", { simple: true });
      assert.equal(String(jm).toLowerCase(), "wal");
      const fk = h.db.pragma("foreign_keys", { simple: true });
      assert.equal(Number(fk), 1);
      const st = await stat(sb.dbPath);
      // Permission bits — best effort on macOS/Linux.
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// migrate() + schema_version
// ---------------------------------------------------------------------------

describe("migrate()", () => {
  test("getCurrentSchemaVersion returns 0 on a fresh (unmigrated) DB", async () => {
    const sb = await makeDbSandbox();
    try {
      // Open via better-sqlite3 directly to skip automatic migration.
      // openDb() would auto-create the parent dir, but we bypass it here,
      // so create the parent dir ourselves first.
      const { default: Database } = await import("better-sqlite3");
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(sb.dbPath), { recursive: true });
      const raw = new Database(sb.dbPath);
      try {
        assert.equal(getCurrentSchemaVersion(raw), 0);
      } finally {
        raw.close();
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("is idempotent (double-call is a no-op)", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath); // migrates once
      openHandles.push(h);
      assert.equal(getCurrentSchemaVersion(h.db), CURRENT_SCHEMA_VERSION);
      // Second call must not throw and must not re-apply.
      migrate(h.db);
      const rows = h.db
        .prepare(`SELECT COUNT(*) AS c FROM schema_version`)
        .get() as { c: number };
      assert.equal(rows.c, 1);
    } finally {
      await sb.cleanup();
    }
  });

  test("after migrate, CURRENT_SCHEMA_VERSION is recorded", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      const row = h.db
        .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
        .get() as { version: number };
      assert.equal(row.version, CURRENT_SCHEMA_VERSION);
    } finally {
      await sb.cleanup();
    }
  });

  test("all 6 tables exist after migrate", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      const expected = [
        "schema_version",
        "repos",
        "repo_stats",
        "sessions",
        "handoff_files",
        "pending_items",
      ];
      const rows = h.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((r) => r.name));
      for (const t of expected) {
        assert.ok(names.has(t), `missing table: ${t}`);
      }
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// upsertRepo
// ---------------------------------------------------------------------------

describe("upsertRepo()", () => {
  test("inserts a new row", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      upsertRepo(h.db, baseRepoInsert());
      const all = getAllRepos(h.db);
      assert.equal(all.length, 1);
      assert.equal(all[0].name, "alpha");
      assert.equal(all[0].config_hash, "hash-v1");
    } finally {
      await sb.cleanup();
    }
  });

  test("updated_at bumps only when config_hash changes", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      upsertRepo(h.db, baseRepoInsert());
      const first = getAllRepos(h.db)[0];
      const firstUpdated = first.updated_at;

      // Wait a full second so datetime('now') granularity differs.
      await new Promise((r) => setTimeout(r, 1100));

      // Same hash: updated_at should NOT change.
      upsertRepo(h.db, baseRepoInsert({ description: "new desc" }));
      const second = getAllRepos(h.db)[0];
      assert.equal(second.updated_at, firstUpdated);
      assert.equal(second.description, "new desc"); // other fields do update

      await new Promise((r) => setTimeout(r, 1100));

      // Different hash: updated_at must change.
      upsertRepo(h.db, baseRepoInsert({ config_hash: "hash-v2" }));
      const third = getAllRepos(h.db)[0];
      assert.notEqual(third.updated_at, firstUpdated);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getAllRepos / deleteReposNotIn
// ---------------------------------------------------------------------------

describe("getAllRepos / deleteReposNotIn", () => {
  test("returns rows ordered by name", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      upsertRepo(h.db, baseRepoInsert({ name: "gamma" }));
      upsertRepo(h.db, baseRepoInsert({ name: "alpha" }));
      upsertRepo(h.db, baseRepoInsert({ name: "beta" }));
      const names = getAllRepos(h.db).map((r) => r.name);
      assert.deepEqual(names, ["alpha", "beta", "gamma"]);
    } finally {
      await sb.cleanup();
    }
  });

  test("deleteReposNotIn([]) deletes all rows", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      upsertRepo(h.db, baseRepoInsert({ name: "a" }));
      upsertRepo(h.db, baseRepoInsert({ name: "b" }));
      const deleted = deleteReposNotIn(h.db, []);
      assert.equal(deleted, 2);
      assert.equal(getAllRepos(h.db).length, 0);
    } finally {
      await sb.cleanup();
    }
  });

  test("deleteReposNotIn(['a','b']) keeps a/b, removes others", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      upsertRepo(h.db, baseRepoInsert({ name: "a" }));
      upsertRepo(h.db, baseRepoInsert({ name: "b" }));
      upsertRepo(h.db, baseRepoInsert({ name: "c" }));
      const deleted = deleteReposNotIn(h.db, ["a", "b"]);
      assert.equal(deleted, 1);
      const names = getAllRepos(h.db).map((r) => r.name);
      assert.deepEqual(names, ["a", "b"]);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// FK cascade behavior
// ---------------------------------------------------------------------------

describe("foreign key cascades", () => {
  test("deleting a repo cascades to repo_stats, handoff_files, pending_items; nulls sessions.repo_name", async () => {
    const sb = await makeDbSandbox();
    try {
      const h = openDb(sb.dbPath);
      openHandles.push(h);
      const db = h.db;

      upsertRepo(db, baseRepoInsert({ name: "zed" }));

      db.prepare(
        `INSERT INTO repo_stats (name) VALUES (?)`,
      ).run("zed");
      db.prepare(
        `INSERT INTO handoff_files (repo_name, filename, mtime)
         VALUES (?, ?, ?)`,
      ).run("zed", "h1.md", new Date().toISOString());
      db.prepare(
        `INSERT INTO pending_items (repo_name, filename, mtime)
         VALUES (?, ?, ?)`,
      ).run("zed", "p1.md", new Date().toISOString());
      db.prepare(
        `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "11111111-2222-3333-4444-555555555555",
        "zed",
        "pd",
        "/home/u/zed",
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      // Delete
      db.prepare(`DELETE FROM repos WHERE name = ?`).run("zed");

      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS c FROM repo_stats`).get() as { c: number }).c,
        0,
        "repo_stats should cascade-delete",
      );
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS c FROM handoff_files`).get() as { c: number }).c,
        0,
        "handoff_files should cascade-delete",
      );
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS c FROM pending_items`).get() as { c: number }).c,
        0,
        "pending_items should cascade-delete",
      );

      const sess = db.prepare(`SELECT repo_name FROM sessions`).get() as { repo_name: string | null };
      assert.equal(sess.repo_name, null, "sessions.repo_name should be set NULL");
    } finally {
      await sb.cleanup();
    }
  });
});
