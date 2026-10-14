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
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { openDb, upsertRepo, setMeta } from "../bin/ccs-db.ts";

const LIST_TS = fileURLToPath(new URL("../bin/ccs-list.ts", import.meta.url));
const SCAN_TS = fileURLToPath(new URL("../bin/ccs-scan.ts", import.meta.url));

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
  cwd?: string,
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("tsx", [LIST_TS, ...args], {
    env: {
      ...process.env,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    },
    cwd,
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
    // Phase 7 CR3-A + review C-5 regression test: if state.db does not exist
    // yet, ccs-list.ts must take the dedicated isMissing branch — the earlier
    // version of this test accepted ANY output containing "state.db not
    // found", which also matched the raw `[ccs-list] fatal:` path and let the
    // friendly-hint branch rot as dead code.
    const sb = await makeListSandbox();
    try {
      // Do NOT create state.db — simulate cold start
      await rm(sb.dbPath, { force: true });
      const { stdout, stderr, code } = runList(sb, []);
      const combined = stdout + stderr;
      assert.match(
        stderr,
        /\[ccs-list\] state\.db not found\. Run `ccs --refresh` first/,
        `expected the friendly-hint branch, got code=${code}, combined=${combined}`,
      );
      assert.ok(
        !/\[ccs-list\] fatal:/.test(combined),
        `cold start must not go through the raw fatal path: ${combined}`,
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

  test("unmapped session command falls back to meta defaults_command (review A-8)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      setMeta(h.db, "defaults_command", "opr claude");
      h.db.prepare(
        `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "pd",
        "/home/u/unregistered",
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        "orphan",
      );
      h.close();

      const { stdout } = runList(sb, ["--sessions-only"]);
      const row = stdout.split("\n").find((l) => l.includes("resume:aaaaaaaa"));
      assert.ok(row, "unmapped session row should exist");
      const command = row!.split("\t")[5];
      assert.equal(
        command,
        "opr claude",
        "unmapped sessions must inherit the resolved default, not hardcoded 'claude'",
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("unmapped session command degrades to 'claude' on a pre-v2 cache without meta", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      // Simulate a schema-v1 cache: meta table absent entirely.
      h.db.exec(`DROP TABLE meta; DELETE FROM schema_version WHERE version = 2;`);
      h.db.prepare(
        `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "pd",
        "/home/u/unregistered",
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );
      h.close();

      const { stdout, code } = runList(sb, ["--sessions-only"]);
      assert.equal(code, 0, `list must not crash on a meta-less cache: ${stdout}`);
      const row = stdout.split("\n").find((l) => l.includes("resume:aaaaaaaa"));
      assert.ok(row, "session row should exist");
      assert.equal(row!.split("\t")[5], "claude");
    } finally {
      await sb.cleanup();
    }
  });

  test("--current-only filters by cwd in SQL: exact, subdir, and sibling-prefix exclusion (review A-10)", async () => {
    const sb = await makeListSandbox();
    try {
      const projDir = join(sb.home, "proj");
      await mkdir(projDir, { recursive: true });
      // Seed with the RESOLVED path: the subprocess's process.cwd() resolves
      // macOS /var -> /private/var aliasing, and real sessions record the
      // resolved cwd the process actually ran in.
      const { realpathSync } = await import("node:fs");
      const projReal = realpathSync(projDir);
      const h = openDb(sb.dbPath);
      const ins = h.db.prepare(
        `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime)
         VALUES (?, NULL, 'pd', ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      ins.run("11111111-1111-4111-8111-111111111111", projReal, now, now, now);
      ins.run("22222222-2222-4222-8222-222222222222", join(projReal, "sub"), now, now, now);
      // Sibling with the filter cwd as a STRING prefix — must be excluded.
      ins.run("33333333-3333-4333-8333-333333333333", projReal + "evil", now, now, now);
      ins.run("44444444-4444-4444-8444-444444444444", join(sb.home, "other"), now, now, now);
      h.close();

      const { stdout, code } = runList(sb, ["--current-only"], projDir);
      assert.equal(code, 0, `list failed: ${stdout}`);
      const kinds = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t")[3]);
      assert.ok(kinds.includes("resume:11111111-1111-4111-8111-111111111111"), "exact cwd match expected");
      assert.ok(kinds.includes("resume:22222222-2222-4222-8222-222222222222"), "subdir match expected");
      assert.ok(!kinds.some((k) => k.startsWith("resume:33333333")), "sibling prefix must be excluded");
      assert.ok(!kinds.some((k) => k.startsWith("resume:44444444")), "unrelated cwd must be excluded");
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

  test("nested repos follow their parent, indented, with a dim ‹parent› hint", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      const add = (name: string, path: string, disabled: 0 | 1 = 0): void => {
        upsertRepo(h.db, {
          name,
          path,
          description: "",
          command: "claude",
          cwd: null,
          tags_json: "[]",
          icon: "📁",
          disabled,
          scan_enabled: 1,
          custom_json: "{}",
          config_hash: name,
        });
      };
      add("Aardvark", "/home/u/aardvark");
      add("Series", "/home/u/series");
      add("Zeta", "/home/u/series/zeta");
      add("Mid", "/home/u/series/mid");
      add("Inner", "/home/u/series/zeta/inner");
      // Shares "/home/u/series" as a string prefix but is a sibling dir.
      add("Series Other", "/home/u/series-other");
      // A disabled parent is not listed, so its child stays top-level.
      add("Hidden", "/home/u/hidden", 1);
      add("Visible", "/home/u/hidden/visible");
      h.close();

      const { stdout, code } = runList(sb, ["--repos-only"]);
      assert.equal(code, 0, `ccs-list failed: ${stdout}`);
      const labels = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => (l.split("\t")[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/ │$/, ""));
      assert.deepEqual(labels, [
        "📁 Aardvark",
        "📁 Series",
        "  └ 📁 Mid  ‹Series›",
        "  └ 📁 Zeta  ‹Series›",
        "    └ 📁 Inner  ‹Zeta›",
        "📁 Series Other",
        "📁 Visible",
      ]);
      // The hint is dimmed, not plain text.
      assert.ok(stdout.includes("\x1b[2m‹Series›\x1b[0m"), "parent hint should be dim");
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

// ---------------------------------------------------------------------------
// Pipe delivery (2026-10-07: the fzf list ended after 3 repos)
// ---------------------------------------------------------------------------

function sandboxEnv(sb: ListSandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: sb.home,
    XDG_CONFIG_HOME: sb.xdgConfig,
    XDG_CACHE_HOME: sb.xdgCache,
  };
  // The developer's own launch command must not leak into the rows.
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  return env;
}

// bin/ccs feeds ccs-list into fzf through a real pipe(2), but spawnSync's
// own stdout is a socketpair — so route through `bash -c '... | cat'` to
// reproduce the production transport. macOS may give a new pipe only 512
// bytes of buffer; a process.exit() right after the write dropped the rest.
function runListPiped(
  sb: ListSandbox,
  args: string[],
  reader = "cat",
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(
    "bash",
    ["-c", `set -o pipefail; tsx "$@" | ${reader}`, "bash", LIST_TS, ...args],
    {
      env: sandboxEnv(sb),
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

// 1 enabled repo + 1 session from seed(), plus `count` more sessions
// (~150 bytes per row, so 1000 sessions is ~150 KB of output).
function seedManySessions(db: Database.Database, count: number): void {
  seed(db);
  const insert = db.prepare(
    `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const uuid = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    insert.run(uuid, "alpha", "pd", "/home/u/alpha", now, now, now, `topic ${i} `.padEnd(60, "x"));
  }
}

describe("ccs-list — pipe delivery", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("a list larger than the pipe buffer reaches the reader in full", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      const SESSIONS = 1000;
      seedManySessions(h.db, SESSIONS);
      h.close();

      const { stdout, stderr, code } = runListPiped(sb, []);
      assert.equal(code, 0, `ccs-list failed: ${stderr}`);
      const rows = stdout.split("\n").filter((l) => l.length > 0);
      // alpha + separator + seeded session + SESSIONS (~150 KB in total)
      assert.equal(
        rows.length,
        1 + 1 + 1 + SESSIONS,
        `got ${rows.length} rows / ${Buffer.byteLength(stdout)} bytes`,
      );
      assert.ok(stdout.endsWith("\n"), "last row must be complete");
      for (const row of rows) {
        assert.equal(row.split("\t").length, 6, `truncated row: ${row}`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a repo whose scan fails is still listed by name; every repos.yml entry is listed", async () => {
    const sb = await makeListSandbox();
    try {
      // ~80 KB of rows: past both buffer sizes seen on macOS (512 B / 64 KB).
      const REPOS = 250;
      const BROKEN = "repo-117";
      const yml = ["version: 1", "repos:"];
      const expected: string[] = [];
      for (let i = 0; i < REPOS; i++) {
        const name = `repo-${String(i).padStart(3, "0")}`;
        const dir = join(sb.home, name);
        // BROKEN's dir is never created → scanOneRepo throws "path not found"
        if (name !== BROKEN) await mkdir(dir, { recursive: true });
        yml.push(
          `  - name: ${name}`,
          `    path: ${dir}`,
          `    description: ${"説明".repeat(30)}`,
        );
        expected.push(`new:${name}`);
      }
      await mkdir(join(sb.xdgConfig, "ccs"), { recursive: true });
      await writeFile(join(sb.xdgConfig, "ccs", "repos.yml"), yml.join("\n") + "\n");
      await mkdir(join(sb.home, ".claude", "projects"), { recursive: true });

      // Same invocation as the pre-scan in bin/ccs.
      const scan = spawnSync("tsx", [SCAN_TS, "--quiet"], {
        env: sandboxEnv(sb),
        encoding: "utf-8",
      });
      assert.equal(scan.status, 0, `ccs-scan failed: ${scan.stderr}`);
      const scanErrors = (scan.stderr ?? "")
        .split("\n")
        .filter((l) => l.startsWith("[ccs-scan]"));
      assert.equal(scanErrors.length, 1, `expected one [ccs-scan] line: ${scan.stderr}`);
      assert.match(scanErrors[0], new RegExp(`^\\[ccs-scan\\] ${BROKEN}: path not found`));

      const { stdout, stderr, code } = runListPiped(sb, ["--repos-only"]);
      assert.equal(code, 0, `ccs-list failed: ${stderr}`);
      const kinds = stdout
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => l.split("\t")[3]);
      assert.deepEqual(kinds, expected);
    } finally {
      await sb.cleanup();
    }
  });

  test("a reader that closes early (fzf picks before reading every row) ends quietly with exit 0", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedManySessions(h.db, 1000);
      h.close();

      // pipefail as in bin/ccs: a non-zero ccs-list exit here would make
      // bin/ccs drop the row the user just picked.
      const { stderr, code } = runListPiped(sb, [], "head -1 >/dev/null");
      assert.equal(stderr, "", "no EPIPE stack trace on the terminal");
      assert.equal(code, 0);
    } finally {
      await sb.cleanup();
    }
  });
});
