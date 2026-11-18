/**
 * Tests for the bash surfaces: bin/ccs (non-interactive paths) and
 * bin/ccs-delete.sh — the ONLY destructive code path in ccs, which had zero
 * test coverage until the 2026-06-12 review (review C-2 / "untested dangerous
 * areas").
 *
 * No bats dependency: node:test drives bash via spawnSync, with stdin piped
 * for the `read -p` prompts and HOME/XDG redirected to a sandbox so the
 * ccs-delete-session.ts cache cleanup can never touch the real state.db.
 * The interactive fzf flow itself is out of scope (needs a TTY harness);
 * the row dispatch after the pick is covered with a stub fzf on PATH.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  chmod,
  access,
  cp,
  symlink,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openDb, upsertRepo } from "../bin/ccs-db.ts";

const CCS_BIN = fileURLToPath(new URL("../bin/ccs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version as string;
const HOLDER = "INDIGO GROUP LLC.";
const DELETE_SH = fileURLToPath(new URL("../bin/ccs-delete.sh", import.meta.url));

const UUID = "abcdef01-2345-6789-abcd-ef0123456789";

/**
 * The parent's environment with the language decided here. Nothing that picks
 * the language leaks in from the shell the tests run in (CCS_LANG,
 * CCS_LANG_RESOLVED, LC_ALL, LC_MESSAGES, LANGUAGE), and the locale is a fixed
 * English UTF-8 one, so `lang` alone decides. bin/ccs reads CCS_LANG; a part run
 * on its own (ccs-delete.sh) reads CCS_LANG_RESOLVED.
 */
function langEnv(lang: "ja" | "en", how: "CCS_LANG" | "CCS_LANG_RESOLVED" = "CCS_LANG"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["CCS_LANG", "CCS_LANG_RESOLVED", "LC_ALL", "LC_MESSAGES", "LANGUAGE"]) delete env[key];
  env.LANG = "en_US.UTF-8";
  env[how] = lang;
  return env;
}

interface ShellSandbox {
  root: string;
  home: string;
  projectsDir: string;
  cleanup: () => Promise<void>;
}

