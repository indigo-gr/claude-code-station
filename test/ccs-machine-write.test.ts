/**
 * The commands that change repos.yml or start Claude Code without the picker:
 * `ccs repo add|remove`, `ccs config get|set`, `ccs sessions --json` and
 * `ccs open` (docs/design/machine-interface.md, chapters 2.3 to 4).
 *
 * What a caller relies on, and what these tests hold:
 *  - a write keeps the form line-based readers parse, leaves a `.bak` of what
 *    was there, never replaces a symlinked repos.yml with a file, and leaves
 *    the file untouched when it refuses, is locked out or is interrupted;
 *  - refusals have their own exit code and reason word, and change nothing;
 *  - `sessions` gives ids and times, a title only when asked and cleaned;
 *  - `open` starts the same command the picker would, in the same folder,
 *    and without a terminal it starts nothing.
 *
 * No real repos.yml, terminal app or Claude Code is touched: HOME / XDG /
 * TMPDIR are a temp directory, claude and `open` are stubs, the terminal is a
 * pseudo-terminal, values are made up.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink, lstat, stat, utimes, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));

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

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "0.65.0 (fake)"; exit 0; fi
cat > "$FAKE_FZF_ROWS"
exit 130
`;
const FAKE_CLAUDE = `#!/usr/bin/env bash
{ printf '%s' "$PWD"; for a in "$@"; do printf '|%s' "$a"; done; printf '\\n'; } >> "$FAKE_CLAUDE_LOG"
`;
// Stands in for macOS's open(1): records what it was asked to open, opens nothing.
const FAKE_OPEN = `#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\\n' "$a"; done; } > "$FAKE_OPEN_LOG"
exit "\${FAKE_OPEN_EXIT:-0}"
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
  openLog: string;
  cleanup: () => Promise<void>;
}

async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-write-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const tmp = join(root, "tmp");
  for (const d of [home, stubBin, tmp]) await mkdir(d, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  await writeFile(join(stubBin, "open"), FAKE_OPEN, { mode: 0o755 });
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
    openLog: join(root, "open.log"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function dirs(box: Box, ...names: string[]): Promise<void> {
  for (const d of names) await mkdir(join(box.home, d), { recursive: true });
}

async function config(box: Box, text: string, ...folders: string[]): Promise<void> {
  await mkdir(box.configDir, { recursive: true });
  await dirs(box, ...folders);
  await writeFile(box.reposYml, text);
}

const read = (box: Box): Promise<string> => readFile(box.reposYml, "utf-8");

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function envFor(box: Box, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${box.stubBin}:${process.env.PATH ?? ""}`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    FAKE_FZF_ROWS: box.fzfRows,
    FAKE_CLAUDE_LOG: box.claudeLog,
    FAKE_OPEN_LOG: box.openLog,
  };
  for (const k of ["CCS_CMD", "CCR_CMD", "CCS_UI", "CCS_NO_UPDATE_CHECK", "CCS_UPDATE_REGISTRY", "CCS_TEST_EDIT_PAUSE_MS"]) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(box: Box, args: string[], extra: Record<string, string | undefined> = {}): Result {
  const res = spawnSync("bash", [CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box, extra),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface Reason {
  vocab: string;
  code: string;
  detail?: string;
}
interface Answer {
  command: string;
  status: string;
  reasons: Reason[];
  [key: string]: unknown;
}

/** stdout is one JSON object and a newline; exit code, status and words follow the contract. */
function answer(res: Result, command: string): Answer {
  assert.ok(res.stdout.endsWith("\n") && !res.stdout.endsWith("\n\n"), `${command}: one object, one newline: ${res.stdout}${res.stderr}`);
  let a: Answer;
  try {
    a = JSON.parse(res.stdout) as Answer;
  } catch {
    assert.fail(`${command}: stdout is not one JSON object: ${res.stdout}\n${res.stderr}`);
  }
  for (const key of ["schema_version", "product_id", "product_version", "command", "written_at", "status", "reasons"]) {
    assert.ok(key in a, `${command}: ${key}`);
  }
  assert.equal(a.command, command);
  assert.equal(a.status, STATUS_OF_EXIT[res.code], `${command}: exit ${res.code} and status ${a.status}`);
  assert.ok(a.reasons.length > 0, command);
  for (const r of a.reasons) {
    assert.equal(r.vocab, "ccs.cli", command);
    assert.match(r.code, WORD, command);
  }
  return a;
}

