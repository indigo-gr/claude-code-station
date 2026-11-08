/**
 * The simple look on a real fzf, in a real pseudo-terminal (v0.3.0).
 *
 * test/tty/ccs_tty.py runs bin/ccs on a pty of a fixed size, keeps a small
 * VT100 model of the screen, types keys and returns the screen text. The
 * claude command is a stub that records where it was launched; fzf, tsx and
 * the scan are the real ones, on a sandbox HOME with fictional repos.
 *
 * Skipped (with the reason) when python3, tsx or fzf >= 0.61 is missing —
 * the stub-fzf tests in ccs-shell.test.ts cover the flags without a TTY.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEAD_REGISTRY, startRegistry, waitFor } from "./tty/fake_registry.ts";

// CCS_TEST_BIN: run the same screens against another build (an older tag, an
// installed tarball) to compare; the default is this checkout.
const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const LIST_TS = fileURLToPath(new URL("../bin/ccs-list.ts", import.meta.url));
const HARNESS = fileURLToPath(new URL("./tty/ccs_tty.py", import.meta.url));

function skipReason(): string | false {
  if (spawnSync("python3", ["--version"]).status !== 0) return "python3 not on PATH";
  if (spawnSync("tsx", ["--version"]).status !== 0) return "tsx not on PATH";
  const v = spawnSync("fzf", ["--version"], { encoding: "utf-8" });
  const m = /^(\d+)\.(\d+)/.exec(v.stdout ?? "");
  if (v.status !== 0 || !m) return "fzf not on PATH";
  const [maj, min] = [Number(m[1]), Number(m[2])];
  if (maj === 0 && min < 61) return `fzf ${m[0]} < 0.61`;
  return false;
}

interface TtySandbox {
  root: string;
  home: string;
  stubBin: string;
  claudeLog: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

const SESSION = "cccccccc-0000-0000-0000-000000000001";

async function makeTtySandbox(extraRepos = 0): Promise<TtySandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-tty-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const claudeLog = join(root, "claude.log");
  const extraNames = Array.from({ length: extraRepos }, (_, i) => `proj-${String(i).padStart(2, "0")}`);
  for (const d of ["studio/app", "studio/web", "notes", ".config/ccs", ".claude/projects/p1", "stub", ...extraNames]) {
    await mkdir(join(home, d), { recursive: true });
  }
  await mkdir(stubBin, { recursive: true });
  await writeFile(
    join(stubBin, "claude"),
    `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> "${claudeLog}"\n`,
    { mode: 0o755 },
  );
  // Fictional data only (test fixtures ship with the public repo).
  await writeFile(
    join(home, ".config", "ccs", "repos.yml"),
    `version: 1
defaults:
  ui: simple
repos:
  - name: Studio
    path: ~/studio
    icon: "🎬"
    description: 制作チーム
    launch: false
  - name: Studio-app
    path: ~/studio/app
    label: App team
    description: アプリ
  - name: Studio-web
    path: ~/studio/web
    label: Web team
    description: 会社のサイト
  - name: notes
    path: ~/notes
    description: その日の作業のまとめ
${extraNames.map((n) => `  - name: ${n}\n    path: ~/${n}\n`).join("")}`,
  );
  const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
  const jsonl = [
    { type: "user", sessionId: SESSION, cwd: join(home, "studio", "web"), timestamp: ts, message: { role: "user", content: "トップの文字を大きくしたい" } },
    { type: "assistant", sessionId: SESSION, cwd: join(home, "studio", "web"), timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "直しました" }] } },
  ];
  await writeFile(
    join(home, ".claude", "projects", "p1", `${SESSION}.jsonl`),
    jsonl.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };
  // On a pty bin/ccs really would ask the registry. Tests never leave this
  // machine: the off switch for the screens, and a dead address behind it. The
  // update notice has its own tests, against a local server.
  env.CCS_NO_UPDATE_CHECK = "1";
  env.CCS_UPDATE_REGISTRY = DEAD_REGISTRY;
  delete env.CCS_UI;
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  delete env.FZF_DEFAULT_OPTS;
  delete env.FZF_DEFAULT_COMMAND;
  return {
    root,
    home,
    stubBin,
    claudeLog,
    env,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface TtyResult {
  snaps: Record<string, string[]>;
  frames: Record<string, string[]>;
  wraps: Record<string, number>;
  times: Record<string, number>;
  exit: number | null;
  tail: string[];
  error: string | null;
}

type Step =
  | { wait: string; timeout?: number }
  | { wait_gone: string; timeout?: number }
  | { send: string }
  | { settle: number; timeout?: number }
  | { snap: string }
  | { exit: number };

async function runTty(
  sb: TtySandbox,
  size: [number, number],
  steps: Step[],
  args: string[] = [],
  terminal: { ambiguous?: 1 | 2; wide?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TtyResult> {
  const script = join(sb.root, `steps-${Date.now()}-${Math.random()}.json`);
  await writeFile(script, JSON.stringify(steps));
  const widths = [
    ...(terminal.ambiguous ? ["--ambiguous", String(terminal.ambiguous)] : []),
    ...(terminal.wide ? ["--wide", terminal.wide] : []),
  ];
  const res = spawnSync(
    "python3",
    ["-I", "-B", HARNESS, "--cols", String(size[0]), "--rows", String(size[1]), ...widths, "--script", script, "--", "bash", CCS_BIN, ...args],
    { encoding: "utf-8", env: { ...sb.env, ...terminal.env }, cwd: sb.home, timeout: 120_000 },
  );
  assert.equal(res.status, 0, `harness failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as TtyResult;
}

const ENTER = "\r";
const ESC = "\u001b";
const DOWN = "\u001b[B";
const CTRL_U = "\u0015";

/** Index of the box whose top border carries `label` (the guide line also says えらぶ). */
function boxTop(screen: string[], label: string): number {
  return screen.findIndex((l) => l.includes("╭") && l.includes(`  ${label}  `));
}

