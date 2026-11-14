/**
 * The commands for scripts and tools: `ccs doctor` and `ccs list --json`
 * (docs/design/machine-interface.md).
 *
 * What a caller relies on, and what these tests hold:
 *  - one JSON object on stdout, with the outer keys, whatever happened;
 *  - the exit code and `status` say the same thing, from one table;
 *  - reason words are lowercase snake_case, in one of two vocabularies;
 *  - no repo path, launch command or `custom` value unless asked for, and in
 *    `doctor` no repo name either;
 *  - nothing is created in the config or cache directories, nothing of ccs's
 *    own stays in TMPDIR, and no request leaves the machine;
 *  - the six command words are commands only as the first argument.
 *
 * No TTY, stdin closed, HOME / XDG / TMPDIR in a temp directory, fzf and
 * claude are stubs, values are made up.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  copyFile,
  symlink,
  stat,
  access,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openDb } from "../bin/ccs-db.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const BIN_DIR = dirname(CCS_BIN);
const NODE_MODULES = join(REPO_ROOT, "node_modules");

// ---------------------------------------------------------------------------
// The contract tables (machine-interface.md 1.3, 1.4, 2.1)
// ---------------------------------------------------------------------------

const STATUS_OF_EXIT: Record<number, string> = {
  0: "ok",
  1: "failed",
  2: "usage",
  3: "unverifiable",
  4: "missing_prerequisite",
  5: "not_found",
  6: "rejected",
  7: "partial",
  130: "interrupted",
};
const WORD = /^[a-z][a-z0-9_]*$/;
const VOCABS = ["ccs.health", "ccs.cli"];
const CHECK_NAMES = [
  "node",
  "tsx",
  "modules",
  "sqlite",
  "fzf",
  "claude",
  "config",
  "config_layout",
  "cache",
  "terminal",
  "groups_dir",
];
const STAGE2_CHECKS = ["sqlite", "config", "config_layout", "cache", "terminal", "groups_dir"];

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

// The stub answers the version question; given rows, it keeps them and either
// picks the row named by FAKE_FZF_PICK or leaves as fzf does on Esc.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "\${FAKE_FZF_VERSION:-0.65.0} (fake)"; exit 0; fi
rows=$(cat)
printf '%s\\n' "$rows" > "$FAKE_FZF_ROWS"
while IFS= read -r row; do
  if [[ -n "\${FAKE_FZF_PICK:-}" && "$(printf '%s' "$row" | cut -f4)" == "$FAKE_FZF_PICK" ]]; then
    printf '%s\\n' "$row"; exit 0
  fi
done <<< "$rows"
exit 130
`;
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$FAKE_CLAUDE_LOG"
`;

interface Box {
  root: string;
  home: string;
  configDir: string;
  cacheDir: string;
  reposYml: string;
  stubBin: string;
  tmp: string;
  fzfRows: string;
  claudeLog: string;
  cleanup: () => Promise<void>;
}

async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-machine-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const tmp = join(root, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(stubBin, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  return {
    root,
    home,
    configDir: join(home, ".config", "ccs"),
    cacheDir: join(home, ".cache", "ccs"),
    reposYml: join(home, ".config", "ccs", "repos.yml"),
    stubBin,
    tmp,
    fzfRows: join(root, "fzf-rows.txt"),
    claudeLog: join(root, "claude.log"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Write repos.yml and make the directories under HOME it should find. */
async function config(box: Box, text: string, dirs: string[] = []): Promise<void> {
  await mkdir(box.configDir, { recursive: true });
  for (const d of dirs) await mkdir(join(box.home, d), { recursive: true });
  await writeFile(box.reposYml, text);
}

const ONE = "version: 1\nrepos:\n  - name: one\n    path: ~/proj/one\n";

interface RunOptions {
  bin?: string;
  env?: Record<string, string | undefined>;
  path?: string;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function envFor(box: Box, opts: RunOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: opts.path ?? `${box.stubBin}:${process.env.PATH ?? ""}`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    FAKE_FZF_ROWS: box.fzfRows,
    FAKE_CLAUDE_LOG: box.claudeLog,
  };
  for (const k of ["CCS_CMD", "CCR_CMD", "CCS_UI", "CCS_NO_UPDATE_CHECK", "CCS_UPDATE_REGISTRY", "CCS_DOCTOR_TIMEOUT"]) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(box: Box, args: string[], opts: RunOptions = {}): Result {
  const res = spawnSync("bash", [opts.bin ?? CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box, opts),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** Every file under `dir`: size, modification time and a hash of the content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p);
        const hash = createHash("sha256").update(await readFile(p)).digest("hex");
        out[p.slice(dir.length + 1)] = `${s.size}:${s.mtimeMs}:${hash}`;
      }
    }
  };
  await walk(dir);
  return out;
}

/** What is left in TMPDIR. The TypeScript runner keeps its own cache there (`tsx-<uid>`); that is not ccs's. */
async function leftInTmp(box: Box): Promise<string[]> {
  return (await readdir(box.tmp)).filter((n) => !n.startsWith("tsx-"));
}

// ---------------------------------------------------------------------------
// Other ways ccs can be installed, and a PATH with only what is named
// ---------------------------------------------------------------------------

interface CopyOptions {
  /** `link`: the real node_modules. `no-sqlite`: every module but better-sqlite3. `none`: nothing. */
  modules?: "link" | "no-sqlite" | "none";
  /** Text of a package.json above the scripts (null = none). */
  manifest?: string | null;
  /** Replace ccs-doctor.ts with this source. */
  doctor?: string;
}