async function makeShellSandbox(): Promise<ShellSandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-shell-"));
  const home = join(root, "home");
  const projectsDir = join(home, ".claude", "projects");
  await mkdir(projectsDir, { recursive: true });
  return {
    root,
    home,
    projectsDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runDelete(
  sb: ShellSandbox,
  args: string[],
  input: string,
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("bash", [DELETE_SH, ...args], {
    encoding: "utf-8",
    input,
    env: {
      ...langEnv("en", "CCS_LANG_RESOLVED"),
      HOME: sb.home,
      XDG_CONFIG_HOME: join(sb.home, ".config"),
      XDG_CACHE_HOME: join(sb.home, ".cache"),
    },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// bin/ccs — non-interactive paths
// ---------------------------------------------------------------------------

describe("bin/ccs (non-interactive)", () => {
  test("--version prints version and exits 0 (before dependency checks)", () => {
    const res = spawnSync("bash", [CCS_BIN, "--version"], { encoding: "utf-8", env: langEnv("en") });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^ccs v\d+\.\d+\.\d+/);
  });

  test("--help prints usage and exits 0", () => {
    const res = spawnSync("bash", [CCS_BIN, "--help"], { encoding: "utf-8", env: langEnv("en") });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /CCS_CMD/);
    assert.match(res.stdout, /--auto-discover/);
  });

  test("works when invoked through a symlink (npm global-install layout)", async () => {
    // `npm install -g github:...` puts a SYMLINK to bin/ccs on PATH; the
    // script must resolve $0 back to the package bin/ to find its sibling
    // modules (and ccs-tsx.sh, which starts them on Node).
    const sb = await makeShellSandbox();
    try {
      const linkDir = join(sb.root, "fake-global-bin");
      await mkdir(linkDir, { recursive: true });
      const link = join(linkDir, "ccs");
      const { symlink } = await import("node:fs/promises");
      await symlink(CCS_BIN, link);

      const res = spawnSync("bash", [link, "init"], {
        encoding: "utf-8",
        env: {
          ...langEnv("en"),
          HOME: sb.home,
          XDG_CONFIG_HOME: join(sb.home, ".config"),
          XDG_CACHE_HOME: join(sb.home, ".cache"),
        },
      });
      // `init` exercises the resolved SCRIPT_DIR (ccs-tsx.sh + ccs-init.ts path) —
      // a broken symlink resolution fails here with "No such file".
      assert.equal(res.status, 0, `symlinked init failed: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Config ready:/);
    } finally {
      await sb.cleanup();
    }
  });

  test("init (no flag) scaffolds the config template in a fresh HOME", async () => {
    const sb = await makeShellSandbox();
    try {
      const res = spawnSync("bash", [CCS_BIN, "init"], {
        encoding: "utf-8",
        env: {
          ...langEnv("en"),
          HOME: sb.home,
          XDG_CONFIG_HOME: join(sb.home, ".config"),
          XDG_CACHE_HOME: join(sb.home, ".cache"),
        },
      });
      assert.equal(res.status, 0, `init failed: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Config ready:/);
      assert.equal(
        await exists(join(sb.home, ".config", "ccs", "repos.yml")),
        true,
        "repos.yml template must be created",
      );
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — what happens after the pick (stub fzf + stub claude)
// ---------------------------------------------------------------------------

// The fzf UI itself needs a TTY, but everything after the pick does not. A
// stub `fzf` on PATH prints the row whose KIND:KEY is $FAKE_FZF_PICK (as if
// the user pressed Enter on it) and records the arguments bin/ccs passed; a
// stub `claude` records where and how it was launched. Every call, --version
// included, is also logged to $FAKE_FZF_CALLS when it is set.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ -n "\${FAKE_FZF_CALLS:-}" ]]; then printf '%s\\n' "$*" >> "$FAKE_FZF_CALLS"; fi
if [[ "\${1:-}" == "--version" ]]; then echo "\${FAKE_FZF_VERSION} (fake)"; exit 0; fi
printf '%s\\n' "$@" > "$FAKE_FZF_ARGS"
rows=$(cat)
while IFS= read -r row; do
  if [[ "$(printf '%s' "$row" | cut -f4)" == "$FAKE_FZF_PICK" ]]; then
    printf '%s\\n' "$row"; exit 0
  fi
done <<< "$rows"
exit 1
`;
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$FAKE_CLAUDE_LOG"
`;

interface PickSandbox extends ShellSandbox {
  stubBin: string;
  fzfArgs: string;
  fzfCalls: string;
  claudeLog: string;
}

async function makePickSandbox(): Promise<PickSandbox> {
  const sb = await makeShellSandbox();
  const stubBin = join(sb.root, "stub-bin");
  await mkdir(stubBin, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });

  // A group header with one launchable child. The child has NO description,
  // so its row has an empty column 2 — the tab-collapse regression case.
  await mkdir(join(sb.home, "studio", "web"), { recursive: true });
  const h = openDb(join(sb.home, ".cache", "ccs", "state.db"));
  const base = {
    description: "",
    command: "claude",
    cwd: null,
    tags_json: "[]",
    icon: "📁",
    disabled: 0 as const,
    scan_enabled: 1 as const,
    custom_json: "{}",
  };
  upsertRepo(h.db, {
    ...base,
    name: "Studio",
    path: join(sb.home, "studio"),
    description: "制作チーム",
    launch: 0,
    config_hash: "a",
  });
  upsertRepo(h.db, {
    ...base,
    name: "Studio-web",
    path: join(sb.home, "studio", "web"),
    label: "Web team",
    config_hash: "b",
  });
  h.close();

  return {
    ...sb,
    stubBin,
    fzfArgs: join(sb.root, "fzf-args.txt"),
    fzfCalls: join(sb.root, "fzf-calls.txt"),
    claudeLog: join(sb.root, "claude.log"),
  };
}

function runPick(
  sb: PickSandbox,
  pick: string,
  args: string[],
  fzfVersion = "0.70.0",
): { stdout: string; stderr: string; code: number } {
  // The launcher's words are checked in Japanese.
  const env: NodeJS.ProcessEnv = {
    ...langEnv("ja"),
    PATH: `${sb.stubBin}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    FAKE_FZF_PICK: pick,
    FAKE_FZF_ARGS: sb.fzfArgs,
    FAKE_FZF_CALLS: sb.fzfCalls,
    FAKE_FZF_VERSION: fzfVersion,
    FAKE_CLAUDE_LOG: sb.claudeLog,
  };
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  const res = spawnSync("bash", [CCS_BIN, "--no-scan", ...args], {
    encoding: "utf-8",
    env,
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

describe("bin/ccs (after the pick)", () => {
  test("picking a group header launches nothing and exits 0 (--new and mixed mode)", async () => {
    const sb = await makePickSandbox();
    try {
      for (const args of [["--new"], []]) {
        const res = runPick(sb, "group:Studio", args);
        assert.equal(res.code, 0, `${args}: ${res.stdout}${res.stderr}`);
        assert.doesNotMatch(res.stdout + res.stderr, /開きます|Launching|Could not parse|Unknown row kind/);
      }
      assert.equal(await exists(sb.claudeLog), false, "claude must not be launched");
    } finally {
      await sb.cleanup();
    }
  });

  test("a NEW row with an empty DESCRIPTION column still launches in its cwd", async () => {
    // `IFS=$'\t' read` merged the empty column into its neighbours, so
    // KIND_KEY came back holding the cwd ("Unknown row kind").
    const sb = await makePickSandbox();
    try {
      const res = runPick(sb, "new:Studio-web", ["--new"]);
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      // The line before the launch is Japanese and names the folder from ~.
      assert.equal(res.stdout, "🚀 Claude Code を開きます（~/studio/web）\n");
      const { readFile } = await import("node:fs/promises");
      const log = (await readFile(sb.claudeLog, "utf-8")).trim();
      assert.ok(log.endsWith(`${join("studio", "web")}|`), `claude ran as: ${log}`);
    } finally {
      await sb.cleanup();
    }
  });

  test("fzf 0.61 and newer get enter/double-click bindings that keep the picker open on heading rows", async () => {
    const sb = await makePickSandbox();
    try {
      const { readFile } = await import("node:fs/promises");
      // On a group header, a separator or an empty result the key flashes a
      // one-line reason in the header instead of accepting; any other row is
      // accepted. The test runs through `bash -c` so a non-POSIX $SHELL cannot
      // break it.
      const bind = (key: string) =>
        `${key}:transform:bash -c 'case $1 in ` +
        `group:*) echo "change-header(  ここは見出しです。下の行をえらんでください)" ;; ` +
        `separator:*) echo "change-header(  ここは区切りの行です。上か下の行をえらんでください)" ;; ` +
        `"") echo "change-header(  見つかりません。delete キーで文字を消してください)" ;; ` +
        `*) echo accept ;; esac' _ {4}`;

      for (const version of ["0.61.0", "0.70.0"]) {
        await rm(sb.fzfArgs, { force: true });
        // A group header that still comes back (an fzf that ignores the
        // binding): the post-pick check is the safety net and exits quietly.
        const res = runPick(sb, "group:Studio", ["--new"], version);
        assert.equal(res.code, 0, `fzf ${version}: ${res.stdout}${res.stderr}`);
        const args = (await readFile(sb.fzfArgs, "utf-8")).split("\n");
        assert.ok(args.includes(bind("enter")), `enter binding expected on fzf ${version}`);
        assert.ok(args.includes(bind("double-click")), `double-click binding expected on fzf ${version}`);
        assert.equal(await exists(sb.claudeLog), false);
      }
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs-delete.sh — the destructive path
// ---------------------------------------------------------------------------

describe("ccs-delete.sh", () => {
  test("rejects a non-UUID argument (injection gate)", async () => {
    const sb = await makeShellSandbox();
    try {
      const res = runDelete(sb, ["../../etc/passwd"], "\n");
      assert.equal(res.code, 1);
      assert.match(res.stdout, /^❌ Not a session ID$/m);
      // Prompts are printed explicitly to stderr (prompt_read), so they are
      // visible even with piped stdin — `read -p` used to drop them here.
      assert.match(res.stderr, /Press Enter to continue/);
    } finally {
      await sb.cleanup();
    }
  });

  test("reports session-not-found for a valid UUID with no file", async () => {
    const sb = await makeShellSandbox();
    try {
      const res = runDelete(sb, [UUID], "\n");
      assert.equal(res.code, 1);
      assert.match(res.stdout, /^❌ The conversation's file was not found$/m);
    } finally {
      await sb.cleanup();
    }
  });

  test("confirmed delete removes the JSONL and the subagent dir (audit L-2 path)", async () => {
    const sb = await makeShellSandbox();
    try {
      const projDir = join(sb.projectsDir, "-some-proj");
      await mkdir(join(projDir, UUID), { recursive: true }); // subagent dir
      await writeFile(join(projDir, UUID, "sub.jsonl"), "{}\n");
      const target = join(projDir, `${UUID}.jsonl`);
      await writeFile(target, '{"type":"user"}\n');

      // "y" answers the confirm prompt; trailing newline feeds "Press Enter".
      const res = runDelete(sb, [UUID], "y\n\n");
      assert.equal(res.code, 0, `unexpected failure: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /✅ Deleted/);
      assert.match(
        res.stderr,
        /Delete this conversation\? \(y\/N\):/,
        "confirm prompt must be visible on piped stdin (prompt_read)",
      );
      assert.equal(await exists(target), false, "JSONL must be deleted");
      assert.equal(
        await exists(join(projDir, UUID)),
        false,
        "subagent dir must be deleted",
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("declined delete keeps the file", async () => {
    const sb = await makeShellSandbox();
    try {
      const projDir = join(sb.projectsDir, "-some-proj");
      await mkdir(projDir, { recursive: true });
      const target = join(projDir, `${UUID}.jsonl`);
      await writeFile(target, '{"type":"user"}\n');

      const res = runDelete(sb, [UUID], "n\n\n");
      assert.equal(res.code, 0);
      assert.match(res.stdout, /Cancelled/);
      assert.equal(await exists(target), true, "file must survive a decline");
    } finally {
      await sb.cleanup();
    }
  });

  test("C-2 regression: rm failure is reported, prompt still runs, exit 1", async () => {
    const sb = await makeShellSandbox();
    const projDir = join(sb.projectsDir, "-some-proj");
    try {
      await mkdir(projDir, { recursive: true });
      const target = join(projDir, `${UUID}.jsonl`);
      await writeFile(target, '{"type":"user"}\n');
      // Read-only directory → rm of a child fails with EACCES (non-root).
      await chmod(projDir, 0o555);

      const res = runDelete(sb, [UUID], "y\n\n");
      assert.equal(res.code, 1, "rm failure must exit 1, not die under set -e");
      assert.match(
        res.stderr,
        /❌ Could not delete: .*\.jsonl/,
        `the failure must be reported (was silent before C-2): ${res.stdout}${res.stderr}`,
      );
      // The "Press Enter" pause is now printed explicitly to stderr
      // (prompt_read), so its visibility is assertable even on piped stdin —
      // this is what keeps the fzf execute pane open on the error.
      assert.match(res.stderr, /Press Enter to continue/);
      assert.equal(await exists(target), true, "file is still there");
    } finally {
      await chmod(projDir, 0o755).catch(() => {});
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — the list's look (one look since v0.6.0), stub fzf
// ---------------------------------------------------------------------------

function runSimple(
  sb: PickSandbox,
  pick: string,
  args: string[],
  opts: { fzfVersion?: string; env?: Record<string, string | undefined>; bin?: string; cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  // The launcher's words are checked in Japanese; opts.env can change that.
  const env: NodeJS.ProcessEnv = {
    ...langEnv("ja"),
    PATH: `${sb.stubBin}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    FAKE_FZF_PICK: pick,
    FAKE_FZF_ARGS: sb.fzfArgs,
    FAKE_FZF_CALLS: sb.fzfCalls,
    FAKE_FZF_VERSION: opts.fzfVersion ?? "0.74.5",
    FAKE_CLAUDE_LOG: sb.claudeLog,
    // The label depends on the width. Without this it would follow the terminal
    // the test suite happens to run in (bin/ccs asks /dev/tty).
    COLUMNS: "120",
  };
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  delete env.CCS_UI;
  delete env.CCS_NO_UPDATE_CHECK;
  delete env.CCS_UPDATE_REGISTRY;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const res = spawnSync("bash", [opts.bin ?? CCS_BIN, ...args], { encoding: "utf-8", env, cwd: opts.cwd });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? -1 };
}

async function fzfArgs(sb: PickSandbox): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(sb.fzfArgs, "utf-8")).split("\n");
}

const isSimpleArgs = (a: string[]) =>
  a.includes("--style=full:rounded") &&
  a.includes(`--border-label=  Claude Code をはじめる  ccs v${VERSION}  Copyright © ${HOLDER}  `) &&
  a.includes("--list-label=  えらぶ  ") &&
  a.includes("--input-label=  さがす  ") &&
  a.includes("--preview-label=  中身  ") &&
  a.includes("--ghost=ここに文字を打つと、しぼりこめます") &&
  a.includes("--prompt=🔎 ") &&
  a.includes("--highlight-line") &&
  a.includes("--with-nth=1") &&
  a.includes("--no-sort") &&
  !a.some((x) => x.startsWith("--prompt=ccs>")) &&
  !a.includes("--with-nth=1..3");

const UI_REMOVED =
  "[ccs] --ui= はなくなりました（v0.6.0 から見た目は 1 つだけです）。--ui= を付けずに ccs と打ってください（usage: unknown_option）";
const fzfTooOld = (v: string) =>
  `[ccs] ccs には fzf 0.61 以上が要ります（いまの fzf: ${v}）。fzf を新しくするには: brew upgrade fzf`;
const CLASSIC_DROPPED =
  "[ccs] defaults.ui: classic は v0.6.0 でなくなりました。いつもの見た目で開きます（使わずに続けます）";

async function readOr(p: string, fallback: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(p, "utf-8");
  } catch {
    return fallback;
  }
}

async function writeReposYml(sb: PickSandbox, uiLine: string | null): Promise<void> {
  await mkdir(join(sb.home, ".config", "ccs"), { recursive: true });
  const defaults = uiLine === null ? "" : `defaults:\n  ${uiLine}\n`;
  await writeFile(
    join(sb.home, ".config", "ccs", "repos.yml"),
    `version: 1\n${defaults}repos:\n  - name: Studio\n    path: ${join(sb.home, "studio")}\n    launch: false\n  - name: Studio-web\n    path: ${join(sb.home, "studio", "web")}\n`,
  );
}

describe("bin/ccs the list's look (stub fzf)", () => {
  test("opens the friendly frame and launches the pick", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"]);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      const a = await fzfArgs(sb);
      assert.ok(isSimpleArgs(a), a.join("\n"));
      // The preview always draws the card: no third argument picks a look.
      assert.ok(
        a.some((x) => /^--preview=bash '[^']*\/ccs-tsx\.sh' '[^']*\/ccs-preview\.(ts|js)' \{4\} \{5\}$/.test(x)),
        a.filter((x) => x.startsWith("--preview=")).join("\n"),
      );
      assert.ok(a.some((x) => x.startsWith("ctrl-r:")), "ctrl-r reloads the list");
      assert.ok(!a.some((x) => x.includes("--ui")), "nothing passes a look on");
      assert.ok(a.some((x) => x.startsWith("enter:transform:") && x.includes("change-header(  ここは見出しです")));
      assert.ok(a.includes("change:first"));
      assert.equal(res.stdout, "🚀 Claude Code を開きます（~/studio/web）\n");
      assert.equal(res.stderr, "");
      const { readFile } = await import("node:fs/promises");
      assert.ok((await readFile(sb.claudeLog, "utf-8")).trim().endsWith(`${join("studio", "web")}|`));
    } finally {
      await sb.cleanup();
    }
  });

  test("fzf older than 0.61: the list does not open, exit 1 with one line saying why", async () => {
    const sb = await makePickSandbox();
    try {
      for (const version of ["0.41.0", "0.44.1", "0.55.0", "0.60.0", "0.60.9"]) {
        await rm(sb.fzfCalls, { force: true });
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { fzfVersion: version });
        assert.equal(res.code, 1, `fzf ${version}: ${res.stdout}${res.stderr}`);
        assert.equal(res.stderr, `${fzfTooOld(version)}\n`, `fzf ${version}`);
        assert.equal(res.stdout, "", `fzf ${version}`);
        // fzf was only asked its version; the list never opened.
        const calls = (await readOr(sb.fzfCalls, "")).split("\n").filter((l) => l !== "");
        assert.ok(calls.length > 0 && calls.every((l) => l === "--version"), `fzf ${version}: ${calls.join(" / ")}`);
        assert.equal(await exists(sb.fzfArgs), false, `fzf ${version}: the list must not open`);
        assert.equal(await exists(sb.claudeLog), false, `fzf ${version}: nothing is launched`);
      }
      for (const version of ["0.61.0", "0.61.1", "0.74.5", "1.0.0"]) {
        await rm(sb.fzfArgs, { force: true });
        const res = runSimple(sb, "none", ["--no-scan"], { fzfVersion: version });
        assert.equal(res.code, 0, `fzf ${version}: ${res.stdout}${res.stderr}`);
        assert.doesNotMatch(res.stderr, /fzf 0\.61 以上が要ります/, `fzf ${version}`);
        assert.ok(isSimpleArgs(await fzfArgs(sb)), `fzf ${version} opens the list`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("--ui= with any value is a usage error: exit 2, one line, fzf is never called", async () => {
    const sb = await makePickSandbox();
    try {
      for (const value of ["x", "simple", "classic", "fancy", ""]) {
        for (const args of [[`--ui=${value}`], ["--no-scan", "--new", `--ui=${value}`]]) {
          const label = args.join(" ");
          const res = runSimple(sb, "new:Studio-web", args);
          assert.equal(res.code, 2, `${label}: ${res.stdout}${res.stderr}`);
          assert.equal(res.stderr, `${UI_REMOVED}\n`, label);
          assert.equal(res.stdout, "", label);
          assert.equal(await exists(sb.fzfCalls), false, `${label}: fzf must not be called at all`);
          assert.equal(await exists(sb.fzfArgs), false, label);
          assert.equal(await exists(sb.claudeLog), false, `${label}: nothing is launched`);
        }
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("CCS_UI is not read: any value leaves the screen and the launch as they are", async () => {
    const sb = await makePickSandbox();
    try {
      const run = async (env: Record<string, string | undefined>) => {
        await rm(sb.fzfArgs, { force: true });
        await rm(sb.claudeLog, { force: true });
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { env });
        return { ...res, args: await readOr(sb.fzfArgs, ""), launched: await readOr(sb.claudeLog, "") };
      };
      const plain = await run({ CCS_UI: undefined });
      assert.equal(plain.code, 0, plain.stderr);
      assert.ok(isSimpleArgs(plain.args.split("\n")));
      assert.notEqual(plain.launched, "");
      for (const value of ["classic", "simple", "fancy", ""]) {
        const withEnv = await run({ CCS_UI: value });
        assert.deepEqual(withEnv, plain, `CCS_UI=${JSON.stringify(value)}`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a defaults_ui left in the cache by an older version changes nothing", async () => {
    const sb = await makePickSandbox();
    try {
      const { setMeta } = await import("../bin/ccs-db.ts");
      const h = openDb(join(sb.home, ".cache", "ccs", "state.db"));
      setMeta(h.db, "defaults_ui", "classic");
      h.close();
      const res = runSimple(sb, "none", ["--no-scan"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stderr, "");
      assert.ok(isSimpleArgs(await fzfArgs(sb)));
    } finally {
      await sb.cleanup();
    }
  });

  test("repos.yml defaults.ui: simple or empty says nothing and opens the list", async () => {
    const sb = await makePickSandbox();
    try {
      for (const line of ["ui: simple", "ui:", "ui: null", null]) {
        await writeReposYml(sb, line);
        await rm(sb.claudeLog, { force: true });
        const res = runSimple(sb, "new:Studio-web", []);
        assert.equal(res.code, 0, `${line}: ${res.stderr}`);
        assert.equal(res.stderr, "", `${line}: a clean scan says nothing`);
        assert.ok(isSimpleArgs(await fzfArgs(sb)), String(line));
        assert.equal(res.stdout, "🚀 Claude Code を開きます（~/studio/web）\n", String(line));
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("repos.yml defaults.ui: classic warns once and opens the same list", async () => {
    const sb = await makePickSandbox();
    try {
      await writeReposYml(sb, "ui: classic");
      const res = runSimple(sb, "new:Studio-web", []);
      assert.equal(res.code, 0, res.stderr);
      const warned = res.stderr.split("\n").filter((l) => l.includes("defaults.ui"));
      assert.deepEqual(warned, [`    ${CLASSIC_DROPPED}`], res.stderr);
      assert.match(res.stderr, /^\[ccs\] 設定ファイルについてのお知らせです（このままでも使えます）。\n/);
      assert.doesNotMatch(res.stderr, /読めなかった|fatal/);
      const a = await fzfArgs(sb);
      assert.ok(isSimpleArgs(a), a.join("\n"));
      assert.equal(res.stdout, "🚀 Claude Code を開きます（~/studio/web）\n");
      const { readFile } = await import("node:fs/promises");
      assert.ok((await readFile(sb.claudeLog, "utf-8")).trim().endsWith(`${join("studio", "web")}|`));
    } finally {
      await sb.cleanup();
    }
  });

  test("repos.yml defaults.ui: another value is refused like any broken repos.yml", async () => {
    const sb = await makePickSandbox();
    try {
      await writeReposYml(sb, "ui: fancy");
      const res = runSimple(sb, "none", []);
      assert.equal(res.code, 0, res.stderr);
      assert.ok((await fzfArgs(sb)).some((x) => x.startsWith("--list-label=  えらぶ  ⚠️ 設定ファイルを読めませんでした")));
      assert.match(
        res.stderr,
        /設定ファイル（~\/\.config\/ccs\/repos\.yml）を読めなかったので、前の一覧を出しました。[^\n]*\n {4}\[ccs-scan\] fatal: .*repos\.yml: defaults\.ui は simple にしてください（いまの値: "fancy"）$/m,
      );
    } finally {
      await sb.cleanup();
    }
  });

  test("Esc (or no pick) says how to come back, and launches nothing", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "none", ["--no-scan"]);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /やめました。もう一度ひらくときは ccs と打ってください。/);
      assert.equal(await exists(sb.claudeLog), false);
    } finally {
      await sb.cleanup();
    }
  });

  test("nothing to open: a guide instead of an empty picker (per mode)", async () => {
    const sb = await makeShellSandbox();
    try {
      const stubBin = join(sb.root, "stub-bin");
      await mkdir(stubBin, { recursive: true });
      await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
      await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
      // A cache with only a group header: nothing launchable.
      await mkdir(join(sb.home, "studio"), { recursive: true });
      const h = openDb(join(sb.home, ".cache", "ccs", "state.db"));
      upsertRepo(h.db, {
        name: "Studio", path: join(sb.home, "studio"), description: "", command: "claude",
        cwd: null, tags_json: "[]", icon: "📁", disabled: 0, scan_enabled: 1, custom_json: "{}",
        launch: 0, config_hash: "a",
      });
      h.close();
      const psb: PickSandbox = {
        ...sb,
        stubBin,
        fzfArgs: join(sb.root, "fzf-args.txt"),
        fzfCalls: join(sb.root, "fzf-calls.txt"),
        claudeLog: join(sb.root, "claude.log"),
      };
      let res = runSimple(psb, "none", ["--no-scan"]);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /まだ一覧に出すプロジェクトがありません。\n {2}・ホームのフォルダから選んで足すには: ccs init --auto-discover/);
      assert.equal(await exists(psb.fzfArgs), false, "fzf is not opened");
      res = runSimple(psb, "none", ["--no-scan", "--resume"]);
      assert.match(res.stdout, /前の会話は、まだありません。/);
      res = runSimple(psb, "none", ["--no-scan", "."]);
      assert.match(res.stdout, /このフォルダでの前の会話は、まだありません。/);
    } finally {
      await sb.cleanup();
    }
  });

  test("a broken repos.yml: the frame warns while open and the reason is explained after it closes", async () => {
    const sb = await makePickSandbox();
    try {
      await mkdir(join(sb.home, ".config", "ccs"), { recursive: true });
      await writeFile(join(sb.home, ".config", "ccs", "repos.yml"), "version: 2\nrepos: []\n");
      const res = runSimple(sb, "none", []);
      assert.equal(res.code, 0, res.stderr);
      assert.ok((await fzfArgs(sb)).some((x) => x.startsWith("--list-label=  えらぶ  ⚠️ 設定ファイルを読めませんでした")));
      assert.match(
        res.stderr,
        /設定ファイル（~\/\.config\/ccs\/repos\.yml）を読めなかったので、前の一覧を出しました。下の行を直してから、もう一度 ccs と打ってください。\n {4}\[ccs-scan\] fatal: .*repos\.yml: version: 2 は使えません（使えるのは 1 だけです）$/m,
      );
      assert.doesNotMatch(res.stderr, /continuing with stale DB|scan failed/);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — version and copyright in the frame, stub fzf
// ---------------------------------------------------------------------------

/** Terminal cells of a label: the Japanese title is double width, © is not. */
const cells = (s: string) => [...s].reduce((n, c) => n + (c.codePointAt(0)! >= 0x3000 ? 2 : 1), 0);

/** The frame needs 2 cells on the left and 2 on the right beside the label. */
const widthFor = (label: string) => cells(label) + 4;

function labelForms(version: string): string[] {
  const pad = "  ";
  const tag = `ccs v${version}`;
  return [
    `${pad}Claude Code をはじめる  ${tag}  Copyright © ${HOLDER}${pad}`,
    `${pad}${tag}  Copyright © ${HOLDER}${pad}`,
    `${pad}${tag}  © ${HOLDER}${pad}`,
    `${pad}${tag}${pad}`,
  ];
}

function borderLabel(args: string[]): string | undefined {
  return args.find((a) => a.startsWith("--border-label="))?.slice("--border-label=".length);
}

const PACKAGE_NAME = "@indigo-gr/claude-code-station";
let buildCount = 0;

/**
 * A copy of bin/ with its own package.json (the way a clone runs in place), to
 * run other version numbers. `dir` is the clone's folder (default: a new one
 * under `root`).
 * `manifest`: the file's exact text (null = no file). A string with no newline
 * or brace is taken as a version number of this package.
 */
async function makeBuild(
  root: string,
  manifest: string | null,
  dir = join(root, `build-${++buildCount}`),
): Promise<string> {
  await cp(join(REPO_ROOT, "bin"), join(dir, "bin"), { recursive: true });
  await symlink(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  if (manifest !== null) {
    const text = /^[0-9]/.test(manifest)
      ? JSON.stringify({ name: PACKAGE_NAME, version: manifest }, null, 2) + "\n"
      : manifest;
    await writeFile(join(dir, "package.json"), text);
  }
  return join(dir, "bin", "ccs");
}

describe("bin/ccs version and copyright label (stub fzf)", () => {
  const forms = labelForms(VERSION);
  for (const [i, form] of forms.entries()) {
    test(`the longest label that fits, at its exact width (form ${i + 1})`, async () => {
      const sb = await makePickSandbox();
      try {
        const fits = widthFor(form);
        runSimple(sb, "new:Studio-web", ["--no-scan"], { env: { COLUMNS: String(fits) } });
        assert.equal(borderLabel(await fzfArgs(sb)), form, `${fits} columns`);
        if (i + 1 < forms.length) {
          runSimple(sb, "new:Studio-web", ["--no-scan"], { env: { COLUMNS: String(fits - 1) } });
          assert.equal(borderLabel(await fzfArgs(sb)), forms[i + 1], `${fits - 1} columns`);
        }
      } finally {
        await sb.cleanup();
      }
    });
  }

  test("the label sits at the same place and the words come from package.json", async () => {
    const sb = await makePickSandbox();
    try {
      for (const version of ["7.8.9", "123.456.789"]) {
        const bin = await makeBuild(sb.root, version);
        for (const form of labelForms(version)) {
          runSimple(sb, "new:Studio-web", ["--no-scan"], { bin, env: { COLUMNS: String(widthFor(form)) } });
          const a = await fzfArgs(sb);
          assert.equal(borderLabel(a), form);
          assert.ok(a.includes("--border-label-pos=3"));
        }
        assert.equal(runSimple(sb, "", ["--version"], { bin }).stdout.trim(), `ccs v${version}`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a width that is not a number falls back to asking the terminal, and never breaks", async () => {
    const sb = await makePickSandbox();
    try {
      for (const columns of ["abc", "0", "-5", "12x", ""]) {
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { env: { COLUMNS: columns } });
        assert.equal(res.code, 0, `COLUMNS=${columns}: ${res.stderr}`);
        assert.ok(borderLabel(await fzfArgs(sb))?.includes(`ccs v${VERSION}`), `COLUMNS=${columns}`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("--help and --version name the version and the holder", async () => {
    const sb = await makePickSandbox();
    try {
      const help = runSimple(sb, "", ["--help"]);
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes(`ccs v${VERSION}`), help.stdout);
      assert.ok(help.stdout.includes(`Copyright © ${HOLDER} MIT License.`), help.stdout);
      assert.ok(help.stdout.includes("CCS_NO_UPDATE_CHECK"), help.stdout);
      assert.equal(runSimple(sb, "", ["--version"]).stdout.trim(), `ccs v${VERSION}`);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — the update notice from the cache, stub fzf
// ---------------------------------------------------------------------------
// stdout is a pipe here, so bin/ccs never starts the check itself. The check on
// a real pty, against a fake registry, is in ccs-tty.test.ts.
//
// How to upgrade follows how ccs was installed. This checkout's bin/ccs is a
// clone run in place (cd, git pull, npm install); the npm command is for the
// package under node_modules, so the tests that read it run a copy laid out
// the way `npm install -g` lays it out.

const UPGRADE = "npm install -g @indigo-gr/claude-code-station";
const cloneUpgrade = (shown: string) => `cd ${shown} && git pull && npm install`;

/** The Node that bin/ccs finds on the same PATH (the stub folder has none). */
const NODE_NOW = (spawnSync("node", ["--version"], { encoding: "utf-8" }).stdout ?? "").trim().replace(/^v/, "");

/**
 * bin/ laid out as `npm install -g` does: <prefix>/lib/node_modules/<package>/bin
 * beside the package's package.json, with <prefix>/bin/ccs a symlink to it.
 * Node does not strip types under node_modules, so the modules are built to
 * .js here, with the same compiler options as the release build (rewritten
 * relative imports, no type check). Returns the symlink.
 */
async function makeNpmBuild(root: string, version: string): Promise<string> {
  const prefix = join(root, `npm-${++buildCount}`);
  const pkg = join(prefix, "lib", "node_modules", "@indigo-gr", "claude-code-station");
  await cp(join(REPO_ROOT, "bin"), join(pkg, "bin"), { recursive: true });
  await symlink(join(REPO_ROOT, "node_modules"), join(pkg, "node_modules"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }, null, 2) + "\n");
  const ts = (await import("typescript")).default;
  for (const file of await readdir(join(pkg, "bin"))) {
    if (!/^ccs-.*\.ts$/.test(file)) continue;
    const out = ts.transpileModule(await readFile(join(pkg, "bin", file), "utf-8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        rewriteRelativeImportExtensions: true,
      },
    }).outputText;
    assert.doesNotMatch(out, /(from|import)\s*\(?\s*["']\.{1,2}\/[^"']*\.ts["']/, `${file}: a .ts import is left`);
    await writeFile(join(pkg, "bin", file.replace(/\.ts$/, ".js")), out);
  }
  await mkdir(join(prefix, "bin"), { recursive: true });
  await symlink(join(pkg, "bin", "ccs"), join(prefix, "bin", "ccs"));
  return join(prefix, "bin", "ccs");
}

// One npm-layout copy for the tests that read the npm command.
let npmRoot = "";
let NPM_BIN = "";
before(async () => {
  npmRoot = await mkdtemp(join(tmpdir(), "ccs-shell-npm-"));
  NPM_BIN = await makeNpmBuild(npmRoot, VERSION);
});
after(async () => {
  if (npmRoot) await rm(npmRoot, { recursive: true, force: true });
});

async function writeUpdateCache(sb: PickSandbox, text: string): Promise<void> {
  await mkdir(join(sb.home, ".cache", "ccs"), { recursive: true });
  await writeFile(join(sb.home, ".cache", "ccs", "update-check"), text);
}
const freshCache = (latest: string) => `latest=${latest}\nchecked=${Math.floor(Date.now() / 1000)}\n`;

/** Any notice at all: the line after the picker, or the frame's label. */
function hasNotice(res: { stderr: string }, a: string[]): boolean {
  return res.stderr.includes("[ccs] 新しい ccs v") || a.some((x) => x.includes("が出ています"));
}

describe("bin/ccs update notice (stub fzf)", () => {
  test("the frame says so while open, the command is printed on one line after it closes", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
      assert.equal(res.code, 0, res.stderr);
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  ccs v99.0.0 が出ています  "));
      assert.deepEqual(
        res.stderr.split("\n").filter((l) => l.includes(UPGRADE)),
        [`[ccs] 新しい ccs v99.0.0 が出ています（いまは v${VERSION}）。上げるには: ${UPGRADE}`],
        res.stderr,
      );
      assert.doesNotMatch(res.stderr, /\[ccs\] Update v/, "no English notice line");
    } finally {
      await sb.cleanup();
    }
  });

  test("also printed when the picker is closed without choosing", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "no-such-row", ["--no-scan"], { bin: NPM_BIN });
      assert.equal(res.code, 0, res.stderr);
      assert.ok(res.stderr.includes(`上げるには: ${UPGRADE}\n`), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("under 44 columns the frame stays quiet, the command is still printed", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN, env: { COLUMNS: "44" } });
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  ccs v99.0.0 が出ています  "));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN, env: { COLUMNS: "43" } });
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  "));
      assert.ok(res.stderr.includes(`上げるには: ${UPGRADE}\n`), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("newer only, by number and not by text", async () => {
    const sb = await makePickSandbox();
    try {
      const bin = await makeBuild(sb.root, "0.10.2");
      for (const [latest, expected] of [
        ["0.10.3", true],
        ["0.11.0", true],
        ["1.0.0", true],
        ["00.10.3", true],
        ["0.10.2", false],
        ["0.10.1", false],
        ["0.9.99", false],
        ["0.0.0", false],
      ] as const) {
        await writeUpdateCache(sb, freshCache(latest));
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin });
        assert.equal(res.code, 0, res.stderr);
        assert.equal(hasNotice(res, await fzfArgs(sb)), expected, `latest ${latest} on 0.10.2`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a cache that is not a plain X.Y.Z shows nothing and runs nothing", async () => {
    const sb = await makePickSandbox();
    try {
      const pwned = join(sb.home, "pwned");
      for (const text of [
        "",
        "garbage",
        "latest=\nchecked=1\n",
        "latest=99.0.0-beta.1\nchecked=1\n",
        "latest=99.0\nchecked=1\n",
        "latest=99.0.0.1\nchecked=1\n",
        "latest=1000000000.0.0\nchecked=1\n",
        "latest=99.0.0;touch pwned\nchecked=1\n",
        "latest=$(touch pwned)\nchecked=1\n",
        "latest=`touch pwned`\nchecked=1\n",
        "latest=99.0.0'\nchecked=1\n",
        "latest=\u001b[31m99.0.0\nchecked=1\n",
        "\u0000\u0001\u0002",
      ]) {
        await writeUpdateCache(sb, text);
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"]);
        assert.equal(res.code, 0, `${JSON.stringify(text)}: ${res.stderr}`);
        assert.equal(hasNotice(res, await fzfArgs(sb)), false, JSON.stringify(text));
        assert.equal(await exists(pwned), false, JSON.stringify(text));
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("the off switch hides a notice the cache would give", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      for (const off of ["1", "0", "yes"]) {
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { env: { CCS_NO_UPDATE_CHECK: off } });
        assert.equal(hasNotice(res, await fzfArgs(sb)), false, `CCS_NO_UPDATE_CHECK=${off}`);
      }
      const empty = runSimple(sb, "new:Studio-web", ["--no-scan"], { env: { CCS_NO_UPDATE_CHECK: "" } });
      assert.equal(hasNotice(empty, await fzfArgs(sb)), true, "an empty value is not set");
    } finally {
      await sb.cleanup();
    }
  });

  test("a prerelease gets no notice", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const bin = await makeBuild(sb.root, "1.0.0-beta.1");
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(hasNotice(res, await fzfArgs(sb)), false);
    } finally {
      await sb.cleanup();
    }
  });

  // A copy install sits in someone else's directory: the package.json beside
  // bin/ may belong to another project, or be anything at all.
  for (const [name, text] of [
    ["another package's", JSON.stringify({ name: "someone-else", version: "5.5.5" }, null, 2) + "\n"],
    [
      "another package's that depends on this one",
      JSON.stringify({ name: "someone-else", version: "5.5.5", dependencies: { [PACKAGE_NAME]: "^1.0.0" } }, null, 2) + "\n",
    ],
    ["a nameless", JSON.stringify({ version: "5.5.5" }, null, 2) + "\n"],
    ["a version-less", JSON.stringify({ name: PACKAGE_NAME }, null, 2) + "\n"],
    ["a broken", '{"name": "@indigo-gr/claude\n{{{ not json'],
    ["an empty", ""],
    ["a binary", "\u0000\u0001\u0002\ufffd"],
  ] as const) {
    test(`${name} package.json beside bin/ means 0.0.0-dev, no notice, no stop`, async () => {
      const sb = await makePickSandbox();
      try {
        await writeUpdateCache(sb, freshCache("99.0.0"));
        const bin = await makeBuild(sb.root, text === "" ? "\n" : text);
        const version = runSimple(sb, "", ["--version"], { bin });
        assert.equal(version.code, 0, version.stderr);
        assert.equal(version.stdout.trim(), "ccs v0.0.0-dev");
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin });
        assert.equal(res.code, 0, res.stderr);
        // Node refuses to load a module under a package.json it cannot parse.
        // bin/package.json keeps it from reading this one, so the picker opens
        // here as anywhere else, and what it shows must not borrow a version.
        const args = await fzfArgs(sb);
        assert.ok(borderLabel(args)?.includes("ccs v0.0.0-dev"));
        assert.ok(!res.stdout.includes("ccs --refresh"), res.stdout);
        assert.equal(hasNotice(res, args), false);
      } finally {
        await sb.cleanup();
      }
    });
  }

  // install.sh and the README's manual install copy bin/ without package.json.
  test("a copy install runs as 0.0.0-dev and gets no notice", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const bin = await makeBuild(sb.root, null);
      assert.equal(runSimple(sb, "", ["--version"], { bin }).stdout.trim(), "ccs v0.0.0-dev");
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin });
      assert.equal(res.code, 0, res.stderr);
      assert.ok(borderLabel(await fzfArgs(sb))?.includes("ccs v0.0.0-dev"));
      assert.equal(hasNotice(res, await fzfArgs(sb)), false);
    } finally {
      await sb.cleanup();
    }
  });

  test("a directory or an unreadable file where the cache goes", async () => {
    const sb = await makePickSandbox();
    const cache = join(sb.home, ".cache", "ccs", "update-check");
    try {
      await mkdir(cache, { recursive: true });
      let res = runSimple(sb, "new:Studio-web", ["--no-scan"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(hasNotice(res, await fzfArgs(sb)), false);
      await rm(cache, { recursive: true });
      await writeUpdateCache(sb, freshCache("99.0.0"));
      await chmod(cache, 0o000);
      res = runSimple(sb, "new:Studio-web", ["--no-scan"]);
      assert.equal(res.code, 0, res.stderr);
    } finally {
      await chmod(cache, 0o600).catch(() => {});
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — the Node a newer version needs, from the cache, stub fzf
// ---------------------------------------------------------------------------
// The update check writes `node=X.Y.Z` (the floor in the new version's
// engines.node) only when it knows it. bin/ccs compares it with `node --version`
// on PATH, by number.

const nodeCache = (latest: string, node: string) => `${freshCache(latest)}node=${node}\n`;
const NODE_LABEL = "--list-label=  えらぶ  ccs v99.0.0 が出ています（先に Node を上げる）  ";
const PLAIN_LABEL = "--list-label=  えらぶ  ccs v99.0.0 が出ています  ";
const usualLine = (upgrade: string) =>
  `[ccs] 新しい ccs v99.0.0 が出ています（いまは v${VERSION}）。上げるには: ${upgrade}`;
const nodeLine = (needed: string, upgrade: string) =>
  `[ccs] 新しい ccs v99.0.0 が出ています（いまは v${VERSION}）。v99.0.0 には Node ${needed} 以上が要ります（いまの Node: ${NODE_NOW}）。先に Node を上げてから、ccs を上げてください: ${upgrade}`;
const noticeLines = (stderr: string) => stderr.split("\n").filter((l) => l.includes("[ccs] 新しい ccs v"));

/** Versions around the Node on PATH: newer and older by number, not by text. */
function nodeNeighbours(): { newer: string[]; notNewer: string[] } {
  const [maj, min, pat] = NODE_NOW.split(".").map(Number);
  const newer = [`${maj}.${min}.${pat + 1}`, `${maj}.${min}.${pat + 10}`, `${maj}.${min + 1}.0`, `${maj + 1}.0.0`, "99.0.0"];
  const notNewer = [NODE_NOW, `${maj}.${min}.0`, `${maj - 1}.99.99`, "0.0.1"];
  // 9 < 10 as numbers, "9" > "1" as text.
  if (min >= 10) notNewer.push(`${maj}.9.99`);
  if (pat >= 10) notNewer.push(`${maj}.${min}.9`);
  return { newer, notNewer };
}

describe("bin/ccs update notice: the Node the new version needs (stub fzf)", () => {
  test("the Node on PATH is a plain X.Y.Z (what these tests compare with)", () => {
    assert.match(NODE_NOW, /^\d+\.\d+\.\d+$/);
  });

  test("node= newer than this Node: the line says to upgrade Node first; the frame says so from 64 columns", async () => {
    const sb = await makePickSandbox();
    try {
      for (const needed of nodeNeighbours().newer) {
        await writeUpdateCache(sb, nodeCache("99.0.0", needed));
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
        assert.equal(res.code, 0, res.stderr);
        assert.deepEqual(noticeLines(res.stderr), [nodeLine(needed, UPGRADE)], `node=${needed}`);
        assert.ok((await fzfArgs(sb)).includes(NODE_LABEL), `node=${needed}`);
      }
      await writeUpdateCache(sb, nodeCache("99.0.0", "99.0.0"));
      for (const [columns, label] of [
        ["120", NODE_LABEL],
        ["64", NODE_LABEL],
        ["63", PLAIN_LABEL],
        ["44", PLAIN_LABEL],
        ["43", "--list-label=  えらぶ  "],
      ] as const) {
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN, env: { COLUMNS: columns } });
        assert.equal(res.code, 0, res.stderr);
        assert.ok((await fzfArgs(sb)).includes(label), `${columns} columns`);
        // The line after the picker does not depend on the width.
        assert.deepEqual(noticeLines(res.stderr), [nodeLine("99.0.0", UPGRADE)], `${columns} columns`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("node= the same as or older than this Node: the usual line and label", async () => {
    const sb = await makePickSandbox();
    try {
      for (const needed of nodeNeighbours().notNewer) {
        await writeUpdateCache(sb, nodeCache("99.0.0", needed));
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
        assert.equal(res.code, 0, res.stderr);
        assert.deepEqual(noticeLines(res.stderr), [usualLine(UPGRADE)], `node=${needed}`);
        assert.ok((await fzfArgs(sb)).includes(PLAIN_LABEL), `node=${needed}`);
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a node= that is not a plain X.Y.Z is ignored, and nothing in it runs", async () => {
    const sb = await makePickSandbox();
    try {
      const pwned = join(sb.root, "pwned");
      for (const value of [
        "99",
        "99.0",
        "v99.0.0",
        "99.0.0.1",
        "99.0.0 ",
        "-99.0.0",
        "1000000000.0.0",
        "",
        "99.0.0-rc.1",
        `$(touch ${pwned})`,
        `\`touch ${pwned}\``,
        `99.0.0;touch ${pwned}`,
        "\u001b[31m99.0.0",
      ]) {
        await writeUpdateCache(sb, nodeCache("99.0.0", value));
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
        assert.equal(res.code, 0, `${JSON.stringify(value)}: ${res.stderr}`);
        assert.deepEqual(noticeLines(res.stderr), [usualLine(UPGRADE)], JSON.stringify(value));
        assert.ok((await fzfArgs(sb)).includes(PLAIN_LABEL), JSON.stringify(value));
        assert.equal(await exists(pwned), false, JSON.stringify(value));
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("node= alone says nothing: no newer version, or the notice switched off", async () => {
    const sb = await makePickSandbox();
    try {
      for (const latest of [VERSION, "0.0.1"]) {
        await writeUpdateCache(sb, nodeCache(latest, "99.0.0"));
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
        assert.equal(res.code, 0, res.stderr);
        assert.equal(hasNotice(res, await fzfArgs(sb)), false, `latest ${latest}`);
        assert.doesNotMatch(res.stderr, /Node/, `latest ${latest}`);
      }
      await writeUpdateCache(sb, nodeCache("99.0.0", "99.0.0"));
      const off = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN, env: { CCS_NO_UPDATE_CHECK: "1" } });
      assert.equal(hasNotice(off, await fzfArgs(sb)), false);
      assert.doesNotMatch(off.stderr, /Node/);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — how to upgrade follows how ccs was installed, stub fzf
// ---------------------------------------------------------------------------

/**
 * bash's own reading of WORD with this HOME: how many words, and the first.
 * Only `set --` sees it; a command substitution in it would run, which the
 * callers check for.
 */
function bashWords(word: string, home: string, cwd?: string): string[] {
  const res = spawnSync("bash", ["-c", 'eval "set -- $1"; printf "%s\\n" "$#" "${1-}"', "_", word], {
    encoding: "utf-8",
    cwd,
    env: { PATH: process.env.PATH, HOME: home },
  });
  return res.stdout.replace(/\n$/, "").split("\n");
}

function upgradeIn(stderr: string): string | undefined {
  return noticeLines(stderr).map((l) => l.split("上げるには: ")[1])[0];
}

describe("bin/ccs update notice: how to upgrade (stub fzf)", () => {
  test("under node_modules (npm): the npm command, and the built .js modules run", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const pkgBin = join(npmRoot, "npm-1", "lib", "node_modules", "@indigo-gr", "claude-code-station", "bin");
      assert.equal(await exists(join(pkgBin, "ccs-machine.js")), true);
      assert.equal(runSimple(sb, "", ["--version"], { bin: NPM_BIN }).stdout.trim(), `ccs v${VERSION}`);
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin: NPM_BIN });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(upgradeIn(res.stderr), UPGRADE, res.stderr);
      // The list came from Node running .js (it refuses .ts under node_modules),
      // and the bindings name the .js modules too.
      const a = await fzfArgs(sb);
      assert.ok(a.includes("--style=full:rounded"), a.join("\n"));
      assert.equal(borderLabel(a), `  Claude Code をはじめる  ccs v${VERSION}  Copyright © ${HOLDER}  `);
      assert.ok(a.includes(PLAIN_LABEL));
      assert.ok(a.some((x) => /^--preview=bash '[^']*\/ccs-tsx\.sh' '[^']*\/ccs-preview\.js' \{4\} \{5\}$/.test(x)));
      assert.ok(!a.some((x) => /ccs-[a-z-]+\.ts/.test(x)), "no .ts module in the bindings");
      assert.equal(res.stdout, "🚀 Claude Code を開きます（~/studio/web）\n");
    } finally {
      await sb.cleanup();
    }
  });

  test("this checkout, run in place: cd to it, git pull, npm install", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"]);
      assert.equal(res.code, 0, res.stderr);
      const clone = (await realpath(REPO_ROOT)).replace(/\/$/, "");
      // HOME is the sandbox here, so the checkout is shown in full.
      const [n, first] = bashWords(upgradeIn(res.stderr)!.slice("cd ".length).split(" && ")[0], sb.home);
      assert.equal(n, "1");
      assert.equal(first, clone);
      assert.match(upgradeIn(res.stderr)!, / && git pull && npm install$/);
      assert.doesNotMatch(res.stderr, /npm install -g/);
    } finally {
      await sb.cleanup();
    }
  });

  test("a clone outside HOME at a plain path: the path as it is", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const bin = await makeBuild(sb.root, "0.10.2");
      const clone = await realpath(join(bin, "..", ".."));
      assert.match(clone, /^[A-Za-z0-9._/+-]+$/, "precondition: a plain temp path");
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(upgradeIn(res.stderr), cloneUpgrade(clone), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("a clone under HOME: shown from ~", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      // The real path: the clone's folder is resolved (cd -P) before it is
      // compared with HOME.
      const home = await realpath(sb.home);
      const bin = await makeBuild(sb.root, "0.10.2", join(home, "src", "ccs"));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin, env: { HOME: home } });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(upgradeIn(res.stderr), cloneUpgrade("~/src/ccs"), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("a HOME that is a symlink: a clone under it is still shown from ~", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      // HOME points at the real folder through a symlink; the clone is under it.
      const real = join(await realpath(sb.root), "real-home");
      await mkdir(real, { recursive: true });
      const link = join(sb.root, "home-link");
      await symlink(real, link);
      await makeBuild(sb.root, "0.10.2", join(real, "src", "ccs"));
      for (const home of [link, real]) {
        for (const bin of [join(link, "src", "ccs", "bin", "ccs"), join(real, "src", "ccs", "bin", "ccs")]) {
          const label = `HOME=${home === link ? "symlink" : "real"}, ccs via ${bin.startsWith(link) ? "symlink" : "real"}`;
          const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin, env: { HOME: home } });
          assert.equal(res.code, 0, `${label}: ${res.stderr}`);
          assert.equal(upgradeIn(res.stderr), cloneUpgrade("~/src/ccs"), `${label}: ${res.stderr}`);
          assert.ok(!res.stderr.includes(real) && !res.stderr.includes(link), `${label}: no full path`);
        }
      }
    } finally {
      await sb.cleanup();
    }
  });

  test("a clone at a path with a space: quoted in full, one word to the shell", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const home = await realpath(sb.home);
      const clone = join(home, "my src", "ccs");
      const bin = await makeBuild(sb.root, "0.10.2", clone);
      const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin, env: { HOME: home } });
      assert.equal(res.code, 0, res.stderr);
      // printf %q of the whole path: no ~ (a quote would make it literal).
      assert.equal(upgradeIn(res.stderr), cloneUpgrade(clone.replace(/ /g, "\\ ")), res.stderr);
      assert.deepEqual(bashWords(clone.replace(/ /g, "\\ "), home), ["1", clone]);
    } finally {
      await sb.cleanup();
    }
  });

  test("a clone at a path with shell syntax: one inert word, nothing runs", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const home = await realpath(sb.home);
      // A folder name cannot hold "/", so the payload names a file relative to
      // the folder everything here runs in.
      const pwned = join(sb.root, "pwned");
      for (const name of ["it's $(touch pwned)", "`touch pwned`", "a;b&c|d", "tab\there", "~notme"]) {
        const clone = join(home, name, "ccs");
        const bin = await makeBuild(sb.root, "0.10.2", clone);
        const res = runSimple(sb, "new:Studio-web", ["--no-scan"], { bin, env: { HOME: home }, cwd: sb.root });
        assert.equal(res.code, 0, `${JSON.stringify(name)}: ${res.stderr}`);
        const cmd = upgradeIn(res.stderr)!;
        assert.ok(cmd.startsWith("cd ") && cmd.endsWith(" && git pull && npm install"), cmd);
        const word = cmd.slice("cd ".length, -" && git pull && npm install".length);
        assert.deepEqual(bashWords(word, home, sb.root), ["1", clone], `${JSON.stringify(name)}: ${word}`);
      }
      assert.equal(await exists(pwned), false);
    } finally {
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// bin/ccs — what may become the version, stub fzf
// ---------------------------------------------------------------------------

describe("bin/ccs reads the version strictly (stub fzf)", () => {
  const OWN = `"name": "${PACKAGE_NAME}"`;
  const pkg = (versionLine: string) => `{\n  ${OWN},\n  ${versionLine}\n}\n`;

  for (const [name, text] of [
    ["a shell command substitution", pkg('"version": "$(touch pwned)"')],
    ["backticks", pkg('"version": "`touch pwned`"')],
    ["a semicolon", pkg('"version": "1.2.3;touch pwned"')],
    ["a space", pkg('"version": "1.2.3 x"')],
    ["a quote", pkg(`"version": "1.2.3'x"`)],
    ["an escape sequence", pkg('"version": "1.2.3\u001b[31m"')],
    ["a slash", pkg('"version": "../../x"')],
    ["an empty string", pkg('"version": ""')],
    ["a number", pkg('"version": 1')],
    ["NUL before the name", `\u0000{\n  "name": "someone\u0000-else",\n  "version": "5.5.5"\n}\n`],
    ["NUL inside the version", pkg('"version": "1.2.3\u0000$(touch pwned)"')],
  ] as const) {
    test(`a version with ${name} is not used`, async () => {
      const sb = await makePickSandbox();
      try {
        const bin = await makeBuild(sb.root, text);
        const res = runSimple(sb, "", ["--version"], { bin });
        assert.equal(res.code, 0, res.stderr);
        assert.equal(res.stderr, "", "no warning from the read");
        // NUL is dropped by bash: "1.2.3$(touch pwned)" still fails the pattern.
        assert.equal(res.stdout.trim(), "ccs v0.0.0-dev", JSON.stringify(text));
        assert.equal(await exists(join(sb.root, "pwned")), false);
        assert.equal(await exists(join(sb.home, "pwned")), false);
      } finally {
        await sb.cleanup();
      }
    });
  }

  test("NUL elsewhere in this package's own file does not stop it", async () => {
    const sb = await makePickSandbox();
    try {
      const bin = await makeBuild(sb.root, `{\n  ${OWN},\n  "description": "a\u0000b",\n  "version": "7.8.9"\n}\n`);
      const res = runSimple(sb, "", ["--version"], { bin });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stderr, "");
      assert.equal(res.stdout.trim(), "ccs v7.8.9");
    } finally {
      await sb.cleanup();
    }
  });

  test("a prerelease with build metadata is read as written", async () => {
    const sb = await makePickSandbox();
    try {
      const bin = await makeBuild(sb.root, pkg('"version": "1.2.3-rc.1+build.5"'));
      assert.equal(runSimple(sb, "", ["--version"], { bin }).stdout.trim(), "ccs v1.2.3-rc.1+build.5");
    } finally {
      await sb.cleanup();
    }
  });
});
