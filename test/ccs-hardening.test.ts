/**
 * What an untrusted value can do on its way through ccs: a repos.yml or a repo
 * that came from someone else, a session file with a strange line in it.
 *
 * The fixtures only write marker files; the secrets are fake. fzf and claude
 * are stubs, so nothing here needs a terminal or leaves the machine. A fix may
 * refuse the value when loading it or clean it on the way out; the tests only
 * look at what must not happen, and at the ordinary case still working.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";

const CCS_BIN = fileURLToPath(new URL("../bin/ccs", import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface Box {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  claudeLog: string;
  cleanup: () => Promise<void>;
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** A HOME with stub fzf (picks the first row matching $STUB_PICK) and stub claude. */
async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-hardening-"));
  const home = join(root, "home");
  const stub = join(root, "stub");
  const claudeLog = join(root, "claude.log");
  await mkdir(join(home, ".config", "ccs"), { recursive: true });
  await mkdir(stub, { recursive: true });
  await writeFile(
    join(stub, "fzf"),
    `#!/usr/bin/env bash
for a in "$@"; do [[ "$a" == "--version" ]] && { echo "0.74.5 (fake)"; exit 0; }; done
grep -m1 -- "$STUB_PICK" || exit 1
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(stub, "claude"),
    `#!/usr/bin/env bash
{ pwd -P; for a in "$@"; do printf 'arg:%s\\n' "$a"; done; } >> "${claudeLog}"
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stub}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    COLUMNS: "120",
    STUB_PICK: "realrepo",
    CCS_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.CCS_CMD;
  delete env.CCR_CMD;
  delete env.CCS_UI;
  delete env.FZF_DEFAULT_OPTS;
  return { root, home, env, claudeLog, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeRepos(box: Box, yaml: string): Promise<void> {
  await writeFile(join(box.home, ".config", "ccs", "repos.yml"), yaml, { mode: 0o600 });
}

function scan(box: Box, args = ["--force", "--no-sessions", "--quiet"]): SpawnSyncReturns<string> {
  return spawnSync(TSX, [bin("ccs-scan.ts"), ...args], { encoding: "utf-8", env: box.env, timeout: 120_000 });
}
function list(box: Box, args: string[] = []): SpawnSyncReturns<string> {
  return spawnSync(TSX, [bin("ccs-list.ts"), ...args], { encoding: "utf-8", env: box.env, timeout: 120_000 });
}
function ccs(box: Box, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("bash", [CCS_BIN, ...args], {
    encoding: "utf-8",
    env: box.env,
    cwd: box.home,
    timeout: 120_000,
    input: "",
  });
}
/** Exactly 6 tab-separated columns in every row, the shape bin/ccs parses. */
function badRows(stdout: string): string[] {
  return stdout.split("\n").filter(Boolean).filter((r) => r.split("\t").length !== 6);
}

// ---------------------------------------------------------------------------
// A tab in a field must not move the columns and choose the command
// ---------------------------------------------------------------------------

describe("a tab in a field cannot choose the command", () => {
  /** A planted row in a YAML double-quoted string: fake columns 4-6, the last one a script. */
  const plant = (box: Box, separator = "\\t") =>
    `X${separator}D${separator}B${separator}new:realrepo${separator}${box.home}${separator}${join(box.root, "evil.sh")}`;

  async function arm(box: Box): Promise<string> {
    const marker = join(box.root, "EVIL_RAN");
    await writeFile(join(box.root, "evil.sh"), `#!/usr/bin/env bash\necho "$*" > "${marker}"\n`, { mode: 0o755 });
    await mkdir(join(box.home, "realrepo"), { recursive: true });
    return marker;
  }

  test("control: an ordinary repo opens with its own command, in 6 columns", async () => {
    const box = await makeBox();
    try {
      await arm(box);
      await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    icon: "🎬"\n`);
      assert.equal(scan(box).status, 0);
      const rows = list(box, ["--repos-only"]);
      assert.equal(rows.status, 0, rows.stderr);
      assert.deepEqual(badRows(rows.stdout), []);
      assert.ok(rows.stdout.includes("🎬"), "the icon is still shown");
      const res = ccs(box, ["--new", "--no-scan", "--ui=classic"]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(await exists(box.claudeLog), true, "the repo's command ran");
    } finally {
      await box.cleanup();
    }
  });

  for (const look of ["classic", "simple"]) {
    for (const [field, line] of [
      ["icon", (v: string) => `    icon: "${v}"`],
      ["label", (v: string) => `    label: "${v}"`],
      ["description", (v: string) => `    description: "${v}"`],
      ["tags", (v: string) => `    tags: ["${v}"]`],
    ] as const) {
      for (const [sepName, sep] of [
        ["tab", "\\t"],
        ["newline", "\\n"],
        ["unit separator", "\\x1f"],
      ] as const) {
        test(`${look}: a ${sepName} in ${field} runs nothing from the field`, async () => {
          const box = await makeBox();
          try {
            const marker = await arm(box);
            await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n${line(plant(box, sep))}\n`);
            scan(box); // a fix may refuse the file here: that is fine
            const rows = list(box, ["--repos-only", `--ui=${look}`]);
            assert.deepEqual(badRows(rows.stdout), [], `${field}: a row has the wrong column count`);
            ccs(box, ["--new", "--no-scan", `--ui=${look}`]);
            assert.equal(await exists(marker), false, `the script in ${field} ran as the command`);
            if (await exists(box.claudeLog)) {
              const log = await readFile(box.claudeLog, "utf-8");
              assert.ok(!log.includes("evil.sh"), log);
            }
          } finally {
            await box.cleanup();
          }
        });
      }
    }
  }

  test("a tab in a session's first message or summary keeps the row in 6 columns", async () => {
    const box = await makeBox();
    try {
      const marker = await arm(box);
      await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n`);
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      const id = "dddddddd-0000-0000-0000-000000000001";
      const planted = `hello\tD\tB\tresume:${id}\t${box.home}\t${join(box.root, "evil.sh")}`;
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "summary", summary: planted },
          { type: "user", sessionId: id, cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: planted } },
          { type: "assistant", sessionId: id, cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      assert.equal(scan(box, ["--force", "--quiet"]).status, 0);
      const rows = list(box, ["--sessions-only"]);
      assert.deepEqual(badRows(rows.stdout), []);
      box.env.STUB_PICK = "resume:";
      ccs(box, ["--resume", "--no-scan", "--ui=classic"]);
      assert.equal(await exists(marker), false, "the script in the session ran as the command");
    } finally {
      await box.cleanup();
    }
  });
});

describe("the icon also reaches the session rows", () => {
  test("classic: a tab in a repo's icon cannot move the columns of its sessions", async () => {
    const box = await makeBox();
    try {
      const marker = join(box.root, "EVIL_RAN");
      await writeFile(join(box.root, "evil.sh"), `#!/usr/bin/env bash\necho "$*" > "${marker}"\n`, { mode: 0o755 });
      await mkdir(join(box.home, "realrepo"), { recursive: true });
      const id = "dddddddd-0000-0000-0000-000000000002";
      await writeRepos(
        box,
        `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    icon: "X\\tD\\tB\\tresume:${id}\\t${box.home}\\t${join(box.root, "evil.sh")}"\n`,
      );
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "user", sessionId: id, cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
          { type: "assistant", sessionId: id, cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      scan(box, ["--force", "--quiet"]);
      assert.deepEqual(badRows(list(box, ["--sessions-only"]).stdout), []);
      box.env.STUB_PICK = "resume:";
      ccs(box, ["--resume", "--no-scan", "--ui=classic"]);
      assert.equal(await exists(marker), false, "the script in the icon ran as the command");
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The preview cuts text only after hiding what must be hidden
// ---------------------------------------------------------------------------

describe("a secret on the preview's cut line stays hidden", () => {
  const SESSION = "eeeeeeee-0000-0000-0000-000000000001";
  // Built at run time so the source holds no text shaped like a key.
  const GITHUB = "ghp_" + "FAKE".repeat(9);
  const ANTHROPIC = "sk-" + "ant-" + "FAKE".repeat(8);
  const SHOWN = /ghp_[A-Za-z0-9]{3,}|sk-ant-[A-Za-z0-9]{3,}/;

  async function preview(box: Box, line: Record<string, unknown>): Promise<string> {
    const proj = join(box.home, ".claude", "projects", "p");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, `${SESSION}.jsonl`),
      JSON.stringify({ type: "user", cwd: box.home, timestamp: "2026-01-01T00:00:00Z", ...line }) + "\n",
    );
    const r = spawnSync(TSX, [bin("ccs-preview-session.ts"), SESSION], { encoding: "utf-8", env: box.env, timeout: 120_000 });
    return r.stdout;
  }

  test("control: a key clear of the cut is hidden", async () => {
    const box = await makeBox();
    try {
      const out = await preview(box, { message: { role: "user", content: `${GITHUB} tail` } });
      assert.ok(out.includes("[REDACTED]"), out);
      assert.ok(!SHOWN.test(out), out);
    } finally {
      await box.cleanup();
    }
  });

  for (const [name, key, pad] of [
    ["a GitHub token", GITHUB, 190],
    ["an Anthropic key", ANTHROPIC, 185],
  ] as const) {
    test(`message text: ${name} across the cut`, async () => {
      const box = await makeBox();
      try {
        const out = await preview(box, { message: { role: "user", content: "a".repeat(pad) + key } });
        assert.ok(!SHOWN.test(out), out);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("assistant text too", async () => {
    const box = await makeBox();
    try {
      const out = await preview(box, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "a".repeat(190) + GITHUB }] },
      });
      assert.ok(!SHOWN.test(out), out);
    } finally {
      await box.cleanup();
    }
  });

  for (const [field, width] of [
    ["cwd", 200],
    ["gitBranch", 100],
    ["version", 50],
  ] as const) {
    test(`${field}: a key across its cut`, async () => {
      const box = await makeBox();
      try {
        const out = await preview(box, {
          message: { role: "user", content: "hello" },
          [field]: "a".repeat(width - 10) + GITHUB,
        });
        assert.ok(!SHOWN.test(out), out);
      } finally {
        await box.cleanup();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A repo cannot make the scan read outside it or run what its config says
// ---------------------------------------------------------------------------

describe("the scan stays inside a repo and runs nothing the repo configures", () => {
  const NETRC_LINE = "machine example.invalid login u password FAKEVALUE123\n";

  async function handoffRows(box: Box): Promise<string> {
    const { openDb } = await import("../bin/ccs-db.ts");
    const h = openDb(join(box.home, ".cache", "ccs", "state.db"));
    try {
      const a = h.db.prepare("SELECT filename, first_line FROM handoff_files").all();
      const b = h.db.prepare("SELECT filename, first_line FROM pending_items").all();
      return JSON.stringify([...a, ...b]);
    } finally {
      h.close();
    }
  }

  for (const dir of ["handoff", "pendings"]) {
    test(`${dir}/: a file symlinked out of the repo is not read`, async () => {
      const box = await makeBox();
      try {
        const repo = join(box.home, "realrepo");
        await mkdir(join(repo, dir), { recursive: true });
        await writeFile(join(box.home, "outside.netrc"), NETRC_LINE);
        await symlink("../../outside.netrc", join(repo, dir, "note.md"));
        await writeFile(join(repo, dir, "real.md"), "# real one\n");
        await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
        const res = scan(box);
        assert.equal(res.status, 0, res.stderr);
        const rows = await handoffRows(box);
        assert.ok(rows.includes("real.md"), `the ordinary file is still read: ${rows}`);
        assert.ok(!rows.includes("FAKEVALUE123"), rows);
      } finally {
        await box.cleanup();
      }
    });

    test(`${dir}/ itself symlinked out of the repo is not read`, async () => {
      const box = await makeBox();
      try {
        const repo = join(box.home, "realrepo");
        await mkdir(repo, { recursive: true });
        await mkdir(join(box.home, "outside"), { recursive: true });
        await writeFile(join(box.home, "outside", "note.md"), NETRC_LINE);
        await symlink("../outside", join(repo, dir));
        await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
        const res = scan(box);
        assert.equal(res.status, 0, res.stderr);
        assert.ok(!(await handoffRows(box)).includes("FAKEVALUE123"));
      } finally {
        await box.cleanup();
      }
    });
  }

  async function gitRepo(box: Box): Promise<string> {
    const repo = join(box.home, "realrepo");
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => {
      const r = spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", repo, ...args],
        { encoding: "utf-8", env: box.env },
      );
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q");
    await writeFile(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    await writeFile(join(repo, "a.txt"), "a changed\n");
    await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
    return repo;
  }

  /** A script that leaves a marker; a repo that came with its .git could name it. */
  async function plantedCommand(box: Box, name: string): Promise<[string, string]> {
    const marker = join(box.root, `${name}_RAN`);
    const script = join(box.root, `${name}.sh`);
    await writeFile(script, `#!/usr/bin/env bash\necho "$*" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    return [marker, script];
  }

  function setConfig(repo: string, box: Box, key: string, value: string): void {
    const r = spawnSync("git", ["-C", repo, "config", key, value], { encoding: "utf-8", env: box.env });
    assert.equal(r.status, 0, r.stderr);
  }

  async function readStats(box: Box): Promise<Record<string, unknown>> {
    const { openDb } = await import("../bin/ccs-db.ts");
    const h = openDb(join(box.home, ".cache", "ccs", "state.db"));
    try {
      return h.db.prepare("SELECT * FROM repo_stats WHERE name = 'realrepo'").get() as Record<string, unknown>;
    } finally {
      h.close();
    }
  }

  test("control: a plain git repo still reports its branch and changes", async () => {
    const box = await makeBox();
    try {
      await gitRepo(box);
      assert.equal(scan(box).status, 0);
      const stats = await readStats(box);
      assert.equal(stats.is_git, 1, JSON.stringify(stats));
      assert.ok(stats.branch, JSON.stringify(stats));
      assert.equal(stats.uncommitted_files, 1, JSON.stringify(stats));
    } finally {
      await box.cleanup();
    }
  });

  for (const [name, configure] of [
    ["core.fsmonitor", (repo: string, box: Box, script: string) => setConfig(repo, box, "core.fsmonitor", script)],
    ["diff.external", (repo: string, box: Box, script: string) => setConfig(repo, box, "diff.external", script)],
    [
      "a textconv driver",
      async (repo: string, box: Box, script: string) => {
        await writeFile(join(repo, ".gitattributes"), "*.txt diff=planted\n");
        setConfig(repo, box, "diff.planted.textconv", script);
      },
    ],
    [
      "a post-index-change hook",
      async (repo: string, box: Box, script: string) => {
        await mkdir(join(repo, "planted-hooks"), { recursive: true });
        await symlink(script, join(repo, "planted-hooks", "post-index-change"));
        setConfig(repo, box, "core.hooksPath", "planted-hooks");
      },
    ],
  ] as const) {
    test(`${name} in the repo's own config runs nothing during a scan`, async () => {
      const box = await makeBox();
      try {
        const repo = await gitRepo(box);
        const [marker, script] = await plantedCommand(box, "planted");
        await configure(repo, box, script);
        const res = scan(box);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(await exists(marker), false, `${name} ran`);
        const stats = await readStats(box);
        assert.equal(stats.is_git, 1, "the repo is still read");
        assert.ok(stats.branch, "the repo is still read");
      } finally {
        await box.cleanup();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A session's cwd cannot walk out of HOME
// ---------------------------------------------------------------------------

describe("a session's cwd stays under HOME", () => {
  const SESSION = "ffffffff-0000-0000-0000-000000000001";

  async function resumeIn(box: Box, cwd: string, look: string): Promise<string | null> {
    const proj = join(box.home, ".claude", "projects", "p");
    await mkdir(proj, { recursive: true });
    await mkdir(join(box.home, "dummy"), { recursive: true });
    await writeFile(
      join(proj, `${SESSION}.jsonl`),
      [
        { type: "user", cwd, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
        { type: "assistant", cwd, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await writeRepos(box, "version: 1\nrepos:\n  - name: dummy\n    path: ~/dummy\n");
    assert.equal(scan(box, ["--force", "--quiet"]).status, 0);
    box.env.STUB_PICK = "resume:";
    ccs(box, ["--resume", "--no-scan", `--ui=${look}`]);
    if (!(await exists(box.claudeLog))) return null;
    return (await readFile(box.claudeLog, "utf-8")).split("\n")[0];
  }

  for (const look of ["classic", "simple"]) {
    test(`${look}: control: an ordinary cwd opens there`, async () => {
      const box = await makeBox();
      try {
        await mkdir(join(box.home, "work"), { recursive: true });
        const where = await resumeIn(box, join(box.home, "work"), look);
        assert.ok(where?.endsWith("/home/work"), String(where));
      } finally {
        await box.cleanup();
      }
    });

    for (const escape of ["../outside", "dummy/../../outside", "dummy/../.."]) {
      test(`${look}: $HOME/${escape} does not open outside HOME`, async () => {
        const box = await makeBox();
        try {
          await mkdir(join(box.root, "outside"), { recursive: true });
          const where = await resumeIn(box, `${box.home}/${escape}`, look);
          if (where !== null) {
            const real = spawnSync("pwd", ["-P"], { cwd: box.home, encoding: "utf-8" }).stdout.trim();
            assert.ok(where === real || where.startsWith(`${real}/`), `opened in ${where}`);
          }
        } finally {
          await box.cleanup();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The command's wildcards are not expanded
// ---------------------------------------------------------------------------

describe("a wildcard in command is passed as written", () => {
  async function launch(box: Box, command: string, look: string): Promise<string[] | null> {
    const repo = join(box.home, "realrepo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "PLANTED-FILENAME"), "x");
    await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    command: "${command}"\n`);
    scan(box);
    ccs(box, ["--new", "--no-scan", `--ui=${look}`]);
    if (!(await exists(box.claudeLog))) return null;
    return (await readFile(box.claudeLog, "utf-8"))
      .split("\n")
      .filter((l) => l.startsWith("arg:"))
      .map((l) => l.slice("arg:".length));
  }

  for (const look of ["classic", "simple"]) {
    test(`${look}: control: words still split, as they do today`, async () => {
      const box = await makeBox();
      try {
        assert.deepEqual(await launch(box, "claude --model opus", look), ["--model", "opus"]);
      } finally {
        await box.cleanup();
      }
    });

    for (const pattern of ["*", "PLANTED*", "?LANTED-FILENAME", "[P]LANTED-FILENAME"]) {
      test(`${look}: claude ${pattern}`, async () => {
        const box = await makeBox();
        try {
          const args = await launch(box, `claude ${pattern}`, look);
          // A fix may also refuse the value when loading it (then nothing opens).
          if (args !== null) {
            assert.ok(!args.includes("PLANTED-FILENAME"), `expanded: ${JSON.stringify(args)}`);
            assert.deepEqual(args, [pattern]);
          }
        } finally {
          await box.cleanup();
        }
      });
    }
  }

  test("a resumed session keeps the wildcard too", async () => {
    const box = await makeBox();
    try {
      const repo = join(box.home, "realrepo");
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "PLANTED-FILENAME"), "x");
      await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    command: "claude *"\n`);
      const id = "ffffffff-0000-0000-0000-000000000002";
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "user", cwd: repo, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
          { type: "assistant", cwd: repo, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      scan(box, ["--force", "--quiet"]);
      box.env.STUB_PICK = "resume:";
      ccs(box, ["--resume", "--no-scan", "--ui=classic"]);
      if (await exists(box.claudeLog)) {
        const log = await readFile(box.claudeLog, "utf-8");
        assert.ok(!log.includes("PLANTED-FILENAME"), log);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// What is displayed carries no terminal control and no text direction tricks
// ---------------------------------------------------------------------------

describe("display fields are clean", () => {
  const ESCAPES: Array<[string, RegExp]> = [
    ["an OSC sequence", /\u001b\]0;PWNED/],
    ["BEL", /\u0007/],
    ["a C1 control", /[\u0080-\u009f]/],
    ["a bidirectional control", /[\u202a-\u202e\u2066-\u2069]/],
  ];
  function assertClean(out: string, what: string): void {
    for (const [name, rx] of ESCAPES) assert.ok(!rx.test(out), `${what}: ${name} left in ${JSON.stringify(out)}`);
  }

  test("stripControlChars takes C1 and bidirectional controls, and leaves text and emoji alone", async () => {
    const { stripControlChars } = await import("../bin/ccs-sanitize.ts");
    // It puts a space where a control was, as it does for C0 today.
    for (const c of ["\u0080", "\u0085", "\u009b", "\u009f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"]) {
      assert.match(stripControlChars(`a${c}b`), /^a ?b$/, c.codePointAt(0)!.toString(16));
    }
    for (const keep of ["制作チーム", "👨‍👩‍👧", "❤️", "🇯🇵", "Ａ・ｶﾞ", "café", "a b"]) {
      assert.equal(stripControlChars(keep), keep);
    }
  });

  for (const [field, line] of [
    ["description", (v: string) => `    description: "${v}"`],
    ["tags", (v: string) => `    tags: ["${v}"]`],
    ["label", (v: string) => `    label: "${v}"`],
    ["icon", (v: string) => `    icon: "${v}"`],
  ] as const) {
    for (const [name, value] of [
      ["an OSC sequence", "a\\e]0;PWNED\\aend"],
      ["a C1 CSI", "a\\u009B31mend"],
      ["a right-to-left override", "a\\u202Eend"],
      ["an isolate", "a\\u2067end"],
    ] as const) {
      test(`${name} in ${field} does not reach the list or the preview`, async () => {
        const box = await makeBox();
        try {
          await mkdir(join(box.home, "realrepo"), { recursive: true });
          await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n${line(value)}\n`);
          scan(box); // a fix may refuse some of these when loading: that is fine
          for (const ui of ["classic", "simple"]) {
            assertClean(list(box, ["--repos-only", `--ui=${ui}`]).stdout, `${ui} list`);
            const p = spawnSync(TSX, [bin("ccs-preview.ts"), "new:realrepo", join(box.home, "realrepo"), `--ui=${ui}`], {
              encoding: "utf-8",
              env: box.env,
              timeout: 120_000,
            });
            assertClean(p.stdout, `${ui} preview`);
          }
        } finally {
          await box.cleanup();
        }
      });
    }
  }

  test("a right-to-left override in a session's message does not reach the list or the preview", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "realrepo"), { recursive: true });
      await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
      const id = "abababab-0000-0000-0000-000000000001";
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "user", cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello\u202Edlrow" } },
          { type: "assistant", cwd: join(box.home, "realrepo"), timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi\u202Ethere" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      assert.equal(scan(box, ["--force", "--quiet"]).status, 0);
      assertClean(list(box, ["--sessions-only"]).stdout, "list");
      const p = spawnSync(TSX, [bin("ccs-preview-session.ts"), id], { encoding: "utf-8", env: box.env, timeout: 120_000 });
      assertClean(p.stdout, "preview");
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The install instructions do not put a directory ahead of the system's
// ---------------------------------------------------------------------------

describe("the install instructions append to PATH", () => {
  const PREPEND = /PATH=\\?"?[^:"]*\.claude\/scripts:/;
  const APPEND = /PATH=\\?"?\\?\$PATH:[^"]*\.claude\/scripts/;

  for (const file of ["install.sh", "README.md"]) {
    test(file, async () => {
      const text = await readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf-8");
      const lines = text.split("\n");
      assert.deepEqual(lines.filter((l) => PREPEND.test(l)), [], "recommends putting it first");
      assert.ok(lines.some((l) => APPEND.test(l)), "recommends appending");
    });
  }
});

// ---------------------------------------------------------------------------
// The guards must not change what ordinary use does
// ---------------------------------------------------------------------------

describe("ordinary use is not caught by the guards", () => {
  async function launch(box: Box, command: string, env: NodeJS.ProcessEnv = {}): Promise<string[] | null> {
    await mkdir(join(box.home, "realrepo"), { recursive: true });
    await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    command: "${command}"\n`);
    Object.assign(box.env, env);
    scan(box);
    ccs(box, ["--new", "--no-scan", "--ui=classic"]);
    if (!(await exists(box.claudeLog))) return null;
    return (await readFile(box.claudeLog, "utf-8"))
      .split("\n")
      .filter((l) => l.startsWith("arg:"))
      .map((l) => l.slice("arg:".length));
  }

  for (const [command, args] of [
    ["claude", []],
    ["claude --model opus", ["--model", "opus"]],
    ["claude --model=opus --verbose", ["--model=opus", "--verbose"]],
    ["claude -p hello", ["-p", "hello"]],
    ["claude --add-dir ~/notes", ["--add-dir", "~/notes"]],
    ["claude --name team@example.invalid", ["--name", "team@example.invalid"]],
    ["claude --tag a,b:c+d%e", ["--tag", "a,b:c+d%e"]],
    ["claude --note 制作チーム", ["--note", "制作チーム"]],
  ] as const) {
    test(`command "${command}" still opens with its words`, async () => {
      const box = await makeBox();
      try {
        assert.deepEqual(await launch(box, command), [...args]);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("a command with Japanese in a C locale still opens", async () => {
    const box = await makeBox();
    try {
      assert.deepEqual(await launch(box, "claude --note 制作", { LC_ALL: "C", LANG: "C" }), ["--note", "制作"]);
    } finally {
      await box.cleanup();
    }
  });

  test("a command in a path still opens", async () => {
    const box = await makeBox();
    try {
      const tool = join(box.root, "tools", "my-claude_1.2");
      await mkdir(join(box.root, "tools"), { recursive: true });
      await writeFile(tool, `#!/usr/bin/env bash\necho ran >> "${box.claudeLog}"\n`, { mode: 0o755 });
      await launch(box, tool);
      assert.equal((await readFile(box.claudeLog, "utf-8")).trim(), "ran");
    } finally {
      await box.cleanup();
    }
  });

  test("set -f ends with the launch: the resumed session's id and cwd are untouched", async () => {
    const box = await makeBox();
    try {
      const repo = join(box.home, "realrepo");
      await mkdir(repo, { recursive: true });
      await writeRepos(box, `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    command: claude --model opus\n`);
      const id = "ffffffff-0000-0000-0000-000000000003";
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "user", cwd: repo, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
          { type: "assistant", cwd: repo, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      scan(box, ["--force", "--quiet"]);
      box.env.STUB_PICK = "resume:";
      ccs(box, ["--resume", "--no-scan", "--ui=classic"]);
      const log = (await readFile(box.claudeLog, "utf-8")).split("\n");
      assert.ok(log[0].endsWith("/home/realrepo"), log[0]);
      assert.deepEqual(log.slice(1).filter(Boolean), ["arg:--model", "arg:opus", "arg:--resume", `arg:${id}`]);
    } finally {
      await box.cleanup();
    }
  });

  for (const name of ["work..old", "..hidden", "a..b/c"]) {
    test(`a cwd with two dots in a name is not an escape: ${name}`, async () => {
      const box = await makeBox();
      try {
        const cwd = join(box.home, name);
        await mkdir(cwd, { recursive: true });
        const id = "ffffffff-0000-0000-0000-000000000004";
        const proj = join(box.home, ".claude", "projects", "p");
        await mkdir(proj, { recursive: true });
        await mkdir(join(box.home, "dummy"), { recursive: true });
        await writeFile(
          join(proj, `${id}.jsonl`),
          [
            { type: "user", cwd, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
            { type: "assistant", cwd, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
          ].map((l) => JSON.stringify(l)).join("\n") + "\n",
        );
        await writeRepos(box, "version: 1\nrepos:\n  - name: dummy\n    path: ~/dummy\n");
        scan(box, ["--force", "--quiet"]);
        box.env.STUB_PICK = "resume:";
        ccs(box, ["--resume", "--no-scan", "--ui=classic"]);
        const where = (await readFile(box.claudeLog, "utf-8")).split("\n")[0];
        assert.ok(where.endsWith(`/home/${name}`), where);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("a symlink that stays inside the repo is still read, a dangling one breaks nothing", async () => {
    const box = await makeBox();
    try {
      const repo = join(box.home, "realrepo");
      await mkdir(join(repo, "handoff"), { recursive: true });
      await mkdir(join(repo, "notes"), { recursive: true });
      await writeFile(join(repo, "notes", "shared.md"), "# shared inside\n");
      await symlink("../notes/shared.md", join(repo, "handoff", "linked.md"));
      await symlink("../nowhere.md", join(repo, "handoff", "dangling.md"));
      await writeFile(join(repo, "handoff", "real.md"), "# real one\n");
      await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
      const res = scan(box);
      assert.equal(res.status, 0, res.stderr);
      const { openDb } = await import("../bin/ccs-db.ts");
      const h = openDb(join(box.home, ".cache", "ccs", "state.db"));
      try {
        const rows = JSON.stringify(h.db.prepare("SELECT filename, first_line FROM handoff_files").all());
        assert.ok(rows.includes("# shared inside"), rows);
        assert.ok(rows.includes("# real one"), rows);
      } finally {
        h.close();
      }
    } finally {
      await box.cleanup();
    }
  });

  test("a repo reached through a symlink under HOME is still read", async () => {
    const box = await makeBox();
    try {
      const real = join(box.home, "elsewhere", "realrepo");
      await mkdir(join(real, "handoff"), { recursive: true });
      await writeFile(join(real, "handoff", "real.md"), "# real one\n");
      await symlink(join("elsewhere", "realrepo"), join(box.home, "realrepo"));
      await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
      assert.equal(scan(box).status, 0);
      const { openDb } = await import("../bin/ccs-db.ts");
      const h = openDb(join(box.home, ".cache", "ccs", "state.db"));
      try {
        assert.ok(JSON.stringify(h.db.prepare("SELECT first_line FROM handoff_files").all()).includes("# real one"));
      } finally {
        h.close();
      }
    } finally {
      await box.cleanup();
    }
  });
});

describe("a repo's state reads the same with the git guards on", () => {
  const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
  async function repoWith(box: Box): Promise<(...a: string[]) => void> {
    const repo = join(box.home, "realrepo");
    await mkdir(repo, { recursive: true });
    await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
    return (...a: string[]) => {
      const r = spawnSync("git", [...G, "-C", repo, ...a], { encoding: "utf-8", env: box.env });
      assert.equal(r.status, 0, r.stderr);
    };
  }
  async function stats(box: Box): Promise<Record<string, unknown>> {
    assert.equal(scan(box).status, 0);
    const { openDb } = await import("../bin/ccs-db.ts");
    const h = openDb(join(box.home, ".cache", "ccs", "state.db"));
    try {
      return h.db.prepare("SELECT * FROM repo_stats WHERE name = 'realrepo'").get() as Record<string, unknown>;
    } finally {
      h.close();
    }
  }
  const file = (box: Box, name: string) => join(box.home, "realrepo", name);

  test("clean, then changed, staged and untracked", async () => {
    const box = await makeBox();
    try {
      const git = await repoWith(box);
      git("init", "-q", "-b", "main");
      await writeFile(file(box, "a.txt"), "one\ntwo\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "first");
      let s = await stats(box);
      assert.deepEqual([s.is_git, s.branch, s.uncommitted_files, s.last_commit_subject], [1, "main", 0, "first"]);

      await writeFile(file(box, "a.txt"), "one\nTWO\nthree\n");
      await writeFile(file(box, "b.txt"), "new\n");
      await writeFile(file(box, "c.txt"), "untracked\n");
      git("add", "b.txt");
      s = await stats(box);
      assert.equal(s.uncommitted_files, 3, JSON.stringify(s));
      assert.equal(s.uncommitted_insertions, 3, JSON.stringify(s)); // diff against HEAD: staged and unstaged
      assert.equal(s.uncommitted_deletions, 1, JSON.stringify(s));
    } finally {
      await box.cleanup();
    }
  });

  async function touchedRepo(box: Box): Promise<string> {
    const git = await repoWith(box);
    git("init", "-q");
    await writeFile(file(box, "a.txt"), "same\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "first");
    await new Promise((r) => setTimeout(r, 1100));
    await writeFile(file(box, "a.txt"), "same\n");
    return join(box.home, "realrepo", ".git", "index");
  }

  test("a file touched but not changed is not a change", async () => {
    const box = await makeBox();
    try {
      await touchedRepo(box);
      const s = await stats(box);
      assert.deepEqual([s.uncommitted_files, s.uncommitted_insertions, s.uncommitted_deletions], [0, 0, 0], JSON.stringify(s));
    } finally {
      await box.cleanup();
    }
  });

  test("a scan does not rewrite the repo's index", async () => {
    const box = await makeBox();
    try {
      const index = await touchedRepo(box);
      const before = await readFile(index);
      await stats(box);
      assert.deepEqual(await readFile(index), before, "the scan rewrote the repo's index");
    } finally {
      await box.cleanup();
    }
  });

  test("no commit yet, and a detached HEAD", async () => {
    const box = await makeBox();
    try {
      const git = await repoWith(box);
      git("init", "-q");
      await writeFile(file(box, "a.txt"), "x\n");
      let s = await stats(box);
      assert.equal(s.is_git, 1, JSON.stringify(s));
      assert.equal(s.uncommitted_files, 1, JSON.stringify(s));
      git("add", "a.txt");
      git("commit", "-q", "-m", "first");
      git("checkout", "-q", "--detach");
      s = await stats(box);
      assert.equal(s.is_git, 1, JSON.stringify(s));
      assert.equal(s.last_commit_subject, "first", JSON.stringify(s));
    } finally {
      await box.cleanup();
    }
  });

  test("a linked worktree, and a repo with its own hooks folder", async () => {
    const box = await makeBox();
    try {
      const git = await repoWith(box);
      git("init", "-q", "-b", "main");
      await writeFile(file(box, "a.txt"), "x\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "first");
      git("config", "core.hooksPath", ".husky");
      await mkdir(file(box, ".husky"), { recursive: true });
      git("worktree", "add", "-q", "-b", "side", join(box.home, "side"));
      await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/side\n");
      const s = await stats(box);
      assert.deepEqual([s.is_git, s.branch, s.last_commit_subject], [1, "side", "first"], JSON.stringify(s));
    } finally {
      await box.cleanup();
    }
  });
});

describe("the scan lock and the missing native module", () => {
  test("a DB that cannot open leaves no lock behind, and the next scan says why again", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "realrepo"), { recursive: true });
      await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
      const cache = join(box.home, ".cache", "ccs");
      await mkdir(join(cache, "state.db"), { recursive: true }); // a directory where the DB goes
      const first = scan(box, ["--force", "--no-sessions"]);
      assert.notEqual(first.status, 0, "the scan fails");
      assert.match(first.stderr, /unable to open database/, first.stderr);
      assert.equal(await exists(join(cache, "scan.lock")), false, "the lock was left behind");
      const second = scan(box, ["--force", "--no-sessions"]);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /unable to open database/, "the real error, not a stale lock");
      await rm(join(cache, "state.db"), { recursive: true });
      assert.equal(scan(box, ["--force", "--no-sessions"]).status, 0, "works once the DB can open");
    } finally {
      await box.cleanup();
    }
  });

  async function buildWithScanError(box: Box, message: string): Promise<string> {
    const dir = join(box.root, "build");
    await cp(fileURLToPath(new URL("../bin", import.meta.url)), join(dir, "bin"), { recursive: true });
    await cp(fileURLToPath(new URL("../package.json", import.meta.url)), join(dir, "package.json"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(dir, "node_modules"));
    await writeFile(join(dir, "bin", "ccs-scan.ts"), `process.stderr.write(${JSON.stringify(message + "\n")});\nprocess.exit(1);\n`);
    return join(dir, "bin", "ccs");
  }

  for (const [look, words] of [
    ["simple", "ソースから作る必要があります"],
    ["classic", "has to be built from source"],
  ] as const) {
    test(`${look}: a platform with no prebuilt module says so, and offers no command that would not help`, async () => {
      const box = await makeBox();
      try {
        await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
        const script = await buildWithScanError(box, "Error: Cannot find module '@example/better-sqlite3-plan9-arm'");
        const r = spawnSync("bash", [script, `--ui=${look}`], { encoding: "utf-8", env: box.env, cwd: box.home, input: "", timeout: 60_000 });
        const out = r.stdout + r.stderr;
        assert.ok(out.includes(words), out);
        const uname = (flag: string) => spawnSync("uname", [flag], { encoding: "utf-8" }).stdout.trim();
        assert.ok(out.includes(`${uname("-s")}-${uname("-m")}`), out);
        assert.ok(!out.includes("npm install"), out);
      } finally {
        await box.cleanup();
      }
    });

    test(`${look}: any other scan error does not mention it`, async () => {
      const box = await makeBox();
      try {
        await writeRepos(box, "version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n");
        const script = await buildWithScanError(box, "Error: something else");
        const r = spawnSync("bash", [script, `--ui=${look}`], { encoding: "utf-8", env: box.env, cwd: box.home, input: "", timeout: 60_000 });
        assert.ok(!(r.stdout + r.stderr).includes("ソースから") && !(r.stdout + r.stderr).includes("built from source"), r.stdout + r.stderr);
      } finally {
        await box.cleanup();
      }
    });
  }
});

describe("display fields that are easy to forget", () => {
  const LEFT = /\u001b\]0;PWNED|\u0007|[\u0080-\u009f]|[‪-‮⁦-⁩]/;

  test("custom: values reach the preview clean", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "realrepo"), { recursive: true });
      await writeRepos(
        box,
        `version: 1\nrepos:\n  - name: realrepo\n    path: ~/realrepo\n    custom:\n      note: "a\\e]0;PWNED\\aend"\n      other: "a\\u202Eend"\n`,
      );
      scan(box);
      for (const ui of ["classic", "simple"]) {
        const p = spawnSync(TSX, [bin("ccs-preview.ts"), "new:realrepo", join(box.home, "realrepo"), `--ui=${ui}`], {
          encoding: "utf-8",
          env: box.env,
        });
        assert.ok(!LEFT.test(p.stdout), `${ui}: ${JSON.stringify(p.stdout)}`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("a group's card: its description and its members' labels", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "team", "app"), { recursive: true });
      await writeRepos(
        box,
        `version: 1\nrepos:\n  - name: team\n    path: ~/team\n    launch: false\n    description: "d\\e]0;PWNED\\aend"\n  - name: team-app\n    path: ~/team/app\n    label: "a\\u202Eend"\n    description: "x\\u0085y"\n`,
      );
      scan(box);
      for (const ui of ["classic", "simple"]) {
        const p = spawnSync(TSX, [bin("ccs-preview.ts"), "group:team", join(box.home, "team"), `--ui=${ui}`], {
          encoding: "utf-8",
          env: box.env,
        });
        assert.ok(!LEFT.test(p.stdout), `${ui}: ${JSON.stringify(p.stdout)}`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("Ctrl-Y cannot put a cwd that walks out of HOME on the clipboard: the row has no such cwd", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "dummy"), { recursive: true });
      await mkdir(join(box.root, "outside"), { recursive: true });
      const id = "ffffffff-0000-0000-0000-000000000005";
      const proj = join(box.home, ".claude", "projects", "p");
      await mkdir(proj, { recursive: true });
      const cwd = `${box.home}/../outside`;
      await writeFile(
        join(proj, `${id}.jsonl`),
        [
          { type: "user", cwd, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
          { type: "assistant", cwd, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "hi" } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      await writeRepos(box, "version: 1\nrepos:\n  - name: dummy\n    path: ~/dummy\n");
      assert.equal(scan(box, ["--force", "--quiet"]).status, 0);
      const rows = list(box, ["--sessions-only"]).stdout.split("\n").filter(Boolean);
      for (const r of rows) assert.ok(!r.split("\t")[4].includes("/../"), r);
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The supported Node version is stated the same everywhere
// ---------------------------------------------------------------------------

describe("the Node version that ccs needs", () => {
  const root = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

  test("package.json, the lockfile, the README and install.sh agree", async () => {
    const pkg = JSON.parse(await readFile(root("package.json"), "utf-8"));
    const lock = JSON.parse(await readFile(root("package-lock.json"), "utf-8"));
    assert.equal(pkg.engines.node, ">=22");
    assert.equal(lock.packages[""].engines.node, ">=22");
    const readme = await readFile(root("README.md"), "utf-8");
    assert.ok(readme.includes("**22+**"), "README prerequisites");
    assert.ok(readme.includes("node-%3E%3D22"), "README badge");
    assert.ok(!/\*\*20\+\*\*|node-%3E%3D20/.test(readme), "README still says 20");
    assert.ok((await readFile(root("install.sh"), "utf-8")).includes("NODE_MAJOR >= 22"));
  });

  test("the README's install commands need no extra flag", async () => {
    const readme = await readFile(root("README.md"), "utf-8");
    assert.ok(!readme.includes("--allow-scripts"), "the flag is gone");
    assert.ok(readme.includes("npm install -g @indigo-gr/claude-code-station"));
  });

  for (const [version, refused] of [
    ["v21.7.3", true],
    ["v22.0.0", false],
    ["v24.22.1", false],
  ] as const) {
    test(`install.sh with Node ${version}: ${refused ? "named as missing" : "accepted"}`, async () => {
      const box = await makeBox();
      try {
        const major = version.slice(1).split(".")[0];
        await writeFile(
          join(box.root, "stub", "node"),
          `#!/usr/bin/env bash\nif [[ "$1" == "-v" ]]; then echo ${version}; else echo ${major}; fi\n`,
          { mode: 0o755 },
        );
        // No input: install.sh asks before going on with something missing, and stops.
        const r = spawnSync("bash", [root("install.sh")], { encoding: "utf-8", env: box.env, cwd: box.home, input: "", timeout: 60_000 });
        const out = r.stdout + r.stderr;
        assert.equal(out.includes(`node >= 22 (found ${version})`), refused, out);
      } finally {
        await box.cleanup();
      }
    });
  }
});