/** What install.sh copies: ccs, ccs-*.ts and ccs-*.sh in one directory. */
async function copyLayout(dir: string, opts: CopyOptions = {}): Promise<string> {
  const scripts = join(dir, "scripts");
  await mkdir(scripts, { recursive: true });
  for (const name of await readdir(BIN_DIR)) {
    if (name === "ccs" || /^ccs-.*\.(ts|sh)$/.test(name)) await copyFile(join(BIN_DIR, name), join(scripts, name));
  }
  const modules = opts.modules ?? "link";
  if (modules === "link") {
    await symlink(NODE_MODULES, join(scripts, "node_modules"));
  } else if (modules === "no-sqlite") {
    await mkdir(join(scripts, "node_modules"));
    for (const name of await readdir(NODE_MODULES)) {
      if (name !== "better-sqlite3") await symlink(join(NODE_MODULES, name), join(scripts, "node_modules", name));
    }
  }
  if (opts.doctor !== undefined) await writeFile(join(scripts, "ccs-doctor.ts"), opts.doctor);
  if (opts.manifest !== undefined && opts.manifest !== null) await writeFile(join(dir, "package.json"), opts.manifest);
  return join(scripts, "ccs");
}

const BASE_TOOLS = [
  "bash", "sh", "env", "cat", "head", "tail", "date", "mktemp", "rm", "sleep", "grep", "uname", "tr",
  "dirname", "basename", "readlink", "sed", "awk", "cut", "wc", "sort", "uniq", "stty", "tput", "mkdir",
  "chmod", "ls", "cp", "mv", "touch", "id", "tee", "find", "ps", "kill",
];

/** A directory holding links to the named tools only, to use as the whole PATH. */
async function pathOf(box: Box, name: string, tools: string[]): Promise<string> {
  const dir = join(box.root, `path-${name}`);
  await mkdir(dir, { recursive: true });
  for (const tool of [...BASE_TOOLS, ...tools]) {
    let target: string;
    if (tool === "node") target = process.execPath;
    else if (tool === "fzf" || tool === "claude") target = join(box.stubBin, tool);
    else {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" });
      target = (found.stdout ?? "").trim();
      if (!target.startsWith("/")) continue;
    }
    await symlink(target, join(dir, tool)).catch(() => {});
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

interface Reason {
  vocab: string;
  code: string;
  detail?: string;
  entry_index?: number;
}
interface Check {
  name: string;
  status: string;
  code: string;
  [key: string]: unknown;
}
interface Answer {
  schema_version: string;
  product_id: string;
  product_version: string;
  command: string;
  written_at: string;
  status: string;
  reasons: Reason[];
  installed?: string;
  running?: string;
  checks?: Check[];
  platform?: { os: string; arch: string };
  settings?: { ui: string; update_check: string; update_check_off_by: string | null };
  repos?: Record<string, unknown>[];
  groups?: unknown[];
}

/** stdout is one JSON object and a newline; its outer keys and words follow the contract. */
function answer(res: Result, what: string): Answer {
  assert.ok(res.stdout.endsWith("\n") && !res.stdout.endsWith("\n\n"), `${what}: one object, one newline: ${res.stdout}`);
  let a: Answer;
  try {
    a = JSON.parse(res.stdout) as Answer;
  } catch {
    assert.fail(`${what}: stdout is not one JSON object: ${res.stdout}\n${res.stderr}`);
  }
  assert.match(a.schema_version, /^1\.\d+\.\d+$/, what);
  assert.equal(a.product_id, "ccs", what);
  assert.equal(typeof a.product_version, "string", what);
  assert.equal(typeof a.command, "string", what);
  assert.match(a.written_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, what);
  assert.equal(a.status, STATUS_OF_EXIT[res.code], `${what}: exit ${res.code} and status ${a.status}`);
  assert.ok(Array.isArray(a.reasons) && a.reasons.length > 0, `${what}: at least one reason`);
  for (const r of a.reasons) {
    assert.ok(VOCABS.includes(r.vocab), `${what}: vocab ${r.vocab}`);
    assert.match(r.code, WORD, what);
    if (r.detail !== undefined) assert.match(r.detail, WORD, what);
  }
  for (const c of a.checks ?? []) {
    assert.match(c.name, WORD, what);
    assert.match(c.status, WORD, what);
    assert.match(c.code, WORD, what);
  }
  for (const r of a.repos ?? []) assert.match(String(r.kind), WORD, what);
  for (const v of [a.installed, a.running, a.platform?.os, a.platform?.arch, a.settings?.ui, a.settings?.update_check]) {
    if (v !== undefined) assert.match(v, WORD, what);
  }
  return a;
}

const codes = (a: Answer): string[] => a.reasons.map((r) => `${r.vocab}:${r.code}`);
const check = (a: Answer, name: string): Check => {
  const found = a.checks?.find((c) => c.name === name);
  assert.ok(found, `the ${name} check is in the answer`);
  return found;
};
const stateOf = (a: Answer, name: string): string => `${check(a, name).status}:${check(a, name).code}`;

function doctor(box: Box, opts: RunOptions = {}, args: string[] = ["--json"]): { res: Result; a: Answer } {
  const res = run(box, ["doctor", ...args], opts);
  const a = answer(res, `ccs doctor ${args.join(" ")}`);
  assert.equal(a.command, "doctor");
  assert.ok([0, 1, 2, 3].includes(res.code), `doctor uses 0 to 3 only (got ${res.code})`);
  assert.equal(a.installed, "installed");
  assert.equal(a.running, "not_applicable");
  if (a.checks) assert.deepEqual(a.checks.map((c) => c.name), CHECK_NAMES, "the checks, in the documented order");
  return { res, a };
}

function list(box: Box, args: string[], opts: RunOptions = {}): { res: Result; a: Answer } {
  const res = run(box, ["list", ...args], opts);
  const a = answer(res, `ccs list ${args.join(" ")}`);
  assert.equal(a.command, "list");
  for (const r of a.reasons) assert.equal(r.vocab, "ccs.cli");
  return { res, a };
}

// ---------------------------------------------------------------------------
// ccs doctor
// ---------------------------------------------------------------------------

describe("ccs doctor: everything in place", () => {
  test("exit 0, ok, the checks in order, the settings in effect", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const { res, a } = doctor(box);
      assert.equal(res.code, 0, res.stderr);
      assert.deepEqual(codes(a), ["ccs.health:ok"]);
      assert.equal(a.checks?.length, 11);
      for (const name of ["node", "tsx", "modules", "sqlite", "fzf", "claude", "config", "config_layout"]) {
        assert.equal(stateOf(a, name), "ok:ok", name);
      }
      assert.equal(check(a, "fzf").version, "0.65.0");
      assert.match(String(check(a, "node").version), /^\d+\.\d+\.\d+$/);
      assert.deepEqual(
        { repos: check(a, "config").repos, disabled: check(a, "config").disabled, missing: check(a, "config").paths_missing, unknown: check(a, "config").unknown_keys },
        { repos: 1, disabled: 0, missing: 0, unknown: 0 },
      );
      assert.equal(stateOf(a, "terminal"), "skipped:not_set");
      assert.equal(stateOf(a, "groups_dir"), "skipped:not_set");
      assert.match(a.written_at, /\.\d{3}Z$/, "the module answers with milliseconds");
      assert.deepEqual(a.settings, { ui: "classic", update_check: "on", update_check_off_by: null });
      assert.equal(res.stderr, "");
    } finally {
      await box.cleanup();
    }
  });

  test("settings follow CCS_UI, defaults.ui and CCS_NO_UPDATE_CHECK", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE.replace("repos:", "defaults:\n  ui: simple\nrepos:"), ["proj/one"]);
      assert.equal(doctor(box).a.settings?.ui, "simple");
      assert.equal(doctor(box, { env: { CCS_UI: "classic" } }).a.settings?.ui, "classic");
      const off = doctor(box, { env: { CCS_NO_UPDATE_CHECK: "1" } }).a.settings;
      assert.deepEqual({ check: off?.update_check, by: off?.update_check_off_by }, { check: "off", by: "env" });
    } finally {
      await box.cleanup();
    }
  });

  test("without --json: the same exit code, and a table for people", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const res = run(box, ["doctor"]);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(res.stdout.length > 0);
      assert.throws(() => JSON.parse(res.stdout), "not JSON unless asked");
    } finally {
      await box.cleanup();
    }
  });
});

