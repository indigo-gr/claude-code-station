/**
 * `ccs init --auto-discover` and the preview's "Other" integrations, with
 * characters a terminal acts on: DEL, C1 (here U+0085) and the marks that
 * reorder displayed text (here U+202E).
 *
 * What a caller relies on, and what these tests hold:
 *  - discover does not suggest a repository when any folder in its path has
 *    one of them, not only its own name. It prints one
 *    `[ccs-init] skipped (... in the path)` line for each such repository
 *    (in the language ccs speaks), with the characters written as JSON
 *    escapes. A ZWJ emoji or an emoji variation selector in a path is still
 *    suggested;
 *  - the other skipped line (shell metacharacters in the path) and append's
 *    malformed line write those characters as JSON escapes too;
 *  - the preview draws an unknown `custom` key like a name: each run of them
 *    becomes one space, a key made of nothing else is `?`, and a key longer
 *    than 40 characters is cut to 40 with an ellipsis;
 *  - on the TypeScript side the set of those characters is one list: the
 *    write checks and the display cleaning use the same function.
 *
 * No real repos.yml or Claude Code is touched: HOME / XDG / TMPDIR are a temp
 * directory, fzf and claude are stubs, values are made up. The characters are
 * built with String.fromCharCode, so this file has none of them raw.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const BIN_DIR = dirname(CCS_BIN);
// The modules run on Node itself (it strips the types of the .ts sources).
const NODE = process.execPath;

const ch = (code: number): string => String.fromCharCode(code);
const BS = ch(92);
const RLO = ch(0x202e);
const NEL = ch(0x85);
const DEL = ch(0x7f);
const ZWJ_FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469);
const HEART_VS16 = String.fromCodePoint(0x2764, 0xfe0f);
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

/** The JSON escape of one UTF-16 unit, as jsonForTerminal writes it. */
function esc(code: number): string {
  return `${BS}u${code.toString(16).padStart(4, "0")}`;
}

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
  const root = await mkdtemp(join(tmpdir(), "ccs-ctlinit-"));
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

