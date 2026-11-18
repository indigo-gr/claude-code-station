/**
 * Paths that carry characters a terminal acts on: DEL, C1 (U+0080-U+009F,
 * here U+0085) and the marks that reorder displayed text (here U+202E).
 *
 * What a caller relies on, and what these tests hold:
 *  - what is drawn never carries those characters: the folder on the repo
 *    card, the group card, the session row without a project, the session
 *    card, the `defaults.groups_dir` line of `config get`, and the card shown
 *    before the cache exists or for a key missing from it. Each run of them
 *    becomes one space;
 *  - the path itself stays as written where it is used: the CWD column of
 *    the row (launch, Ctrl-Y, Ctrl-I read it), `list --json --with-paths` and
 *    `config get --with-paths --json` (there the characters are \uXXXX on
 *    stdout, and the parsed value is the same).
 *
 * No real repos.yml or Claude Code is touched: HOME / XDG / TMPDIR are a temp
 * directory, fzf and claude are stubs, values are made up. The characters are
 * built with String.fromCharCode, so this file has none of them raw.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const BIN_DIR = dirname(CCS_BIN);
// The modules run on Node itself (it strips the types of the .ts sources).
const NODE = process.execPath;

const ch = (code: number): string => String.fromCharCode(code);
const RLO = ch(0x202e);
const NEL = ch(0x85);
const DEL = ch(0x7f);
/** Everything a terminal acts on that JSON.stringify leaves raw (C0 it already escapes). */
const RAW = new RegExp(
  "[" +
    [
      [0x7f, 0x9f],
      [0x61c, 0x61c],
      [0x200e, 0x200f],
      [0x202a, 0x202e],
      [0x2028, 0x2029],
      [0x2066, 0x2069],
    ]
      .map(([a, b]) => (a === b ? ch(a) : `${ch(a)}-${ch(b)}`))
      .join("") +
    "]",
);
const ESC_202E = new RegExp(ch(92) + ch(92) + "u202e", "i");
const BS = ch(92);

/** A YAML double-quoted scalar with DEL, C1 and the marks written as escapes. */
function yq(s: string): string {
  let out = "";
  for (const c of s) {
    const o = c.codePointAt(0) ?? 0;
    out += o >= 0x7f && (o <= 0x9f || (o >= 0x2000 && o <= 0x206f)) ? `${BS}u${o.toString(16).padStart(4, "0")}` : c;
  }
  return `"${out}"`;
}

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
  const root = await mkdtemp(join(tmpdir(), "ccs-ctlpath-"));
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

type Lang = "ja" | "en";
const LANGS: readonly Lang[] = ["ja", "en"];

/**
 * The language is set by each test, never taken from the shell that runs it:
 * the language variables are dropped and LANG is fixed. A test that reads
 * the words passes CCS_LANG (bin/ccs) or CCS_LANG_RESOLVED (a module alone).
 */
