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

// ---------------------------------------------------------------------------
// Regression suite for the 2026-06-12 audit fixes.
// ---------------------------------------------------------------------------

const AUDIT_UUID_A = "11111111-2222-4333-8444-555555555555";

function sessionLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

async function writeSession(
  sb: ScanSandbox,
  uuid: string,
  lines: string[],
): Promise<string> {
  const projDir = join(sb.projectsDir, "-audit-proj");
  await mkdir(projDir, { recursive: true });
  const file = join(projDir, `${uuid}.jsonl`);
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

async function openStateDb() {
  const { default: Database } = await import("better-sqlite3");
  const { getPaths } = await import("../bin/ccs-config.ts");
  return new Database(getPaths().stateDb, { readonly: true });
}

describe("scan() — audit regressions", () => {
  test("C-1: repo_stats session aggregates are correct after a SINGLE scan", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "agg-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: agg\n    path: ${repoDir}\n`,
    );
    const ts = new Date().toISOString();
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: repoDir,
        timestamp: ts,
        message: { content: "first message" },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(
            `SELECT session_count_total, session_last_at FROM repo_stats WHERE name = ?`,
          )
          .get("agg") as
          | { session_count_total: number; session_last_at: string | null }
          | undefined;
        assert.ok(row, "repo_stats row should exist");
        assert.equal(
          row!.session_count_total,
          1,
          "session count must be visible after the FIRST scan (was lagging one scan behind)",
        );
        assert.equal(row!.session_last_at, ts);
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("logic H-1: --no-sessions scan preserves previous session aggregates", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "keep-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: keep\n    path: ${repoDir}\n`,
    );
    const ts = new Date().toISOString();
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: repoDir,
        timestamp: ts,
        message: { content: "hello" },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });

      // Simulate a stale/cleared sessions table (the rewind scenario).
      {
        const { default: Database } = await import("better-sqlite3");
        const { getPaths } = await import("../bin/ccs-config.ts");
        const dbw = new Database(getPaths().stateDb);
        try {
          dbw.prepare(`DELETE FROM sessions`).run();
        } finally {
          dbw.close();
        }
      }

      await scan({ force: true, scanSessions: false });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(
            `SELECT session_count_total FROM repo_stats WHERE name = ?`,
          )
          .get("keep") as { session_count_total: number } | undefined;
        assert.equal(
          row?.session_count_total,
          1,
          "--no-sessions must carry forward previous aggregates, not rewind to 0",
        );
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("H-1/M-2: session cwd with shell metacharacters degrades to 'unknown'", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "victim-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: victim\n    path: ${repoDir}\n`,
    );
    const evilCwd = `${repoDir} && touch /tmp/PWNED #`;
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: evilCwd,
        timestamp: new Date().toISOString(),
        message: { content: "innocent looking session" },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(`SELECT cwd FROM sessions WHERE uuid = ?`)
          .get(AUDIT_UUID_A) as { cwd: string } | undefined;
        assert.ok(row, "session row should exist");
        assert.equal(
          row!.cwd,
          "unknown",
          "tainted cwd must never be stored verbatim",
        );
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("NEW-1: topic with raw ESC sequences is stored stripped", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "esc-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: esc\n    path: ${repoDir}\n`,
    );
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: repoDir,
        timestamp: new Date().toISOString(),
        message: {
          content: "\u001b[31mFAKE-ERROR\u001b[0m \u001b]0;hijack\u0007 normal text",
        },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(`SELECT topic FROM sessions WHERE uuid = ?`)
          .get(AUDIT_UUID_A) as { topic: string | null } | undefined;
        assert.ok(row?.topic, "topic should exist");
        assert.ok(
          !row!.topic!.includes("\u001b"),
          `raw ESC must not reach state.db; got: ${JSON.stringify(row!.topic)}`,
        );
        assert.match(row!.topic!, /normal text/);
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("H-4: message_count counts only user/assistant entries", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "count-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: count\n    path: ${repoDir}\n`,
    );
    const ts = new Date().toISOString();
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({ type: "summary", summary: "meta row" }),
      sessionLine({
        type: "user",
        cwd: repoDir,
        timestamp: ts,
        message: { content: "q" },
      }),
      sessionLine({ type: "assistant", timestamp: ts, message: { content: "a" } }),
      sessionLine({ type: "file-history-snapshot", snapshot: {} }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(`SELECT message_count FROM sessions WHERE uuid = ?`)
          .get(AUDIT_UUID_A) as { message_count: number } | undefined;
        assert.equal(row?.message_count, 2, "only user+assistant rows count");
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("logic M-4: session started in a repo SUBDIRECTORY maps to the repo", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "mono-repo");
    const subDir = join(repoDir, "packages", "web");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: mono\n    path: ${repoDir}\n`,
    );
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: subDir,
        timestamp: new Date().toISOString(),
        message: { content: "subdir session" },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(`SELECT repo_name FROM sessions WHERE uuid = ?`)
          .get(AUDIT_UUID_A) as { repo_name: string | null } | undefined;
        assert.equal(row?.repo_name, "mono");
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

describe("scan() — audit M-3 remap", () => {
  test("session indexed before its repo existed is remapped on a later scan", async () => {
    const sb = await makeScanSandbox();
    const repoDir = join(sb.home, "late-repo");
    const otherDir = join(sb.home, "other-repo");
    await mkdir(repoDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    // First scan: repos.yml registers an UNRELATED sibling (not an ancestor of
    // repoDir), so the session under repoDir lands with repo_name = NULL.
    await writeFile(
      sb.reposYml,
      `version: 1\nrepos:\n  - name: other\n    path: ${otherDir}\n`,
    );
    await writeSession(sb, AUDIT_UUID_A, [
      sessionLine({
        type: "user",
        cwd: repoDir,
        timestamp: new Date().toISOString(),
        message: { content: "orphan session" },
      }),
    ]);
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { scan } = await freshScan();
      await scan({ force: true, scanSessions: true });
      {
        const db = await openStateDb();
        try {
          const row = db
            .prepare(`SELECT repo_name FROM sessions WHERE uuid = ?`)
            .get(AUDIT_UUID_A) as { repo_name: string | null } | undefined;
          assert.equal(row?.repo_name, null, "should start unmapped");
        } finally {
          db.close();
        }
      }

      // Register the repo and rescan. The JSONL mtime is unchanged (skip path),
      // so the remap pass must claim the previously-NULL session.
      await writeFile(
        sb.reposYml,
        `version: 1\nrepos:\n  - name: late\n    path: ${repoDir}\n`,
      );
      await scan({ force: true, scanSessions: true });
      const db = await openStateDb();
      try {
        const row = db
          .prepare(`SELECT repo_name FROM sessions WHERE uuid = ?`)
          .get(AUDIT_UUID_A) as { repo_name: string | null } | undefined;
        assert.equal(row?.repo_name, "late", "remap must claim orphan session");
      } finally {
        db.close();
      }
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});