/** Rows of the "えらぶ" box (between its top border and the next bottom border). */
function listRows(screen: string[]): string[] {
  const top = boxTop(screen, "えらぶ");
  const rows: string[] = [];
  for (let i = top + 1; i < screen.length; i++) {
    if (/╰/.test(screen[i])) break;
    rows.push(screen[i]);
  }
  return rows;
}

const OPEN: Step[] = [{ wait: "えらぶ", timeout: 30 }, { wait: "中のプロジェクト", timeout: 30 }, { settle: 0.8 }];

const reason = skipReason();
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8")).version as string;
const HOLDER = "INDIGO GROUP LLC.";
const TAG = `ccs v${VERSION}`;
const UPGRADE = "npm install -g @indigo-gr/claude-code-station";

describe("bin/ccs --ui=simple on a real fzf (pty)", { skip: reason }, () => {
  test("120x36: the frame, the four labels, groups first, cursor off the heading", async () => {
    const sb = await makeTtySandbox();
    try {
      const r = await runTty(sb, [120, 36], [...OPEN, { snap: "open" }, { send: ESC }, { exit: 15 }]);
      assert.equal(r.error, null, r.tail.join("\n"));
      const screen = r.snaps.open;
      const text = screen.join("\n");
      for (const s of ["Claude Code をはじめる", "さがす", "えらぶ", "中身", "Enter: ひらく   ↑↓ かマウス: えらぶ   Esc: やめる", "ここに文字を打つと、しぼりこめます"]) {
        assert.ok(text.includes(s), `missing ${s}\n${text}`);
      }
      const rows = listRows(screen);
      const idx = (s: string) => rows.findIndex((l) => l.includes(s));
      assert.ok(idx("グループ") >= 0 && idx("グループ") < idx("プロジェクト"), rows.join("\n"));
      assert.ok(idx("プロジェクト") < idx("前の会話のつづき"), rows.join("\n"));
      assert.match(rows[idx("グループ") + 1], /▶ 🎬 Studio/, "cursor starts on the group, not the heading");
      assert.ok(!/[├└]/.test(rows.join("\n")), "no tree glyphs");
      assert.equal(r.exit, 0);
      assert.ok(r.tail.some((l) => l.includes("やめました。もう一度ひらくときは ccs と打ってください。")));
    } finally {
      await sb.cleanup();
    }
  });

  test("typing the group's name keeps the group, its projects, then their conversations; Enter on the header explains", async () => {
    const sb = await makeTtySandbox();
    try {
      const r = await runTty(sb, [120, 36], [
        ...OPEN,
        { send: "Studio" },
        { settle: 1.0 },
        { snap: "filtered" },
        { send: ENTER },
        { wait: "ここは見出しです。下の行をえらんでください", timeout: 10 },
        { snap: "on_header" },
        { send: DOWN + DOWN },
        { wait: "Enter: ひらく", timeout: 10 },
        { settle: 0.8 },
        { send: ENTER },
        { exit: 20 },
      ]);
      assert.equal(r.error, null, r.tail.join("\n"));
      const rows = listRows(r.snaps.filtered).filter((l) => /\S/.test(l.replace(/[│▌]/g, "")));
      assert.match(rows[0], /▶ 🎬 Studio/);
      assert.match(rows[1], /App team/);
      assert.match(rows[2], /Web team/);
      assert.match(rows[3], /💬 3 時間前 +Studio・Web team/);
      assert.ok(!rows.some((l) => l.includes("notes")), rows.join("\n"));
      assert.equal(r.exit, 0);
      const log = (await readFile(sb.claudeLog, "utf-8")).trim();
      assert.equal(log, `${join(sb.home, "studio", "web")}|`, "Down twice from the header = Web team");
      assert.ok(r.tail.some((l) => l.includes("🚀 Claude Code を開きます")));
    } finally {
      await sb.cleanup();
    }
  });

  test("no match: the guide line says so, Enter does nothing, Esc leaves cleanly", async () => {
    const sb = await makeTtySandbox();
    try {
      const r = await runTty(sb, [120, 36], [
        ...OPEN,
        { send: "zzqqxx" },
        { wait: "見つかりません。delete キーで文字を消してください", timeout: 10 },
        // fzf fires zero, then result, then focus: the message has to outlast them.
        { settle: 1.0 },
        { snap: "no_match" },
        { send: ENTER },
        { settle: 0.8 },
        { snap: "after_enter" },
        { send: CTRL_U },
        { wait: "Enter: ひらく", timeout: 10 },
        { send: ESC },
        { exit: 15 },
      ]);
      assert.equal(r.error, null, r.tail.join("\n"));
      assert.ok(r.snaps.no_match.join("\n").includes("見つかりません"), r.snaps.no_match.join("\n"));
      assert.ok(r.snaps.after_enter.join("\n").includes("さがす"), "still open after Enter");
      assert.equal(r.exit, 0);
      assert.ok(!(await readFile(sb.claudeLog, "utf-8").catch(() => "")), "nothing launched");
    } finally {
      await sb.cleanup();
    }
  });

  test("80x24: the preview moves below and the list keeps 8 rows", async () => {
    const sb = await makeTtySandbox();
    try {
      // The lower preview is short: wait for the card's title, not its end.
      const r = await runTty(sb, [80, 24], [
        { wait: "えらぶ", timeout: 30 },
        { wait: "グループ「Studio」", timeout: 30 },
        { settle: 0.8 },
        { snap: "open" },
        { send: ESC },
        { exit: 15 },
      ]);
      assert.equal(r.error, null, r.tail.join("\n"));
      const screen = r.snaps.open;
      const listTop = boxTop(screen, "えらぶ");
      const previewTop = boxTop(screen, "中身");
      assert.ok(previewTop > listTop, `preview below the list\n${screen.join("\n")}`);
      assert.ok(listRows(screen).length >= 8, screen.join("\n"));
      assert.ok(screen.some((l) => l.includes("Enter: ひらく")), "guide line visible");
    } finally {
      await sb.cleanup();
    }
  });

  test("fzf --filter on the simple rows: the group's name selects exactly the group's rows", async () => {
    const sb = await makeTtySandbox();
    try {
      const scan = spawnSync(
        "tsx",
        [fileURLToPath(new URL("../bin/ccs-scan.ts", import.meta.url)), "--force", "--quiet"],
        { env: sb.env, encoding: "utf-8" },
      );
      assert.equal(scan.status, 0, scan.stderr);
      const list = spawnSync("tsx", [LIST_TS, "--ui=simple"], { env: sb.env, encoding: "utf-8" });
      assert.equal(list.status, 0, list.stderr);
      const filtered = spawnSync(
        "fzf",
        ["--filter", "Studio", "--no-sort", "--ansi", "--delimiter", "\t", "--with-nth", "1"],
        { input: list.stdout, encoding: "utf-8", env: sb.env },
      );
      const keys = filtered.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[3]);
      assert.deepEqual(keys, ["group:Studio", "new:Studio-app", "new:Studio-web", `resume:${SESSION}`]);
    } finally {
      await sb.cleanup();
    }
  });
});

