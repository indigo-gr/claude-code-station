/**
 * Tests for bin/ccs-list.ts (and the group/label paths of bin/ccs-preview.ts,
 * which read the same sandbox DB)
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
const PREVIEW_TS = fileURLToPath(new URL("../bin/ccs-preview.ts", import.meta.url));

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

/** A plain enabled repo row; spread and override launch/label/icon/... */
function repoRow(name: string, path: string) {
  return {
    name,
    path,
    description: "",
    command: "claude",
    cwd: null,
    tags_json: "[]",
    icon: "📁",
    disabled: 0 as const,
    scan_enabled: 1 as const,
    custom_json: "{}",
    config_hash: name,
  };
}

// The physical parent/child layout the group header exists for: a parent
// folder that must not be launched, with launchable children inside it.
// (Fictional data — test fixtures ship with the public repo.)
function seedStudio(db: Database.Database): void {
  upsertRepo(db, {
    ...repoRow("Studio", "/home/u/studio"),
    icon: "🎬",
    description: "制作チーム",
    launch: 0,
  });
  upsertRepo(db, {
    ...repoRow("Studio-app", "/home/u/studio/app"),
    icon: "📱",
    description: "アプリ app/",
    label: "App team",
  });
  upsertRepo(db, {
    ...repoRow("Studio-hq", "/home/u/studio/hq"),
    icon: "🎬",
    description: "統括 hq/",
    label: "Studio",
  });
  upsertRepo(db, {
    ...repoRow("Studio-web", "/home/u/studio/web"),
    icon: "🌐",
    description: "サイト web/",
    label: "Web team",
  });
}