describe("ccs doctor: something it needs is missing", () => {
  for (const [missing, word] of [
    ["fzf", "fzf_missing"],
    ["claude", "claude_missing"],
  ] as const) {
    test(`${missing} not on PATH: exit 1, the ${missing} check fails with ${word}`, async () => {
      const box = await makeBox();
      try {
        await config(box, ONE, ["proj/one"]);
        const path = await pathOf(box, `no-${missing}`, ["node", ...["fzf", "claude"].filter((t) => t !== missing)]);
        const { res, a } = doctor(box, { path });
        assert.equal(res.code, 1, res.stdout + res.stderr);
        assert.equal(stateOf(a, missing), `fail:${word}`);
        assert.deepEqual(codes(a), [`ccs.health:${word}`]);
        assert.equal(stateOf(a, "config"), "ok:ok", "the other checks still run");
      } finally {
        await box.cleanup();
      }
    });
  }

  test("node not on PATH: exit 1, answered without any module", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const path = await pathOf(box, "no-node", ["fzf", "claude"]);
      const { res, a } = doctor(box, { path });
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.equal(stateOf(a, "node"), "fail:node_missing");
      assert.deepEqual(codes(a), ["ccs.health:node_missing"]);
      assert.equal(a.checks?.length, 11);
      assert.equal(stateOf(a, "modules"), "skipped:blocked");
      for (const name of STAGE2_CHECKS) assert.equal(stateOf(a, name), "skipped:blocked", name);
      assert.match(a.written_at, /:\d{2}Z$/, "bash answers to the second");
      assert.equal(a.settings, undefined, "no settings without the module");
      assert.ok(a.platform);
    } finally {
      await box.cleanup();
    }
  });

  test("an fzf too old to run ccs fails; one only too old for a feature warns", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const old = doctor(box, { env: { FAKE_FZF_VERSION: "0.41.0" } });
      assert.equal(old.res.code, 1);
      assert.equal(stateOf(old.a, "fzf"), "fail:fzf_too_old");
      assert.deepEqual(codes(old.a), ["ccs.health:fzf_too_old"]);

      const headers = doctor(box, { env: { FAKE_FZF_VERSION: "0.44.0" } });
      assert.equal(headers.res.code, 0);
      assert.equal(stateOf(headers.a, "fzf"), "warn:fzf_too_old_for_headers");
      assert.equal(check(headers.a, "fzf").version, "0.44.0");
      assert.deepEqual(codes(headers.a), ["ccs.health:ok"], "a warning leaves the whole ok");

      // The simple look needs a newer fzf; the classic one does not.
      assert.equal(stateOf(doctor(box, { env: { FAKE_FZF_VERSION: "0.55.0" } }).a, "fzf"), "ok:ok");
      await config(box, ONE.replace("repos:", "defaults:\n  ui: simple\nrepos:"), ["proj/one"]);
      const simple = doctor(box, { env: { FAKE_FZF_VERSION: "0.55.0" } });
      assert.equal(simple.res.code, 0);
      assert.equal(stateOf(simple.a, "fzf"), "warn:fzf_too_old_for_simple");
      // One word per check: under 0.45 it is the headers word, simple look or not.
      assert.equal(stateOf(doctor(box, { env: { FAKE_FZF_VERSION: "0.44.0" } }).a, "fzf"), "warn:fzf_too_old_for_headers");
      assert.equal(stateOf(doctor(box, { env: { FAKE_FZF_VERSION: "0.61.0" } }).a, "fzf"), "ok:ok");
    } finally {
      await box.cleanup();
    }
  });

  test("better-sqlite3 cannot be loaded: exit 1, sqlite fails and the cache check is blocked", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const bin = await copyLayout(join(box.root, "copy"), { modules: "no-sqlite" });
      const { res, a } = doctor(box, { bin });
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.equal(stateOf(a, "sqlite"), "fail:sqlite_native_module_missing");
      assert.equal(stateOf(a, "cache"), "skipped:blocked");
      assert.deepEqual(codes(a), ["ccs.health:sqlite_native_module_missing"]);
      assert.equal(stateOf(a, "config"), "ok:ok", "repos.yml is still checked");
    } finally {
      await box.cleanup();
    }
  });

  for (const [name, text, dirs, word] of [
    ["broken YAML", "version: 1\nrepos: [\n", [], "yaml_parse_error"],
    ["version 2", ONE.replace("version: 1", "version: 2"), ["proj/one"], "unsupported_version"],
    ["a duplicate name", ONE + "  - name: one\n    path: ~/proj/one\n", ["proj/one"], "duplicate_name"],
    ["a path outside HOME", "version: 1\nrepos:\n  - name: one\n    path: /etc\n", [], "path_outside_home"],
    ["a quoted flag", ONE + '    disabled: "false"\n', ["proj/one"], "entry_invalid"],
  ] as const) {
    test(`repos.yml with ${name}: exit 1, config fails with ${word}`, async () => {
      const box = await makeBox();
      try {
        await config(box, text, [...dirs]);
        const { res, a } = doctor(box);
        assert.equal(res.code, 1, res.stdout + res.stderr);
        assert.equal(stateOf(a, "config"), `fail:${word}`);
        assert.equal(stateOf(a, "config_layout"), "skipped:blocked");
        assert.deepEqual(codes(a), [`ccs.health:${word}`]);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("a package.json Node cannot parse above a copy install: exit 1, modules fails", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const bin = await copyLayout(join(box.root, "copy"), { manifest: '{"name": "@example/broken\n{{{ not json' });
      const { res, a } = doctor(box, { bin });
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.equal(stateOf(a, "modules"), "fail:invalid_package_config");
      assert.deepEqual(codes(a), ["ccs.health:invalid_package_config"]);
      assert.equal(a.checks?.length, 11);
      for (const name of STAGE2_CHECKS) assert.equal(stateOf(a, name), "skipped:blocked", name);
      assert.equal(stateOf(a, "node"), "ok:ok");
      assert.equal(stateOf(a, "fzf"), "ok:ok");
    } finally {
      await box.cleanup();
    }
  });
});