/**
 * Every look, at sizes down to 40 columns, on a terminal that draws © in one
 * cell and on one that draws it in two.
 *
 * fzf counts © as one cell whatever RUNEWIDTH_EASTASIAN says (its East Asian
 * width is Neutral), so the second case is a terminal that disagrees with fzf;
 * --wide makes the harness behave like that terminal.
 *
 * LIST_ROWS_BASE is what v0.3.3 showed on the same fixture: a new line on the
 * screen must not take rows away from the list. Regenerate it by running this
 * file with CCS_TEST_BIN pointing at the v0.3.3 bin/ccs and CCS_TTY_SHOW=1.
 */
const LOOKS = ["simple", "classic"] as const;
const SIZES: Array<[number, number]> = [[120, 36], [80, 24], [80, 16], [60, 24], [40, 24], [40, 16]];
const LIST_ROWS_BASE: Record<string, number> = {
  "simple 120x36": 28,
  "simple 80x24": 8,
  "simple 80x16": 3,
  "simple 60x24": 8,
  "simple 40x24": 8,
  "simple 40x16": 3,
  "classic 120x36": 22,
  "classic 80x24": 13,
  "classic 80x16": 10,
  "classic 60x24": 13,
  "classic 40x24": 13,
  "classic 40x16": 10,
};
// A classic row starts with the gutter or the pointer. Matching names instead
// would also count the preview pane beside the list.
const CLASSIC_ROW = /^│ [▌>▶] /;