/** LABEL column without ANSI styling and the trailing ` │` separator. */
function plain(label: string): string {
  return label.replace(/\x1b\[[0-9;]*m/g, "").replace(/ │$/, "");
}

function plainLabels(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => plain(l.split("\t")[0] ?? ""));
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
        "  ├ 📁 Mid  ‹Series›",
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

  test("tree glyphs: ├ for earlier siblings, └ for the last, │ rails while an ancestor has later siblings", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      for (const [name, path] of [
        ["Root", "/home/u/root"],
        ["A", "/home/u/root/a"],
        ["A1", "/home/u/root/a/a1"],
        ["A1x", "/home/u/root/a/a1/x"],
        ["A2", "/home/u/root/a/a2"],
        ["B", "/home/u/root/b"],
        ["B1", "/home/u/root/b/b1"],
        ["Solo", "/home/u/solo"],
      ]) {
        upsertRepo(h.db, repoRow(name, path));
      }
      h.close();

      const { stdout, code } = runList(sb, ["--repos-only"]);
      assert.equal(code, 0, `ccs-list failed: ${stdout}`);
      assert.deepEqual(plainLabels(stdout), [
        "📁 Root",
        "  ├ 📁 A  ‹Root›",
        "  │ ├ 📁 A1  ‹A›",
        "  │ │ └ 📁 A1x  ‹A1›",
        "  │ └ 📁 A2  ‹A›",
        "  └ 📁 B  ‹Root›",
        "    └ 📁 B1  ‹B›",
        "📁 Solo",
      ]);
    } finally {
      await sb.cleanup();
    }
  });

  test("launch: false renders a group:<name> header; children show their label and nest under it", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      // Label hygiene: control chars are stripped (no raw ESC reaches fzf),
      // and a label that strips to nothing falls back to the name.
      upsertRepo(h.db, { ...repoRow("Zed", "/home/u/zed"), label: "Evil\x1b[2JLabel" });
      upsertRepo(h.db, { ...repoRow("Zz", "/home/u/zz"), label: " \t " });
      h.db.prepare(
        `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
         VALUES (?, 'Studio-web', 'pd', '/home/u/studio/web', ?, ?, ?, 'landing page')`,
      ).run(
        "ebebebeb-0000-4000-8000-000000000000",
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );
      h.close();

      const { stdout, code } = runList(sb, []);
      assert.equal(code, 0, `ccs-list failed: ${stdout}`);
      const rows = stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
      for (const r of rows) assert.equal(r.length, 6, `6 columns: ${r.join("|")}`);

      const header = rows[0];
      assert.equal(header[3], "group:Studio");
      assert.equal(plain(header[0]), "🎬 Studio");
      assert.equal(header[1], "制作チーム");
      assert.equal(header[2], "", "a header carries no badges");
      assert.equal(header[4], "/home/u/studio", "CWD carries the path (for ^I / preview)");
      assert.equal(header[5], "", "a header has no command");

      assert.deepEqual(
        rows.slice(1, 4).map((r) => [plain(r[0]), r[3], r[5]]),
        [
          ["  ├ 📱 App team  ‹Studio›", "new:Studio-app", "claude"],
          // ‹Studio› would only repeat the row's own label — omitted.
          ["  ├ 🎬 Studio", "new:Studio-hq", "claude"],
          ["  └ 🌐 Web team  ‹Studio›", "new:Studio-web", "claude"],
        ],
      );

      const zed = rows.find((r) => r[3] === "new:Zed")!;
      assert.ok(!zed[0].includes("\x1b[2J"), "raw ESC from the label must not reach fzf");
      assert.equal(plain(zed[0]), "📁 Evil [2JLabel");
      assert.equal(plain(rows.find((r) => r[3] === "new:Zz")![0]), "📁 Zz");

      // Session rows keep the unique name, not the label.
      const session = rows.find((r) => r[3] === "resume:ebebebeb-0000-4000-8000-000000000000")!;
      assert.equal(plain(session[0]), "🔄 🌐 Studio-web");
    } finally {
      await sb.cleanup();
    }
  });

  test("a v2 cache (no launch/label columns) still lists every repo as a launchable row", async () => {
    // ccs-list opens readonly+skipMigrate; `ccs --no-scan` right after an
    // upgrade meets a cache that migration v3 has not touched yet.
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      h.db.exec(`
        ALTER TABLE repos DROP COLUMN launch;
        ALTER TABLE repos DROP COLUMN label;
        DELETE FROM schema_version WHERE version >= 3;
      `);
      h.close();

      const { stdout, stderr, code } = runList(sb, ["--repos-only"]);
      assert.equal(code, 0, `list must not crash on a v2 cache: ${stderr}`);
      const rows = stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
      assert.deepEqual(
        rows.map((r) => [plain(r[0]), r[3]]),
        [
          ["🎬 Studio", "new:Studio"],
          ["  ├ 📱 Studio-app  ‹Studio›", "new:Studio-app"],
          ["  ├ 🎬 Studio-hq  ‹Studio›", "new:Studio-hq"],
          ["  └ 🌐 Studio-web  ‹Studio›", "new:Studio-web"],
        ],
      );
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
// Preview pane for group headers / labelled repos (bin/ccs-preview.ts)
// ---------------------------------------------------------------------------

function runPreview(sb: ListSandbox, kindKey: string, cwd: string): string {
  const res = spawnSync("tsx", [PREVIEW_TS, kindKey, cwd], {
    env: {
      ...process.env,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    },
    encoding: "utf-8",
  });
  return (res.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ccs-preview — group header & label", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("group:<name> shows the header, a not-launchable note, and its entries", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      // Deeper repos belong to their own parent, not to the header.
      upsertRepo(h.db, repoRow("Studio-web-docs", "/home/u/studio/web/docs"));
      h.close();

      const out = runPreview(sb, "group:Studio", "/home/u/studio");
      const lines = out.split("\n");
      assert.equal(lines[0], "🎬 Studio");
      assert.equal(lines[1], "/home/u/studio");
      assert.equal(lines[2], "制作チーム");
      assert.match(out, /not launchable/);
      assert.match(out, /Entries \(3\)/);
      const entries = lines
        .filter((l) => l.startsWith("  "))
        .map((l) => l.trim().replace(/\s+/g, " "));
      assert.deepEqual(entries, [
        "📱 App team app/",
        "🎬 Studio hq/",
        "🌐 Web team web/",
      ]);
    } finally {
      await sb.cleanup();
    }
  });

  test("new:<name> is titled with the label, followed by the dim name", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      h.close();

      const out = runPreview(sb, "new:Studio-web", "/home/u/studio/web");
      assert.equal(out.split("\n")[0], "🌐 Web team  (Studio-web)");
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

// ---------------------------------------------------------------------------
// ui: simple (v0.3.0) — list rows and preview cards
// ---------------------------------------------------------------------------

/** Studio group + a standalone repo + three sessions (one unmapped). */
function seedSimple(db: Database.Database): void {
  seedStudio(db);
  upsertRepo(db, { ...repoRow("alpha", "/home/u/alpha"), description: "Alpha repo" });
  const ins = db.prepare(
    `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  ins.run("aaaaaaaa-0000-0000-0000-000000000001", "Studio-web", "pd", "/home/u/studio/web", ago(5), ago(5), ago(5), "トップの文字を直す");
  ins.run("aaaaaaaa-0000-0000-0000-000000000002", "alpha", "pd", "/home/u/alpha", ago(200), ago(200), ago(200), "Alpha の作業");
  ins.run("aaaaaaaa-0000-0000-0000-000000000003", null, "pd", "/home/u/elsewhere", ago(300), ago(300), ago(300), null);
}

function cols(stdout: string): string[][] {
  return stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
}

describe("ccs-list --ui=simple", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("groups first, then projects, then conversations — each under a heading row", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const res = runList(sb, ["--ui=simple"]);
      assert.equal(res.code, 0, res.stderr);
      const rows = cols(res.stdout);
      // Six columns, keys in list order, no badges anywhere.
      assert.ok(rows.every((r) => r.length === 6));
      assert.deepEqual(rows.map((r) => r[3]), [
        "separator:-",
        "group:Studio",
        "new:Studio-app",
        "new:Studio-hq",
        "new:Studio-web",
        "separator:-",
        "new:alpha",
        "separator:-",
        "resume:aaaaaaaa-0000-0000-0000-000000000001",
        "resume:aaaaaaaa-0000-0000-0000-000000000002",
        "resume:aaaaaaaa-0000-0000-0000-000000000003",
      ]);
      assert.ok(rows.every((r) => r[2] === ""), "simple rows carry no badge column");
      const labels = rows.map((r) => plain(r[0]).replace(/\s+/g, " ").trim());
      assert.deepEqual(labels.slice(0, 7), [
        "──────── グループ ────────",
        "🎬 Studio 制作チーム",
        "📱 App team アプリ app/ （Studio）",
        "🎬 Studio 統括 hq/",
        "🌐 Web team サイト web/ （Studio）",
        "──────── プロジェクト ────────",
        "📁 alpha Alpha repo",
      ]);
      assert.equal(labels[7], "──────── 前の会話のつづき ────────");
      assert.equal(labels[8], "💬 5 分前 Studio・Web team トップの文字を直す");
      assert.equal(labels[9], "💬 3 時間前 alpha Alpha の作業");
      assert.equal(labels[10], "💬 5 時間前 /home/u/elsewhere （話題なし）");
      // No tree glyphs; children are indented instead.
      assert.ok(!rows.some((r) => /[├└│]/.test(plain(r[0]))));
      assert.match(plain(rows[2][0]), /^ {3}📱 App team/);
    } finally {
      await sb.cleanup();
    }
  });

  test("launch columns stay the classic ones (cwd, command; groups have none)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const rows = cols(runList(sb, ["--ui=simple"]).stdout);
      const byKey = new Map(rows.map((r) => [r[3], r]));
      assert.deepEqual(byKey.get("group:Studio")!.slice(4), ["/home/u/studio", ""]);
      assert.deepEqual(byKey.get("new:Studio-web")!.slice(4), ["/home/u/studio/web", "claude"]);
      assert.deepEqual(
        byKey.get("resume:aaaaaaaa-0000-0000-0000-000000000003")!.slice(4),
        ["/home/u/elsewhere", "claude"],
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("the group's name is on every row inside it, so typing it filters to the group", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const rows = cols(runList(sb, ["--ui=simple"]).stdout);
      const hits = rows.filter((r) => plain(r[0]).includes("Studio")).map((r) => r[3]);
      assert.deepEqual(hits, [
        "group:Studio",
        "new:Studio-app",
        "new:Studio-hq",
        "new:Studio-web",
        "resume:aaaaaaaa-0000-0000-0000-000000000001",
      ]);
    } finally {
      await sb.cleanup();
    }
  });

  test("empty sections get no heading (--repos-only, --sessions-only, no groups)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const reposOnly = cols(runList(sb, ["--ui=simple", "--repos-only"]).stdout);
      assert.ok(!reposOnly.some((r) => plain(r[0]).includes("前の会話")));
      const sessionsOnly = cols(runList(sb, ["--ui=simple", "--sessions-only"]).stdout);
      assert.equal(plain(sessionsOnly[0][0]).replace(/\s+/g, " "), "──────── 前の会話のつづき ────────");
      assert.equal(sessionsOnly.length, 4);
    } finally {
      await sb.cleanup();
    }
    const sb2 = await makeListSandbox();
    try {
      const h = openDb(sb2.dbPath);
      upsertRepo(h.db, repoRow("solo", "/home/u/solo"));
      h.close();
      const rows = cols(runList(sb2, ["--ui=simple"]).stdout);
      assert.deepEqual(rows.map((r) => r[3]), ["separator:-", "new:solo"]);
      assert.match(plain(rows[0][0]), /プロジェクト/);
    } finally {
      await sb2.cleanup();
    }
  });

  test("--print-ui returns the stored defaults.ui, and classic for anything else", async () => {
    const sb = await makeListSandbox();
    try {
      // No cache yet → classic, exit 0.
      let res = runList(sb, ["--print-ui"]);
      assert.equal(res.code, 0);
      assert.equal(res.stdout, "classic\n");
      const h = openDb(sb.dbPath);
      setMeta(h.db, "defaults_ui", "simple");
      h.close();
      res = runList(sb, ["--print-ui"]);
      assert.equal(res.stdout, "simple\n");
      const h2 = openDb(sb.dbPath);
      setMeta(h2.db, "defaults_ui", "$(evil)");
      h2.close();
      res = runList(sb, ["--print-ui"]);
      assert.equal(res.stdout, "classic\n");
    } finally {
      await sb.cleanup();
    }
  });

  test("without --ui the classic rows are unchanged (tree glyphs, badges)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const rows = cols(runList(sb, []).stdout);
      // Classic keeps plain name order: groups are not moved to the top.
      assert.deepEqual(rows.slice(0, 2).map((r) => r[3]), ["new:alpha", "group:Studio"]);
      assert.ok(rows.some((r) => /[├└]/.test(plain(r[0]))));
      assert.ok(rows.some((r) => r[2].length > 0), "classic rows keep their badges");
    } finally {
      await sb.cleanup();
    }
  });
});

function runPreviewSimple(sb: ListSandbox, kindKey: string, cwd: string): string {
  const res = spawnSync("tsx", [PREVIEW_TS, kindKey, cwd, "--ui=simple"], {
    env: {
      ...process.env,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    },
    encoding: "utf-8",
  });
  return (res.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ccs-preview --ui=simple (cards)", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("new: says what Enter does, the folder, last use, and plain-word state", async () => {
    const sb = await makeListSandbox();
    try {
      await mkdir(join(sb.home, "work", "site"), { recursive: true });
      const h = openDb(sb.dbPath);
      upsertRepo(h.db, {
        ...repoRow("site", join(sb.home, "work", "site")),
        label: "Web team",
        description: "会社のサイト",
        custom_json: JSON.stringify({ github_repo: "x/y", plane_project_id: "p" }),
      });
      h.db
        .prepare(
          `INSERT INTO repo_stats (name, is_git, branch, uncommitted_files, uncommitted_insertions,
             uncommitted_deletions, handoff_count, pending_count, session_count_total, session_last_at)
           VALUES ('site', 1, 'feature-x', 2, 10, 1, 1, 0, 0, NULL)`,
        )
        .run();
      h.close();
      const out = runPreviewSimple(sb, "new:site", join(sb.home, "work", "site"));
      assert.match(out, /✨ Web team で、新しく Claude Code を始めます/);
      assert.match(out, /📂 フォルダ\n {5}~\/work\/site\n/);
      assert.match(out, /🕒 最後に開いた\n {5}まだ開いたことはありません/);
      assert.match(out, /まだ保存（commit）していない変更が 2 ファイルあります/);
      assert.match(out, /作業中のブランチ: feature-x/);
      assert.match(out, /📌 申し送り\n {5}1 件あります/);
      assert.match(out, /つながっているサービス\n {5}Plane・GitHub/);
      assert.match(out, /Enter を押すと、このフォルダで Claude Code が開きます/);
      assert.doesNotMatch(out, /Uncommitted|Branch:|Sessions/);
    } finally {
      await sb.cleanup();
    }
  });

  test("new: a missing folder is said plainly, with where Enter will open instead", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      upsertRepo(h.db, repoRow("gone", join(sb.home, "nowhere")));
      h.close();
      const out = runPreviewSimple(sb, "new:gone", join(sb.home, "nowhere"));
      assert.match(out, /このフォルダが見つかりません。repos\.yml の path を確かめてください/);
      assert.match(out, /Enter を押すと、いまいるフォルダで Claude Code が開きます/);
    } finally {
      await sb.cleanup();
    }
  });

  test("group: is a heading that points to the projects inside", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      h.close();
      const out = runPreviewSimple(sb, "group:Studio", "/home/u/studio");
      assert.match(out, /📂 グループ「Studio」/);
      assert.match(out, /ここは見出しです。開くときは、下のプロジェクトをえらんでください/);
      assert.match(out, /中のプロジェクト（3）/);
      assert.match(out, /📱 App team/);
      assert.doesNotMatch(out, /launch: false|not launchable/);
    } finally {
      await sb.cleanup();
    }
  });

  test("resume: card first, then the conversation without tool placeholders", async () => {
    const sb = await makeListSandbox();
    try {
      const uuid = "bbbbbbbb-0000-0000-0000-000000000001";
      const proj = join(sb.home, ".claude", "projects", "p1");
      await mkdir(proj, { recursive: true });
      const lines = [
        { type: "user", cwd: "/home/u/alpha", message: { content: "ログイン画面を直したい" } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        { type: "user", message: { content: [{ type: "tool_result" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "直しました" }] } },
      ];
      await writeFile(join(proj, `${uuid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
      const h = openDb(sb.dbPath);
      upsertRepo(h.db, { ...repoRow("alpha", "/home/u/alpha"), label: "アルファ" });
      const now = new Date().toISOString();
      h.db
        .prepare(
          `INSERT INTO sessions (uuid, repo_name, project_dir, cwd, started_at, last_activity_at, jsonl_mtime, topic)
           VALUES (?, 'alpha', 'p1', '/home/u/alpha', ?, ?, ?, 'ログイン画面を直したい')`,
        )
        .run(uuid, now, now, now);
      h.close();
      const out = runPreviewSimple(sb, `resume:${uuid}`, "/home/u/alpha");
      assert.match(out, /↩️ {2}前の会話のつづきから再開します/);
      assert.match(out, /プロジェクト\n {5}アルファ/);
      assert.match(out, /最後に話した\n {5}たった今/);
      assert.match(out, /前の話題\n {5}ログイン画面を直したい/);
      assert.match(out, /Enter を押すと、この会話のつづきが開きます/);
      assert.match(out, /──── これまでの会話 ────/);
      assert.match(out, /👤 あなた: ログイン画面を直したい/);
      assert.match(out, /🤖 Claude: 直しました/);
      assert.doesNotMatch(out, /\[tool/);
      assert.doesNotMatch(out, /Session Info/);
    } finally {
      await sb.cleanup();
    }
  });

  test("separator: and a missing cache answer in one sentence", async () => {
    const sb = await makeListSandbox();
    try {
      assert.match(runPreviewSimple(sb, "separator:-", ""), /ここは区切りの行です/);
      // No state.db at all.
      assert.match(
        runPreviewSimple(sb, "new:x", "/home/u/x"),
        /まだ一覧の準備ができていません。\n {2}いちど Esc でやめて、ccs --refresh と打ってください。/,
      );
    } finally {
      await sb.cleanup();
    }
  });
});

describe("ccs-list --ui=simple — display hardening", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  test("a group label with $& / $' is drawn literally, and an escape in the icon is neutralized", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      upsertRepo(h.db, { ...repoRow("G", "/home/u/g"), label: "R$&D $' $$", icon: "\x1b[31m🎬", launch: 0 });
      upsertRepo(h.db, repoRow("G-a", "/home/u/g/a"));
      h.close();
      const rows = cols(runList(sb, ["--ui=simple"]).stdout);
      const header = rows.find((r) => r[3] === "group:G")!;
      // ESC is removed, which neutralizes the sequence; the printable rest
      // ("[31m") stays as harmless text — the same policy as truncate().
      assert.ok(plain(header[0]).startsWith("[31m🎬 R$&D $' $$"), plain(header[0]));
      assert.ok(!header[0].includes("\x1b[31m"), "the icon's escape sequence is neutralized");
    } finally {
      await sb.cleanup();
    }
  });
});

