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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openDb, upsertRepo } from "../bin/ccs-db.ts";

const CCS_BIN = fileURLToPath(new URL("../bin/ccs", import.meta.url));
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