function countListRows(look: string, screen: string[]): number {
  if (look === "simple") return listRows(screen).length;
  return screen.filter((l) => CLASSIC_ROW.test(l)).length;
}

async function measure(look: string, size: [number, number], terminal: Parameters<typeof runTty>[4] = {}) {
  const sb = await makeTtySandbox(30);
  try {
    const first = look === "simple" ? "えらぶ" : "ccs>";
    return await runTty(
      sb,
      size,
      [{ wait: first, timeout: 30 }, { settle: 1.0 }, { snap: "open" }, { send: ESC }, { exit: 15 }],
      [`--ui=${look}`],
      terminal,
    );
  } finally {
    await sb.cleanup();
  }
}

describe("the screen at every size (pty)", { skip: reason }, () => {
  for (const look of LOOKS) {
    for (const size of SIZES) {
      const name = `${look} ${size[0]}x${size[1]}`;
      test(`${name}: frame holds and the list keeps its rows`, async (t) => {
        const plain = await measure(look, size);
        const wide = await measure(look, size, { wide: "©" });
        for (const [kind, r] of [["plain", plain], ["wide ©", wide]] as const) {
          assert.equal(r.error, null, `${kind}\n${r.tail.join("\n")}`);
          const screen = r.snaps.open;
          const rows = countListRows(look, screen);
          t.diagnostic(`${name} ${kind}: list rows=${rows} frame problems=${r.frames.open.length} wraps=${r.wraps.open}`);
          if (process.env.CCS_TTY_SHOW) t.diagnostic("\n" + screen.join("\n"));
          assert.deepEqual(r.frames.open, [], `${kind}\n${screen.join("\n")}`);
          if (!process.env.CCS_TEST_BIN) {
            assert.ok(screen.join("\n").includes(TAG), `${kind}: no version\n${screen.join("\n")}`);
            assert.ok(screen.join("\n").includes(`© ${HOLDER}`), `${kind}: no holder\n${screen.join("\n")}`);
          }
          assert.equal(r.wraps.open, 0, `${kind}: a line ran past the right edge\n${screen.join("\n")}`);
          const base = LIST_ROWS_BASE[name];
          if (base !== undefined) {
            assert.ok(rows >= base, `${kind}: ${rows} list rows, v0.3.3 had ${base}\n${screen.join("\n")}`);
          }
        }
      });
    }
  }
});

