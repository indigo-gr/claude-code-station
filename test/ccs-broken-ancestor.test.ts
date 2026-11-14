/**
 * A package.json that Node cannot parse, above ccs or above the directory ccs
 * is started in.
 *
 * Node takes a module's type from the nearest package.json above it, and
 * refuses to load the module at all when that file is broken. ccs used to end
 * with an empty list (or a hint to run `ccs --refresh`, which could not help)
 * and exit 0.
 *
 * Layout A — what npm installs, and a checkout: <root>/bin holds all of bin/
 *   (with bin/package.json), <root>/package.json is broken. The list opens.
 * Layout B — what install.sh copies: <root>/scripts holds ccs, ccs-*.ts and
 *   ccs-*.sh only, <root>/package.json is broken. ccs stops: exit 1, nothing
 *   on stdout, one line on stderr carrying the reason word; fzf never starts.
 *
 * fzf and claude are stubs on PATH, HOME is a temp directory and the update
 * check is off, so nothing here reaches a terminal, the network or real data.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs (an older
 * tag shows them fail).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, cp, copyFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN_DIR = dirname(process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url)));
const NODE_MODULES = join(REPO_ROOT, "node_modules");

// The stub answers the version question, then keeps what it was given and
// leaves as fzf does on Esc.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "0.65.0 (fake)"; exit 0; fi
cat > "$FAKE_FZF_ROWS"
exit 130
`;
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$FAKE_CLAUDE_LOG"
`;

const BROKEN = [
  ["a broken", '{"name": "@example/broken\n{{{ not json'],
  ["an empty", ""],
  ["a binary", "\u0000\u0001\u0002�"],
] as const;

// One registered repo: the simple look adds a separator row above it.
const LOOKS = [
  ["simple", 2],
  ["classic", 1],
] as const;

// The reason word scripts match on: lowercase snake_case, like every reason
// word of the machine interface.
const REASON = /invalid_package_config/;
const NODE_NOISE = /Invalid package config|ERR_INVALID_PACKAGE_CONFIG|node:internal/;

interface Sandbox {
  root: string;
  home: string;
  stubBin: string;
  rowsFile: string;
  claudeLog: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "ccs-ancestor-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  await mkdir(join(home, ".config", "ccs"), { recursive: true });
  await mkdir(join(home, "proj", "one"), { recursive: true });
  await mkdir(stubBin, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  await writeFile(
    join(home, ".config", "ccs", "repos.yml"),
    "version: 1\nrepos:\n  - name: one\n    path: ~/proj/one\n",
  );
  const init = spawnSync("git", ["init", "-q", join(home, "proj", "one")], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(init.status, 0, init.stderr);
  return {
    root,
    home,
    stubBin,
    rowsFile: join(root, "fzf-rows.txt"),
    claudeLog: join(root, "claude.log"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Layout A: all of bin/ under <dir>/bin, node_modules beside it. */
async function layoutA(dir: string, manifest: string | null): Promise<string> {
  await cp(BIN_DIR, join(dir, "bin"), { recursive: true });
  await symlink(NODE_MODULES, join(dir, "node_modules"));
  if (manifest !== null) await writeFile(join(dir, "package.json"), manifest);
  return join(dir, "bin", "ccs");
}

/** Layout B: only what install.sh copies, node_modules linked next to the scripts. */
async function layoutB(dir: string, manifest: string | null): Promise<string> {
  const scripts = join(dir, "scripts");
  await mkdir(scripts, { recursive: true });
  for (const name of await readdir(BIN_DIR)) {
    if (name === "ccs" || /^ccs-.*\.(ts|sh)$/.test(name)) await copyFile(join(BIN_DIR, name), join(scripts, name));
  }
  await symlink(NODE_MODULES, join(scripts, "node_modules"));
  if (manifest !== null) await writeFile(join(dir, "package.json"), manifest);
  return join(scripts, "ccs");
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** What fzf was given, one row per entry; null when fzf never started. */
  rows: string[] | null;
  launched: boolean;
}

async function run(sb: Sandbox, bin: string, args: string[], cwd?: string): Promise<Run> {
  await rm(sb.rowsFile, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sb.stubBin}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    CCS_NO_UPDATE_CHECK: "1",
    COLUMNS: "120",
    FAKE_FZF_ROWS: sb.rowsFile,
    FAKE_CLAUDE_LOG: sb.claudeLog,
  };
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  delete env.CCS_UI;
  delete env.CCS_UPDATE_REGISTRY;
  const res = spawnSync("bash", [bin, ...args], { encoding: "utf-8", env, cwd: cwd ?? sb.root });
  const given = await readFile(sb.rowsFile, "utf-8").catch(() => null);
  const launched = await readFile(sb.claudeLog, "utf-8").then(
    () => true,
    () => false,
  );
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    rows: given === null ? null : given.split("\n").filter((r) => r !== ""),
    launched,
  };
}

