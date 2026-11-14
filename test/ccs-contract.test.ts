/**
 * repos.yml as a contract with other tools.
 *
 * docs/design/repos-yml-schema.md promises that, while `version: 1` holds,
 * keys are only added and the minimal form keeps loading; that ccs writes the
 * block form a line-based reader can parse; and that its tables describe what
 * bin/ccs-config.ts reads. These tests hold each of those to the code.
 *
 *  1. The minimal sample is fixed here. It must stay in the document as
 *     written and keep loading with the same meaning.
 *  2. The recommended form: the sample, the first-run template and what
 *     `ccs init` appends are readable line by line (`- name:` then `path:`).
 *  3. The document's tables, its JSON Schema and the keys the loader knows
 *     name the same keys.
 *  4. The strict readings: true/false only for `disabled` and `scan`, a blank
 *     `description` / `icon` as unset, the `custom` size limit, and `ccs init`
 *     refusing a one-line `repos:` list.
 *
 * HOME is a temp directory, fzf and claude are stubs, values are made up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig, ensureConfigDir, ConfigError, type CcsConfig } from "../bin/ccs-config.ts";
import { appendReposToYaml } from "../bin/ccs-init.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = readFileSync(join(REPO_ROOT, "docs", "design", "repos-yml-schema.md"), "utf-8");
const CONFIG_SOURCE = readFileSync(join(REPO_ROOT, "bin", "ccs-config.ts"), "utf-8");
const CCS_BIN = join(REPO_ROOT, "bin", "ccs");
const INIT_TS = join(REPO_ROOT, "bin", "ccs-init.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

// The minimal repos.yml an installer writes. Changing this text is changing the
// contract: the document's sample has to change with it, and readers be told.
const MINIMAL = `version: 1
defaults:
  command: "claude"
  ui: simple
repos:
  - name: example
    path: ~/projects/example
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Home {
  root: string;
  home: string;
  reposYml: string;
  cleanup: () => Promise<void>;
}

async function makeHome(): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), "ccs-contract-"));
  const home = join(root, "home");
  await mkdir(join(home, ".config", "ccs"), { recursive: true });
  return {
    root,
    home,
    reposYml: join(home, ".config", "ccs", "repos.yml"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface Loaded {
  cfg: CcsConfig | null;
  err: Error | null;
  warnings: string[];
}

/** Run `fn` with HOME pointed at the sandbox, collecting what it warns. */
function inHome<T>(h: Home, fn: () => T): { value: T | null; err: Error | null; warnings: string[] } {
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CCS_CMD", "CCR_CMD"] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = h.home;
  process.env.XDG_CONFIG_HOME = join(h.home, ".config");
  process.env.XDG_CACHE_HOME = join(h.home, ".cache");
  delete process.env.CCS_CMD;
  delete process.env.CCR_CMD;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), err: null, warnings };
  } catch (e) {
    return { value: null, err: e as Error, warnings };
  } finally {
    console.warn = warn;
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

/** Write `text` as repos.yml (creating the directories it names) and load it. */
async function load(h: Home, text: string, dirs: string[] = []): Promise<Loaded> {
  for (const d of dirs) await mkdir(join(h.home, d), { recursive: true });
  await writeFile(h.reposYml, text);
  const r = inHome(h, () => loadConfig());
  return { cfg: r.value, err: r.err, warnings: r.warnings };
}

const one = (extra: string): string => `version: 1\nrepos:\n  - name: a\n    path: ~/a\n${extra}`;

/**
 * What a reader without a YAML parser sees: an item starts at `- name:`, and
 * its `path:` is the one written directly under it.
 */
function readByLine(text: string): { name: string; path: string }[] {
  const clean = (v: string): string => v.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  const items: { name: string; path: string }[] = [];
  let indent = -1;
  for (const line of text.split("\n")) {
    const item = /^(\s*)-\s+name:\s*(.*)$/.exec(line);
    if (item) {
      items.push({ name: clean(item[2]), path: "" });
      indent = item[1].length + 2;
      continue;
    }
    const path = /^(\s*)path:\s*(.*)$/.exec(line);
    if (path && items.length > 0 && path[1].length === indent) items[items.length - 1].path = clean(path[2]);
  }
  return items;
}

const expand = (h: Home, p: string): string => (p === "~" ? h.home : p.replace(/^~\//, `${h.home}/`));

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// The document, read as data
// ---------------------------------------------------------------------------

/** The `## ` section holding `marker`. */
function section(marker: string): string {
  const found = DOC.split(/^## /m).filter((s) => s.includes(marker));
  assert.equal(found.length, 1, `one section of the document holds ${marker}`);
  return found[0];
}

/** The keys in the first column of a section's own tables (not its `### ` parts'). */
const tableKeys = (text: string): string[] =>
  [...text.split(/^### /m)[0].matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

const fenced = (lang: string): string[] =>
  [...DOC.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```", "gm"))].map((m) => m[1]);

const TOP_TABLE = tableKeys(section("| `repos` | array |"));
const REPO_TABLE = tableKeys(section("| `name` | string |"));

interface Schema {
  properties: {
    defaults: { properties: Record<string, unknown> };
    repos: { items: { properties: Record<string, unknown> } };
  } & Record<string, unknown>;
}
const SCHEMA = JSON.parse(fenced("json")[0] ?? "null") as Schema;

/** The string members of a `new Set([...])` the loader declares. */
function knownKeys(name: string): string[] {
  const m = new RegExp(name + " = new Set\\(\\[([\\s\\S]*?)\\]\\)").exec(CONFIG_SOURCE);
  assert.ok(m, `${name} is declared in bin/ccs-config.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const sorted = (a: Iterable<string>): string[] => [...a].sort();

// ---------------------------------------------------------------------------
// 1. The minimal sample
// ---------------------------------------------------------------------------

describe("repos.yml contract: the minimal version 1 sample", () => {
  test("the document shows the sample exactly as fixed here", () => {
    assert.ok(
      fenced("yaml").includes(MINIMAL),
      "docs/design/repos-yml-schema.md must keep the minimal sample as written in this test",
    );
  });

  test("it loads, with the meaning the contract gives each key", async () => {
    const h = await makeHome();
    try {
      const { cfg, err, warnings } = await load(h, MINIMAL, ["projects/example"]);
      assert.equal(err, null, err?.message);
      assert.deepEqual(warnings, [], "no warning for the minimal form");
      assert.equal(cfg?.version, 1);
      assert.deepEqual(cfg?.defaults, { command: "claude", ui: "simple" });
      assert.equal(cfg?.repos.length, 1);
      const repo = cfg?.repos[0];
      assert.equal(repo?.name, "example");
      assert.equal(repo?.path, join(h.home, "projects", "example"), "a leading ~ is $HOME");
      assert.equal(repo?.command, "claude", "an entry without command takes defaults.command");
      // What an entry gets when it writes nothing else.
      assert.equal(repo?.description, "");
      assert.equal(repo?.disabled, false);
      assert.equal(repo?.scan, true);
      assert.equal(repo?.launch, true);
      assert.equal(repo?.lead, false);
      assert.equal(repo?.label, "");
      assert.deepEqual(repo?.tags, []);
      assert.deepEqual(repo?.custom, {});
    } finally {
      await h.cleanup();
    }
  });

  test("only the integer 1 is version 1", async () => {
    const h = await makeHome();
    try {
      for (const version of ["2", '"1"', "1.5", "true", ""]) {
        const { err } = await load(h, MINIMAL.replace("version: 1", `version: ${version}`), ["projects/example"]);
        assert.ok(err instanceof ConfigError, `version: ${version}`);
        assert.match(err.message, /unsupported version/, `version: ${version}`);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("keys added later do not stop a reader: ignored, with a warning outside defaults", async () => {
    const h = await makeHome();
    try {
      const text = MINIMAL.replace("  ui: simple\n", "  ui: simple\n  added_in_defaults: 1\n")
        .replace("    path: ~/projects/example\n", "    path: ~/projects/example\n    added_in_entry: 1\n")
        .concat("added_at_top: 1\n");
      const { cfg, err, warnings } = await load(h, text, ["projects/example"]);
      assert.equal(err, null, err?.message);
      assert.equal(cfg?.repos[0].name, "example");
      assert.deepEqual(warnings, [
        '[ccs] unknown key "added_at_top" in top-level (ignored)',
        '[ccs] unknown key "added_in_entry" in repos[0] (ignored)',
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("other tools' values under custom come back as written", async () => {
    const h = await makeHome();
    try {
      const custom = "    custom:\n      tool_a: { id: 7, tags: [x, y] }\n      tool_b: on-call\n";
      const { cfg, err, warnings } = await load(h, MINIMAL + custom, ["projects/example"]);
      assert.equal(err, null, err?.message);
      assert.deepEqual(warnings, []);
      assert.deepEqual(cfg?.repos[0].custom, { tool_a: { id: 7, tags: ["x", "y"] }, tool_b: "on-call" });
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The recommended form
// ---------------------------------------------------------------------------

describe("repos.yml contract: the form a line-based reader can parse", () => {
  test("the minimal sample reads the same line by line as through the loader", async () => {
    const h = await makeHome();
    try {
      const { cfg } = await load(h, MINIMAL, ["projects/example"]);
      const lines = readByLine(MINIMAL);
      assert.deepEqual(lines, [{ name: "example", path: "~/projects/example" }]);
      assert.deepEqual(
        lines.map((r) => ({ name: r.name, path: expand(h, r.path) })),
        cfg?.repos.map((r) => ({ name: r.name, path: r.path })),
      );
      assert.ok(!/^repos:\s*\[/m.test(MINIMAL), "block form, not a one-line list");
    } finally {
      await h.cleanup();
    }
  });

  test("the one-line form is what a line-based reader cannot see", () => {
    assert.deepEqual(readByLine("version: 1\nrepos: [{name: a, path: ~/a}]\n"), []);
  });

  test("the first-run template is in the recommended form", async () => {
    const h = await makeHome();
    try {
      await rm(join(h.home, ".config"), { recursive: true });
      const made = inHome(h, () => {
        ensureConfigDir();
        return loadConfig();
      });
      assert.equal(made.err, null, made.err?.message);
      const text = await readFile(h.reposYml, "utf-8");
      assert.deepEqual(
        readByLine(text).map((r) => ({ name: r.name, path: expand(h, r.path) })),
        made.value?.repos.map((r) => ({ name: r.name, path: r.path })),
      );
    } finally {
      await h.cleanup();
    }
  });

  test("ccs init appends in the recommended form", () => {
    const added = appendReposToYaml(MINIMAL, [
      { name: "second", path: "~/work/second" },
      { name: "third", path: "~/work/third" },
    ]);
    assert.ok(added.startsWith(MINIMAL), "what was there stays byte for byte");
    assert.deepEqual(readByLine(added), [
      { name: "example", path: "~/projects/example" },
      { name: "second", path: "~/work/second" },
      { name: "third", path: "~/work/third" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The document and the loader name the same keys
// ---------------------------------------------------------------------------

describe("repos.yml contract: the document matches the keys the loader reads", () => {
  test("entry keys: the table, the JSON Schema and the loader agree", () => {
    const loader = sorted(knownKeys("KNOWN_REPO_KEYS"));
    assert.deepEqual(sorted(REPO_TABLE), loader, "the repos[] table");
    assert.deepEqual(sorted(Object.keys(SCHEMA.properties.repos.items.properties)), loader, "the JSON Schema");
  });

  test("top-level keys: the table, the JSON Schema and the loader agree", () => {
    const loader = sorted(knownKeys("KNOWN_TOP_KEYS"));
    assert.deepEqual(sorted(TOP_TABLE.filter((k) => !k.includes("."))), loader, "the top-level table");
    assert.deepEqual(sorted(Object.keys(SCHEMA.properties)), loader, "the JSON Schema");
  });

  test("defaults keys: the table and the JSON Schema agree, and the loader reads none beyond them", () => {
    const table = sorted(TOP_TABLE.filter((k) => k.startsWith("defaults.")).map((k) => k.slice("defaults.".length)));
    assert.deepEqual(table, sorted(Object.keys(SCHEMA.properties.defaults.properties)));
    const read = new Set([...CONFIG_SOURCE.matchAll(/\bdefaults\.([a-z_]+)\b/g)].map((m) => m[1]));
    assert.ok(read.size > 0, "the loader reads defaults.<key>");
    for (const key of read) assert.ok(table.includes(key), `defaults.${key} is read but not documented`);
  });

  test("defaults keys: the loader reads every documented key", () => {
    const table = TOP_TABLE.filter((k) => k.startsWith("defaults.")).map((k) => k.slice("defaults.".length));
    const read = new Set([...CONFIG_SOURCE.matchAll(/\bdefaults\.([a-z_]+)\b/g)].map((m) => m[1]));
    assert.deepEqual(sorted(read), sorted(table));
  });

  test("an entry using every documented key loads without an unknown-key warning", async () => {
    const h = await makeHome();
    try {
      const values: Record<string, string> = {
        name: "all-keys",
        path: "~/all",
        description: "every key the table lists",
        command: "claude",
        cwd: "~/all",
        tags: "[one, two]",
        disabled: "false",
        scan: "true",
        icon: '"*"',
        launch: "true",
        label: "All keys",
        lead: "false",
        custom: "{ note: made up }",
      };
      assert.deepEqual(sorted(Object.keys(values)), sorted(REPO_TABLE), "this test covers the whole table");
      const entry = REPO_TABLE.map((k, i) => `${i === 0 ? "  - " : "    "}${k}: ${values[k]}`).join("\n");
      const ok = await load(h, `version: 1\nrepos:\n${entry}\n`, ["all"]);
      assert.equal(ok.err, null, ok.err?.message);
      assert.deepEqual(ok.warnings, []);
      // The same check does catch a key the loader does not know.
      const extra = await load(h, `version: 1\nrepos:\n${entry}\n    not_in_the_table: 1\n`, ["all"]);
      assert.deepEqual(extra.warnings, ['[ccs] unknown key "not_in_the_table" in repos[0] (ignored)']);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Strict readings
// ---------------------------------------------------------------------------

describe("repos.yml: disabled and scan take only true or false", () => {
  test("true and false are read as written; a missing key is the default", async () => {
    const h = await makeHome();
    try {
      for (const [extra, disabled, scan] of [
        ["", false, true],
        ["    disabled: true\n", true, true],
        ["    disabled: false\n", false, true],
        ["    scan: false\n", false, false],
        ["    scan: true\n", false, true],
        ["    disabled: true\n    scan: false\n", true, false],
      ] as const) {
        const { cfg, err } = await load(h, one(extra), ["a"]);
        assert.equal(err, null, `${JSON.stringify(extra)}: ${err?.message}`);
        assert.equal(cfg?.repos[0].disabled, disabled, JSON.stringify(extra));
        assert.equal(cfg?.repos[0].scan, scan, JSON.stringify(extra));
      }
    } finally {
      await h.cleanup();
    }
  });

  for (const key of ["disabled", "scan"] as const) {
    test(`${key}: anything else is an error naming the key and the value`, async () => {
      const h = await makeHome();
      try {
        for (const [written, got] of [
          ['"false"', '"false"'],
          ['"true"', '"true"'],
          ["1", "1"],
          ["0", "0"],
          ["null", "null"],
          ["", "null"],
          ["yes", '"yes"'],
          ["[true]", "[true]"],
        ] as const) {
          const { err } = await load(h, one(`    ${key}: ${written}\n`), ["a"]);
          assert.ok(err instanceof ConfigError, `${key}: ${written} must be refused`);
          assert.ok(
            err.message.endsWith(`repos[0].${key} must be true or false (got ${got})`),
            `${key}: ${written} -> ${err.message}`,
          );
        }
      } finally {
        await h.cleanup();
      }
    });
  }
});

describe("repos.yml: a value that refers to itself", () => {
  // YAML lets a value hold an alias to itself; nothing ccs reads can be that.
  test("inside an entry it is an entry error naming the entry; elsewhere a parse error", async () => {
    const h = await makeHome();
    try {
      for (const line of ["disabled: &x [*x]", "custom: &x {a: *x}", "tags: &x [*x]", "description: &x [*x]"]) {
        const { err } = await load(h, one(`    ${line}\n`), ["a"]);
        assert.ok(err instanceof ConfigError, `${line}: ${String(err)}`);
        assert.match(err.message, /repos\[0\]/, line);
      }
      const top = await load(h, "version: 1\ndefaults: &d {x: *d}\nrepos:\n  - name: a\n    path: ~/a\n", ["a"]);
      assert.ok(top.err instanceof ConfigError, String(top.err));
    } finally {
      await h.cleanup();
    }
  });
});

describe("repos.yml: a blank description or icon is unset", () => {
  test("blank, null and ~ give no description and the default icon", async () => {
    const h = await makeHome();
    try {
      const plain = await load(h, one(""), ["a"]);
      for (const blank of ["", " null", " ~"]) {
        const { cfg, err } = await load(h, one(`    description:${blank}\n    icon:${blank}\n`), ["a"]);
        assert.equal(err, null, err?.message);
        assert.equal(cfg?.repos[0].description, "", `description:${blank}`);
        assert.equal(cfg?.repos[0].icon, plain.cfg?.repos[0].icon, `icon:${blank}`);
        assert.notEqual(cfg?.repos[0].icon, "null");
      }
    } finally {
      await h.cleanup();
    }
  });

  test("a value that is not a string is still shown as text", async () => {
    const h = await makeHome();
    try {
      const { cfg, err } = await load(h, one("    description: 12\n    icon: 7\n"), ["a"]);
      assert.equal(err, null, err?.message);
      assert.equal(cfg?.repos[0].description, "12");
      assert.equal(cfg?.repos[0].icon, "7");
      const quoted = await load(h, one('    description: "null"\n'), ["a"]);
      assert.equal(quoted.cfg?.repos[0].description, "null", "the quoted word is a description");
    } finally {
      await h.cleanup();
    }
  });
});

describe("repos.yml: the custom size limit", () => {
  // {"blob":"…"} is the string plus 11 characters.
  const withBlob = (n: number): string => one(`    custom:\n      blob: ${"x".repeat(n)}\n`);

  test("64,000 characters of JSON pass, one more does not", async () => {
    const h = await makeHome();
    try {
      const fits = await load(h, withBlob(64_000 - 11), ["a"]);
      assert.equal(fits.err, null, fits.err?.message);
      const over = await load(h, withBlob(64_000 - 10), ["a"]);
      assert.ok(over.err instanceof ConfigError);
      assert.ok(over.err.message.includes("got 64001"), over.err.message);
    } finally {
      await h.cleanup();
    }
  });

  test("the error says what is measured", async () => {
    const h = await makeHome();
    try {
      const { err } = await load(h, withBlob(64_100), ["a"]);
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes("64KB limit"), err.message);
      assert.ok(err.message.includes("64,000 characters of JSON; got 64111"), err.message);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs init and a one-line repos list
// ---------------------------------------------------------------------------

// fzf picks everything it is offered.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "0.65.0 (fake)"; exit 0; fi
cat
`;
const FAKE_CLAUDE = "#!/usr/bin/env bash\nexit 0\n";

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

async function initHome(text: string): Promise<Home & { env: NodeJS.ProcessEnv }> {
  const h = await makeHome();
  const stubBin = join(h.root, "stub-bin");
  await mkdir(stubBin, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  await mkdir(join(h.home, "a"), { recursive: true });
  // One repo that is not registered yet, for discover to offer.
  const init = spawnSync("git", ["init", "-q", join(h.home, "b")], {
    encoding: "utf-8",
    env: { ...process.env, HOME: h.home },
  });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(h.reposYml, text);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    HOME: h.home,
    XDG_CONFIG_HOME: join(h.home, ".config"),
    XDG_CACHE_HOME: join(h.home, ".cache"),
    CCS_NO_UPDATE_CHECK: "1",
    COLUMNS: "120",
  };
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  delete env.CCS_UI;
  return { ...h, env };
}

function autoDiscover(h: { env: NodeJS.ProcessEnv; root: string }): Cli {
  const res = spawnSync("bash", [CCS_BIN, "init", "--auto-discover"], { encoding: "utf-8", env: h.env, cwd: h.root });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function append(h: { env: NodeJS.ProcessEnv; root: string }, candidates: string): Cli {
  const res = spawnSync(TSX, [INIT_TS, "append"], { encoding: "utf-8", env: h.env, cwd: h.root, input: candidates });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const ONE_LINE = "version: 1\nrepos: [{name: a, path: ~/a}]\n";
const BLOCK = "version: 1\nrepos:\n  - name: a\n    path: ~/a\n";
const BLOCK_WITH_ONE_LINE_ITEM = "version: 1\nrepos:\n  - {name: a, path: ~/a}\n";

describe("ccs init and a one-line repos list", () => {
  test("--auto-discover refuses it: exit 1, the reason word, the file untouched", async () => {
    const h = await initHome(ONE_LINE);
    try {
      const res = autoDiscover(h);
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.ok(res.stderr.includes("flow_style_repos"), res.stderr);
      assert.equal(await readFile(h.reposYml, "utf-8"), ONE_LINE);
      assert.equal(await exists(h.reposYml + ".bak"), false, "no backup is written for a refusal");
    } finally {
      await h.cleanup();
    }
  });

  test("append refuses it the same way", async () => {
    const h = await initHome(ONE_LINE);
    try {
      const res = append(h, "b\t~/b\n");
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.ok(res.stderr.includes("flow_style_repos"), res.stderr);
      assert.equal(await readFile(h.reposYml, "utf-8"), ONE_LINE);
      assert.equal(await exists(h.reposYml + ".bak"), false);
    } finally {
      await h.cleanup();
    }
  });

  test("an empty one-line list: discover stops at the loader, append at the form", async () => {
    const empty = "version: 1\nrepos: []\n";
    const h = await initHome(empty);
    try {
      const discover = autoDiscover(h);
      assert.equal(discover.code, 1, discover.stdout + discover.stderr);
      assert.ok(discover.stderr.includes("repos must be a non-empty array"), discover.stderr);
      const added = append(h, "b\t~/b\n");
      assert.equal(added.code, 1, added.stdout + added.stderr);
      assert.ok(added.stderr.includes("flow_style_repos"), added.stderr);
      assert.equal(await readFile(h.reposYml, "utf-8"), empty);
      assert.equal(await exists(h.reposYml + ".bak"), false);
    } finally {
      await h.cleanup();
    }
  });

  for (const [name, text] of [
    ["a block list", BLOCK],
    ["a block list holding a one-line item", BLOCK_WITH_ONE_LINE_ITEM],
  ] as const) {
    test(`--auto-discover still adds to ${name}, in the recommended form, keeping a backup`, async () => {
      const h = await initHome(text);
      try {
        const res = autoDiscover(h);
        assert.equal(res.code, 0, res.stdout + res.stderr);
        const after = await readFile(h.reposYml, "utf-8");
        assert.ok(after.startsWith(text), "what was there stays byte for byte");
        assert.deepEqual(readByLine(after.slice(text.length)), [{ name: "b", path: "~/b" }]);
        assert.equal(await readFile(h.reposYml + ".bak", "utf-8"), text);
      } finally {
        await h.cleanup();
      }
    });
  }
});
