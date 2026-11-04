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
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CCS_BIN = fileURLToPath(new URL("../bin/ccs", import.meta.url));
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

async function makeTtySandbox(): Promise<TtySandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-tty-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const claudeLog = join(root, "claude.log");
  for (const d of ["studio/app", "studio/web", "notes", ".config/ccs", ".claude/projects/p1", "stub"]) {
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
`,
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
): Promise<TtyResult> {
  const script = join(sb.root, `steps-${Date.now()}-${Math.random()}.json`);
  await writeFile(script, JSON.stringify(steps));
  const res = spawnSync(
    "python3",
    ["-I", HARNESS, "--cols", String(size[0]), "--rows", String(size[1]), "--script", script, "--", "bash", CCS_BIN, ...args],
    { encoding: "utf-8", env: sb.env, cwd: sb.home, timeout: 120_000 },
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
        { send: ENTER },
        { settle: 0.8 },
        { snap: "after_enter" },
        { send: CTRL_U },
        { wait: "Enter: ひらく", timeout: 10 },
        { send: ESC },
        { exit: 15 },
      ]);
      assert.equal(r.error, null, r.tail.join("\n"));
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