function envFor(box: Box, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: "en_US.UTF-8",
    PATH: `${box.stubBin}:${process.env.PATH ?? ""}`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    FAKE_FZF_ROWS: box.fzfRows,
    CCS_NO_UPDATE_CHECK: "1",
    CCS_TSX_REAL: NODE,
  };
  for (const k of ["CCS_CMD", "CCR_CMD", "CCS_UI", "CCS_UPDATE_REGISTRY", "CCS_TEST_EDIT_PAUSE_MS"]) delete env[k];
  for (const k of ["CCS_LANG", "CCS_LANG_RESOLVED", "LC_ALL", "LC_MESSAGES"]) delete env[k];
  return { ...env, ...extra };
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(box: Box, args: string[], lang?: Lang): Result {
  const res = spawnSync("bash", [CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box, lang ? { CCS_LANG: lang } : {}),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parse(res: Result, what: string): Record<string, unknown> {
  try {
    return JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`${what}: stdout is not one JSON object: ${res.stdout}\n${res.stderr}`);
  }
}

/** The rows the picker hands to fzf, split into columns. */
async function rows(box: Box): Promise<string[][]> {
  await rm(box.fzfRows, { force: true });
  const res = run(box, []);
  assert.equal(res.code, 0, res.stderr);
  const text = await readFile(box.fzfRows, "utf-8");
  return text.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
}

/** What fzf runs for the preview pane: ccs-preview.ts {4} {5} (the card), in the language bin/ccs passes on. */
function preview(box: Box, key: string, cwd: string, lang: Lang): Result {
  const args = [join(BIN_DIR, "ccs-tsx.sh"), join(BIN_DIR, "ccs-preview.ts"), key, cwd];
  const res = spawnSync("bash", args, {
    encoding: "utf-8",
    env: envFor(box, { CCS_LANG_RESOLVED: lang }),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Drop the ANSI styling, so a line reads as drawn. */
function plain(text: string): string {
  return text.replace(new RegExp(ch(27) + "\\[[0-9;]*m", "g"), "");
}

/** The card's fixed words this file looks at, as bin/ccs-lang-<lang>.txt has them. */
const WORDS: Record<Lang, { folder: string; group: (name: string) => string; notReady: string; notInList: (name: string) => string }> = {
  ja: {
    folder: "📂 フォルダ",
    group: (name) => `📂 グループ「${name}」`,
    notReady: "まだ一覧の準備ができていません。",
    notInList: (name) => `「${name}」はまだ一覧に入っていません。`,
  },
  en: {
    folder: "📂 Folder",
    group: (name) => `📂 Group "${name}"`,
    notReady: "The list is not ready yet.",
    notInList: (name) => `"${name}" is not in the list yet.`,
  },
};

/** The card's lines, styling dropped and the indent trimmed. */
function cardLines(text: string): string[] {
  return plain(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// Made-up layout: a group header, an entry whose path has U+202E, U+0085 and
// DEL, an entry whose relative path is only U+202E, and a plain entry.
const GROUP_DIR = `g${RLO}s`;
const ODD_LEAF = `a${RLO}b${NEL}c${DEL}d`;
const ONLY_MARK = RLO;

async function groupLayout(box: Box): Promise<{ groupPath: string; webPath: string; onlyPath: string }> {
  const groupPath = join(box.home, GROUP_DIR);
  const webPath = join(groupPath, ODD_LEAF);
  const onlyPath = join(groupPath, ONLY_MARK);
  for (const d of [webPath, onlyPath, join(box.home, "w", "api")]) await mkdir(d, { recursive: true });
  await writeFile(
    box.reposYml,
    "version: 1\nrepos:\n" +
      `  - name: studio\n    path: ${yq(`~/${GROUP_DIR}`)}\n    launch: false\n` +
      `  - name: web\n    path: ${yq(`~/${GROUP_DIR}/${ODD_LEAF}`)}\n` +
      `  - name: only\n    path: ${yq(`~/${GROUP_DIR}/${ONLY_MARK}`)}\n` +
      "  - name: api\n    path: ~/w/api\n",
  );
  return { groupPath, webPath, onlyPath };
}

// ---------------------------------------------------------------------------
// 11-12: repos.yml paths with the cache built
// ---------------------------------------------------------------------------

describe("a repos.yml path with U+202E, U+0085 and DEL (cache built)", () => {
  test("the rows keep the path as written in the CWD column; the shown columns carry none of them", async () => {
    const box = await makeBox();
    try {
      const { groupPath, webPath } = await groupLayout(box);
      const all = await rows(box);
      const web = all.find((r) => r[3] === "new:web");
      const studio = all.find((r) => r[3] === "group:studio");
      assert.ok(web && studio, JSON.stringify(all.map((r) => r[3])));
      assert.equal(web[4], webPath, "the CWD column (launch, Ctrl-Y) is the path as written");
      assert.equal(studio[4], groupPath, "the group header's CWD column is the path as written");
      for (const r of all) assert.doesNotMatch(r.slice(0, 3).join("\t"), RAW, `shown columns of ${JSON.stringify(r[3])}`);
    } finally {
      await box.cleanup();
    }
  });

  test("list --json --with-paths keeps the path as written, as \\uXXXX on stdout", async () => {
    const box = await makeBox();
    try {
      const { webPath } = await groupLayout(box);
      const res = run(box, ["list", "--json", "--with-paths"]);
      assert.equal(res.code, 0, res.stderr);
      assert.doesNotMatch(res.stdout, RAW, "no raw control or reordering character on stdout");
      assert.match(res.stdout, ESC_202E, "written as an escape");
      const repos = parse(res, "list --json --with-paths").repos as { name: string; path: string }[];
      assert.equal(repos.find((r) => r.name === "web")?.path, webPath);
    } finally {
      await box.cleanup();
    }
  });

  test("the repo card: the folder is the path with each run as one space", async () => {
    const box = await makeBox();
    try {
      const { webPath } = await groupLayout(box);
      await rows(box); // scan, so the preview reads a fresh cache
      for (const lang of LANGS) {
        const res = preview(box, "new:web", webPath, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        assert.doesNotMatch(res.stdout, RAW, `${lang}: ${JSON.stringify(res.stdout.slice(0, 400))}`);
        const lines = cardLines(res.stdout);
        const folder = lines.indexOf(WORDS[lang].folder);
        assert.notEqual(folder, -1, `${lang}: the folder heading: ${JSON.stringify(lines)}`);
        assert.equal(lines[folder + 1], "~/g s/a b c d", `${lang}: the folder on the card: ${JSON.stringify(lines)}`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("the group card: nothing raw; the members under paths with the marks are listed by name", async () => {
    const box = await makeBox();
    try {
      const { groupPath } = await groupLayout(box);
      await rows(box);
      for (const lang of LANGS) {
        const res = preview(box, "group:studio", groupPath, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        assert.doesNotMatch(res.stdout, RAW, `${lang}: ${JSON.stringify(res.stdout.slice(0, 600))}`);
        const lines = cardLines(res.stdout);
        assert.ok(lines.includes(WORDS[lang].group("studio")), `${lang}: the title: ${JSON.stringify(lines)}`);
        // The members, the one whose relative path is only U+202E included.
        const members = lines.slice(lines.findIndex((l) => l.startsWith("🗂")) + 1);
        assert.deepEqual(members, ["📁 only", "📁 web"], `${lang}: the members: ${JSON.stringify(lines)}`);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 13: a session without a project, whose cwd has U+202E
// ---------------------------------------------------------------------------

describe("a session without a project whose cwd has U+202E", () => {
  test("the row and the session card draw the cwd without it; the CWD column keeps it", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "w", "api"), { recursive: true });
      await writeFile(box.reposYml, "version: 1\nrepos:\n  - name: api\n    path: ~/w/api\n");
      const cwd = join(box.home, `p${RLO}q`);
      await mkdir(cwd, { recursive: true });
      const uuid = "00000002-1111-4222-8333-444444444444";
      const project = join(box.home, ".claude", "projects", "-made-up-pq");
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, `${uuid}.jsonl`),
        JSON.stringify({ type: "user", cwd, timestamp: new Date().toISOString(), message: { content: "hello there" } }) + "\n",
      );
      const all = await rows(box);
      const row = all.find((r) => r[3] === `resume:${uuid}`);
      assert.ok(row, `the session row: ${JSON.stringify(all.map((r) => r[3]))}`);
      assert.equal(row[4], cwd, "the CWD column (launch, Ctrl-Y) is the cwd as written");
      assert.doesNotMatch(row.slice(0, 3).join("\t"), RAW, JSON.stringify(row.slice(0, 3)));
      assert.match(row[0], /~\/p q/, "the cwd shown in place of a project name");

      for (const lang of LANGS) {
        const card = preview(box, `resume:${uuid}`, cwd, lang);
        assert.equal(card.code, 0, `${lang}: ${card.stderr}`);
        assert.doesNotMatch(card.stdout, RAW, `${lang}: ${JSON.stringify(card.stdout.slice(0, 400))}`);
        const lines = cardLines(card.stdout);
        const folder = lines.indexOf(WORDS[lang].folder);
        assert.notEqual(folder, -1, `${lang}: the folder heading: ${JSON.stringify(lines)}`);
        assert.equal(lines[folder + 1], "~/p q", `${lang}: the folder on the session card: ${JSON.stringify(lines)}`);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 14: defaults.groups_dir with U+202E
// ---------------------------------------------------------------------------

describe("defaults.groups_dir with U+202E", () => {
  test("config get --with-paths draws the line without it; --json keeps the value", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "w", "api"), { recursive: true });
      await mkdir(join(box.home, `d${RLO}x`), { recursive: true });
      await writeFile(
        box.reposYml,
        `version: 1\ndefaults:\n  groups_dir: ${yq(`~/d${RLO}x`)}\nrepos:\n  - name: api\n    path: ~/w/api\n`,
      );
      const text = run(box, ["config", "get", "--with-paths"]);
      assert.equal(text.code, 0, text.stderr);
      assert.doesNotMatch(text.stdout, RAW, text.stdout);
      assert.match(text.stdout, new RegExp(`^defaults\\.groups_dir = ${join(box.home, "d x").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

      const js = run(box, ["config", "get", "--with-paths", "--json"]);
      assert.equal(js.code, 0, js.stderr);
      assert.doesNotMatch(js.stdout, RAW, "no raw control or reordering character on stdout");
      assert.match(js.stdout, ESC_202E, "written as an escape");
      const settings = parse(js, "config get --json").settings as Record<string, { path?: string }>;
      assert.equal(settings["defaults.groups_dir"]?.path, join(box.home, `d${RLO}x`));
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 15: the preview before the cache exists, and for a key missing from it
// ---------------------------------------------------------------------------

describe("the preview without a cache entry", () => {
  const name = `na${RLO}me`;
  const cwd = `/made/up/a${RLO}b`;

  test("before the cache exists: the card carries no U+202E", async () => {
    const box = await makeBox();
    try {
      for (const kind of ["new", "group"] as const) {
        for (const lang of LANGS) {
          const res = preview(box, `${kind}:${name}`, cwd, lang);
          assert.equal(res.code, 0, `${kind} ${lang}: ${res.stderr}`);
          assert.doesNotMatch(res.stdout, RAW, `${kind} ${lang}: ${JSON.stringify(res.stdout.slice(0, 400))}`);
          // The card says the list is not ready; it draws neither the name nor the path.
          const lines = cardLines(res.stdout);
          assert.equal(lines[0], WORDS[lang].notReady, `${kind} ${lang}: ${JSON.stringify(lines)}`);
          assert.ok(!plain(res.stdout).includes("na me") && !plain(res.stdout).includes("/made/up"), `${kind} ${lang}: ${JSON.stringify(lines)}`);
        }
      }
    } finally {
      await box.cleanup();
    }
  });

  test("a key missing from the cache: the not-found line names it without U+202E", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "w", "api"), { recursive: true });
      await writeFile(box.reposYml, "version: 1\nrepos:\n  - name: api\n    path: ~/w/api\n");
      await rows(box); // build the cache
      for (const kind of ["new", "group"] as const) {
        for (const lang of LANGS) {
          const res = preview(box, `${kind}:${name}`, cwd, lang);
          assert.equal(res.code, 0, `${kind} ${lang}: ${res.stderr}`);
          assert.doesNotMatch(res.stdout, RAW, `${kind} ${lang}: ${JSON.stringify(res.stdout.slice(0, 400))}`);
          const lines = cardLines(res.stdout);
          assert.equal(lines[0], WORDS[lang].notInList("na me"), `${kind} ${lang}: the not-found line: ${JSON.stringify(lines)}`);
          assert.ok(!plain(res.stdout).includes("/made/up"), `${kind} ${lang}: the path is not drawn: ${JSON.stringify(lines)}`);
        }
      }
    } finally {
      await box.cleanup();
    }
  });
});
