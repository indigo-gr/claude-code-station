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

import { test, describe } from "node:test";
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
      ...process.env,
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
    const res = spawnSync("bash", [CCS_BIN, "--version"], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^ccs v\d+\.\d+\.\d+/);
  });

  test("--help prints usage and exits 0", () => {
    const res = spawnSync("bash", [CCS_BIN, "--help"], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /CCS_CMD/);
    assert.match(res.stdout, /--auto-discover/);
  });

  test("works when invoked through a symlink (npm global-install layout)", async () => {
    // `npm install -g github:...` puts a SYMLINK to bin/ccs on PATH; the
    // script must resolve $0 back to the package bin/ to find its sibling
    // .ts modules and the package-local tsx.
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
          ...process.env,
          HOME: sb.home,
          XDG_CONFIG_HOME: join(sb.home, ".config"),
          XDG_CACHE_HOME: join(sb.home, ".cache"),
        },
      });
      // `init` exercises the resolved SCRIPT_DIR (tsx + ccs-init.ts path) —
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
          ...process.env,
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
// stub `claude` records where and how it was launched.
const FAKE_FZF = `#!/usr/bin/env bash
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
    claudeLog: join(sb.root, "claude.log"),
  };
}

function runPick(
  sb: PickSandbox,
  pick: string,
  args: string[],
  fzfVersion = "0.70.0",
): { stdout: string; stderr: string; code: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sb.stubBin}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    FAKE_FZF_PICK: pick,
    FAKE_FZF_ARGS: sb.fzfArgs,
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
        assert.doesNotMatch(res.stdout + res.stderr, /Launching|Could not parse|Unknown row kind/);
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
      assert.match(res.stdout, /Launching Studio-web in /);
      const { readFile } = await import("node:fs/promises");
      const log = (await readFile(sb.claudeLog, "utf-8")).trim();
      assert.ok(log.endsWith(`${join("studio", "web")}|`), `claude ran as: ${log}`);
    } finally {
      await sb.cleanup();
    }
  });

  test("fzf >= 0.45 gets enter/double-click bindings that ignore group rows; older fzf does not", async () => {
    const sb = await makePickSandbox();
    try {
      const { readFile } = await import("node:fs/promises");
      const bind = (key: string) =>
        `${key}:transform:bash -c 'case $1 in group:*) echo ignore ;; *) echo accept ;; esac' _ {4}`;

      runPick(sb, "group:Studio", ["--new"], "0.70.0");
      let args = (await readFile(sb.fzfArgs, "utf-8")).split("\n");
      assert.ok(args.includes(bind("enter")), "enter binding expected");
      assert.ok(args.includes(bind("double-click")), "double-click binding expected");

      // Older fzf has no transform action (it would refuse to start); the
      // post-pick check is then the only guard and still exits quietly.
      const res = runPick(sb, "group:Studio", ["--new"], "0.44.1");
      assert.equal(res.code, 0);
      args = (await readFile(sb.fzfArgs, "utf-8")).split("\n");
      assert.ok(!args.some((a) => a.includes(":transform:")), "no transform on fzf 0.44");
      assert.equal(await exists(sb.claudeLog), false);
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
      assert.match(res.stdout, /Invalid session ID/);
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
      assert.match(res.stdout, /Session file not found/);
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
        /Delete this session\? \(y\/N\):/,
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
        /Failed to delete/,
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
// bin/ccs — the simple look (v0.3.0), stub fzf
// ---------------------------------------------------------------------------

function runSimple(
  sb: PickSandbox,
  pick: string,
  args: string[],
  opts: { fzfVersion?: string; env?: Record<string, string | undefined>; bin?: string } = {},
): { stdout: string; stderr: string; code: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sb.stubBin}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    FAKE_FZF_PICK: pick,
    FAKE_FZF_ARGS: sb.fzfArgs,
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
  const res = spawnSync("bash", [opts.bin ?? CCS_BIN, ...args], { encoding: "utf-8", env });
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
  a.includes("--highlight-line") &&
  a.includes("--with-nth=1") &&
  a.includes("--no-sort");
const isClassicArgs = (a: string[]) =>
  a.includes("--prompt=ccs> ") && a.includes("--with-nth=1..3") && !a.some((x) => x.startsWith("--style"));

describe("bin/ccs --ui=simple (stub fzf)", () => {
  test("--ui=simple opens the friendly frame and launches the pick the same way", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=simple"]);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      const a = await fzfArgs(sb);
      assert.ok(isSimpleArgs(a), a.join("\n"));
      assert.ok(a.some((x) => x.includes("ccs-preview.ts' {4} {5} --ui=simple")), "preview gets --ui=simple");
      assert.ok(a.some((x) => x.startsWith("ctrl-r:") && x.includes("--ui=simple")), "reload keeps the look");
      assert.ok(a.some((x) => x.startsWith("enter:transform:") && x.includes("change-header(  ここは見出しです")));
      assert.ok(a.includes("change:first"));
      assert.match(res.stdout, /🚀 Claude Code を開きます（~\/studio\/web）/);
      const { readFile } = await import("node:fs/promises");
      assert.ok((await readFile(sb.claudeLog, "utf-8")).trim().endsWith(`${join("studio", "web")}|`));
    } finally {
      await sb.cleanup();
    }
  });

  test("fzf older than 0.61 opens the classic look with one line saying why", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "none", ["--no-scan", "--ui=simple"], { fzfVersion: "0.60.0" });
      assert.equal(res.code, 0);
      assert.match(res.stderr, /fzf 0\.61 以上が要ります（いまの fzf: 0\.60\.0）。ふつうの見た目で開きます。fzf を新しくするには: brew upgrade fzf/);
      assert.equal(res.stderr.trim().split("\n").length, 1);
      assert.ok(isClassicArgs(await fzfArgs(sb)));
    } finally {
      await sb.cleanup();
    }
  });

  test("CCS_UI picks the look; --ui= wins over it; a bad CCS_UI is ignored with a warning", async () => {
    const sb = await makePickSandbox();
    try {
      runSimple(sb, "none", ["--no-scan"], { env: { CCS_UI: "simple" } });
      assert.ok(isSimpleArgs(await fzfArgs(sb)));
      runSimple(sb, "none", ["--no-scan", "--ui=classic"], { env: { CCS_UI: "simple" } });
      assert.ok(isClassicArgs(await fzfArgs(sb)));
      const bad = runSimple(sb, "none", ["--no-scan"], { env: { CCS_UI: "fancy" } });
      assert.match(bad.stderr, /CCS_UI must be simple or classic \(got: fancy\) — ignored/);
      assert.ok(isClassicArgs(await fzfArgs(sb)));
    } finally {
      await sb.cleanup();
    }
  });

  test("an unknown --ui value stops before anything runs", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "none", ["--no-scan", "--ui=fancy"]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /--ui must be simple or classic \(got: fancy\)/);
      assert.equal(await exists(sb.fzfArgs), false);
    } finally {
      await sb.cleanup();
    }
  });

  test("defaults.ui stored by the last scan applies under --no-scan", async () => {
    const sb = await makePickSandbox();
    try {
      const { setMeta } = await import("../bin/ccs-db.ts");
      const h = openDb(join(sb.home, ".cache", "ccs", "state.db"));
      setMeta(h.db, "defaults_ui", "simple");
      h.close();
      runSimple(sb, "none", ["--no-scan"]);
      assert.ok(isSimpleArgs(await fzfArgs(sb)));
    } finally {
      await sb.cleanup();
    }
  });

  test("repos.yml defaults.ui reaches the launcher through the pre-scan", async () => {
    const sb = await makePickSandbox();
    try {
      await mkdir(join(sb.home, ".config", "ccs"), { recursive: true });
      await writeFile(
        join(sb.home, ".config", "ccs", "repos.yml"),
        `version: 1\ndefaults:\n  ui: simple\nrepos:\n  - name: Studio\n    path: ${join(sb.home, "studio")}\n    launch: false\n  - name: Studio-web\n    path: ${join(sb.home, "studio", "web")}\n`,
      );
      const res = runSimple(sb, "new:Studio-web", []);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(isSimpleArgs(await fzfArgs(sb)));
      assert.equal(res.stderr, "", "a clean scan says nothing");
      // CCS_UI=classic (and --ui=classic) still win over repos.yml simple.
      runSimple(sb, "none", [], { env: { CCS_UI: "classic" } });
      assert.ok(isClassicArgs(await fzfArgs(sb)));
      runSimple(sb, "none", ["--ui=classic"]);
      assert.ok(isClassicArgs(await fzfArgs(sb)));
    } finally {
      await sb.cleanup();
    }
  });

  test("Esc (or no pick) says how to come back, and launches nothing", async () => {
    const sb = await makePickSandbox();
    try {
      const res = runSimple(sb, "none", ["--no-scan", "--ui=simple"]);
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
      const psb: PickSandbox = { ...sb, stubBin, fzfArgs: join(sb.root, "fzf-args.txt"), claudeLog: join(sb.root, "claude.log") };
      let res = runSimple(psb, "none", ["--no-scan", "--ui=simple"]);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /まだ一覧に出すプロジェクトがありません。\n {2}・ホームのフォルダから選んで足すには: ccs init --auto-discover/);
      assert.equal(await exists(psb.fzfArgs), false, "fzf is not opened");
      res = runSimple(psb, "none", ["--no-scan", "--ui=simple", "--resume"]);
      assert.match(res.stdout, /前の会話は、まだありません。/);
      res = runSimple(psb, "none", ["--no-scan", "--ui=simple", "."]);
      assert.match(res.stdout, /このフォルダでの前の会話は、まだありません。/);
    } finally {
      await sb.cleanup();
    }
  });

  test("a broken repos.yml: classic prints as before; simple warns in the frame and explains after", async () => {
    const sb = await makePickSandbox();
    try {
      await mkdir(join(sb.home, ".config", "ccs"), { recursive: true });
      await writeFile(join(sb.home, ".config", "ccs", "repos.yml"), "version: 2\nrepos: []\n");
      const classic = runSimple(sb, "none", []);
      assert.match(classic.stderr, /\[ccs-scan\] fatal: .*unsupported version[\s\S]*\[ccs\] scan failed, continuing with stale DB/);
      const simple = runSimple(sb, "none", ["--ui=simple"]);
      assert.ok((await fzfArgs(sb)).some((x) => x.startsWith("--list-label=  えらぶ  ⚠️ 設定ファイルを読めませんでした")));
      assert.match(
        simple.stderr,
        /設定ファイル（~\/\.config\/ccs\/repos\.yml）を読めなかったので、前の一覧を出しました。下の行を直してから、もう一度 ccs と打ってください。\n {4}\[ccs-scan\] fatal: .*unsupported version/,
      );
      assert.doesNotMatch(simple.stderr, /continuing with stale DB/);
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

function labelForms(look: "simple" | "classic", version: string): string[] {
  const pad = look === "simple" ? "  " : " ";
  const tag = `ccs v${version}`;
  const forms = [
    `${pad}${tag}  Copyright © ${HOLDER}${pad}`,
    `${pad}${tag}  © ${HOLDER}${pad}`,
    `${pad}${tag}${pad}`,
  ];
  if (look === "simple") forms.unshift(`${pad}Claude Code をはじめる  ${tag}  Copyright © ${HOLDER}${pad}`);
  return forms;
}

function borderLabel(args: string[]): string | undefined {
  return args.find((a) => a.startsWith("--border-label="))?.slice("--border-label=".length);
}

const PACKAGE_NAME = "@indigo-gr/claude-code-station";
let buildCount = 0;

/**
 * A copy of bin/ with its own package.json, to run other version numbers.
 * `manifest`: the file's exact text (null = no file). A string with no newline
 * or brace is taken as a version number of this package.
 */
async function makeBuild(root: string, manifest: string | null): Promise<string> {
  const dir = join(root, `build-${++buildCount}`);
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
  for (const look of ["simple", "classic"] as const) {
    const forms = labelForms(look, VERSION);
    for (const [i, form] of forms.entries()) {
      test(`${look}: the longest label that fits, at its exact width (form ${i + 1})`, async () => {
        const sb = await makePickSandbox();
        try {
          const fits = widthFor(form);
          runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { env: { COLUMNS: String(fits) } });
          assert.equal(borderLabel(await fzfArgs(sb)), form, `${fits} columns`);
          if (i + 1 < forms.length) {
            runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { env: { COLUMNS: String(fits - 1) } });
            assert.equal(borderLabel(await fzfArgs(sb)), forms[i + 1], `${fits - 1} columns`);
          }
        } finally {
          await sb.cleanup();
        }
      });
    }

    test(`${look}: the label sits at the same place and the words come from package.json`, async () => {
      const sb = await makePickSandbox();
      try {
        for (const version of ["7.8.9", "123.456.789"]) {
          const bin = await makeBuild(sb.root, version);
          for (const form of labelForms(look, version)) {
            runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { bin, env: { COLUMNS: String(widthFor(form)) } });
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
  }

  test("a width that is not a number falls back to asking the terminal, and never breaks", async () => {
    const sb = await makePickSandbox();
    try {
      for (const columns of ["abc", "0", "-5", "12x", ""]) {
        const res = runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=simple"], { env: { COLUMNS: columns } });
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

const UPGRADE = "npm install -g @indigo-gr/claude-code-station";

async function writeUpdateCache(sb: PickSandbox, text: string): Promise<void> {
  await mkdir(join(sb.home, ".cache", "ccs"), { recursive: true });
  await writeFile(join(sb.home, ".cache", "ccs", "update-check"), text);
}
const freshCache = (latest: string) => `latest=${latest}\nchecked=${Math.floor(Date.now() / 1000)}\n`;

function hasNotice(res: { stderr: string }, a: string[]): boolean {
  return res.stderr.includes(UPGRADE) || a.some((x) => x.includes("が出ています"));
}

describe("bin/ccs update notice (stub fzf)", () => {
  test("simple: the frame says so while open, the command is printed after it closes", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=simple"]);
      assert.equal(res.code, 0, res.stderr);
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  ccs v99.0.0 が出ています  "));
      assert.ok(res.stderr.includes(`[ccs] 新しい ccs v99.0.0 が出ています（いまは v${VERSION}）。上げるには: ${UPGRADE}`), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("simple: also printed when the picker is closed without choosing", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "no-such-row", ["--no-scan", "--ui=simple"]);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(res.stderr.includes(UPGRADE), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("simple: under 44 columns the frame stays quiet, the command is still printed", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=simple"], { env: { COLUMNS: "44" } });
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  ccs v99.0.0 が出ています  "));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=simple"], { env: { COLUMNS: "43" } });
      assert.ok((await fzfArgs(sb)).includes("--list-label=  えらぶ  "));
      assert.ok(res.stderr.includes(UPGRADE), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  test("classic: one line with the command", async () => {
    const sb = await makePickSandbox();
    try {
      await writeUpdateCache(sb, freshCache("99.0.0"));
      const res = runSimple(sb, "new:Studio-web", ["--no-scan", "--ui=classic"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(
        res.stderr.split("\n").filter((l) => l.includes(UPGRADE)).length,
        1,
        res.stderr,
      );
      assert.ok(res.stderr.includes(`[ccs] Update v${VERSION} -> v99.0.0: ${UPGRADE}`), res.stderr);
    } finally {
      await sb.cleanup();
    }
  });

  for (const look of ["simple", "classic"]) {
    test(`${look}: newer only, by number and not by text`, async () => {
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
          const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { bin });
          assert.equal(res.code, 0, res.stderr);
          assert.equal(hasNotice(res, await fzfArgs(sb)), expected, `latest ${latest} on 0.10.2`);
        }
      } finally {
        await sb.cleanup();
      }
    });

    test(`${look}: a cache that is not a plain X.Y.Z shows nothing and runs nothing`, async () => {
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
          const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`]);
          assert.equal(res.code, 0, `${JSON.stringify(text)}: ${res.stderr}`);
          assert.equal(hasNotice(res, await fzfArgs(sb)), false, JSON.stringify(text));
          assert.equal(await exists(pwned), false, JSON.stringify(text));
        }
      } finally {
        await sb.cleanup();
      }
    });

    test(`${look}: the off switch hides a notice the cache would give`, async () => {
      const sb = await makePickSandbox();
      try {
        await writeUpdateCache(sb, freshCache("99.0.0"));
        for (const off of ["1", "0", "yes"]) {
          const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { env: { CCS_NO_UPDATE_CHECK: off } });
          assert.equal(hasNotice(res, await fzfArgs(sb)), false, `CCS_NO_UPDATE_CHECK=${off}`);
        }
        const empty = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { env: { CCS_NO_UPDATE_CHECK: "" } });
        assert.equal(hasNotice(empty, await fzfArgs(sb)), true, "an empty value is not set");
      } finally {
        await sb.cleanup();
      }
    });

    test(`${look}: a prerelease gets no notice`, async () => {
      const sb = await makePickSandbox();
      try {
        await writeUpdateCache(sb, freshCache("99.0.0"));
        const bin = await makeBuild(sb.root, "1.0.0-beta.1");
        const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { bin });
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
      test(`${look}: ${name} package.json beside bin/ means 0.0.0-dev, no notice, no stop`, async () => {
        const sb = await makePickSandbox();
        try {
          await writeUpdateCache(sb, freshCache("99.0.0"));
          const bin = await makeBuild(sb.root, text === "" ? "\n" : text);
          const version = runSimple(sb, "", ["--version"], { bin });
          assert.equal(version.code, 0, version.stderr);
          assert.equal(version.stdout.trim(), "ccs v0.0.0-dev");
          const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { bin });
          assert.equal(res.code, 0, res.stderr);
          // Node itself refuses to load a module under a package.json it cannot
          // parse, so the simple look may not reach fzf at all. It must still end
          // cleanly, and whatever it does show must not borrow a version.
          const args = await fzfArgs(sb).catch(() => [] as string[]);
          if (args.length) assert.ok(borderLabel(args)?.includes("ccs v0.0.0-dev"));
          else assert.ok(res.stdout.includes("ccs --refresh"), res.stdout);
          assert.equal(hasNotice(res, args), false);
        } finally {
          await sb.cleanup();
        }
      });
    }

    // install.sh and the README's manual install copy bin/ without package.json.
    test(`${look}: a copy install runs as 0.0.0-dev and gets no notice`, async () => {
      const sb = await makePickSandbox();
      try {
        await writeUpdateCache(sb, freshCache("99.0.0"));
        const bin = await makeBuild(sb.root, null);
        assert.equal(runSimple(sb, "", ["--version"], { bin }).stdout.trim(), "ccs v0.0.0-dev");
        const res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`], { bin });
        assert.equal(res.code, 0, res.stderr);
        assert.ok(borderLabel(await fzfArgs(sb))?.includes("ccs v0.0.0-dev"));
        assert.equal(hasNotice(res, await fzfArgs(sb)), false);
      } finally {
        await sb.cleanup();
      }
    });

    test(`${look}: a directory or an unreadable file where the cache goes`, async () => {
      const sb = await makePickSandbox();
      const cache = join(sb.home, ".cache", "ccs", "update-check");
      try {
        await mkdir(cache, { recursive: true });
        let res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`]);
        assert.equal(res.code, 0, res.stderr);
        assert.equal(hasNotice(res, await fzfArgs(sb)), false);
        await rm(cache, { recursive: true });
        await writeUpdateCache(sb, freshCache("99.0.0"));
        await chmod(cache, 0o000);
        res = runSimple(sb, "new:Studio-web", ["--no-scan", `--ui=${look}`]);
        assert.equal(res.code, 0, res.stderr);
      } finally {
        await chmod(cache, 0o600).catch(() => {});
        await sb.cleanup();
      }
    });
  }
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