describe("ccs doctor: it could not tell", () => {
  for (const [name, source, word] of [
    ["never answers", "setInterval(() => {}, 1000);\n", "check_timeout"],
    ["dies", "process.exit(1);\n", "check_crashed"],
  ] as const) {
    test(`the second stage ${name}: exit 3, modules is unknown with ${word}`, async () => {
      const box = await makeBox();
      try {
        await config(box, ONE, ["proj/one"]);
        const bin = await copyLayout(join(box.root, "copy"), { doctor: source });
        const { res, a } = doctor(box, { bin, env: { CCS_DOCTOR_TIMEOUT: "2" } });
        assert.equal(res.code, 3, res.stdout + res.stderr);
        assert.equal(stateOf(a, "modules"), `unknown:${word}`);
        assert.deepEqual(codes(a), [`ccs.health:${word}`]);
        assert.equal(a.checks?.length, 11);
        for (const check of STAGE2_CHECKS) assert.equal(stateOf(a, check), "skipped:blocked", check);
        assert.deepEqual(await leftInTmp(box), [], "nothing of ccs's stays in TMPDIR");
        const still = spawnSync("ps", ["-ax", "-o", "command"], { encoding: "utf-8" }).stdout ?? "";
        assert.ok(!still.includes(join(box.root, "copy")), "the second stage does not outlive doctor");
      } finally {
        await box.cleanup();
      }
    });
  }
});