const withAndWithoutScan = (look: string): string[][] => [[`--ui=${look}`], [`--ui=${look}`, "--no-scan"]];

function assertOpened(res: Run, expectedRows: number, what: string): void {
  assert.equal(res.code, 0, `${what}: ${res.stderr}`);
  assert.notEqual(res.rows, null, `${what}: fzf must start`);
  assert.equal(res.rows?.length, expectedRows, `${what}: ${JSON.stringify(res.rows)}`);
  assert.ok(
    res.rows?.some((r) => r.split("\t")[3] === "new:one"),
    `${what}: the registered repo is in the list: ${JSON.stringify(res.rows)}`,
  );
  const said = res.stdout + res.stderr;
  assert.doesNotMatch(said, NODE_NOISE, what);
  assert.ok(!said.includes("ccs --refresh"), `${what}: ${said}`);
}

function assertStopped(res: Run, what: string): void {
  assert.equal(res.code, 1, `${what}: ${res.stdout}${res.stderr}`);
  assert.equal(res.rows, null, `${what}: fzf must not start`);
  assert.equal(res.launched, false, `${what}: nothing is launched`);
  assert.equal(res.stdout, "", what);
  const lines = res.stderr.split("\n");
  assert.equal(lines.length, 2, `${what}: one line, then the newline: ${res.stderr}`);
  assert.equal(lines[1], "", what);
  assert.match(lines[0], REASON, what);
  assert.ok(lines[0].includes("package.json"), `${what}: the line names the file: ${lines[0]}`);
  assert.doesNotMatch(res.stderr, /node:internal|\n\s+at /, `${what}: no Node stack`);
  assert.ok(!res.stderr.includes("ccs --refresh"), `${what}: no hint that cannot help: ${res.stderr}`);
}

describe("bin/ccs under a package.json Node cannot parse (stub fzf)", () => {
  for (const [name, text] of BROKEN) {
    for (const [look, expectedRows] of LOOKS) {
      test(`layout A, ${look}: the list opens under ${name} package.json`, async () => {
        const sb = await makeSandbox();
        try {
          const bin = await layoutA(join(sb.root, "pkg"), text);
          for (const args of withAndWithoutScan(look)) {
            assertOpened(await run(sb, bin, args), expectedRows, args.join(" "));
          }
        } finally {
          await sb.cleanup();
        }
      });

      test(`layout B, ${look}: stops with the reason under ${name} package.json`, async () => {
        const sb = await makeSandbox();
        try {
          const bin = await layoutB(join(sb.root, "copy"), text);
          for (const args of withAndWithoutScan(look)) {
            assertStopped(await run(sb, bin, args), args.join(" "));
          }
        } finally {
          await sb.cleanup();
        }
      });
    }
  }

  // The stop above comes from the broken file, not from the copy layout itself.
  for (const [look, expectedRows] of LOOKS) {
    test(`layout B, ${look}: opens when no package.json is broken`, async () => {
      const sb = await makeSandbox();
      try {
        const bin = await layoutB(join(sb.root, "copy"), null);
        for (const args of withAndWithoutScan(look)) {
          assertOpened(await run(sb, bin, args), expectedRows, args.join(" "));
        }
      } finally {
        await sb.cleanup();
      }
    });
  }

  // Node also reads the package.json above the directory a program starts in.
  // ccs starts its modules from its own folder, so where the user stands does
  // not matter.
  for (const [look, expectedRows] of LOOKS) {
    test(`${look}: started below a broken package.json, the list still opens`, async () => {
      const sb = await makeSandbox();
      try {
        const healthy = JSON.stringify({ name: "@example/healthy", version: "1.2.3", type: "module" }, null, 2) + "\n";
        const bin = await layoutA(join(sb.root, "pkg"), healthy);
        const below = join(sb.root, "work", "sub");
        await mkdir(below, { recursive: true });
        await writeFile(join(sb.root, "work", "package.json"), BROKEN[0][1]);
        for (const args of withAndWithoutScan(look)) {
          assertOpened(await run(sb, bin, args, below), expectedRows, args.join(" "));
        }
      } finally {
        await sb.cleanup();
      }
    });
  }

  // The stop line names the broken file, unless the path could repaint the
  // terminal: then it says where to look without printing it.
  for (const [look] of LOOKS) {
    test(`layout B, ${look}: a path with control characters is not printed`, async () => {
      const sb = await makeSandbox();
      try {
        const bin = await layoutB(join(sb.root, "esc\u001b[31mred"), BROKEN[0][1]);
        for (const args of withAndWithoutScan(look)) {
          const res = await run(sb, bin, args);
          assertStopped(res, args.join(" "));
          // eslint-disable-next-line no-control-regex
          assert.doesNotMatch(res.stdout + res.stderr, /[\u0000-\u0008\u000b-\u001f\u007f]/, args.join(" "));
          assert.ok(!res.stderr.includes("31mred"), res.stderr);
        }
      } finally {
        await sb.cleanup();
      }
    });
  }
});
