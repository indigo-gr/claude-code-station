/**
 * Tests for bin/ccs-scan.ts
 *
 * MOCKING LIMITATION — see `docs/v0.2.0-review-notes.md`:
 * `scanSessions()` hardcodes `join(homedir(), ".claude", "projects")` and
 * `ccs-config.ts` reads `homedir()` + XDG env vars. To isolate tests we
 * override HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME per test before importing
 * the scan module. The `homedir()` function on POSIX returns $HOME when set,
 * so overriding HOME redirects both config lookup and session discovery to
 * our sandbox. On Windows this approach would not work (homedir uses USERPROFILE).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ScanSandbox {
  root: string;
  home: string;
  xdgConfig: string;
  xdgCache: string;
  reposYml: string;
  projectsDir: string;
  cleanup: () => Promise<void>;
}

async function makeScanSandbox(): Promise<ScanSandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-scan-"));
  const home = join(root, "home");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const reposYml = join(xdgConfig, "ccs", "repos.yml");
  const projectsDir = join(home, ".claude", "projects");
  await mkdir(join(xdgConfig, "ccs"), { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  return {
    root,
    home,
    xdgConfig,
    xdgCache,
    reposYml,
    projectsDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function applyEnv(overrides: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function freshScan(): Promise<typeof import("../bin/ccs-scan.ts")> {
  const url = new URL("../bin/ccs-scan.ts", import.meta.url).href;
  return import(url) as Promise<typeof import("../bin/ccs-scan.ts")>;
}

// ---------------------------------------------------------------------------

describe("scan() — smoke", () => {
  test("returns 0 reposScanned when repos.yml lists a single empty repo (path under HOME)", async () => {
    const sb = await makeScanSandbox();
    // Create a repo dir so existsSync passes inside scanOneRepo.
    const repoDir = join(sb.home, "empty-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1
repos:
  - name: empty
    path: ${repoDir}
`,
    );
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
      CCS_CMD: undefined,
      CCR_CMD: undefined,
    });
    try {
      const { scan } = await freshScan();
      const res = await scan({ force: true, scanSessions: false, ttlSeconds: 0 });
      assert.equal(res.reposScanned, 1);
      assert.equal(res.reposErrored, 0);
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

describe("scan() — TTL behavior", () => {
  test("second scan within ttlSeconds skips; --force ignores TTL", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "r1");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1
repos:
  - name: r1
    path: ${repoDir}
`,
    );
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      const first = await scan({ force: true, scanSessions: false });
      assert.equal(first.reposScanned, 1);

      // Immediate second call with generous TTL — should SKIP.
      const second = await scan({ force: false, ttlSeconds: 3600, scanSessions: false });
      assert.equal(second.reposSkipped, 1);
      assert.equal(second.reposScanned, 0);

      // --force override — must re-scan.
      const third = await scan({ force: true, ttlSeconds: 3600, scanSessions: false });
      assert.equal(third.reposScanned, 1);
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

describe("scan() — secret masking in handoff previews", () => {
  test("handoff file containing an 'sk-...' token is stored with [REDACTED]", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "secret-repo");
    const handoffDir = join(repoDir, "handoff");
    await mkdir(handoffDir, { recursive: true });
    const leak = "sk-" + "A".repeat(30) + " is my secret";
    await writeFile(join(handoffDir, "note.md"), leak + "\ntrailing", "utf-8");
    await writeFile(
      sb.reposYml,
      `version: 1
repos:
  - name: secret
    path: ${repoDir}
`,
    );
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: false });

      // Open the state DB directly to verify first_line content.
      const { default: Database } = await import("better-sqlite3");
      const { getPaths } = await import("../bin/ccs-config.ts");
      const paths = getPaths();
      const db = new Database(paths.stateDb, { readonly: true });
      try {
        const row = db
          .prepare(`SELECT first_line FROM handoff_files WHERE repo_name = ?`)
          .get("secret") as { first_line: string | null } | undefined;
        assert.ok(row, "handoff row should exist");
        assert.ok(
          row!.first_line?.includes("[REDACTED]"),
          `expected redaction; got: ${row!.first_line}`,
        );
        assert.ok(
          !row!.first_line?.includes("sk-A"),
          "raw secret must not leak into DB",
        );
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

describe("scan() — session indexing", () => {
  test("JSONL under ~/.claude/projects/ is indexed with repo_name when cwd matches a registered repo", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "match-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1
repos:
  - name: match
    path: ${repoDir}
`,
    );

    // Build a realistic JSONL with a UUID filename.
    const uuid = "abcdef01-2345-6789-abcd-ef0123456789";
    const projDir = join(sb.projectsDir, "-Users-test-match-repo");
    await mkdir(projDir, { recursive: true });
    const ts1 = new Date(Date.now() - 1000).toISOString();
    const ts2 = new Date().toISOString();
    const line1 = JSON.stringify({
      type: "user",
      cwd: repoDir,
      gitBranch: "main",
      timestamp: ts1,
      message: { content: "hello world" },
    });
    const line2 = JSON.stringify({
      type: "assistant",
      cwd: repoDir,
      timestamp: ts2,
      message: { content: "hi" },
    });
    await writeFile(join(projDir, `${uuid}.jsonl`), line1 + "\n" + line2 + "\n");

    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      const res = await scan({ force: true, scanSessions: true });
      assert.ok(res.sessionsIndexed >= 1, "expected at least one session indexed");

      const { default: Database } = await import("better-sqlite3");
      const { getPaths } = await import("../bin/ccs-config.ts");
      const paths = getPaths();
      const db = new Database(paths.stateDb, { readonly: true });
      try {
        const row = db
          .prepare(`SELECT uuid, repo_name, cwd, topic FROM sessions WHERE uuid = ?`)
          .get(uuid) as
          | { uuid: string; repo_name: string | null; cwd: string; topic: string | null }
          | undefined;
        assert.ok(row, "session row should exist");
        assert.equal(row!.repo_name, "match");
        assert.equal(row!.cwd, repoDir);
        assert.match(row!.topic ?? "", /hello world/);
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});