// The top border carries the label. Enter on a heading, an empty result and a
// copy all replace the HEADER (change-header); none of them may touch the label.
function assertLabel(screen: string[], what: string): void {
  const text = screen.join("\n");
  assert.ok(screen[0].includes(TAG) || text.includes(`─ ${TAG}`), `${what}: no version\n${text}`);
  assert.ok(text.includes(`Copyright © ${HOLDER}`), `${what}: no holder\n${text}`);
}

describe("the label at the widths where it changes (pty)", { skip: reason }, () => {
  // The exact forms at these widths are in ccs-shell.test.ts; here a real fzf has
  // to draw them. 37 and 39 are the narrowest for "© holder", 47 and 49 for
  // "Copyright © holder", 73 for the title (simple), each with the one below.
  const WIDTHS: Record<string, number[]> = {
    simple: [30, 38, 39, 48, 49, 72, 73],
    classic: [30, 36, 37, 46, 47],
  };
  for (const look of LOOKS) {
    for (const cols of WIDTHS[look]) {
      test(`${look} ${cols} columns: the corners survive and the version shows`, async () => {
        const r = await measure(look, [cols, 24]);
        assert.equal(r.error, null, r.tail.join("\n"));
        const text = r.snaps.open.join("\n");
        assert.deepEqual(r.frames.open, [], text);
        assert.ok(text.includes(TAG), text);
      });
    }
  }

  test("classic: the guide line follows the real width, and an exported COLUMNS wins", async () => {
    const guide = async (cols: number, env: NodeJS.ProcessEnv = {}) => {
      const r = await measure("classic", [cols, 24], { env });
      assert.equal(r.error, null, r.tail.join("\n"));
      return r.snaps.open.join("\n");
    };
    assert.ok((await guide(80)).includes("Enter: launch"), "80 columns: the long guide");
    assert.ok((await guide(79)).includes("⏎launch"), "79 columns: the short guide");
    const forced = await guide(120, { COLUMNS: "60" });
    assert.ok(forced.includes("⏎launch"), forced);
    assert.ok(forced.includes(`${TAG}  Copyright © ${HOLDER}`), forced);
  });
});

