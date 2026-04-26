/**
 * Tests for bin/ccs-list.ts
 *
 * We populate the state DB directly (bypassing YAML->DB sync) and invoke
 * ccs-list.ts as a subprocess via `tsx` — capturing stdout. XDG env vars
 * are overridden to point at a sandbox DB.
 *
 * NOTE: these tests depend on `tsx` being available on PATH. If `tsx` is
 * not installed, these tests are skipped with a diagnostic. See review
 * notes for mocking limitation discussion.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { openDb, upsertRepo } from "../bin/ccs-db.ts";

const LIST_TS = fileURLToPath(new URL("../bin/ccs-list.ts", import.meta.url));

interface ListSandbox {
  root: string;
  home: string;
  xdgConfig: string;
  xdgCache: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

async function makeListSandbox(): Promise<ListSandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-list-"));
  const home = join(root, "home");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  await mkdir(join(xdgCache, "ccs"), { recursive: true });
  const dbPath = join(xdgCache, "ccs", "state.db");
  return {
    root,
    home,
    xdgConfig,
    xdgCache,
    dbPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function seed(db: Database.Database): void {
  // Two repos (one disabled), one session.
  upsertRepo(db, {
    name: "alpha",
    path: "/home/u/alpha",
    description: "Alpha repo",
    command: "claude",
    cwd: null,
    tags_json: "[]",
    icon: "📁",
    disabled: 0,
    scan_enabled: 1,
    custom_json: "{}",
    config_hash: "h1",
  });
  upsertRepo(db, {
    name: "beta",
    path: "/home/u/beta",
    description: "Beta (disabled)",
    command: "claude",
    cwd: null,
    tags_json: "[]",
    icon: "📁",
    disabled: 1,
    scan_enabled: 1,
    custom_json: "{}",
    config_hash: "h2",
  });
  db.prepare(
    `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "11111111-2222-3333-4444-555555555555",
    "alpha",
    "pd",
    "/home/u/alpha",
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    "Some topic",
  );
}

function runList(
  sb: ListSandbox,
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("tsx", [LIST_TS, ...args], {
    env: {
      ...process.env,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    },
    encoding: "utf-8",
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

function tsxAvailable(): boolean {
  const res = spawnSync("tsx", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

// ---------------------------------------------------------------------------

describe("ccs-list", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("output is tab-separated with 6 columns; disabled repos excluded", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seed(h.db);
      h.close();

      const { stdout, code } = runList(sb, []);
      assert.equal(code, 0, `ccs-list failed: ${stdout}`);
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      assert.ok(lines.length > 0, "should produce rows");

      for (const line of lines) {
        const cols = line.split("\t");
        assert.equal(cols.length, 6, `row should have 6 tab-separated cols: ${line}`);
      }
      // alpha (repo) must appear; beta (disabled) must NOT
      assert.ok(lines.some((l) => l.includes("alpha")), "alpha expected");
      assert.ok(!lines.some((l) => l.includes("Beta (disabled)")), "beta must be excluded");
    } finally {
      await sb.cleanup();
    }
  });

  test("cold start (state.db missing) prints friendly hint, not raw stack trace", async () => {
    // Phase 7 CR3-A regression test: if state.db does not exist yet,
    // ccs-list.ts must NOT leak a Node stack trace to stderr. It should
    // print a one-line message pointing the user at `ccs --refresh`.
    const sb = await makeListSandbox();
    try {
      // Do NOT create state.db — simulate cold start
      await rm(sb.dbPath, { force: true });
      const { stdout, stderr, code } = runList(sb, []);
      // Either exit code 0 with hint on stderr, or non-zero — but NO raw
      // stack trace. Friendly message mentions `ccs --refresh`.
      const combined = stdout + stderr;
      assert.ok(
        /ccs --refresh|state\.db not found|cache/i.test(combined),
        `expected friendly cold-start hint, got code=${code}, combined=${combined}`,
      );
      // Raw stack trace indicators must NOT appear
      assert.ok(
        !/at Database|SqliteError|unable to open database/.test(combined),
        `raw error leak in output: ${combined}`,
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("--repos-only yields only KIND=new rows", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seed(h.db);
      h.close();

      const { stdout } = runList(sb, ["--repos-only"]);
      const lines = stdout.split("\n").filter(Boolean);
      for (const l of lines) {
        const kind = l.split("\t")[3] ?? "";
        assert.ok(kind.startsWith("new:"), `expected new:*, got ${kind}`);
      }
      assert.ok(lines.length >= 1);
    } finally {
      await sb.cleanup();
    }
  });

  test("--sessions-only yields only KIND=resume rows", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seed(h.db);
      h.close();

      const { stdout } = runList(sb, ["--sessions-only"]);
      const lines = stdout.split("\n").filter(Boolean);
      for (const l of lines) {
        const kind = l.split("\t")[3] ?? "";
        assert.ok(kind.startsWith("resume:"), `expected resume:*, got ${kind}`);
      }
      assert.ok(lines.length >= 1);
    } finally {
      await sb.cleanup();
    }
  });

  test("badges column respects 60-char limit", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      // Seed with stats that would produce many badges
      upsertRepo(h.db, {
        name: "heavy",
        path: "/home/u/heavy",
        description: "",
        command: "claude",
        cwd: null,
        tags_json: "[]",
        icon: "📁",
        disabled: 0,
        scan_enabled: 1,
        custom_json: JSON.stringify({
          plane_project_id: "p1",
          attio_workspace: "a1",
          notion_db: "n1",
          linear_team: "l1",
          slack_channel: "s1",
          github_repo: "g1",
          figma_file: "f1",
        }),
        config_hash: "hh",
      });
      h.db.prepare(
        `INSERT INTO repo_stats (
           name, is_git, branch,
           uncommitted_files, uncommitted_insertions, uncommitted_deletions,
           handoff_count, pending_count
         ) VALUES (?, 1, 'main', 1, 99, 99, 5, 5)`,
      ).run("heavy");
      h.close();

      const { stdout } = runList(sb, ["--repos-only"]);
      const heavy = stdout
        .split("\n")
        .find((l) => l.includes("heavy"));
      assert.ok(heavy, "heavy row should exist");
      const badges = heavy!.split("\t")[2] ?? "";
      assert.ok(badges.length <= 60, `badges length > 60: ${badges.length} "${badges}"`);
    } finally {
      await sb.cleanup();
    }
  });
});