/** What bin/ccs runs with the lines fzf hands back: ccs-init.ts append, in the language bin/ccs passes on. */
function append(box: Box, input: string, lang: Lang): Result {
  const res = spawnSync("bash", [join(BIN_DIR, "ccs-tsx.sh"), join(BIN_DIR, "ccs-init.ts"), "append"], {
    encoding: "utf-8",
    env: envFor(box, { CCS_LANG_RESOLVED: lang }),
    cwd: box.root,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** `ccs init --auto-discover` up to the picker: the candidate rows fzf got, and the run. */
async function discover(box: Box, lang: Lang): Promise<{ res: Result; rows: string[][] }> {
  await rm(box.fzfRows, { force: true });
  const res = run(box, ["init", "--auto-discover"], lang);
  let text = "";
  try {
    text = await readFile(box.fzfRows, "utf-8");
  } catch {
    // no candidates: fzf was not started
  }
  return { res, rows: text.split("\n").filter((l) => l !== "").map((l) => l.split("\t")) };
}

/** What fzf runs for the preview pane: ccs-preview.ts {4} {5}, in the language bin/ccs passes on. */
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

async function gitRepo(box: Box, rel: string): Promise<string> {
  const abs = join(box.home, ...rel.split("/"));
  await mkdir(join(abs, ".git"), { recursive: true });
  return abs;
}

const BASE_YML = "version: 1\nrepos:\n  - name: base\n    path: ~/base\n";
/** The heads of the skipped lines, as bin/ccs-lang-<lang>.txt has them (init_skip_*). */
const HEADS: Record<Lang, { inThePath: string; shellMeta: string; malformed: string }> = {
  en: {
    inThePath: "[ccs-init] skipped (control or text-direction characters in the path): ",
    shellMeta: "[ccs-init] skipped (shell metacharacters in the path): ",
    malformed: "[ccs-init] malformed candidate line skipped: ",
  },
  ja: {
    inThePath: "[ccs-init] 飛ばしました（パスに制御文字か向きを変える文字があります）: ",
    shellMeta: "[ccs-init] 飛ばしました（パスにシェルの記号があります）: ",
    malformed: "[ccs-init] 形の崩れた候補の行を飛ばしました: ",
  },
};

function linesStarting(text: string, head: string): string[] {
  return text.split("\n").filter((l) => l.startsWith(head));
}

// ---------------------------------------------------------------------------
// ccs init --auto-discover
// ---------------------------------------------------------------------------

describe("ccs init --auto-discover with a parent folder that has U+202E, U+0085 or DEL", () => {
  test("the repository is not suggested; one skipped line each, the character as an escape; ZWJ and VS16 paths are suggested", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "base"));
      await writeFile(box.reposYml, BASE_YML);
      const odd = [
        [RLO, 0x202e],
        [NEL, 0x85],
        [DEL, 0x7f],
      ] as const;
      for (const [i, [c]] of odd.entries()) await gitRepo(box, `w/p${i}${c}q/odd${i}`);
      await gitRepo(box, `w/a${ZWJ_FAMILY}/zwj`);
      await gitRepo(box, `w/${HEART_VS16}b`);
      await gitRepo(box, "w/plain");

      for (const lang of LANGS) {
        const { res, rows } = await discover(box, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        assert.deepEqual(
          rows.map((r) => r[1]).sort(),
          [`~/w/a${ZWJ_FAMILY}/zwj`, `~/w/${HEART_VS16}b`, "~/w/plain"].sort(),
          `${lang}: the candidates fzf got: ${JSON.stringify(rows)}`,
        );
        for (const r of rows) assert.doesNotMatch(r.join("\t"), RAW, `${lang}: candidate ${JSON.stringify(r)}`);

        const skipped = linesStarting(res.stderr, HEADS[lang].inThePath);
        assert.equal(skipped.length, odd.length, `${lang}: ${res.stderr}`);
        for (const [i, [, code]] of odd.entries()) {
          const mine = skipped.filter((l) => l.includes(`/odd${i}`));
          assert.equal(mine.length, 1, `${lang}: one line for odd${i}: ${JSON.stringify(skipped)}`);
          assert.ok(mine[0].includes(`p${i}${esc(code)}q`), `${lang}: odd${i} written as an escape: ${JSON.stringify(mine[0])}`);
        }
        assert.doesNotMatch(res.stderr, RAW, `${lang}: nothing raw on stderr`);
        assert.deepEqual(linesStarting(res.stderr, HEADS[lang].shellMeta), [], lang);
        assert.equal(await readFile(box.reposYml, "utf-8"), BASE_YML, `${lang}: the picker was cancelled; repos.yml untouched`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("the repository's own folder name with U+202E is still skipped with the same line", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "base"));
      await writeFile(box.reposYml, BASE_YML);
      await gitRepo(box, `w/x${RLO}y`);
      await gitRepo(box, "w/plain");
      for (const lang of LANGS) {
        const { res, rows } = await discover(box, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        assert.deepEqual(rows, [["plain", "~/w/plain"]], lang);
        const skipped = linesStarting(res.stderr, HEADS[lang].inThePath);
        assert.equal(skipped.length, 1, `${lang}: ${res.stderr}`);
        assert.ok(skipped[0].includes(`x${esc(0x202e)}y`), `${lang}: ${skipped[0]}`);
        assert.doesNotMatch(res.stderr, RAW, lang);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("a path with ';' and U+202E, U+0085: the shell-metacharacter line, the characters as escapes, and only that line", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "base"));
      await writeFile(box.reposYml, BASE_YML);
      await gitRepo(box, `w/s;t${RLO}u${NEL}v/meta`);
      await gitRepo(box, "w/plain");
      for (const lang of LANGS) {
        const { res, rows } = await discover(box, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        assert.deepEqual(rows, [["plain", "~/w/plain"]], lang);
        const meta = linesStarting(res.stderr, HEADS[lang].shellMeta);
        assert.equal(meta.length, 1, `${lang}: ${res.stderr}`);
        assert.ok(meta[0].includes(`s;t${esc(0x202e)}u${esc(0x85)}v`), `${lang}: ${meta[0]}`);
        assert.deepEqual(linesStarting(res.stderr, HEADS[lang].inThePath), [], `${lang}: not a second line for the same path`);
        assert.doesNotMatch(res.stderr, RAW, `${lang}: nothing raw on stderr`);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ccs-init append (the lines the picker hands back)
// ---------------------------------------------------------------------------

describe("ccs-init append with a line without a tab", () => {
  test("U+0085 and U+202E in it: the malformed line on stderr has them as escapes; repos.yml untouched", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "base"));
      await writeFile(box.reposYml, BASE_YML);
      for (const lang of LANGS) {
        const res = append(box, `x${NEL}y${RLO}z${DEL}w\n`, lang);
        assert.equal(res.code, 0, `${lang}: ${res.stderr}`);
        const bad = linesStarting(res.stderr, HEADS[lang].malformed);
        assert.equal(bad.length, 1, `${lang}: ${res.stderr}`);
        assert.ok(bad[0].includes(`x${esc(0x85)}y${esc(0x202e)}z${esc(0x7f)}w`), `${lang}: ${bad[0]}`);
        assert.doesNotMatch(res.stderr, RAW, `${lang}: nothing raw on stderr`);
        assert.equal(await readFile(box.reposYml, "utf-8"), BASE_YML, lang);
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Custom keys in the preview card
// ---------------------------------------------------------------------------

describe("an unknown custom key in the preview", () => {
  test("the card names known services only: an unknown key is not drawn at all, and nothing raw", async () => {
    const box = await makeBox();
    try {
      await mkdir(join(box.home, "w", "web"), { recursive: true });
      const long = "k".repeat(45);
      await writeFile(
        box.reposYml,
        "version: 1\nrepos:\n  - name: web\n    path: ~/w/web\n    custom:\n" +
          `      ${yq(`a${RLO}b`)}: v\n` +
          `      ${yq(`${RLO}${NEL}`)}: w\n` +
          `      ${long}: x\n`,
      );
      const listed = run(box, []); // scan, so the preview reads a fresh cache
      assert.equal(listed.code, 0, listed.stderr);
      for (const lang of LANGS) {
        const p = preview(box, "new:web", join(box.home, "w", "web"), lang);
        assert.equal(p.code, 0, `${lang}: ${p.stderr}`);
        assert.doesNotMatch(p.stdout, RAW, `${lang}: ${JSON.stringify(p.stdout.slice(0, 400))}`);
        const text = plain(p.stdout);
        assert.match(text, /web/, `${lang}: the card of the repo: ${JSON.stringify(text.slice(0, 400))}`);
        // No services line at all (card_services in either table), and none of the keys or values.
        for (const shown of ["a b", "kkkkkkkkkk", ": v", ": w", ": x", "Other", "つながっているサービス", "Connected services"]) {
          assert.ok(!text.includes(shown), `${lang}: ${JSON.stringify(shown)} is not drawn: ${JSON.stringify(text)}`);
        }
      }
    } finally {
      await box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// One list of characters on the TypeScript side
// ---------------------------------------------------------------------------

describe("the set of characters checked and cleaned", () => {
  test("ccs-config-edit's hasControlChars is ccs-sanitize's", async () => {
    const sanitize = (await import(pathToFileURL(join(BIN_DIR, "ccs-sanitize.ts")).href)) as { hasControlChars: unknown };
    const edit = (await import(pathToFileURL(join(BIN_DIR, "ccs-config-edit.ts")).href)) as { hasControlChars: unknown };
    assert.equal(typeof sanitize.hasControlChars, "function");
    assert.equal(edit.hasControlChars, sanitize.hasControlChars);
  });

  test("hasControlChars: each reordering mark, C1, DEL and C0 are in; ZWJ, VS16 and plain text are not", async () => {
    const { hasControlChars } = (await import(pathToFileURL(join(BIN_DIR, "ccs-sanitize.ts")).href)) as {
      hasControlChars: (v: string) => boolean;
    };
    const marks = [0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const code of [...marks, 0x80, 0x85, 0x9b, 0x9f, 0x7f, 0x00, 0x09, 0x1b, 0x1f]) {
      assert.equal(hasControlChars(`a${ch(code)}b`), true, `U+${code.toString(16).padStart(4, "0")}`);
    }
    for (const code of [0x200d, 0xfe0f, 0x2028, 0x202f, 0x2065, 0x206a, 0xa0, 0x20]) {
      assert.equal(hasControlChars(`a${ch(code)}b`), false, `U+${code.toString(16).padStart(4, "0")}`);
    }
    assert.equal(hasControlChars(ZWJ_FAMILY + HEART_VS16 + "café"), false);
  });

  test("no bin/*.ts other than ccs-sanitize.ts writes the reordering marks or the DEL-C1 range", async () => {
    const markEscape = new RegExp(BS + BS + "u(061c|200e|200f|202[a-e]|206[6-9])", "i");
    const delC1 = new RegExp(BS + BS + "x(7f|9f)|" + BS + BS + "u00(7f|9f)", "i");
    const files = (await readdir(BIN_DIR)).filter((f) => f.endsWith(".ts")).sort();
    assert.ok(files.includes("ccs-sanitize.ts"), JSON.stringify(files));
    for (const f of files) {
      const text = await readFile(join(BIN_DIR, f), "utf-8");
      assert.doesNotMatch(text, RAW, `${f}: a raw character`);
      if (f === "ccs-sanitize.ts") {
        const at = text.split("\n").filter((l) => markEscape.test(l));
        assert.equal(at.length, 1, `${f}: the marks on one line (one list): ${JSON.stringify(at)}`);
        assert.equal(text.split("\n").filter((l) => delC1.test(l)).length, 1, `${f}: the DEL-C1 range on one line`);
        continue;
      }
      assert.doesNotMatch(text, markEscape, `${f}: a copy of the reordering marks`);
      assert.doesNotMatch(text, delC1, `${f}: a copy of the DEL-C1 range`);
    }
  });
});