/** Run with --json and expect this exit code and reason word. */
function expect(box: Box, args: string[], command: string, code: number, word: string, extra: Record<string, string | undefined> = {}): Answer {
  const res = run(box, [...args, "--json"], extra);
  const a = answer(res, command);
  assert.deepEqual([res.code, a.reasons.map((r) => r.code)], [code, [word]], `ccs ${args.join(" ")}: ${res.stderr}`);
  return a;
}

/** What a reader without a YAML parser sees (`- name:` then `path:` right under it). */
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

const names = (box: Box): string[] => {
  const res = run(box, ["list", "--json"]);
  return ((JSON.parse(res.stdout) as { repos?: { name: string }[] }).repos ?? []).map((r) => r.name);
};

const TWO = "version: 1\nrepos:\n  - name: web\n    path: ~/p/web\n  - name: api\n    path: ~/p/api\n";

// ---------------------------------------------------------------------------
// ccs repo add
// ---------------------------------------------------------------------------

describe("ccs repo add", () => {
  test("with no repos.yml: creates the minimal form, private, and says so", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "p/web");
      const a = expect(box, ["repo", "add", join(box.home, "p", "web")], "repo add", 0, "ok");
      assert.deepEqual(a.repo, { name: "web", created_config: true });
      const text = await read(box);
      assert.deepEqual(readByLine(text), [{ name: "web", path: "~/p/web" }]);
      assert.match(text, /^version: 1$/m);
      assert.ok(!text.includes("command"), "no default command is written");
      assert.equal((await stat(box.reposYml)).mode & 0o777, 0o600);
      assert.deepEqual(names(box), ["web"], "ccs reads what it wrote");
    } finally {
      await box.cleanup();
    }
  });

  test("a taken name gets a number; without --json nothing on stdout and one line on stderr", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "q/web");
      const res = run(box, ["repo", "add", join(box.home, "q", "web")]);
      assert.deepEqual([res.code, res.stdout], [0, ""], res.stderr);
      assert.equal(res.stderr.split("\n").length, 2, res.stderr);
      assert.deepEqual(names(box), ["web", "api", "web-2"]);
      const text = await read(box);
      assert.ok(text.startsWith(TWO), "what was there stays byte for byte");
      assert.deepEqual(readByLine(text).slice(2), [{ name: "web-2", path: "~/q/web" }]);
      assert.equal(await readFile(box.reposYml + ".bak", "utf-8"), TWO);
    } finally {
      await box.cleanup();
    }
  });

  test("--name, --description and --with-paths", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "q/site");
      const dir = join(box.home, "q", "site");
      const plain = expect(box, ["repo", "add", dir, "--name", "site-one", "--description", "A made-up site"], "repo add", 0, "ok");
      assert.deepEqual(plain.repo, { name: "site-one", created_config: false }, "no path unless asked");
      assert.match(await read(box), /^ {4}description: A made-up site$/m);
      await dirs(box, "q/other");
      const withPath = expect(box, ["repo", "add", join(box.home, "q", "other"), "--with-paths"], "repo add", 0, "ok");
      assert.deepEqual(withPath.repo, { name: "other", created_config: false, path: join(box.home, "q", "other") });
    } finally {
      await box.cleanup();
    }
  });

  test("a name already in repos.yml is refused when it is asked for by --name; left to ccs, the name gets a number", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "q/web");
      const dir = join(box.home, "q", "web");
      const refused = expect(box, ["repo", "add", dir, "--name", "web"], "repo add", 6, "name_taken");
      assert.equal(refused.repo, undefined);
      assert.equal(await read(box), TWO, "the file is untouched");
      assert.deepEqual(names(box), ["web", "api"]);
      // the same folder without --name: ccs picks a free name itself
      const added = expect(box, ["repo", "add", dir], "repo add", 0, "ok");
      assert.deepEqual(added.repo, { name: "web-2", created_config: false });
    } finally {
      await box.cleanup();
    }
  });

  test("what it refuses: exit 6 with the word for each, and the file untouched", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "p/2024", "p/a;b");
      await writeFile(join(box.home, "file.txt"), "x\n");
      for (const [path, word] of [
        [join(box.home, "p", "web"), "path_taken"],
        ["/etc", "path_outside_home"],
        [join(box.home, "..", "elsewhere"), "path_outside_home"],
        [join(box.home, "nosuch"), "path_not_found"],
        [join(box.home, "file.txt"), "path_not_directory"],
        [join(box.home, "p", "2024"), "needs_quoting"],
        [join(box.home, "p", "a;b"), "unsafe_characters"],
      ] as const) {
        const a = expect(box, ["repo", "add", path], "repo add", 6, word);
        assert.equal(a.repo, undefined, word);
        assert.equal(await read(box), TWO, word);
      }
      assert.equal(await exists(box.reposYml + ".bak"), false, "no backup for a refusal");
      assert.equal(await exists(box.reposYml + ".lock"), false);
    } finally {
      await box.cleanup();
    }
  });

  test("a one-line repos list is refused: exit 6, flow_style_repos, the file untouched", async () => {
    const box = await makeBox();
    try {
      const flow = "version: 1\nrepos: [{name: web, path: ~/p/web}]\n";
      await config(box, flow, "p/web", "q/site");
      expect(box, ["repo", "add", join(box.home, "q", "site")], "repo add", 6, "flow_style_repos");
      assert.equal(await read(box), flow);
      assert.equal(await exists(box.reposYml + ".bak"), false);
    } finally {
      await box.cleanup();
    }
  });

  test("comments and the user's own formatting stay as written", async () => {
    const box = await makeBox();
    try {
      const text =
        "# my repos\nversion: 1\n\ndefaults:\n  command: \"claude\" # the usual\n\nrepos:\n" +
        "  # the front end\n  - name: web\n    path: ~/p/web\n    tags: [x] # inline\n\n  - name: api\n    path: ~/p/api\n";
      await config(box, text, "p/web", "p/api", "q/site");
      expect(box, ["repo", "add", join(box.home, "q", "site")], "repo add", 0, "ok");
      const after = await read(box);
      assert.ok(after.startsWith(text), `the lines that were there are unchanged:\n${after}`);
      assert.deepEqual(readByLine(after.slice(text.length)), [{ name: "site", path: "~/q/site" }]);
      assert.equal(await readFile(box.reposYml + ".bak", "utf-8"), text);
    } finally {
      await box.cleanup();
    }
  });

  test("a symlinked repos.yml stays a symlink; the file it points to is the one written", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "p/web", "p/api", "q/site", "dotfiles");
      await mkdir(box.configDir, { recursive: true });
      const real = join(box.home, "dotfiles", "repos.yml");
      await writeFile(real, TWO);
      await symlink(real, box.reposYml);
      expect(box, ["repo", "add", join(box.home, "q", "site")], "repo add", 0, "ok");
      assert.ok((await lstat(box.reposYml)).isSymbolicLink(), "still a symlink");
      assert.deepEqual(readByLine(await readFile(real, "utf-8")).map((r) => r.name), ["web", "api", "site"]);
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The write itself: the lock, an interruption
// ---------------------------------------------------------------------------

