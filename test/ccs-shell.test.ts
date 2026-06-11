/**
 * Tests for the bash surfaces: bin/ccs (non-interactive paths) and
 * bin/ccs-delete.sh — the ONLY destructive code path in ccs, which had zero
 * test coverage until the 2026-06-12 review (review C-2 / "untested dangerous
 * areas").
 *
 * No bats dependency: node:test drives bash via spawnSync, with stdin piped
 * for the `read -p` prompts and HOME/XDG redirected to a sandbox so the
 * ccs-delete-session.ts cache cleanup can never touch the real state.db.
 * The interactive fzf flow itself is out of scope (needs a TTY harness).
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
