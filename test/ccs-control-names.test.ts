/**
 * Names and group ids that carry characters a terminal acts on: DEL, C1
 * (U+0080-U+009F) and the marks that reorder displayed text (U+061C,
 * U+200E-U+200F, U+202A-U+202E, U+2066-U+2069).
 *
 * What a caller relies on, and what these tests hold:
 *  - ccs never writes such a name: `repo add` refuses it like a label or a
 *    description (invalid_value), and `ccs init --auto-discover` does not
 *    suggest such a folder. C0 stays unsafe_characters. A ZWJ emoji is fine;
 *  - a name or a group id written by hand is still read, and stays the key as
 *    written (the hidden key column, `--repo`, the `list --json` value);
 *  - what is drawn (the shown columns of the list, the preview, a group
 *    header without a label) never carries those characters;
 *  - JSON on stdout writes them (and U+2028-U+2029) as \uXXXX: the parsed
 *    value is the same, the raw bytes on a terminal are not there.
 *
 * No real repos.yml or Claude Code is touched: HOME / XDG / TMPDIR are a temp
 * directory, fzf and claude are stubs, values are made up.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const BIN_DIR = dirname(CCS_BIN);
const TSX = join(BIN_DIR, "..", "node_modules", ".bin", "tsx");

const RLO = "\u202e";
const LRI = "\u2066";
const ALM = "\u061c";
const C1 = "\u009b";
const DEL = "\u007f";
const LS = "\u2028";
/** Everything a terminal acts on that JSON.stringify leaves raw (C0 it already escapes). */
const RAW = /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/;

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "0.65.0 (fake)"; exit 0; fi
cat > "$FAKE_FZF_ROWS"
exit 130
`;

interface Box {
  root: string;
  home: string;
  reposYml: string;
  stubBin: string;
  tmp: string;
  fzfRows: string;
  cleanup: () => Promise<void>;
}

async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-ctl-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const tmp = join(root, "tmp");
  for (const d of [home, stubBin, tmp, join(home, ".config", "ccs")]) await mkdir(d, { recursive: true });
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return {
    root,
    home,
    reposYml: join(home, ".config", "ccs", "repos.yml"),
    stubBin,
    tmp,
    fzfRows: join(root, "fzf-rows.txt"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function dirs(box: Box, ...names: string[]): Promise<void> {
  for (const d of names) await mkdir(join(box.home, d), { recursive: true });
}

function envFor(box: Box): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${box.stubBin}:${process.env.PATH ?? ""}`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    FAKE_FZF_ROWS: box.fzfRows,
    CCS_NO_UPDATE_CHECK: "1",
    CCS_TSX_REAL: TSX,
  };
  for (const k of ["CCS_CMD", "CCR_CMD", "CCS_UI", "CCS_UPDATE_REGISTRY", "CCS_TEST_EDIT_PAUSE_MS"]) delete env[k];
  return env;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(box: Box, args: string[]): Result {
  const res = spawnSync("bash", [CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface Answer {
  status: string;
  reasons: { code: string }[];
  [key: string]: unknown;
}

function json(res: Result, what: string): Answer {
  try {
    return JSON.parse(res.stdout) as Answer;
  } catch {
    assert.fail(`${what}: stdout is not one JSON object: ${res.stdout}\n${res.stderr}`);
  }
}

/** `ccs <args> --json` with this exit code and reason word. */
function expect(box: Box, args: string[], code: number, word: string): Answer {
  const res = run(box, [...args, "--json"]);
  const a = json(res, args.join(" "));
  assert.deepEqual([res.code, a.reasons.map((r) => r.code)], [code, [word]], `ccs ${args.join(" ")}: ${res.stdout}${res.stderr}`);
  return a;
}

/** The rows the picker hands to fzf, split into columns. */
async function rows(box: Box, ui: "classic" | "simple"): Promise<string[][]> {
  await rm(box.fzfRows, { force: true });
  const res = run(box, [`--ui=${ui}`]);
  assert.equal(res.code, 0, res.stderr);
  const text = await readFile(box.fzfRows, "utf-8");
  return text.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
}

function preview(box: Box, key: string, ui: "classic" | "simple"): Result {
  const args = [join(BIN_DIR, "ccs-tsx.sh"), join(BIN_DIR, "ccs-preview.ts"), key, ""];
  if (ui === "simple") args.push("--ui=simple");
  const res = spawnSync("bash", args, { encoding: "utf-8", env: envFor(box), cwd: box.root, stdio: ["ignore", "pipe", "pipe"] });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const TWO = "version: 1\nrepos:\n  - name: web\n    path: ~/w/web\n  - name: api\n    path: ~/w/api\n";

// ---------------------------------------------------------------------------
// What ccs writes
// ---------------------------------------------------------------------------

describe("names ccs writes", () => {
  test("repo add --name with a text-direction mark, C1 or DEL: exit 6, invalid_value, repos.yml untouched", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api", "q/new");
      await writeFile(box.reposYml, TWO);
      for (const [label, name] of [
        ["U+202E", `a${RLO}b`],
        ["U+2066", `a${LRI}b`],
        ["U+061C", `a${ALM}b`],
        ["U+009B", `a${C1}b`],
        ["U+007F", `a${DEL}b`],
      ] as const) {
        expect(box, ["repo", "add", join(box.home, "q", "new"), "--name", name], 6, "invalid_value");
        assert.equal(await readFile(box.reposYml, "utf-8"), TWO, label);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("repo add --name with a tab (C0): exit 6, unsafe_characters, repos.yml untouched", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api", "q/new");
      await writeFile(box.reposYml, TWO);
      expect(box, ["repo", "add", join(box.home, "q", "new"), "--name", "a\tb"], 6, "unsafe_characters");
      assert.equal(await readFile(box.reposYml, "utf-8"), TWO);
    } finally {
      await box.cleanup();
    }
  });

  test("repo add --name with a ZWJ emoji is accepted (the joiner is not refused)", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api", "q/new");
      await writeFile(box.reposYml, TWO);
      const family = "\u{1F468}\u200d\u{1F469}";
      const a = expect(box, ["repo", "add", join(box.home, "q", "new"), "--name", family], 0, "ok");
      assert.deepEqual(a.repo, { name: family, created_config: false });
      const listed = json(run(box, ["list", "--json"]), "list --json");
      assert.ok((listed.repos as { name: string }[]).some((r) => r.name === family));
    } finally {
      await box.cleanup();
    }
  });

  test("repo add without --name in a folder whose name has U+202E: exit 6, invalid_value", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api", `q/x${RLO}y`);
      await writeFile(box.reposYml, TWO);
      expect(box, ["repo", "add", join(box.home, "q", `x${RLO}y`)], 6, "invalid_value");
      assert.equal(await readFile(box.reposYml, "utf-8"), TWO);
    } finally {
      await box.cleanup();
    }
  });

  test("ccs init --auto-discover does not suggest a folder whose name has U+202E or U+009B; the others still are", async () => {
    const { buildCandidates } = (await import(pathToFileURL(join(BIN_DIR, "ccs-init.ts")).href)) as {
      buildCandidates: (found: string[], existing: { names: Set<string>; paths: Set<string> }, home: string) => { name: string; path: string }[];
    };
    const home = "/home/someone";
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write; // the skip notices
    let got: { name: string; path: string }[];
    try {
      got = buildCandidates(
        [`${home}/w/a${RLO}b`, `${home}/w/c${C1}d`, `${home}/w/plain`, `${home}/w/café`],
        { names: new Set(), paths: new Set() },
        home,
      );
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(got, [
      { name: "plain", path: "~/w/plain" },
      { name: "café", path: "~/w/café" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// What ccs reads and draws
// ---------------------------------------------------------------------------

describe("a name written by hand", () => {
  test("is read; list --json keeps the value, and the bytes on stdout carry no U+202E", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api");
      await writeFile(box.reposYml, `version: 1\nrepos:\n  - name: "x${RLO}y"\n    path: ~/w/web\n  - name: api\n    path: ~/w/api\n`);
      const res = run(box, ["list", "--json"]);
      assert.equal(res.code, 0, res.stderr);
      assert.doesNotMatch(res.stdout, RAW, "no raw control or reordering character on stdout");
      assert.match(res.stdout, /\\u202e/i, "written as an escape");
      assert.deepEqual((json(res, "list --json").repos as { name: string }[]).map((r) => r.name), [`x${RLO}y`, "api"]);
    } finally {
      await box.cleanup();
    }
  });

  test("the picker draws it without U+202E in columns 1-3; the key in column 4 stays as written", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api");
      await writeFile(box.reposYml, `version: 1\nrepos:\n  - name: "x${RLO}y"\n    path: ~/w/web\n  - name: api\n    path: ~/w/api\n`);
      for (const ui of ["classic", "simple"] as const) {
        const all = await rows(box, ui);
        const row = all.find((r) => r[3] === `new:x${RLO}y`);
        assert.ok(row, `${ui}: the row keeps its key: ${JSON.stringify(all.map((r) => r[3]))}`);
        for (const r of all) assert.doesNotMatch(r.slice(0, 3).join("\t"), RAW, `${ui}: shown columns of ${JSON.stringify(r[3])}`);
        assert.match(row.slice(0, 3).join(" "), /x y/, `${ui}: the name is drawn without the mark`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("the preview draws it without U+202E, also in the (name) after a label", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api");
      for (const [what, entry] of [
        ["no label", `  - name: "x${RLO}y"\n    path: ~/w/web\n`],
        ["with a label", `  - name: "x${RLO}y"\n    path: ~/w/web\n    label: Web front\n`],
      ] as const) {
        await writeFile(box.reposYml, `version: 1\nrepos:\n${entry}  - name: api\n    path: ~/w/api\n`);
        await rows(box, "classic"); // scan, so the preview reads a fresh cache
        for (const ui of ["classic", "simple"] as const) {
          const res = preview(box, `new:x${RLO}y`, ui);
          assert.equal(res.code, 0, `${what} ${ui}: ${res.stderr}`);
          assert.doesNotMatch(res.stdout, RAW, `${what} ${ui}: ${JSON.stringify(res.stdout.slice(0, 300))}`);
          if (what === "no label") assert.match(res.stdout, /x y/, `${what} ${ui}: the name is the title, cleaned`);
          else {
            assert.match(res.stdout, /Web front/, `${what} ${ui}`);
            // only the classic header adds the dim (name) after a label
            if (ui === "classic") assert.match(res.stdout, /\(x y\)/, `${what} ${ui}: the (name) after the label, cleaned`);
          }
        }
      }
    } finally {
      await box.cleanup();
    }
  });
});

describe("a group id without a label", () => {
  test("list --json keeps the id as written; the label is the id cleaned (or ?); nothing raw on stdout or in the shown columns", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api", "defs");
      await writeFile(
        box.reposYml,
        "version: 1\ndefaults:\n  groups_dir: ~/defs\nrepos:\n  - name: web\n    path: ~/w/web\n  - name: api\n    path: ~/w/api\n",
      );
      const ids = [`a${RLO}b`, `a${C1}b`, RLO];
      for (const [i, id] of ids.entries()) {
        await writeFile(
          join(box.home, "defs", `g${i}.json`),
          JSON.stringify({ version: 1, id, kind: "logical", members: [{ path: "~/w/web" }] }),
        );
      }
      const res = run(box, ["list", "--json"]);
      assert.equal(res.code, 0, res.stderr);
      assert.doesNotMatch(res.stdout, RAW, "no raw control or reordering character on stdout");
      const groups = json(res, "list --json").groups as { id: string; label: string }[];
      assert.deepEqual(groups.map((g) => g.id), ids);
      assert.deepEqual(groups.map((g) => g.label), ["a b", "a b", "?"]);
      for (const ui of ["classic", "simple"] as const) {
        const all = await rows(box, ui);
        const headers = all.filter((r) => (r[3] ?? "").startsWith("group:@"));
        assert.equal(headers.length, 3, `${ui}: ${JSON.stringify(all.map((r) => r[3]))}`);
        assert.deepEqual(headers.map((r) => r[3]), ids.map((id) => `group:@${id}`), `${ui}: the keys stay as written`);
        for (const r of all) assert.doesNotMatch(r.slice(0, 3).join("\t"), RAW, `${ui}: shown columns of ${JSON.stringify(r[3])}`);
      }
    } finally {
      await box.cleanup();
    }
  });
});

describe("JSON on stdout", () => {
  test("list, doctor and sessions write DEL, C1, reordering marks and U+2028 as escapes; the parsed values are the same", async () => {
    const box = await makeBox();
    try {
      await dirs(box, "w/web", "w/api");
      const description = `odd ${DEL} ${C1} ${RLO} ${LS} text`;
      await writeFile(
        box.reposYml,
        `version: 1\nrepos:\n  - name: web\n    path: ~/w/web\n    description: "odd \\x7F \\x9B \\u202E \\u2028 text"\n  - name: api\n    path: ~/w/api\n`,
      );
      const listed = run(box, ["list", "--json"]);
      assert.equal(listed.code, 0, listed.stderr);
      assert.doesNotMatch(listed.stdout, RAW, "list --json");
      const web = (json(listed, "list --json").repos as { name: string; description: string }[]).find((r) => r.name === "web");
      assert.equal(web?.description, description, "the parsed description is what repos.yml says");

      const project = join(box.home, ".claude", "projects", "-made-up-web");
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, "00000001-1111-4222-8333-444444444444.jsonl"),
        JSON.stringify({ type: "user", cwd: join(box.home, "w", "web"), timestamp: new Date().toISOString(), message: { content: `first ${DEL}${C1}${RLO}${LS} line` } }) + "\n",
      );
      for (const args of [["doctor", "--json"], ["sessions", "--json", "--with-titles"], ["sessions", "--json"]]) {
        const res = run(box, args);
        assert.ok([0, 1].includes(res.code), `${args.join(" ")}: ${res.stdout}${res.stderr}`);
        assert.doesNotMatch(res.stdout, RAW, args.join(" "));
        json(res, args.join(" "));
      }
    } finally {
      await box.cleanup();
    }
  });
});