describe("lead: true (v0.3.1)", { skip: !tsxAvailable() && "tsx not on PATH" }, () => {
  /** Studio group whose lead (hq) sorts after app by name. */
  function seedLead(db: Database.Database): void {
    seedStudio(db);
    upsertRepo(db, { ...repoRow("Studio-hq", "/home/u/studio/hq"), icon: "🎬", description: "統括 hq/", label: "Studio", lead: 1 });
    upsertRepo(db, { ...repoRow("Studio-zz", "/home/u/studio/zz"), icon: "🛰", description: "衛星", label: "Zz" });
  }

  test("simple: the lead is first inside its group and drawn with 👑; a 1-column icon is padded to 2", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedLead(h.db);
      h.close();
      const rows = cols(runList(sb, ["--ui=simple", "--repos-only"]).stdout);
      assert.deepEqual(rows.map((r) => r[3]), [
        "separator:-",
        "group:Studio",
        "new:Studio-hq",
        "new:Studio-app",
        "new:Studio-web",
        "new:Studio-zz",
      ]);
      assert.match(plain(rows[2][0]), /^ {3}👑 Studio\s+統括 hq\//);
      // 🛰 is one column for fzf: it gets a space so the name does not touch it,
      // and the description starts in the same column as the other rows.
      const zz = plain(rows[5][0]);
      assert.match(zz, /^ {3}🛰 {2}Zz/);
      const descCol = (l: string, d: string) => {
        let w = 0;
        for (const ch of l.slice(0, l.indexOf(d))) w += /\p{Emoji_Presentation}|[　-鿿]/u.test(ch) ? 2 : ch === "️" ? 0 : 1;
        return w;
      };
      assert.equal(descCol(zz, "衛星"), descCol(plain(rows[3][0]), "アプリ"));
    } finally {
      await sb.cleanup();
    }
  });

  test("classic: the lead is first among its siblings too, icon unchanged; no lead = name order as before", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedLead(h.db);
      h.close();
      const rows = cols(runList(sb, ["--repos-only"]).stdout);
      assert.deepEqual(rows.map((r) => r[3]), ["group:Studio", "new:Studio-hq", "new:Studio-app", "new:Studio-web", "new:Studio-zz"]);
      assert.match(plain(rows[1][0]), /^ {2}├ 🎬 Studio/);
    } finally {
      await sb.cleanup();
    }
  });

  test("cards: the group card lists the lead first as 👑 （統括）; the lead's own card says so", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedLead(h.db);
      h.close();
      const group = runPreviewSimple(sb, "group:Studio", "/home/u/studio");
      const entries = group.split("\n").filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim());
      assert.match(entries[0], /^👑 Studio .*（統括）$/);
      assert.match(entries[1], /App team/);
      const card = runPreviewSimple(sb, "new:Studio-hq", "/home/u/studio/hq");
      assert.match(card, /👑 このグループの統括です/);
      const classic = runPreview(sb, "group:Studio", "/home/u/studio");
      const classicEntries = classic.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "));
      assert.equal(classicEntries[0], "🎬 Studio", "classic preview: lead first, own icon");
    } finally {
      await sb.cleanup();
    }
  });
});