describe("the label stays when the header changes (pty)", { skip: reason }, () => {
  async function withClipboardStub(sb: TtySandbox): Promise<string> {
    const log = join(sb.root, "clipboard.log");
    await writeFile(join(sb.stubBin, "pbcopy"), `#!/usr/bin/env bash\ncat >> "${log}"\n`, { mode: 0o755 });
    return log;
  }

  test("simple: heading, empty result, copy", async () => {
    const sb = await makeTtySandbox();
    try {
      await withClipboardStub(sb);
      const r = await runTty(sb, [120, 36], [
        ...OPEN,
        { snap: "open" },
        { send: ENTER },
        { wait: "ここは見出しです", timeout: 10 },
        { snap: "heading" },
        { send: "zzqqxx" },
        { wait: "見つかりません", timeout: 10 },
        { settle: 1.0 },
        { snap: "empty" },
        { send: CTRL_U },
        { wait: "Enter: ひらく", timeout: 10 },
        { send: DOWN },
        { settle: 0.5 },
        { send: "\u0019" }, // Ctrl-Y
        { wait: "コピーしました", timeout: 10 },
        { snap: "copied" },
        { send: ESC },
        { exit: 15 },
      ]);
      assert.equal(r.error, null, r.tail.join("\n"));
      for (const name of ["open", "heading", "empty", "copied"]) {
        assertLabel(r.snaps[name], name);
        assert.deepEqual(r.frames[name], [], `${name}\n${r.snaps[name].join("\n")}`);
      }
      assert.ok(r.snaps.empty.join("\n").includes("見つかりません"), "the message stays");
      const base = listRows(r.snaps.open).length;
      for (const name of ["heading", "empty", "copied"]) {
        assert.equal(listRows(r.snaps[name]).length, base, `${name}: the list changed size`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("classic: copy", async () => {
    const sb = await makeTtySandbox();
    try {
      await withClipboardStub(sb);
      const r = await runTty(
        sb,
        [120, 36],
        [
          { wait: "ccs>", timeout: 30 },
          { settle: 1.0 },
          { snap: "open" },
          { send: "\u0019" },
          { wait: "Copied command", timeout: 10 },
          { snap: "copied" },
          { send: ESC },
          { exit: 15 },
        ],
        ["--ui=classic"],
      );
      assert.equal(r.error, null, r.tail.join("\n"));
      for (const name of ["open", "copied"]) {
        assertLabel(r.snaps[name], name);
        assert.deepEqual(r.frames[name], [], `${name}\n${r.snaps[name].join("\n")}`);
      }
    } finally {
      await sb.cleanup();
    }
  });
});

/**
 * The update check as it really starts: bin/ccs on a pty, against a fake
 * registry on 127.0.0.1. Nothing here leaves the machine.
 */
describe("the update check on a pty (fake registry)", { skip: reason }, () => {
  const DAY = 86_400;
  const HOUR = 3_600;
  const nowS = () => Math.floor(Date.now() / 1000);
  const cachePath = (sb: TtySandbox) => join(sb.home, ".cache", "ccs", "update-check");
  const seed = async (sb: TtySandbox, latest: string, checked: number) => {
    await mkdir(join(sb.home, ".cache", "ccs"), { recursive: true });
    await writeFile(cachePath(sb), `latest=${latest}\nchecked=${checked}\n`);
  };
  const on = (registry: string) => ({ env: { CCS_NO_UPDATE_CHECK: undefined, CCS_UPDATE_REGISTRY: registry } });
  const openAndClose = (look: string): Step[] => [
    { wait: look === "simple" ? "えらぶ" : "ccs>", timeout: 30 },
    { snap: "first" },
    { settle: 1.0 },
    { snap: "open" },
    { send: ESC },
    { exit: 15 },
  ];
  const readCache = (sb: TtySandbox) => readFile(cachePath(sb), "utf-8").catch(() => "");
  const checkedIn = (text: string) => Number(/^checked=(\d+)$/m.exec(text)?.[1] ?? "0");

  test("no cache: one request, and the answer shows on the next launch, not this one", async () => {
    const sb = await makeTtySandbox();
    const reg = await startRegistry('body:{"latest":"99.0.0"}', join(sb.root, "registry.log"));
    try {
      const first = await runTty(sb, [120, 36], openAndClose("simple"), ["--ui=simple"], on(reg.url));
      assert.equal(first.error, null, first.tail.join("\n"));
      assert.equal(first.exit, 0);
      assert.ok(!first.snaps.open.join("\n").includes("が出ています"), "no notice on the launch that asks");
      assert.ok(!first.tail.join("\n").includes(UPGRADE), first.tail.join("\n"));
      await waitFor("the cache", async () => (await readCache(sb)).includes("latest=99.0.0"));
      assert.equal((await stat(cachePath(sb))).mode & 0o777, 0o600);
      assert.equal((await reg.requests()).length, 1);

      const second = await runTty(sb, [120, 36], openAndClose("simple"), ["--ui=simple"], on(reg.url));
      assert.equal(second.error, null, second.tail.join("\n"));
      assert.ok(second.snaps.open.join("\n").includes("ccs v99.0.0 が出ています"), second.snaps.open.join("\n"));
      assert.ok(second.tail.join("\n").includes("上げるには"), second.tail.join("\n"));
      assert.deepEqual(second.frames.open, [], second.snaps.open.join("\n"));
      await new Promise((res) => setTimeout(res, 800));
      assert.equal((await reg.requests()).length, 1, "at most once a day");
    } finally {
      reg.stop();
      await sb.cleanup();
    }
  });

  for (const [name, checked, expected] of [
    ["23 hours old: no request", () => nowS() - 23 * HOUR, 0],
    ["a day old: one request", () => nowS() - DAY - 5, 1],
    ["from the future: one request", () => nowS() + DAY, 1],
    ["not a number: one request", () => NaN, 1],
  ] as const) {
    test(`checked ${name}`, async () => {
      const sb = await makeTtySandbox();
      const reg = await startRegistry('body:{"latest":"99.0.0"}', join(sb.root, "registry.log"));
      try {
        const value = checked();
        await mkdir(join(sb.home, ".cache", "ccs"), { recursive: true });
        await writeFile(cachePath(sb), `latest=\nchecked=${Number.isNaN(value) ? "soon" : value}\n`);
        const r = await runTty(sb, [120, 36], openAndClose("simple"), ["--ui=simple"], on(reg.url));
        assert.equal(r.error, null, r.tail.join("\n"));
        if (expected) await waitFor("a request", async () => (await reg.requests()).length > 0);
        else await new Promise((res) => setTimeout(res, 1000));
        assert.equal((await reg.requests()).length, expected);
      } finally {
        reg.stop();
        await sb.cleanup();
      }
    });
  }

  for (const look of ["simple", "classic"]) {
    test(`${look}: the off switch makes no request and writes no cache`, async () => {
      const sb = await makeTtySandbox();
      const reg = await startRegistry('body:{"latest":"99.0.0"}', join(sb.root, "registry.log"));
      try {
        const r = await runTty(sb, [120, 36], openAndClose(look), [`--ui=${look}`], {
          env: { CCS_NO_UPDATE_CHECK: "1", CCS_UPDATE_REGISTRY: reg.url },
        });
        assert.equal(r.error, null, r.tail.join("\n"));
        await new Promise((res) => setTimeout(res, 1000));
        assert.deepEqual(await reg.requests(), []);
        assert.equal(await readCache(sb), "");
      } finally {
        reg.stop();
        await sb.cleanup();
      }
    });

    test(`${look}: a registry that never answers does not delay the picker or its exit`, async () => {
      const off = await makeTtySandbox();
      const sb = await makeTtySandbox();
      const reg = await startRegistry("hang", join(sb.root, "registry.log"));
      try {
        const baseline = await runTty(off, [120, 36], openAndClose(look), [`--ui=${look}`]);
        assert.equal(baseline.error, null, baseline.tail.join("\n"));
        // Stay open past the request's limit. ccs leads this pty's session, so
        // closing earlier would hang up the check too; a real terminal's leader
        // is the shell, and the check outlives ccs there.
        const steps = openAndClose(look);
        steps.splice(2, 1, { settle: 4.5 });
        const r = await runTty(sb, [120, 36], steps, [`--ui=${look}`], on(reg.url));
        assert.equal(r.error, null, r.tail.join("\n"));
        assert.equal(r.exit, 0);
        // The request's limit is 3 s: waiting for it would show as at least that.
        const delay = r.times.first - baseline.times.first;
        assert.ok(delay < 2, `opened ${delay.toFixed(2)} s later than with the check off`);
        assert.equal((await reg.requests()).length, 1, "the request was really made");
        const text = await waitFor("the failed attempt", async () => {
          const t = await readCache(sb);
          return t.includes("checked=") && t;
        });
        const expected = nowS() - DAY + HOUR;
        assert.ok(Math.abs(checkedIn(text) - expected) <= 30, text);
      } finally {
        reg.stop();
        await off.cleanup();
        await sb.cleanup();
      }
    });

    test(`${look}: offline, the picker opens and a known newer version still shows`, async () => {
      const sb = await makeTtySandbox();
      try {
        await seed(sb, "99.0.0", nowS() - 2 * DAY);
        const r = await runTty(sb, [120, 36], openAndClose(look), [`--ui=${look}`], on(DEAD_REGISTRY));
        assert.equal(r.error, null, r.tail.join("\n"));
        assert.equal(r.exit, 0);
        const shown = (r.snaps.open.join("\n") + r.tail.join("\n"));
        assert.ok(shown.includes("99.0.0"), shown);
        const text = await waitFor("the failed attempt", async () => {
          const t = await readCache(sb);
          return checkedIn(t) > nowS() - DAY && t;
        });
        assert.ok(text.includes("latest=99.0.0"), text);
      } finally {
        await sb.cleanup();
      }
    });

    test(`${look}: same or older shows nothing`, async () => {
      const sb = await makeTtySandbox();
      try {
        for (const latest of [VERSION, "0.0.1"]) {
          await seed(sb, latest, nowS());
          const r = await runTty(sb, [120, 36], openAndClose(look), [`--ui=${look}`], on(DEAD_REGISTRY));
          assert.equal(r.error, null, r.tail.join("\n"));
          const shown = r.snaps.open.join("\n") + r.tail.join("\n");
          assert.ok(!shown.includes(UPGRADE) && !shown.includes("が出ています"), `${latest}\n${shown}`);
        }
      } finally {
        await sb.cleanup();
      }
    });
  }

  for (const size of [[80, 24], [44, 24], [43, 24], [40, 24]] as Array<[number, number]>) {
    for (const look of ["simple", "classic"]) {
      test(`${look} ${size[0]}x${size[1]} with a notice: frame and list rows hold`, async () => {
        const plain = await makeTtySandbox(30);
        const sb = await makeTtySandbox(30);
        try {
          await seed(sb, "10.20.30", nowS());
          const a = await runTty(plain, size, openAndClose(look), [`--ui=${look}`]);
          const b = await runTty(sb, size, openAndClose(look), [`--ui=${look}`], on(DEAD_REGISTRY));
          assert.equal(b.error, null, b.tail.join("\n"));
          assert.deepEqual(b.frames.open, [], b.snaps.open.join("\n"));
          assert.equal(
            countListRows(look, b.snaps.open),
            countListRows(look, a.snaps.open),
            b.snaps.open.join("\n"),
          );
        } finally {
          await plain.cleanup();
          await sb.cleanup();
        }
      });
    }
  }

  test("--version and --help on a pty make no request", async () => {
    const sb = await makeTtySandbox();
    const reg = await startRegistry('body:{"latest":"99.0.0"}', join(sb.root, "registry.log"));
    try {
      for (const flag of ["--version", "--help"]) {
        const r = await runTty(sb, [120, 36], [{ exit: 15 }], [flag], on(reg.url));
        assert.equal(r.exit, 0, flag);
      }
      await new Promise((res) => setTimeout(res, 1000));
      assert.deepEqual(await reg.requests(), []);
    } finally {
      reg.stop();
      await sb.cleanup();
    }
  });

  test("stdout not a terminal: no request", async () => {
    const sb = await makeTtySandbox();
    const reg = await startRegistry('body:{"latest":"99.0.0"}', join(sb.root, "registry.log"));
    try {
      // A stub fzf: the real one would wait for a terminal that is not there.
      await writeFile(
        join(sb.stubBin, "fzf"),
        '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "0.74.5 (fake)"; exit 0; fi\ncat >/dev/null\nexit 1\n',
        { mode: 0o755 },
      );
      const res = spawnSync("bash", ["-c", `bash "${CCS_BIN}" --ui=classic --no-scan </dev/null | cat`], {
        encoding: "utf-8",
        env: { ...sb.env, CCS_NO_UPDATE_CHECK: undefined, CCS_UPDATE_REGISTRY: reg.url },
        cwd: sb.home,
        timeout: 30_000,
      });
      assert.notEqual(res.status, null, "finished");
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(await reg.requests(), []);
    } finally {
      reg.stop();
      await sb.cleanup();
    }
  });
});
