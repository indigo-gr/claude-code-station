/**
 * Tests for bin/ccs-init.ts (`ccs init --auto-discover`).
 *
 * Discovery walks a synthetic $HOME tree built in a tmpdir sandbox; the
 * append path reuses the config-test sandbox pattern (HOME/XDG overrides)
 * because appendAndValidate() re-runs the full loadConfig() validation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  symlink,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverGitRepos,
  buildCandidates,
  appendReposToYaml,
  appendAndValidate,
} from "../bin/ccs-init.ts";

async function makeHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ccs-init-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return {
    home,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function gitDir(...segments: string[]): Promise<void> {
  await mkdir(join(...segments, ".git"), { recursive: true });
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

// ---------------------------------------------------------------------------
// discoverGitRepos()
// ---------------------------------------------------------------------------

describe("discoverGitRepos()", () => {
  test("finds repos, stops at repo roots, skips excluded and hidden dirs", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await gitDir(home, "Workspace", "repo-a");
      await gitDir(home, "Workspace", "repo-a", "vendored"); // inside repo-a — not emitted
      await gitDir(home, "deep", "x", "y", "repo-b");
      await gitDir(home, "node_modules", "trap"); // excluded dir
      await gitDir(home, ".hidden", "trap"); // hidden dir
      await mkdir(join(home, "plain-dir"), { recursive: true }); // no .git

      const found = await discoverGitRepos({ home });
      assert.deepEqual(found, [
        join(home, "Workspace", "repo-a"),
        join(home, "deep", "x", "y", "repo-b"),
      ]);
    } finally {
      await cleanup();
    }
  });

  test("respects maxDepth", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await gitDir(home, "a", "shallow"); // depth 2
      await gitDir(home, "a", "b", "c", "deep"); // depth 4
      const found = await discoverGitRepos({ home, maxDepth: 2 });
      assert.deepEqual(found, [join(home, "a", "shallow")]);
    } finally {
      await cleanup();
    }
  });

  test("$HOME-as-dotfiles-repo is emitted but does not mask children", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await mkdir(join(home, ".git"), { recursive: true }); // dotfiles pattern
      await gitDir(home, "proj");
      const found = await discoverGitRepos({ home });
      assert.deepEqual(found, [home, join(home, "proj")]);
    } finally {
      await cleanup();
    }
  });

  test("symlinked directories are not followed (cycle safety)", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await gitDir(home, "real");
      await symlink(home, join(home, "loop")); // cycle: home/loop -> home
      const found = await discoverGitRepos({ home });
      assert.deepEqual(found, [join(home, "real")]);
    } finally {
      await cleanup();
    }
  });

  test("accepts .git as a FILE (worktree / submodule checkout)", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await mkdir(join(home, "wt"), { recursive: true });
      await writeFile(join(home, "wt", ".git"), "gitdir: /elsewhere\n");
      const found = await discoverGitRepos({ home });
      assert.deepEqual(found, [join(home, "wt")]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// buildCandidates()
// ---------------------------------------------------------------------------

describe("buildCandidates()", () => {
  const home = "/home/u";

  test("subtracts registered paths, uniquifies names, emits ~-relative paths", () => {
    const found = [
      "/home/u/Workspace/app",
      "/home/u/old/registered",
      "/home/u/other/app", // basename collides with Workspace/app
    ];
    const out = buildCandidates(
      found,
      { names: new Set(["taken"]), paths: new Set(["/home/u/old/registered"]) },
      home,
    );
    assert.deepEqual(out, [
      { name: "app", path: "~/Workspace/app" },
      { name: "app-2", path: "~/other/app" },
    ]);
  });

  test("uniquifies against existing config names too", () => {
    const out = buildCandidates(
      ["/home/u/app"],
      { names: new Set(["app", "app-2"]), paths: new Set() },
      home,
    );
    assert.deepEqual(out, [{ name: "app-3", path: "~/app" }]);
  });

  test("skips paths with shell metacharacters (config would reject them)", () => {
    const out = buildCandidates(
      ["/home/u/bad;dir", "/home/u/ok"],
      { names: new Set(), paths: new Set() },
      home,
    );
    assert.deepEqual(out, [{ name: "ok", path: "~/ok" }]);
  });

  test("home itself becomes name 'home', path '~'", () => {
    const out = buildCandidates(
      [home],
      { names: new Set(), paths: new Set() },
      home,
    );
    assert.deepEqual(out, [{ name: "home", path: "~" }]);
  });
});

// ---------------------------------------------------------------------------
// appendReposToYaml()
// ---------------------------------------------------------------------------

describe("appendReposToYaml()", () => {
  test("appends entries while preserving comments and existing formatting", () => {
    const source = `# my precious comment
version: 1

defaults:
  command: "claude"   # wrapper goes here

repos:
  - name: existing
    path: ~/existing
`;
    const out = appendReposToYaml(source, [
      { name: "new-repo", path: "~/Workspace/new-repo" },
    ]);
    assert.match(out, /# my precious comment/);
    assert.match(out, /# wrapper goes here/);
    assert.match(out, /name: existing/);
    assert.match(out, /name: new-repo/);
    assert.match(out, /path: ~\/Workspace\/new-repo/);
  });

  test("throws when the repos sequence is missing", () => {
    assert.throws(
      () => appendReposToYaml("version: 1\n", [{ name: "x", path: "~/x" }]),
      /repos.*sequence not found/,
    );
  });

  test("untouched lines stay byte-identical — no reflow or flow-seq repadding", () => {
    // Regression from the first real-world run: default toString() repadded
    // every `tags: [x]` to `[ x ]` and folded a >80-char description line.
    const longDesc = "World Monitor Pro - " + "地政学・経済・インフラ".repeat(8);
    const source = [
      "version: 1",
      "repos:",
      "  - name: styled",
      "    path: ~/styled",
      `    description: ${longDesc}`,
      "    tags: [dev, tool]",
      "",
    ].join("\n");
    const out = appendReposToYaml(source, [{ name: "n", path: "~/n" }]);
    assert.ok(
      out.includes(`    description: ${longDesc}\n`),
      "long description must not be folded across lines",
    );
    assert.ok(
      out.includes("    tags: [dev, tool]\n"),
      "flow sequence must keep its original [x, y] padding style",
    );
  });
});

// ---------------------------------------------------------------------------
// appendAndValidate() — backup + rollback
// ---------------------------------------------------------------------------

describe("appendAndValidate()", () => {
  async function makeConfigSandbox() {
    const root = await mkdtemp(join(tmpdir(), "ccs-init-cfg-"));
    const home = join(root, "home");
    const xdgConfig = join(home, ".config");
    const reposYml = join(xdgConfig, "ccs", "repos.yml");
    await mkdir(join(xdgConfig, "ccs"), { recursive: true });
    const restore = applyEnv({
      HOME: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: join(home, ".cache"),
      CCS_CMD: undefined,
      CCR_CMD: undefined,
    });
    return {
      home,
      reposYml,
      cleanup: async () => {
        restore();
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  test("happy path: appends, keeps a .bak of the previous content", async () => {
    const sb = await makeConfigSandbox();
    try {
      const original = `version: 1\nrepos:\n  - name: seed\n    path: ${sb.home}\n`;
      await writeFile(sb.reposYml, original);
      appendAndValidate(sb.reposYml, [{ name: "added", path: "~/added" }]);

      const updated = await readFile(sb.reposYml, "utf-8");
      assert.match(updated, /name: added/);
      const backup = await readFile(sb.reposYml + ".bak", "utf-8");
      assert.equal(backup, original, ".bak must hold the pre-append content");
    } finally {
      await sb.cleanup();
    }
  });

  test("rollback: a candidate that fails validation restores the original file", async () => {
    const sb = await makeConfigSandbox();
    try {
      const original = `version: 1\nrepos:\n  - name: seed\n    path: ${sb.home}\n`;
      await writeFile(sb.reposYml, original);
      // Duplicate name → loadConfig() throws → file must be restored.
      assert.throws(
        () => appendAndValidate(sb.reposYml, [{ name: "seed", path: "~/dup" }]),
        /validation failed after append/,
      );
      const after = await readFile(sb.reposYml, "utf-8");
      assert.equal(after, original, "repos.yml must be restored on failure");
      await access(sb.reposYml + ".bak"); // backup still present for inspection
    } finally {
      await sb.cleanup();
    }
  });
});
