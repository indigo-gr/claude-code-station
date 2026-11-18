/**
 * Tests for bin/ccs-list.ts (and the group/label paths of bin/ccs-preview.ts,
 * which read the same sandbox DB)
 *
 * We populate the state DB directly (bypassing YAML->DB sync) and invoke
 * ccs-list.ts as a subprocess on Node itself (process.execPath; Node strips
 * the types of the .ts sources) — capturing stdout. XDG env vars are
 * overridden to point at a sandbox DB.
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

/** LABEL column without ANSI styling. */
function plain(label: string): string {
  return label.replace(/\x1b\[[0-9;]*m/g, "");
}

/** LABEL column without styling, padding runs collapsed to one space. */
function flat(label: string): string {
  return plain(label).replace(/\s+/g, " ").trim();
}

/** Leading spaces of a LABEL column: the nesting depth, three per level. */
function indentOf(label: string): number {
  return (plain(label).match(/^ */) ?? [""])[0].length;
}

/**
 * The rows and cards here are checked in Japanese unless a test says
 * otherwise: the modules get the language the way bin/ccs passes it
 * (CCS_LANG_RESOLVED). The other inputs are cleared so the machine's locale
 * or a CCS_LANG in the shell changes nothing.
 */
function inLanguage(env: NodeJS.ProcessEnv, lang: "ja" | "en" = "ja"): NodeJS.ProcessEnv {
  for (const k of ["CCS_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete env[k];
  env.CCS_LANG_RESOLVED = lang;
  return env;
}
const inJapanese = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => inLanguage(env, "ja");

function runList(
  sb: ListSandbox,
  args: string[],
  cwd?: string,
  lang: "ja" | "en" = "ja",
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(process.execPath, [LIST_TS, ...args], {
    env: inLanguage(
      {
        ...process.env,
        HOME: sb.home,
        XDG_CONFIG_HOME: sb.xdgConfig,
        XDG_CACHE_HOME: sb.xdgCache,
      },
      lang,
    ),
    cwd,
    encoding: "utf-8",
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

// ---------------------------------------------------------------------------

describe("ccs-list", () => {
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
      for (const [lang, hint] of [
        ["en", /^\[ccs-list\] state\.db not found\. Run `ccs --refresh` first/],
        ["ja", /^\[ccs-list\] state\.db がありません。先に ccs --refresh と打って/],
      ] as const) {
        const { stdout, stderr, code } = runList(sb, [], undefined, lang);
        const combined = stdout + stderr;
        assert.match(
          stderr,
          hint,
          `${lang}: expected the friendly-hint branch, got code=${code}, combined=${combined}`,
        );
        assert.ok(
          !/\[ccs-list\] fatal:/.test(combined),
          `${lang}: cold start must not go through the raw fatal path: ${combined}`,
        );
        // Raw stack trace indicators must NOT appear
        assert.ok(
          !/at Database|SqliteError|unable to open database/.test(combined),
          `${lang}: raw error leak in output: ${combined}`,
        );
      }
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

  test("--repos-only yields the プロジェクト heading, then only KIND=new rows", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seed(h.db);
      h.close();

      const { stdout } = runList(sb, ["--repos-only"]);
      const lines = stdout.split("\n").filter(Boolean);
      assert.equal(lines[0].split("\t")[3], "separator:-");
      assert.equal(flat(lines[0].split("\t")[0]), "──────── プロジェクト ────────");
      for (const l of lines.slice(1)) {
        const kind = l.split("\t")[3] ?? "";
        assert.ok(kind.startsWith("new:"), `expected new:*, got ${kind}`);
      }
      assert.ok(lines.length >= 2);
    } finally {
      await sb.cleanup();
    }
  });

  test("nested repos follow their parent, indented, with a dim （parent） hint", async () => {
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
      const rows = cols(stdout);
      assert.deepEqual(
        rows.map((r) => [r[3], indentOf(r[0]), flat(r[0])]),
        [
          ["separator:-", 0, "──────── プロジェクト ────────"],
          ["new:Aardvark", 0, "📁 Aardvark"],
          ["new:Series", 0, "📁 Series"],
          ["new:Mid", 3, "📁 Mid （Series）"],
          ["new:Zeta", 3, "📁 Zeta （Series）"],
          ["new:Inner", 6, "📁 Inner （Zeta）"],
          // A string prefix of /home/u/series, but a sibling folder.
          ["new:Series Other", 0, "📁 Series Other"],
          // Its parent is disabled and not listed, so it stays at the top.
          ["new:Visible", 0, "📁 Visible"],
        ],
      );
      // The hint is dimmed, not plain text; no tree glyphs are drawn.
      assert.ok(stdout.includes("\x1b[2m（Series）\x1b[0m"), "parent hint should be dim");
      assert.ok(!rows.some((r) => /[├└│‹›]/.test(r[0])), "no tree glyphs");
    } finally {
      await sb.cleanup();
    }
  });

  test("deep nesting: each child right after its parent's earlier children, one indent step per level", async () => {
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
      assert.deepEqual(
        cols(stdout).map((r) => [r[3], indentOf(r[0]), flat(r[0])]),
        [
          ["separator:-", 0, "──────── プロジェクト ────────"],
          ["new:Root", 0, "📁 Root"],
          ["new:A", 3, "📁 A （Root）"],
          ["new:A1", 6, "📁 A1 （A）"],
          ["new:A1x", 9, "📁 A1x （A1）"],
          ["new:A2", 6, "📁 A2 （A）"],
          ["new:B", 3, "📁 B （Root）"],
          ["new:B1", 6, "📁 B1 （B）"],
          ["new:Solo", 0, "📁 Solo"],
        ],
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("launch: false renders a group:<name> header under グループ; children show their label and nest under it", async () => {
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

      assert.deepEqual(rows[0].slice(3), ["separator:-", "", ""]);
      assert.equal(flat(rows[0][0]), "──────── グループ ────────");
      const header = rows[1];
      assert.equal(header[3], "group:Studio");
      assert.equal(flat(header[0]), "🎬 Studio 制作チーム");
      assert.equal(header[1], "制作チーム");
      assert.equal(header[2], "", "a header carries no badges");
      assert.equal(header[4], "/home/u/studio", "CWD carries the path (for ^I / preview)");
      assert.equal(header[5], "", "a header has no command");

      assert.deepEqual(
        rows.slice(2, 5).map((r) => [indentOf(r[0]), flat(r[0]), r[3], r[5]]),
        [
          [3, "📱 App team アプリ app/ （Studio）", "new:Studio-app", "claude"],
          // （Studio） would only repeat the row's own label — omitted.
          [3, "🎬 Studio 統括 hq/", "new:Studio-hq", "claude"],
          [3, "🌐 Web team サイト web/ （Studio）", "new:Studio-web", "claude"],
        ],
      );
      assert.equal(flat(rows[5][0]), "──────── プロジェクト ────────");

      const zed = rows.find((r) => r[3] === "new:Zed")!;
      assert.ok(!zed[0].includes("\x1b[2J"), "raw ESC from the label must not reach fzf");
      assert.equal(flat(zed[0]), "📁 Evil [2JLabel");
      assert.equal(flat(rows.find((r) => r[3] === "new:Zz")![0]), "📁 Zz");

      // A session row names the group and the repo's label; the key keeps the uuid.
      const session = rows.find((r) => r[3] === "resume:ebebebeb-0000-4000-8000-000000000000")!;
      assert.equal(flat(session[0]), "💬 たった今 Studio・Web team landing page");
      assert.deepEqual(session.slice(4), ["/home/u/studio/web", "claude"]);
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
      // No launch column: the parent is an ordinary project, not a group.
      assert.deepEqual(
        rows.map((r) => [indentOf(r[0]), flat(r[0]), r[3]]),
        [
          [0, "──────── プロジェクト ────────", "separator:-"],
          [0, "🎬 Studio 制作チーム", "new:Studio"],
          [3, "📱 Studio-app アプリ app/ （Studio）", "new:Studio-app"],
          [3, "🎬 Studio-hq 統括 hq/ （Studio）", "new:Studio-hq"],
          [3, "🌐 Studio-web サイト web/ （Studio）", "new:Studio-web"],
        ],
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("--sessions-only yields the 前の会話のつづき heading, then only KIND=resume rows", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seed(h.db);
      h.close();

      const { stdout } = runList(sb, ["--sessions-only"]);
      const lines = stdout.split("\n").filter(Boolean);
      assert.equal(lines[0].split("\t")[3], "separator:-");
      assert.equal(flat(lines[0].split("\t")[0]), "──────── 前の会話のつづき ────────");
      for (const l of lines.slice(1)) {
        const kind = l.split("\t")[3] ?? "";
        assert.ok(kind.startsWith("resume:"), `expected resume:*, got ${kind}`);
      }
      assert.ok(lines.length >= 2);
    } finally {
      await sb.cleanup();
    }
  });

  test("the badge column stays empty, even for a repo with many services and changes", async () => {
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
      // The simple look shows no badges; column 3 is kept for the row's shape.
      assert.equal(heavy!.split("\t").length, 6);
      assert.equal(heavy!.split("\t")[2], "");
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Preview pane for group headers / labelled repos (bin/ccs-preview.ts)
// ---------------------------------------------------------------------------

function runPreview(sb: ListSandbox, kindKey: string, cwd: string): string {
  const res = spawnSync(process.execPath, [PREVIEW_TS, kindKey, cwd], {
    env: inJapanese({
      ...process.env,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    }),
    encoding: "utf-8",
  });
  return (res.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ccs-preview — group header & label", () => {
  test("new:<name> is titled with the label; without a label, with the name", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      upsertRepo(h.db, { ...repoRow("Zz", "/home/u/zz"), label: " \t " });
      h.close();

      const titled = runPreview(sb, "new:Studio-web", "/home/u/studio/web");
      assert.equal(titled.split("\n")[1], "  ✨ Web team で、新しく Claude Code を始めます");
      const unlabelled = runPreview(sb, "new:Zz", "/home/u/zz");
      assert.equal(unlabelled.split("\n")[1], "  ✨ Zz で、新しく Claude Code を始めます");
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
  return inJapanese(env);
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
    ["-c", `set -o pipefail; "$0" "$@" | ${reader}`, process.execPath, LIST_TS, ...args],
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

describe("ccs-list — pipe delivery", () => {
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
      // two headings + alpha + seeded session + SESSIONS (~150 KB in total)
      assert.equal(
        rows.length,
        2 + 1 + 1 + SESSIONS,
        `got ${rows.length} rows / ${Buffer.byteLength(stdout)} bytes`,
      );
      assert.ok(stdout.endsWith("\n"), "last row must be complete");
      for (const row of rows) {
        assert.equal(row.split("\t").length, 6, `truncated row: ${row}`);
      }
      assert.deepEqual(
        rows.map((r) => r.split("\t")[3]).filter((k) => !k.startsWith("resume:")),
        ["separator:-", "new:alpha", "separator:-"],
      );
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
      const scan = spawnSync(process.execPath, [SCAN_TS, "--quiet"], {
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
      assert.deepEqual(kinds, ["separator:-", ...expected]);
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
// The simple look (the only one since v0.6.0) — list rows and preview cards
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

describe("ccs-list — simple rows", () => {
  test("groups first, then projects, then conversations — each under a heading row", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const res = runList(sb, []);
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

  test("launch columns: cwd and command (groups have none)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const rows = cols(runList(sb, []).stdout);
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
      const rows = cols(runList(sb, []).stdout);
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
      const reposOnly = cols(runList(sb, ["--repos-only"]).stdout);
      assert.ok(!reposOnly.some((r) => plain(r[0]).includes("前の会話")));
      const sessionsOnly = cols(runList(sb, ["--sessions-only"]).stdout);
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
      const rows = cols(runList(sb2, []).stdout);
      assert.deepEqual(rows.map((r) => r[3]), ["separator:-", "new:solo"]);
      assert.match(plain(rows[0][0]), /プロジェクト/);
    } finally {
      await sb2.cleanup();
    }
  });

  test("--print-ui is gone; --print-settings prints update_check only, whatever an old cache says about ui", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      // What a v0.5 scan left behind.
      setMeta(h.db, "defaults_ui", "classic");
      setMeta(h.db, "defaults_update_check", "off");
      h.close();
      const settings = runList(sb, ["--print-settings"]);
      assert.equal(settings.code, 0, settings.stderr);
      assert.equal(settings.stdout, "update_check=off\n");
      // --print-ui is no flag any more: no mode line, the rows as without it.
      const printUi = runList(sb, ["--print-ui"]);
      const plainRun = runList(sb, []);
      assert.equal(printUi.code, 0, printUi.stderr);
      assert.doesNotMatch(printUi.stdout, /^(?:ui=)?(?:classic|simple)$/m);
      assert.deepEqual(cols(printUi.stdout).map((r) => r[3]), cols(plainRun.stdout).map((r) => r[3]));
      assert.equal(cols(plainRun.stdout)[0][3], "separator:-", "the stored classic opens nothing classic");
    } finally {
      await sb.cleanup();
    }
  });

  test("--ui=classic, --ui=simple or none: the same simple rows (ccs-list ignores --ui=)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedSimple(h.db);
      h.close();
      const none = runList(sb, []);
      assert.equal(none.code, 0, none.stderr);
      for (const arg of ["--ui=classic", "--ui=simple", "--ui=fancy"]) {
        const res = runList(sb, [arg]);
        assert.equal(res.code, 0, `${arg}: ${res.stderr}`);
        assert.deepEqual(cols(res.stdout).map((r) => [r[3], flat(r[0])]), cols(none.stdout).map((r) => [r[3], flat(r[0])]), arg);
      }
      const rows = cols(none.stdout);
      // Groups first under their heading; no tree glyphs, no badges.
      assert.deepEqual(rows.slice(0, 2).map((r) => r[3]), ["separator:-", "group:Studio"]);
      assert.ok(!rows.some((r) => /[├└│‹›]/.test(plain(r[0]))), "no tree glyphs");
      assert.ok(rows.every((r) => r[2] === ""), "no badges");
    } finally {
      await sb.cleanup();
    }
  });
});

describe("ccs-preview (cards, the only preview)", () => {
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
      const out = runPreview(sb, "new:site", join(sb.home, "work", "site"));
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
      const out = runPreview(sb, "new:gone", join(sb.home, "nowhere"));
      assert.match(out, /このフォルダが見つかりません。repos\.yml の path を確かめてください/);
      assert.match(out, /Enter を押すと、いまいるフォルダで Claude Code が開きます/);
    } finally {
      await sb.cleanup();
    }
  });

  test("group: is a heading that points to the projects inside (its own children only)", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedStudio(h.db);
      // Deeper repos belong to their own parent, not to the header.
      upsertRepo(h.db, repoRow("Studio-web-docs", "/home/u/studio/web/docs"));
      h.close();
      const out = runPreview(sb, "group:Studio", "/home/u/studio");
      assert.match(out, /📂 グループ「Studio」/);
      assert.match(out, /\n {2}制作チーム\n/);
      assert.match(out, /ここは見出しです。開くときは、下のプロジェクトをえらんでください/);
      assert.match(out, /中のプロジェクト（3）/);
      const entries = out
        .split("\n")
        .filter((l) => /^ {5}\S/.test(l))
        .map((l) => l.trim().replace(/\s+/g, " "));
      assert.deepEqual(entries, ["📱 App team アプリ app/", "🎬 Studio 統括 hq/", "🌐 Web team サイト web/"]);
      assert.doesNotMatch(out, /launch: false|not launchable|Entries|Studio-web-docs/);
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
      const out = runPreview(sb, `resume:${uuid}`, "/home/u/alpha");
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
      assert.match(runPreview(sb, "separator:-", ""), /ここは区切りの行です/);
      // No state.db at all.
      assert.match(
        runPreview(sb, "new:x", "/home/u/x"),
        /まだ一覧の準備ができていません。\n {2}いちど Esc でやめて、ccs --refresh と打ってください。/,
      );
    } finally {
      await sb.cleanup();
    }
  });
});

describe("ccs-list — display hardening", () => {
  test("a group label with $& / $' is drawn literally, and an escape in the icon is neutralized", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      upsertRepo(h.db, { ...repoRow("G", "/home/u/g"), label: "R$&D $' $$", icon: "\x1b[31m🎬", launch: 0 });
      upsertRepo(h.db, repoRow("G-a", "/home/u/g/a"));
      h.close();
      const rows = cols(runList(sb, []).stdout);
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

describe("lead: true (v0.3.1)", () => {
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
      const rows = cols(runList(sb, ["--repos-only"]).stdout);
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

  test("cards: the group card lists the lead first as 👑 （統括）; the lead's own card says so", async () => {
    const sb = await makeListSandbox();
    try {
      const h = openDb(sb.dbPath);
      seedLead(h.db);
      h.close();
      const group = runPreview(sb, "group:Studio", "/home/u/studio");
      const entries = group.split("\n").filter((l) => /^ {5}\S/.test(l)).map((l) => l.trim());
      assert.match(entries[0], /^👑 Studio .*（統括）$/);
      assert.match(entries[1], /App team/);
      const card = runPreview(sb, "new:Studio-hq", "/home/u/studio/hq");
      assert.match(card, /👑 このグループの統括です/);
    } finally {
      await sb.cleanup();
    }
  });
});