describe("ccs doctor: it works, with something to say", () => {
  test("no repos.yml and no cache: exit 0, two warnings, and nothing is created", async () => {
    const box = await makeBox();
    try {
      const { res, a } = doctor(box);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.equal(stateOf(a, "config"), "warn:config_missing");
      assert.equal(stateOf(a, "config_layout"), "skipped:not_set");
      assert.equal(stateOf(a, "cache"), "warn:cache_missing");
      assert.deepEqual(codes(a), ["ccs.health:ok"]);
      assert.equal(run(box, ["doctor"]).code, 0);
      assert.equal(await exists(join(box.home, ".config")), false, "no config directory");
      assert.equal(await exists(join(box.home, ".cache")), false, "no cache directory");
      assert.deepEqual(await leftInTmp(box), []);
    } finally {
      await box.cleanup();
    }
  });

  test("unknown keys and missing folders: counted, never named", async () => {
    const box = await makeBox();
    try {
      await config(
        box,
        "version: 1\nextra_top: 1\nrepos:\n  - name: zebra-quartz\n    path: ~/proj/one\n    extra_entry: 1\n" +
          "  - name: gone-one\n    path: ~/gone/one\n  - name: gone-two\n    path: ~/gone/two\n" +
          "  - name: hidden\n    path: ~/gone/three\n    disabled: true\n",
        ["proj/one"],
      );
      const { res, a } = doctor(box);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      // Both apply; the word is the first of the two in the table.
      assert.equal(stateOf(a, "config"), "warn:unknown_keys");
      const c = check(a, "config");
      assert.deepEqual(
        { repos: c.repos, disabled: c.disabled, missing: c.paths_missing, unknown: c.unknown_keys },
        { repos: 4, disabled: 1, missing: 2, unknown: 2 },
      );
    } finally {
      await box.cleanup();
    }
  });

  test("a form line-based readers cannot parse: config_layout warns", async () => {
    const box = await makeBox();
    try {
      await config(box, "version: 1\nrepos: [{name: one, path: ~/proj/one}]\n", ["proj/one"]);
      const flow = doctor(box);
      assert.equal(flow.res.code, 0);
      assert.equal(stateOf(flow.a, "config"), "ok:ok");
      assert.equal(stateOf(flow.a, "config_layout"), "warn:flow_style_repos");

      await config(box, "version: 1\nrepos:\n  - path: ~/proj/one\n    name: one\n", ["proj/one"]);
      const order = doctor(box);
      assert.equal(order.res.code, 0);
      assert.equal(stateOf(order.a, "config_layout"), "warn:name_path_not_direct");
    } finally {
      await box.cleanup();
    }
  });

  test("a cache written by a newer ccs: cache warns and gives the schema number", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      await mkdir(box.cacheDir, { recursive: true });
      const h = openDb(join(box.cacheDir, "state.db"));
      const current = (h.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
      h.close();
      const now = doctor(box);
      assert.equal(stateOf(now.a, "cache"), "ok:ok");
      assert.equal(check(now.a, "cache").schema, current);

      const again = openDb(join(box.cacheDir, "state.db"));
      again.db.prepare("INSERT INTO schema_version (version) VALUES (99)").run();
      again.close();
      const newer = doctor(box);
      assert.equal(newer.res.code, 0);
      assert.equal(stateOf(newer.a, "cache"), "warn:cache_schema_newer");
      assert.equal(check(newer.a, "cache").schema, 99);
    } finally {
      await box.cleanup();
    }
  });
});

