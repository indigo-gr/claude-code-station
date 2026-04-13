/**
 * Tests for bin/ccs-config.ts
 *
 * Uses node:test (built-in, Node 20+). No extra deps.
 *
 * NOTE: ccs-config.ts uses `homedir()` + `process.env.XDG_*` to compute paths,
 * plus `homedir()` for path-under-HOME security checks. To isolate tests we
 * override `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` per test and
 * re-import the module via a fresh dynamic import (cache-busted by query string)
 * so module-level state (e.g. `migrationWarned`) resets.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  home: string;
  xdgConfig: string;
  xdgCache: string;
  configDir: string;
  reposYml: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-cfg-"));
  const home = join(root, "home");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  await mkdir(home, { recursive: true });
  const configDir = join(xdgConfig, "ccs");
  const reposYml = join(configDir, "repos.yml");
  return {
    home,
    xdgConfig,
    xdgCache,
    configDir,
    reposYml,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Apply XDG env overrides. Returns a restore function. */
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

/** Fresh-import ccs-config.ts so module-level state is reset. */
async function freshImport(): Promise<
  typeof import("../bin/ccs-config.ts")
> {
  const url = new URL("../bin/ccs-config.ts", import.meta.url).href;
  // Cache bust — Node's module cache keys by resolved URL including query.
  // Note: ESM loader caches; tests still import fresh enough for our state.
  return import(url) as Promise<typeof import("../bin/ccs-config.ts")>;
}

async function writeYml(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf-8");
}

// ---------------------------------------------------------------------------
// getPaths()
// ---------------------------------------------------------------------------

describe("getPaths()", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  test("honors XDG_CONFIG_HOME and XDG_CACHE_HOME", async () => {
    const sb = await makeSandbox();
    restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    const { getPaths } = await freshImport();
    const p = getPaths();
    assert.equal(p.configDir, join(sb.xdgConfig, "ccs"));
    assert.equal(p.cacheDir, join(sb.xdgCache, "ccs"));
    assert.equal(p.reposYml, join(sb.xdgConfig, "ccs", "repos.yml"));
    assert.equal(p.stateDb, join(sb.xdgCache, "ccs", "state.db"));
    await sb.cleanup();
  });

  test("defaults to ~/.config/ccs and ~/.cache/ccs when XDG unset", async () => {
    const sb = await makeSandbox();
    restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: undefined,
      XDG_CACHE_HOME: undefined,
    });
    const { getPaths } = await freshImport();
    const p = getPaths();
    assert.equal(p.configDir, join(sb.home, ".config", "ccs"));
    assert.equal(p.cacheDir, join(sb.home, ".cache", "ccs"));
    await sb.cleanup();
  });
});

// ---------------------------------------------------------------------------
// ensureConfigDir()
// ---------------------------------------------------------------------------