describe("ccs: writing repos.yml", () => {
  test("another writer's fresh lock: exit 1, config_locked, nothing written, the lock left alone", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "q/site");
      await writeFile(box.reposYml + ".lock", "");
      expect(box, ["repo", "add", join(box.home, "q", "site")], "repo add", 1, "config_locked");
      expect(box, ["config", "set", "defaults.ui", "simple"], "config set", 1, "config_locked");
      expect(box, ["repo", "remove", "api"], "repo remove", 1, "config_locked");
      assert.equal(await read(box), TWO);
      assert.equal(await exists(box.reposYml + ".lock"), true, "the other writer's lock is not removed");
      // Reading does not need the lock.
      assert.equal(run(box, ["list", "--json"]).code, 0);
      assert.equal(run(box, ["config", "get", "--json"]).code, 0);
    } finally {
      await box.cleanup();
    }
  });

  test("a lock left behind long ago is taken over, and none is left after", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api", "q/site");
      await writeFile(box.reposYml + ".lock", "");
      const old = new Date(Date.now() - 60_000);
      await utimes(box.reposYml + ".lock", old, old);
      expect(box, ["repo", "add", join(box.home, "q", "site")], "repo add", 0, "ok");
      assert.deepEqual(names(box), ["web", "api", "site"]);
      assert.equal(await exists(box.reposYml + ".lock"), false);
    } finally {
      await box.cleanup();
    }
  });

  // The edit pauses at each of its steps (a test-only setting), so the
  // interrupt lands before the write, between write and check, and after.
  for (const [what, args] of [
    ["repo add", (box: Box) => ["repo", "add", join(box.home, "q", "site"), "--json"]],
    ["config set", () => ["config", "set", "defaults.ui", "simple", "--json"]],
  ] as const) {
    for (const delay of [100, 900, 1700]) {
      test(`SIGINT ${delay} ms into ${what}: exit 130, interrupted, repos.yml as it was, no lock`, async () => {
        const box = await makeBox();
        try {
          await config(box, TWO, "p/web", "p/api", "q/site");
          const child = spawn("bash", [CCS_BIN, ...args(box)], {
            env: envFor(box, { CCS_TEST_EDIT_PAUSE_MS: "700" }),
            cwd: box.root,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
          let stdout = "";
          child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
          const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
          for (let i = 0; i < 300 && !(await exists(box.reposYml + ".lock")); i++) {
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.equal(await exists(box.reposYml + ".lock"), true, "the edit has started");
          await new Promise((r) => setTimeout(r, delay));
          process.kill(-(child.pid as number), "SIGINT");
          const code = await closed;
          assert.equal(code, 130, stdout);
          assert.equal(await read(box), TWO, "repos.yml is as it was");
          assert.equal(await exists(box.reposYml + ".lock"), false, "no lock is left");
          assert.deepEqual((await readdir(box.tmp)).filter((n) => !n.startsWith("tsx-")), [], "nothing of ccs's stays in TMPDIR");
          // One answer, not one from each place that noticed the interrupt.
          const a = answer({ code: 130, stdout, stderr: "" }, what);
          assert.deepEqual(a.reasons.map((r) => r.code), ["interrupted"]);
        } finally {
          await box.cleanup();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// ccs repo remove
// ---------------------------------------------------------------------------

describe("ccs repo remove", () => {
  test("removes the entry and nothing else; unknown names and the last entry are refused", async () => {
    const box = await makeBox();
    try {
      const text = "# my repos\nversion: 1\nrepos:\n  - name: web\n    path: ~/p/web\n    tags: [x]\n  # the back end\n  - name: api\n    path: ~/p/api\n";
      await config(box, text, "p/web", "p/api");
      expect(box, ["repo", "remove", "nosuch"], "repo remove", 5, "repo_not_found");
      assert.equal(await read(box), text);
      expect(box, ["repo", "remove", "web"], "repo remove", 0, "ok");
      assert.deepEqual(names(box), ["api"]);
      const after = await read(box);
      assert.ok(after.startsWith("# my repos\nversion: 1\nrepos:\n"), after);
      assert.ok(!after.includes("~/p/web") && after.includes("~/p/api"), after);
      assert.equal(await readFile(box.reposYml + ".bak", "utf-8"), text);
      const kept = await read(box);
      expect(box, ["repo", "remove", "api"], "repo remove", 6, "last_entry");
      assert.equal(await read(box), kept);
      assert.equal(await exists(box.reposYml + ".lock"), false);
    } finally {
      await box.cleanup();
    }
  });

  test("no repos.yml: exit 4, and none is created", async () => {
    const box = await makeBox();
    try {
      expect(box, ["repo", "remove", "web"], "repo remove", 4, "config_missing");
      assert.equal(await exists(join(box.home, ".config")), false);
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs config get / set
// ---------------------------------------------------------------------------

describe("ccs config", () => {
  test("get with no repos.yml gives the defaults in effect and what each setting may be", async () => {
    const box = await makeBox();
    try {
      const a = expect(box, ["config", "get"], "config get", 0, "ok");
      const settings = a.settings as Record<string, unknown>;
      assert.equal(settings["defaults.ui"], "classic");
      assert.equal(settings["defaults.update_check"], true);
      assert.equal(settings["defaults.terminal"], null);
      const allowed = a.allowed as Record<string, unknown[]>;
      assert.deepEqual(allowed["defaults.ui"], ["classic", "simple"]);
      assert.deepEqual(allowed["defaults.update_check"], [true, false]);
      assert.equal(await exists(join(box.home, ".config")), false, "reading creates nothing");
      const plain = run(box, ["config", "get"]);
      assert.equal(plain.code, 0);
      assert.throws(() => JSON.parse(plain.stdout), "lines for people without --json");
    } finally {
      await box.cleanup();
    }
  });

  test("get with a repos.yml that fails ccs's checks: exit 4, config_invalid with the detail", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO.replace("version: 1", "version: 2"), "p/web", "p/api");
      const a = expect(box, ["config", "get"], "config get", 4, "config_invalid");
      assert.equal(a.reasons[0].detail, "unsupported_version");
      assert.equal(a.settings, undefined);
    } finally {
      await box.cleanup();
    }
  });

  test("set writes once, says whether anything changed, and the next reader sees it", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      const first = expect(box, ["config", "set", "defaults.ui", "simple"], "config set", 0, "ok");
      assert.deepEqual([first.key, first.changed], ["defaults.ui", true]);
      const text = await read(box);
      assert.ok(text.indexOf("defaults:") < text.indexOf("repos:"), `defaults goes before repos:\n${text}`);
      assert.ok(text.endsWith(TWO.slice(TWO.indexOf("repos:"))), "the entries are untouched");
      assert.equal(await readFile(box.reposYml + ".bak", "utf-8"), TWO);
      const again = expect(box, ["config", "set", "defaults.ui", "simple"], "config set", 0, "ok");
      assert.equal(again.changed, false);
      assert.equal(await read(box), text, "the same value writes nothing");
      const got = expect(box, ["config", "get"], "config get", 0, "ok");
      assert.equal((got.settings as Record<string, unknown>)["defaults.ui"], "simple");
    } finally {
      await box.cleanup();
    }
  });

  test("set on an entry: a label, and an empty value removes it", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      expect(box, ["config", "set", "--repo", "web", "label", "Web team"], "config set", 0, "ok");
      assert.match(await read(box), /^ {4}label: Web team$/m);
      const list = JSON.parse(run(box, ["list", "--json"]).stdout) as { repos: { name: string; label: string }[] };
      assert.deepEqual(list.repos.map((r) => [r.name, r.label]), [["web", "Web team"], ["api", ""]]);
      expect(box, ["config", "set", "--repo", "web", "label", ""], "config set", 0, "ok");
      assert.ok(!(await read(box)).includes("label"), "the key is gone");
    } finally {
      await box.cleanup();
    }
  });

  test("what set refuses, each with its code, and the file untouched", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      for (const [args, code, word] of [
        [["defaults.ui", "fancy"], 6, "invalid_value"],
        [["defaults.command", "x"], 6, "key_not_settable"],
        [["--repo", "web", "path", "~/x"], 6, "key_not_settable"],
        [["--repo", "web", "name", "other"], 6, "key_not_settable"],
        [["--repo", "nosuch", "label", "x"], 5, "repo_not_found"],
        [["label", "x"], 2, "missing_argument"],
        [["defaults.ui"], 2, "missing_argument"],
        [["defaults.update_check", "maybe"], 6, "invalid_value"],
      ] as const) {
        expect(box, ["config", "set", ...args], "config set", code, word);
        assert.equal(await read(box), TWO, args.join(" "));
      }
      assert.equal(await exists(box.reposYml + ".bak"), false);
    } finally {
      await box.cleanup();
    }
  });

  test("set with no repos.yml: exit 4, and none is created", async () => {
    const box = await makeBox();
    try {
      expect(box, ["config", "set", "defaults.ui", "simple"], "config set", 4, "config_missing");
      assert.equal(await exists(join(box.home, ".config")), false);
    } finally {
      await box.cleanup();
    }
  });

  test("defaults.update_check: false turns the update check off for doctor, like the environment switch", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      expect(box, ["config", "set", "defaults.update_check", "false"], "config set", 0, "ok");
      const settings = (env: Record<string, string | undefined> = {}): Record<string, unknown> =>
        (JSON.parse(run(box, ["doctor", "--json"], env).stdout) as { settings: Record<string, unknown> }).settings;
      assert.deepEqual([settings().update_check, settings().update_check_off_by], ["off", "config"]);
      const both = settings({ CCS_NO_UPDATE_CHECK: "1" });
      assert.deepEqual([both.update_check, both.update_check_off_by], ["off", "env"]);
    } finally {
      await box.cleanup();
    }
  });

  test("settings the loader checks: a wrong terminal or a quoted update_check is config_invalid", async () => {
    const box = await makeBox();
    try {
      for (const line of ["  terminal: iterm", '  update_check: "false"']) {
        await config(box, TWO.replace("repos:", `defaults:\n${line}\nrepos:`), "p/web", "p/api");
        const a = expect(box, ["list"], "list", 4, "config_invalid");
        assert.equal(a.reasons[0].detail, "defaults_invalid", line);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs sessions --json
// ---------------------------------------------------------------------------

const uuid = (n: number): string => `0000000${n}-1111-4222-8333-444444444444`;

/** One conversation file under ~/.claude/projects, as Claude Code writes them. */
async function conversation(box: Box, id: string, cwd: string, minutesAgo: number, first: string): Promise<void> {
  const dir = join(box.home, ".claude", "projects", "-made-up-project");
  await mkdir(dir, { recursive: true });
  const timestamp = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await writeFile(
    join(dir, `${id}.jsonl`),
    JSON.stringify({ type: "user", cwd, timestamp, message: { content: first } }) + "\n",
  );
}

interface Project {
  name: string;
  more: number;
  sessions: { uuid: string; last_activity_at: string | null; title?: string | null }[];
}

describe("ccs sessions --json", () => {
  test("arguments: --json is required, limits are numbers in range, the project must exist", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      const plain = run(box, ["sessions"]);
      assert.deepEqual([plain.code, plain.stdout], [2, ""], plain.stderr);
      expect(box, ["sessions", "--limit", "0"], "sessions", 2, "invalid_argument");
      expect(box, ["sessions", "--limit", "x"], "sessions", 2, "invalid_argument");
      expect(box, ["sessions", "--bogus"], "sessions", 2, "unknown_option");
      expect(box, ["sessions", "--project", "nosuch"], "sessions", 5, "repo_not_found");
    } finally {
      await box.cleanup();
    }
  });

  test("no cache and --no-scan: exit 4, cache_missing, and no cache is created", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      expect(box, ["sessions", "--no-scan"], "sessions", 4, "cache_missing");
      assert.equal(await exists(box.cacheDir), false);
    } finally {
      await box.cleanup();
    }
  });

  test("five per project, newest first, the rest counted; no title, folder or text unless asked", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO + "  - name: hidden\n    path: ~/p/hidden\n    disabled: true\n", "p/web", "p/api", "p/hidden", "elsewhere");
      for (let n = 1; n <= 7; n++) await conversation(box, uuid(n), join(box.home, "p", "web"), n * 10, `zz-first-words number ${n}`);
      await conversation(box, uuid(8), join(box.home, "p", "hidden"), 5, "zz-first-words hidden");
      await conversation(box, uuid(9), join(box.home, "elsewhere"), 5, "zz-first-words elsewhere");
      const res = run(box, ["sessions", "--json"]);
      const a = answer(res, "sessions");
      assert.equal(res.code, 0, res.stderr);
      const projects = a.projects as Project[];
      assert.deepEqual(projects.map((p) => p.name), ["web"], "a disabled entry's conversations are not listed");
      assert.deepEqual(projects[0].sessions.map((s) => s.uuid), [1, 2, 3, 4, 5].map(uuid), "newest first");
      assert.equal(projects[0].more, 2);
      assert.deepEqual([a.limit, a.unmapped, a.stale], [5, 1, false]);
      for (const s of projects[0].sessions) {
        assert.deepEqual(Object.keys(s).sort(), ["last_activity_at", "uuid"]);
        assert.match(String(s.last_activity_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
      const said = res.stdout + res.stderr;
      for (const secret of [box.home, "zz-first-words"]) assert.ok(!said.includes(secret), `${secret} is not in the output`);

      const two = answer(run(box, ["sessions", "--json", "--limit", "2", "--project", "web"]), "sessions");
      assert.deepEqual((two.projects as Project[])[0].sessions.map((s) => s.uuid), [uuid(1), uuid(2)]);
      assert.equal((two.projects as Project[])[0].more, 5);
    } finally {
      await box.cleanup();
    }
  });

  test("--with-titles: one clean line, secrets masked, cut at 80 characters", async () => {
    const box = await makeBox();
    try {
      await config(box, TWO, "p/web", "p/api");
      // Built at run time so the source holds no text shaped like a key.
      const fakeKey = "sk-" + "ant-" + "api03-" + "A".repeat(40);
      await conversation(box, uuid(1), join(box.home, "p", "web"), 30, `line one\nline two \u001b[31mred‮ flipped`);
      await conversation(box, uuid(2), join(box.home, "p", "web"), 20, `use the key ${fakeKey} please`);
      await conversation(box, uuid(3), join(box.home, "p", "web"), 10, "x".repeat(120));
      const res = run(box, ["sessions", "--json", "--with-titles"]);
      const a = answer(res, "sessions");
      assert.equal(res.code, 0, res.stderr);
      const titles = (a.projects as Project[])[0].sessions.map((s) => String(s.title));
      assert.equal(titles.length, 3);
      for (const t of titles) {
        assert.doesNotMatch(t, /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/, JSON.stringify(t));
        assert.ok([...t].length <= 81, `${[...t].length} characters`);
      }
      assert.equal(titles[0], "x".repeat(80) + "…");
      assert.ok(!res.stdout.includes(fakeKey), "the key is masked");
      assert.ok(titles[1].includes("[REDACTED]"), titles[1]);
      assert.ok(titles[2].startsWith("line one"), titles[2]);
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs open
// ---------------------------------------------------------------------------

const OPEN_SAMPLE =
  "version: 1\nrepos:\n  - name: web\n    path: ~/p/web\n  - name: off\n    path: ~/p/off\n    disabled: true\n" +
  "  - name: group\n    path: ~/g\n    launch: false\n";

// Runs a command on a pseudo-terminal and gives back its output and exit code.
const ON_A_PTY = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = b""
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    out += data
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

function onPty(box: Box, args: string[], extra: Record<string, string | undefined> = {}): Result {
  const res = spawnSync("python3", ["-c", ON_A_PTY, "bash", CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box, extra),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const hasPython = spawnSync("python3", ["-c", "import pty"], { encoding: "utf-8" }).status === 0;

describe("ccs open", () => {
  test("without a terminal: exit 4, no_tty, and nothing is started", async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      expect(box, ["open", "--repo", "web"], "open", 4, "no_tty");
      expect(box, ["open", "--repo", "web", "--here"], "open", 4, "no_tty");
      assert.equal(await exists(box.claudeLog), false);
      assert.equal(await exists(box.fzfRows), false);
    } finally {
      await box.cleanup();
    }
  });

  test("what it refuses, each with its code, and nothing is started", async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      // A cache, so that an unknown conversation is "not found" rather than "no cache".
      assert.equal(run(box, ["sessions", "--json"]).code, 0);
      for (const [args, code, word] of [
        [[], 2, "missing_argument"],
        [["--repo", "web", "--here", "--new-window"], 2, "conflicting_options"],
        [["--repo", "web", "--session", uuid(1)], 2, "conflicting_options"],
        [["--repo", "web", "--terminal", "terminal"], 2, "conflicting_options"],
        [["--repo", "web", "--new-window", "--terminal", "nosuch"], 2, "invalid_argument"],
        [["--repo", "web", "--bogus"], 2, "unknown_option"],
        [["--repo", "nosuch"], 5, "repo_not_found"],
        [["--session", uuid(1)], 5, "session_not_found"],
        [["--session", "not-a-uuid"], 6, "invalid_uuid"],
        [["--repo", "off"], 6, "repo_disabled"],
        [["--repo", "group"], 6, "not_launchable"],
      ] as const) {
        expect(box, ["open", ...args], "open", code, word);
      }
      assert.equal(await exists(box.claudeLog), false);
      assert.equal(await exists(box.openLog), false);
    } finally {
      await box.cleanup();
    }
  });

  test("the command to start is not on PATH: exit 4, dependency_missing with the detail claude", async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE.replace("    path: ~/p/web\n", "    path: ~/p/web\n    command: zz-not-installed --flag\n"), "p/web", "p/off", "g");
      const a = expect(box, ["open", "--repo", "web"], "open", 4, "dependency_missing");
      assert.equal(a.reasons[0].detail, "claude");
      assert.ok(!JSON.stringify(a).includes("zz-not-installed"), "the command itself is not shown");
    } finally {
      await box.cleanup();
    }
  });

  test("--here on a terminal: the command starts in the entry's folder, with the arguments after --", { skip: !hasPython && "python3 with pty is needed" }, async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      const res = onPty(box, ["open", "--repo", "web", "--", "--x", "a b"]);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "p", "web")}|--x|a b\n`);
      assert.equal(await exists(box.fzfRows), false, "the picker is not opened");
      assert.ok(!res.stdout.includes("schema_version"), "what the terminal shows is the started command's");
    } finally {
      await box.cleanup();
    }
  });

  test("--here follows the same command order as the picker: the entry's, then defaults, then CCS_CMD", { skip: !hasPython && "python3 with pty is needed" }, async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      assert.equal(onPty(box, ["open", "--repo", "web"], { CCS_CMD: "claude --model zz-model" }).code, 0);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "p", "web")}|--model|zz-model\n`);
      await rm(box.claudeLog);
      await config(box, OPEN_SAMPLE.replace("repos:", 'defaults:\n  command: "claude --from-defaults"\nrepos:'), "p/web", "p/off", "g");
      assert.equal(onPty(box, ["open", "--repo", "web"], { CCS_CMD: "claude --model zz-model" }).code, 0);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "p", "web")}|--from-defaults\n`);
    } finally {
      await box.cleanup();
    }
  });

  test("--session on a terminal resumes that conversation in its entry's folder", { skip: !hasPython && "python3 with pty is needed" }, async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      await conversation(box, uuid(1), join(box.home, "p", "web"), 10, "made-up first words");
      assert.equal(run(box, ["sessions", "--json"]).code, 0);
      const res = onPty(box, ["open", "--session", uuid(1)]);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "p", "web")}|--resume|${uuid(1)}\n`);
    } finally {
      await box.cleanup();
    }
  });

  test("--new-window: macOS hands a one-shot launcher to the terminal app; elsewhere it says unsupported_os", async () => {
    const box = await makeBox();
    try {
      await config(box, OPEN_SAMPLE, "p/web", "p/off", "g");
      if (process.platform !== "darwin") {
        expect(box, ["open", "--repo", "web", "--new-window"], "open", 4, "unsupported_os");
        assert.equal(await exists(box.openLog), false);
        return;
      }
      // The terminal app has to be chosen, by the flag or in repos.yml.
      expect(box, ["open", "--repo", "web", "--new-window"], "open", 4, "terminal_not_set");
      assert.equal(await exists(box.openLog), false);
      expect(box, ["config", "set", "defaults.terminal", "terminal"], "config set", 0, "ok");
      assert.equal(expect(box, ["open", "--repo", "web", "--new-window"], "open", 0, "ok").mode, "new_window");
      await rm(box.openLog);
      const a = expect(box, ["open", "--repo", "web", "--new-window", "--terminal", "terminal"], "open", 0, "ok");
      assert.deepEqual([a.mode, a.terminal], ["new_window", "terminal"]);
      const asked = (await readFile(box.openLog, "utf-8")).split("\n").filter((l) => l !== "");
      assert.deepEqual(asked.slice(0, 2), ["-a", "Terminal"], "open -a Terminal <launcher>");
      const launcher = asked[2];
      assert.ok(launcher.startsWith(box.tmp), `the launcher is under TMPDIR: ${launcher}`);
      assert.equal((await stat(launcher)).mode & 0o777, 0o700, "only the user can read or run it");
      const text = await readFile(launcher, "utf-8");
      assert.ok(text.includes("open --here --repo 'web'"), text);
      assert.ok(text.includes('rm -f -- "$0"'), "it removes itself when run");
      assert.equal(await exists(box.claudeLog), false, "nothing is started in this process");
      // The terminal app refusing the launcher is a failure, and the launcher is removed.
      await rm(box.openLog);
      expect(box, ["open", "--repo", "web", "--new-window", "--terminal", "terminal"], "open", 1, "launch_failed", { FAKE_OPEN_EXIT: "1" });
      const failed = (await readFile(box.openLog, "utf-8")).split("\n")[2];
      assert.equal(await exists(failed), false);
    } finally {
      await box.cleanup();
    }
  });
});