describe("ccs doctor: arguments and Ctrl-C", () => {
  test("an unknown argument: exit 2, usage, in the command-line vocabulary, without checks", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      for (const args of [["--bogus", "--json"], ["--json", "extra"], ["--json", "--with-paths"]]) {
        const { res, a } = doctor(box, {}, args);
        assert.equal(res.code, 2, args.join(" "));
        assert.deepEqual(codes(a), ["ccs.cli:unknown_option"], args.join(" "));
        assert.equal(a.checks, undefined, args.join(" "));
      }
      const plain = run(box, ["doctor", "--bogus"]);
      assert.equal(plain.code, 2);
      assert.equal(plain.stdout, "", "nothing on stdout without --json");
    } finally {
      await box.cleanup();
    }
  });

  test("SIGINT to its process group: exit 130, interrupted, nothing left behind", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      const bin = await copyLayout(join(box.root, "copy"), { doctor: "setInterval(() => {}, 1000);\n" });
      // Its own session, as a terminal gives it: a child started with `&` ignores SIGINT.
      const child = spawn("bash", [bin, "doctor", "--json"], {
        env: envFor(box, { env: { CCS_DOCTOR_TIMEOUT: "60" } }),
        cwd: box.root,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
      const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      // Wait until the second stage is running, then interrupt the whole group.
      const marker = join(box.root, "copy", "scripts", "ccs-doctor.ts");
      for (let i = 0; i < 100; i++) {
        const ps = spawnSync("ps", ["-ax", "-o", "command"], { encoding: "utf-8" }).stdout ?? "";
        if (ps.includes(marker)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 300));
      process.kill(-(child.pid as number), "SIGINT");
      const code = await closed;
      assert.equal(code, 130, stdout);
      const a = answer({ code: 130, stdout, stderr: "" }, "interrupted doctor");
      assert.equal(a.command, "doctor");
      assert.deepEqual(codes(a), ["ccs.cli:interrupted"]);
      assert.equal(a.checks, undefined);
      assert.deepEqual(await leftInTmp(box), []);
      await new Promise((r) => setTimeout(r, 500));
      const still = spawnSync("ps", ["-ax", "-o", "command"], { encoding: "utf-8" }).stdout ?? "";
      assert.ok(!still.includes(marker), "the second stage is gone");
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs list --json
// ---------------------------------------------------------------------------

// A header with two children (one the lead), a disabled header with a child,
// a folder that is gone, a plain entry, and one without a path.
const SAMPLE = `version: 1
defaults:
  command: "wrap-zeta claude"
repos:
  - name: studio
    path: ~/studio
    launch: false
    label: Studio
  - name: studio-hq
    path: ~/studio/hq
    lead: true
  - name: studio-web
    path: ~/studio/web
    command: "npm run dev-zeta"
    cwd: ~/studio/web
    scan: false
    custom:
      tool_id: zz-custom-9
  - name: old-group
    path: ~/old
    launch: false
    disabled: true
  - name: old-child
    path: ~/old/child
  - name: gone
    path: ~/gone
  - name: solo
    path: ~/solo
    description: A lone one
    icon: "*"
    tags: [a, b]
  - name: pathless
`;
const SAMPLE_DIRS = ["studio/hq", "studio/web", "old/child", "solo"];

describe("ccs list --json", () => {
  test("the entries in repos.yml order, with kind, parent and exists, and nothing that was not asked for", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const { res, a } = list(box, ["--json"]);
      assert.equal(res.code, 0, res.stderr);
      assert.deepEqual(codes(a), ["ccs.cli:ok"]);
      assert.deepEqual(
        a.repos?.map((r) => [r.name, r.kind, r.parent, r.exists, r.disabled, r.lead, r.launch]),
        [
          ["studio", "group", null, true, false, false, false],
          ["studio-hq", "repo", "studio", true, false, true, true],
          ["studio-web", "repo", "studio", true, false, false, true],
          ["old-group", "group", null, true, true, false, false],
          // A disabled header is not a parent.
          ["old-child", "repo", null, true, false, false, true],
          ["gone", "repo", null, false, false, false, true],
          ["solo", "repo", null, true, false, false, true],
          ["pathless", "repo", null, false, false, false, true],
        ],
      );
      const solo = a.repos?.find((r) => r.name === "solo");
      assert.deepEqual(
        { label: solo?.label, description: solo?.description, icon: solo?.icon, tags: solo?.tags },
        { label: "", description: "A lone one", icon: "*", tags: ["a", "b"] },
      );
      assert.equal(a.repos?.[0].label, "Studio");
      for (const r of a.repos ?? []) {
        for (const key of ["path", "command", "cwd", "custom", "scan"]) assert.ok(!(key in r), `${String(r.name)} has no ${key}`);
      }
      assert.deepEqual(a.groups, []);
      const said = res.stdout + res.stderr;
      for (const secret of [box.home, "wrap-zeta", "dev-zeta", "zz-custom-9"]) {
        assert.ok(!said.includes(secret), `${secret} is not in the output`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("--with-paths adds the expanded path, or null where none is written", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const { res, a } = list(box, ["--json", "--with-paths"]);
      assert.equal(res.code, 0, res.stderr);
      assert.deepEqual(
        a.repos?.map((r) => r.path),
        [
          join(box.home, "studio"),
          join(box.home, "studio", "hq"),
          join(box.home, "studio", "web"),
          join(box.home, "old"),
          join(box.home, "old", "child"),
          join(box.home, "gone"),
          join(box.home, "solo"),
          null,
        ],
      );
      for (const r of a.repos ?? []) {
        for (const key of ["command", "cwd", "custom", "scan"]) assert.ok(!(key in r), `${String(r.name)} has no ${key}`);
      }
      assert.ok(!res.stderr.includes(box.home), "paths go to stdout only");
    } finally {
      await box.cleanup();
    }
  });

  test("without --json: exit 2, nothing on stdout, one line saying why", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const res = run(box, ["list"]);
      assert.equal(res.code, 2);
      assert.equal(res.stdout, "");
      assert.equal(res.stderr.split("\n").length, 2, res.stderr);
      assert.ok(res.stderr.includes("--json"), res.stderr);
      // With `--` first, --json after it is not the flag.
      assert.equal(run(box, ["list", "--", "--json"]).code, 2);
    } finally {
      await box.cleanup();
    }
  });

  test("unknown and extra arguments: exit 2 with the word for each", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const bogus = list(box, ["--json", "--bogus"]);
      assert.equal(bogus.res.code, 2);
      assert.deepEqual(codes(bogus.a), ["ccs.cli:unknown_option"]);
      assert.equal(bogus.a.repos, undefined, "no entries with a failure");
      const extra = list(box, ["--json", "extra"]);
      assert.equal(extra.res.code, 2);
      assert.deepEqual(codes(extra.a), ["ccs.cli:extra_argument"]);
    } finally {
      await box.cleanup();
    }
  });

  test("no repos.yml: exit 4, config_missing, and none is created", async () => {
    const box = await makeBox();
    try {
      const { res, a } = list(box, ["--json"]);
      assert.equal(res.code, 4, res.stdout + res.stderr);
      assert.deepEqual(codes(a), ["ccs.cli:config_missing"]);
      assert.equal(a.repos, undefined);
      assert.equal(await exists(join(box.home, ".config")), false);
      assert.equal(await exists(join(box.home, ".cache")), false);
      assert.deepEqual(await leftInTmp(box), []);
    } finally {
      await box.cleanup();
    }
  });

  for (const [name, text, detail, index] of [
    ["broken YAML", "version: 1\nrepos: [\n", "yaml_parse_error", undefined],
    ["version 2", ONE.replace("version: 1", "version: 2"), "unsupported_version", undefined],
    ["a duplicate name", ONE + "  - name: one\n    path: ~/proj/one\n", "duplicate_name", 1],
    ["a path outside HOME", "version: 1\nrepos:\n  - name: zebra-quartz\n    path: /etc\n", "path_outside_home", 0],
  ] as const) {
    test(`repos.yml with ${name}: exit 4, config_invalid with the detail, no name or path`, async () => {
      const box = await makeBox();
      try {
        await config(box, text, ["proj/one"]);
        const { res, a } = list(box, ["--json"]);
        assert.equal(res.code, 4, res.stdout + res.stderr);
        assert.equal(a.reasons.length, 1);
        assert.deepEqual(
          { code: a.reasons[0].code, detail: a.reasons[0].detail },
          { code: "config_invalid", detail },
        );
        if (index !== undefined) assert.equal(a.reasons[0].entry_index, index);
        assert.equal(a.repos, undefined);
        const said = res.stdout + res.stderr;
        for (const secret of [box.home, "zebra-quartz", "/etc"]) assert.ok(!said.includes(secret), `${secret}: ${said}`);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("node not on PATH: exit 4, dependency_missing, before the arguments are read", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const path = await pathOf(box, "no-node", ["fzf", "claude"]);
      for (const args of [["--json"], ["--json", "--bogus"]]) {
        const { res, a } = list(box, args, { path });
        assert.equal(res.code, 4, res.stdout + res.stderr);
        assert.deepEqual(a.reasons, [{ vocab: "ccs.cli", code: "dependency_missing", detail: "node" }]);
        assert.match(a.written_at, /:\d{2}Z$/);
      }
      const plain = run(box, ["list"], { path });
      assert.equal(plain.code, 4);
      assert.equal(plain.stdout, "");
    } finally {
      await box.cleanup();
    }
  });

  test("tsx nowhere: exit 4, dependency_missing with the detail tsx", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const bin = await copyLayout(join(box.root, "copy"), { modules: "none" });
      const path = await pathOf(box, "no-tsx", ["node", "fzf", "claude"]);
      const { res, a } = list(box, ["--json"], { bin, path });
      assert.equal(res.code, 4, res.stdout + res.stderr);
      assert.deepEqual(a.reasons, [{ vocab: "ccs.cli", code: "dependency_missing", detail: "tsx" }]);
      const d = doctor(box, { bin, path });
      assert.equal(d.res.code, 1);
      assert.equal(stateOf(d.a, "tsx"), "fail:tsx_missing");
    } finally {
      await box.cleanup();
    }
  });

  // The word a caller can act on, the one doctor and the picker give.
  test(
    "a package.json Node cannot parse above a copy install: exit 1, invalid_package_config",
    async () => {
      const box = await makeBox();
      try {
        await config(box, SAMPLE, SAMPLE_DIRS);
        const bin = await copyLayout(join(box.root, "copy"), { manifest: '{"name": "@example/broken\n{{{ not json' });
        const { res, a } = list(box, ["--json"], { bin });
        assert.equal(res.code, 1, res.stdout + res.stderr);
        assert.deepEqual(codes(a), ["ccs.cli:invalid_package_config"]);
      } finally {
        await box.cleanup();
      }
    },
  );

  test("the same failure never shows Node's own message or a path", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const bin = await copyLayout(join(box.root, "copy"), { manifest: '{"name": "@example/broken\n{{{ not json' });
      const { res, a } = list(box, ["--json"], { bin });
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.equal(a.repos, undefined);
      assert.doesNotMatch(res.stderr, /node:internal|\n\s+at /, "no Node stack");
      assert.ok(!(res.stdout + res.stderr).includes(box.root), res.stderr);
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Both commands: what they leave alone
// ---------------------------------------------------------------------------

// The YAML parser warns about a value it cannot resolve (an unknown tag here)
// and quotes the whole line, whatever it holds.
const WITH_PARSER_WARNING = ONE + "    custom:\n      tool_id: !made-up zz-custom-9\n";

describe("ccs doctor and ccs list: a line of repos.yml the parser warns about", () => {
  test("doctor keeps it off both streams", async () => {
    const box = await makeBox();
    try {
      await config(box, WITH_PARSER_WARNING, ["proj/one"]);
      for (const args of [["doctor", "--json"], ["doctor"]]) {
        const res = run(box, args);
        assert.equal(res.code, 0, res.stdout + res.stderr);
        assert.ok(!(res.stdout + res.stderr).includes("zz-custom-9"), res.stdout + res.stderr);
      }
    } finally {
      await box.cleanup();
    }
  });

  test(
    "list --json keeps it off both streams",
    async () => {
      const box = await makeBox();
      try {
        await config(box, WITH_PARSER_WARNING, ["proj/one"]);
        const { res } = list(box, ["--json"]);
        assert.equal(res.code, 0, res.stdout + res.stderr);
        assert.ok(!(res.stdout + res.stderr).includes("zz-custom-9"), res.stderr);
      } finally {
        await box.cleanup();
      }
    },
  );
});

describe("ccs doctor and ccs list: nothing written, nothing sent, nothing leaked", () => {
  test("the config and cache directories are the same before and after", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      await writeFile(join(box.configDir, "README.md"), "notes\n");
      await mkdir(box.cacheDir, { recursive: true });
      openDb(join(box.cacheDir, "state.db")).close();
      await writeFile(join(box.cacheDir, "update-check"), "latest=9.9.9\nchecked=1\n");
      const before = { config: await snapshot(box.configDir), cache: await snapshot(box.cacheDir) };
      for (const args of [["doctor", "--json"], ["doctor"], ["list", "--json"], ["list", "--json", "--with-paths"], ["list"]]) {
        run(box, args);
        const after = { config: await snapshot(box.configDir), cache: await snapshot(box.cacheDir) };
        assert.deepEqual(after.config, before.config, `ccs ${args.join(" ")}: the config directory`);
        // SQLite may keep its own -wal / -shm beside a database it only reads.
        const cache = Object.fromEntries(Object.entries(after.cache).filter(([k]) => !/^state\.db-(wal|shm)$/.test(k)));
        assert.deepEqual(cache, before.cache, `ccs ${args.join(" ")}: the cache directory`);
        assert.deepEqual(await leftInTmp(box), [], `ccs ${args.join(" ")}: TMPDIR`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("no update check: no connection to the registry, no cache file, no waiting", async () => {
    const box = await makeBox();
    let connections = 0;
    const server = createServer(() => {
      connections++; // accepted, never answered
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await config(box, SAMPLE, SAMPLE_DIRS);
      const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const started = Date.now();
      for (const args of [["doctor", "--json"], ["list", "--json"]]) {
        const res = run(box, args, { env: { CCS_UPDATE_REGISTRY: registry } });
        assert.equal(res.code, 0, res.stdout + res.stderr);
      }
      assert.ok(Date.now() - started < 30_000, "neither waits for a registry that never answers");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(connections, 0);
      assert.equal(await exists(join(box.cacheDir, "update-check")), false);
      assert.equal(await exists(box.cacheDir), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await box.cleanup();
    }
  });

  test("doctor names no repo, path, command or custom value, on either stream", async () => {
    const box = await makeBox();
    try {
      await config(box, SAMPLE.replace("name: solo", "name: zebra-quartz") + "    extra_key: 1\n", SAMPLE_DIRS);
      for (const args of [["doctor", "--json"], ["doctor"]]) {
        const res = run(box, args);
        assert.equal(res.code, 0, res.stdout + res.stderr);
        const said = res.stdout + res.stderr;
        for (const secret of [box.home, box.root, "zebra-quartz", "studio", "Studio", "wrap-zeta", "dev-zeta", "zz-custom-9", "A lone one"]) {
          assert.ok(!said.includes(secret), `ccs ${args.join(" ")} shows ${secret}: ${said}`);
        }
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The command words and the picker
// ---------------------------------------------------------------------------

describe("ccs: the six command words", () => {
  // Whatever follows, the word never reaches the picker or the launched command.
  for (const word of ["sessions", "repo", "config", "open"] as const) {
    test(`${word} as the first argument is a command: one JSON answer, no picker, nothing launched`, async () => {
      const box = await makeBox();
      try {
        await config(box, ONE, ["proj/one"]);
        for (const args of [["--json", "--bogus"], ["--bogus", "--json"], ["nosuch-subcommand", "--json"]]) {
          const res = run(box, [word, ...args], { env: { FAKE_FZF_PICK: "new:one" } });
          const a = answer(res, `ccs ${word} ${args.join(" ")}`);
          assert.ok(a.command === word || a.command.startsWith(`${word} `), a.command);
          assert.equal(res.code, 2, `ccs ${word} ${args.join(" ")}: ${res.stdout}`);
          for (const r of a.reasons) assert.equal(r.vocab, "ccs.cli");
        }
        assert.equal(await exists(box.fzfRows), false, "fzf is not started");
        assert.equal(await exists(box.claudeLog), false, "nothing is launched");
      } finally {
        await box.cleanup();
      }
    });
  }

  test("doctor and list are commands only when first: `ccs --new doctor` opens the picker and passes doctor on", async () => {
    const box = await makeBox();
    try {
      await config(box, ONE, ["proj/one"]);
      for (const word of ["doctor", "list"]) {
        await rm(box.fzfRows, { force: true });
        await rm(box.claudeLog, { force: true });
        const res = run(box, ["--new", word], { env: { FAKE_FZF_PICK: "new:one", CCS_NO_UPDATE_CHECK: "1" } });
        assert.equal(res.code, 0, res.stdout + res.stderr);
        const rows = (await readFile(box.fzfRows, "utf-8")).split("\n").filter((r) => r !== "");
        assert.ok(rows.some((r) => r.split("\t")[3] === "new:one"), "the picker opened with the repo");
        const launched = await readFile(box.claudeLog, "utf-8");
        assert.equal(launched, `${join(box.home, "proj", "one")}|${word}\n`, "the word goes to the launched command");
      }
    } finally {
      await box.cleanup();
    }
  });

  test("--version and --help still answer first, and --help lists the two commands", async () => {
    const box = await makeBox();
    try {
      const version = run(box, ["--version"]);
      assert.equal(version.code, 0);
      assert.match(version.stdout, /^ccs v\S+\n$/);
      const help = run(box, ["--help"]);
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes("ccs doctor"), help.stdout);
      assert.ok(help.stdout.includes("ccs list --json"), help.stdout);
      // product_version is what --version prints.
      const a = doctor(box).a;
      assert.equal(`ccs v${a.product_version}\n`, version.stdout);
    } finally {
      await box.cleanup();
    }
  });
});