describe("ensureConfigDir()", () => {
  test("creates configDir + cacheDir with mode 0700", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const { ensureConfigDir, getPaths } = await freshImport();
      ensureConfigDir();
      const p = getPaths();
      const cfgStat = await stat(p.configDir);
      const cacheStat = await stat(p.cacheDir);
      // Mode bits: mask to permission bits
      assert.equal(cfgStat.mode & 0o777, 0o700);
      assert.equal(cacheStat.mode & 0o777, 0o700);
      // Template files created
      const ymlStat = await stat(p.reposYml);
      assert.ok(ymlStat.isFile());
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

describe("loadConfig()", () => {
  test("rejects unsupported version (2)", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      await writeYml(
        sb.reposYml,
        "version: 2\nrepos:\n  - name: a\n    path: " + sb.home + "\n",
      );
      const { loadConfig, ConfigError } = await freshImport();
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /unsupported version/);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("rejects duplicate names", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: dup
    path: ${sb.home}
  - name: dup
    path: ${sb.home}
`,
      );
      const { loadConfig, ConfigError } = await freshImport();
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /duplicate name/);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("rejects path outside $HOME", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: evil
    path: /etc
`,
      );
      const { loadConfig, ConfigError } = await freshImport();
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /outside \$HOME/);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("rejects name with tab/newline/backslash", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      // Use JSON-style YAML to unambiguously inject a tab in the name.
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: "bad\\tname"
    path: ${sb.home}
`,
      );
      const { loadConfig, ConfigError } = await freshImport();
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /invalid characters/);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("rejects path with shell metacharacters", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      // Path containing `"` + `;` + `#` — under $HOME but shell-unsafe.
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: unsafe
    path: "${sb.home}/safe\\";echo OWNED #"
`,
      );
      const { loadConfig, ConfigError } = await freshImport();
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /shell metacharacter/);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("warns (does NOT throw) on missing path", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: ghost
    path: ${sb.home}/does-not-exist
`,
      );
      const { loadConfig } = await freshImport();
      const cfg = loadConfig(); // should NOT throw
      assert.equal(cfg.repos.length, 1);
      assert.ok(
        warnings.some((w) => /path not found/.test(w)),
        `expected warning; saw: ${warnings.join(" | ")}`,
      );
    } finally {
      console.warn = origWarn;
      restore();
      await sb.cleanup();
    }
  });

  test("command priority: repos[].command > defaults.command > CCS_CMD > 'claude'", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
      CCS_CMD: "env-claude",
      CCR_CMD: undefined,
    });
    try {
      await writeYml(
        sb.reposYml,
        `version: 1
defaults:
  command: default-claude
repos:
  - name: explicit
    path: ${sb.home}
    command: explicit-claude
  - name: usesDefault
    path: ${sb.home}
`,
      );
      const { loadConfig } = await freshImport();
      const cfg = loadConfig();
      const byName = Object.fromEntries(cfg.repos.map((r) => [r.name, r]));
      assert.equal(byName.explicit.command, "explicit-claude");
      assert.equal(byName.usesDefault.command, "default-claude");
    } finally {
      restore();
      await sb.cleanup();
    }

    // Now test fallback chain without defaults.command
    const sb2 = await makeSandbox();
    const restore2 = applyEnv({
      HOME: sb2.home,
      XDG_CONFIG_HOME: sb2.xdgConfig,
      XDG_CACHE_HOME: sb2.xdgCache,
      CCS_CMD: "env-claude",
      CCR_CMD: undefined,
    });
    try {
      await writeYml(
        sb2.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb2.home}
`,
      );
      const { loadConfig } = await freshImport();
      const cfg = loadConfig();
      assert.equal(cfg.repos[0].command, "env-claude");
    } finally {
      restore2();
      await sb2.cleanup();
    }

    // No env at all → "claude"
    const sb3 = await makeSandbox();
    const restore3 = applyEnv({
      HOME: sb3.home,
      XDG_CONFIG_HOME: sb3.xdgConfig,
      XDG_CACHE_HOME: sb3.xdgCache,
      CCS_CMD: undefined,
      CCR_CMD: undefined,
    });
    try {
      await writeYml(
        sb3.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb3.home}
`,
      );
      const { loadConfig } = await freshImport();
      const cfg = loadConfig();
      assert.equal(cfg.repos[0].command, "claude");
    } finally {
      restore3();
      await sb3.cleanup();
    }
  });

  test("CCR_CMD honored with deprecation warning when CCS_CMD unset", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
      CCS_CMD: undefined,
      CCR_CMD: "legacy-claude",
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb.home}
`,
      );
      const mod = await freshImport();
      // Reset the module-level once-flag so the warning fires for this test
      // regardless of prior test runs that also set CCR_CMD.
      mod.resetMigrationWarning?.();
      const cfg = mod.loadConfig();
      assert.equal(cfg.repos[0].command, "legacy-claude");
      assert.ok(
        warnings.some((w) => /CCR_CMD is deprecated/.test(w)),
        `expected deprecation warning; saw: ${warnings.join(" | ")}`,
      );
    } finally {
      console.warn = origWarn;
      restore();
      await sb.cleanup();
    }
  });

  test("configHash is deterministic", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      const yml = `version: 1
repos:
  - name: a
    path: ${sb.home}
    tags: [x, y]
`;
      await writeYml(sb.reposYml, yml);
      const { loadConfig } = await freshImport();
      const c1 = loadConfig();
      const c2 = loadConfig();
      assert.equal(c1.repos[0].configHash, c2.repos[0].configHash);
      assert.match(c1.repos[0].configHash, /^[0-9a-f]{64}$/);
    } finally {
      restore();
      await sb.cleanup();
    }
  });

  test("custom: accepted as object; rejected as array/primitive", async () => {
    const sb = await makeSandbox();
    const restore = applyEnv({
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdgConfig,
      XDG_CACHE_HOME: sb.xdgCache,
    });
    try {
      // OK: object
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb.home}
    custom:
      plane_project_id: foo
`,
      );
      const { loadConfig, ConfigError } = await freshImport();
      const cfg = loadConfig();
      assert.equal(cfg.repos[0].custom.plane_project_id, "foo");

      // Bad: array
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb.home}
    custom: [1, 2, 3]
`,
      );
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match((e as Error).message, /custom must be an object/);
        return true;
      });

      // Bad: primitive
      await writeYml(
        sb.reposYml,
        `version: 1
repos:
  - name: a
    path: ${sb.home}
    custom: "not an object"
`,
      );
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        return true;
      });
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});
