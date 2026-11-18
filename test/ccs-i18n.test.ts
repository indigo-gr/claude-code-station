/**
 * ccs in two languages, Japanese and English (docs/design/i18n.md).
 *
 * What these tests hold:
 *  1. the order that decides the language: --lang=, CCS_LANG,
 *     defaults.language in repos.yml, LC_ALL / LC_MESSAGES / LANG (the first
 *     non-empty one), then English; unknown values in CCS_LANG and
 *     defaults.language are skipped with one warning line;
 *  2. an unknown --lang= value is a usage error (exit 2) for every command,
 *     and --lang= is ccs's own only before a bare `--`;
 *  3. the two string tables: same keys, same insertions, a clean format, every
 *     key the code uses is in the English table, and the texts that go into
 *     fzf actions hold no character that would end the action early;
 *  4. --json answers do not change with the language;
 *  5. representative texts in both languages (written out here, not read from
 *     the tables, so a broken table fails);
 *  6. bash 3.2's `tx` puts a value in as it is;
 *  7. a missing table: the chosen language's table missing reads in English,
 *     the English table missing stops every command that speaks to a person
 *     with one fixed line, and a key no table has is never shown by its name.
 *
 * Every run gets a temporary HOME / XDG / TMPDIR, stub fzf and claude, and an
 * environment built from nothing: no CCS_LANG, CCS_LANG_RESOLVED or locale
 * variable leaks in from the shell the tests run in. No network (the update
 * check is off, or its registry is unreachable). Values are made up.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, access, cp } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));
const BIN_DIR = dirname(CCS_BIN);
const VERSION = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf-8")).version as string;
const BASH = "/bin/bash";

type Lang = "ja" | "en";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

// fzf: answers --version; otherwise keeps its arguments (NUL-separated) and
// the rows, then picks the row whose 4th column is FAKE_FZF_PICK, or leaves
// as fzf does on Esc. Pure bash, so no locale can upset it.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "\${FAKE_FZF_VERSION:-0.65.0} (fake)"; exit 0; fi
printf '%s\\0' "$@" > "$FAKE_FZF_ARGS"
rows=$(cat)
printf '%s\\n' "$rows" > "$FAKE_FZF_ROWS"
while IFS= read -r row; do
  r=\${row#*$'\\t'}; r=\${r#*$'\\t'}; r=\${r#*$'\\t'}; k=\${r%%$'\\t'*}
  if [[ -n "\${FAKE_FZF_PICK:-}" && "$k" == "$FAKE_FZF_PICK" ]]; then
    printf '%s\\n' "$row"; exit 0
  fi
done <<< "$rows"
exit 130
`;
// claude: keeps the arguments it was started with (NUL-separated).
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$FAKE_CLAUDE_ARGS"
`;

interface Box {
  root: string;
  home: string;
  stubBin: string;
  tmp: string;
  reposYml: string;
  fzfArgs: string;
  fzfRows: string;
  claudeArgs: string;
}

const boxes: string[] = [];

async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-i18n-"));
  boxes.push(root);
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const tmp = join(root, "tmp");
  for (const d of [home, stubBin, tmp, join(home, "proj", "one"), join(home, ".config", "ccs")]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  // node is the one running these tests; nothing else from the outer PATH.
  await symlink(process.execPath, join(stubBin, "node"));
  return {
    root,
    home,
    stubBin,
    tmp,
    reposYml: join(home, ".config", "ccs", "repos.yml"),
    fzfArgs: join(root, "fzf-args"),
    fzfRows: join(root, "fzf-rows"),
    claudeArgs: join(root, "claude-args"),
  };
}

async function cleanupAll(): Promise<void> {
  for (const root of boxes.splice(0)) await rm(root, { recursive: true, force: true });
}

const REPOS = "repos:\n  - name: one\n    path: ~/proj/one\n";
const ONE = `version: 1\n${REPOS}`;
/** repos.yml with `defaults:` holding the given line(s), two spaces in. */
const withDefaults = (line: string): string => `version: 1\ndefaults:\n  ${line}\n${REPOS}`;

type EnvPatch = Record<string, string | undefined>;

/**
 * The whole environment of a run, built from nothing: the language is decided
 * only by what a case passes in `patch`.
 */
function envFor(box: Box, patch: EnvPatch = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${box.stubBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    CCS_NO_UPDATE_CHECK: "1",
    // Never reached (the check is off, or stdout is not a terminal), and
    // unreachable if it ever were.
    CCS_UPDATE_REGISTRY: "http://127.0.0.1:9",
    FAKE_FZF_ARGS: box.fzfArgs,
    FAKE_FZF_ROWS: box.fzfRows,
    FAKE_CLAUDE_ARGS: box.claudeArgs,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(box: Box, args: string[], patch: EnvPatch = {}): Result {
  const res = spawnSync(BASH, [CCS_BIN, ...args], {
    encoding: "utf-8",
    env: envFor(box, patch),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function runAsync(box: Box, args: string[], patch: EnvPatch = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [CCS_BIN, ...args], {
      env: envFor(box, patch),
      cwd: box.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf-8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run `work` over `items`, at most `width` at a time, results in order. */
async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

type Answer = Record<string, unknown>;

function parseAnswer(res: Result, what: string): Answer {
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `${what}: one line of JSON on stdout\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(lines[0]) as Answer;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

const nulList = async (file: string): Promise<string[]> =>
  (await readFile(file, "utf-8")).split("\0").slice(0, -1);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const lines = (s: string): string[] => s.split("\n").filter((l) => l.trim() !== "");

/** Run a few lines of JS against a module of BIN_DIR, in a fresh node, and parse its JSON. */
function inModule(file: string, body: string, env: NodeJS.ProcessEnv): unknown {
  const script = `const m = await import(process.argv[1]);\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(join(BIN_DIR, file)).href], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", ...env },
    cwd: BIN_DIR,
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `${file}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// ---------------------------------------------------------------------------
// 1. The order that decides the language
// ---------------------------------------------------------------------------

interface LangCase {
  name: string;
  want: Lang;
  /** repos.yml; omitted = no file at all */
  yml?: string;
  env?: EnvPatch;
  /** extra arguments before `doctor` / after `--json` */
  before?: string[];
  after?: string[];
}

interface LangSeen {
  lang: unknown;
  code: number;
  stderr: string;
}

async function doctorLanguage(c: LangCase): Promise<LangSeen> {
  const box = await makeBox();
  if (c.yml !== undefined) await writeFile(box.reposYml, c.yml);
  const res = await runAsync(box, [...(c.before ?? []), "doctor", "--json", ...(c.after ?? [])], c.env ?? {});
  let lang: unknown = `(no answer: exit ${res.code})`;
  try {
    const a = parseAnswer(res, c.name);
    lang = (a.settings as Answer | undefined)?.language;
  } catch {
    // reported through `lang` below
  }
  return { lang, code: res.code, stderr: res.stderr };
}

/** All cases at once; one assertion that shows every case that went wrong. */
async function checkCases(cases: LangCase[]): Promise<LangSeen[]> {
  const names = new Set(cases.map((c) => c.name));
  assert.equal(names.size, cases.length, "case names are unique");
  const seen = await pool(cases, 8, doctorLanguage);
  const got: Record<string, unknown> = {};
  const want: Record<string, unknown> = {};
  cases.forEach((c, i) => {
    got[c.name] = seen[i].lang;
    want[c.name] = c.want;
  });
  assert.deepEqual(got, want);
  return seen;
}

const LOCALE_VALUES: [string, Lang][] = [
  ["ja_JP.UTF-8", "ja"],
  ["ja", "ja"],
  ["C", "en"],
  ["POSIX", "en"],
  ["en_US.UTF-8", "en"],
  ["", "en"],
];

describe("the language: --lang=, CCS_LANG, defaults.language, the locale, English", () => {
  test("the locale: each of LC_ALL, LC_MESSAGES and LANG on its own; nothing set is English", async () => {
    try {
      const cases: LangCase[] = [{ name: "nothing at all", want: "en" }];
      for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
        for (const [value, want] of LOCALE_VALUES) {
          cases.push({ name: `${name}=${JSON.stringify(value)}`, env: { [name]: value }, want });
        }
      }
      await checkCases(cases);
    } finally {
      await cleanupAll();
    }
  });

  test("the locale: the first non-empty of LC_ALL, LC_MESSAGES, LANG decides", async () => {
    try {
      await checkCases([
        { name: "LC_ALL=C LANG=ja_JP.UTF-8", env: { LC_ALL: "C", LANG: "ja_JP.UTF-8" }, want: "en" },
        { name: "LC_ALL=POSIX LANG=ja", env: { LC_ALL: "POSIX", LANG: "ja" }, want: "en" },
        { name: "LC_ALL=ja_JP.UTF-8 LANG=C", env: { LC_ALL: "ja_JP.UTF-8", LANG: "C" }, want: "ja" },
        {
          name: "LC_ALL=en_US.UTF-8 LC_MESSAGES=ja_JP.UTF-8",
          env: { LC_ALL: "en_US.UTF-8", LC_MESSAGES: "ja_JP.UTF-8" },
          want: "en",
        },
        { name: "LC_MESSAGES=ja_JP.UTF-8 LANG=en_US.UTF-8", env: { LC_MESSAGES: "ja_JP.UTF-8", LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "LC_MESSAGES=C LANG=ja_JP.UTF-8", env: { LC_MESSAGES: "C", LANG: "ja_JP.UTF-8" }, want: "en" },
        { name: "LC_ALL='' LANG=ja_JP.UTF-8", env: { LC_ALL: "", LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: "LC_ALL='' LC_MESSAGES='' LANG=ja", env: { LC_ALL: "", LC_MESSAGES: "", LANG: "ja" }, want: "ja" },
        { name: "LC_ALL='' LC_MESSAGES=ja LANG=C", env: { LC_ALL: "", LC_MESSAGES: "ja", LANG: "C" }, want: "ja" },
        { name: "LC_ALL='' LC_MESSAGES='' LANG=''", env: { LC_ALL: "", LC_MESSAGES: "", LANG: "" }, want: "en" },
      ]);
    } finally {
      await cleanupAll();
    }
  });

  test("defaults.language: ja and en decide; auto, empty, null and unknown leave it to the locale", async () => {
    try {
      const values: [string, string, Lang | null][] = [
        ["auto", "language: auto", null],
        ["ja", "language: ja", "ja"],
        ["en", "language: en", "en"],
        ["empty string", 'language: ""', null],
        ["no value", "language:", null],
        ["null", "language: null", null],
        ["fr", "language: fr", null],
      ];
      const locales: [string, EnvPatch, Lang][] = [
        ["LANG=ja_JP.UTF-8", { LANG: "ja_JP.UTF-8" }, "ja"],
        ["LANG=en_US.UTF-8", { LANG: "en_US.UTF-8" }, "en"],
        ["no locale", {}, "en"],
      ];
      const cases: LangCase[] = [];
      for (const [vName, line, decided] of values) {
        for (const [lName, env, byLocale] of locales) {
          cases.push({ name: `defaults.language ${vName}, ${lName}`, yml: withDefaults(line), env, want: decided ?? byLocale });
        }
      }
      cases.push(
        { name: "no repos.yml, LANG=ja_JP.UTF-8", env: { LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: "no defaults block, LANG=ja_JP.UTF-8", yml: ONE, env: { LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: 'quoted "ja", LANG=en', yml: withDefaults('language: "ja"'), env: { LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "quoted 'en', LANG=ja", yml: withDefaults("language: 'en'"), env: { LANG: "ja_JP.UTF-8" }, want: "en" },
        { name: "ja with a comment, LANG=en", yml: withDefaults("language: ja   # mine"), env: { LANG: "en_US.UTF-8" }, want: "ja" },
        {
          name: "defaults after repos, LANG=en",
          yml: `version: 1\n${REPOS}defaults:\n  language: ja\n`,
          env: { LANG: "en_US.UTF-8" },
          want: "ja",
        },
        {
          name: "language among other defaults, LANG=en",
          yml: `version: 1\ndefaults:\n  update_check: true\n  language: ja\n  ui: simple\n${REPOS}`,
          env: { LANG: "en_US.UTF-8" },
          want: "ja",
        },
        {
          // i18n.md 2: the one-line form is not read at start; the locale decides.
          name: "flow style defaults: {language: ja}, LANG=en",
          yml: `version: 1\ndefaults: {language: ja}\n${REPOS}`,
          env: { LANG: "en_US.UTF-8" },
          want: "en",
        },
        {
          name: "a language: line outside defaults, LANG=en",
          yml: `version: 1\nother:\n  language: ja\n${REPOS}`,
          env: { LANG: "en_US.UTF-8" },
          want: "en",
        },
      );
      await checkCases(cases);
    } finally {
      await cleanupAll();
    }
  });

  test("CCS_LANG wins over defaults.language and the locale; empty is not set; unknown is skipped", async () => {
    try {
      await checkCases([
        { name: "CCS_LANG=ja over en, en", yml: withDefaults("language: en"), env: { CCS_LANG: "ja", LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "CCS_LANG=en over ja, ja", yml: withDefaults("language: ja"), env: { CCS_LANG: "en", LC_ALL: "ja_JP.UTF-8" }, want: "en" },
        { name: "CCS_LANG=ja over LC_ALL=C", env: { CCS_LANG: "ja", LC_ALL: "C" }, want: "ja" },
        { name: "CCS_LANG='' then defaults ja", yml: withDefaults("language: ja"), env: { CCS_LANG: "", LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "CCS_LANG='' then the locale", env: { CCS_LANG: "", LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: "CCS_LANG=fr then defaults ja", yml: withDefaults("language: ja"), env: { CCS_LANG: "fr", LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "CCS_LANG=fr then defaults en", yml: withDefaults("language: en"), env: { CCS_LANG: "fr", LANG: "ja_JP.UTF-8" }, want: "en" },
        { name: "CCS_LANG=fr then the locale ja", env: { CCS_LANG: "fr", LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: "CCS_LANG=fr, defaults fr, LANG=ja", yml: withDefaults("language: fr"), env: { CCS_LANG: "fr", LANG: "ja_JP.UTF-8" }, want: "ja" },
        { name: "CCS_LANG=fr, defaults fr, nothing", yml: withDefaults("language: fr"), env: { CCS_LANG: "fr" }, want: "en" },
      ]);
    } finally {
      await cleanupAll();
    }
  });

  test("--lang= wins over everything, before or after the command word", async () => {
    try {
      const allJa = { CCS_LANG: "ja", LC_ALL: "ja_JP.UTF-8", LANG: "ja_JP.UTF-8" };
      const allEn = { CCS_LANG: "en", LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
      await checkCases([
        { name: "--lang=ja first, all else en", before: ["--lang=ja"], yml: withDefaults("language: en"), env: allEn, want: "ja" },
        { name: "--lang=ja last, all else en", after: ["--lang=ja"], yml: withDefaults("language: en"), env: allEn, want: "ja" },
        { name: "--lang=en first, all else ja", before: ["--lang=en"], yml: withDefaults("language: ja"), env: allJa, want: "en" },
        { name: "--lang=en last, all else ja", after: ["--lang=en"], yml: withDefaults("language: ja"), env: allJa, want: "en" },
        { name: "--lang=ja over CCS_LANG=fr", before: ["--lang=ja"], env: { CCS_LANG: "fr", LANG: "en_US.UTF-8" }, want: "ja" },
        { name: "--lang=en, nothing else", after: ["--lang=en"], env: { LANG: "ja_JP.UTF-8" }, want: "en" },
      ]);
    } finally {
      await cleanupAll();
    }
  });

  test("an unknown CCS_LANG: one warning line, and terminal control characters are not printed", async () => {
    try {
      const box = await makeBox();
      const res = run(box, ["doctor", "--json"], { CCS_LANG: "fr", LANG: "en_US.UTF-8" });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(lines(res.stderr).length, 1, `one line:\n${res.stderr}`);
      assert.match(res.stderr, /CCS_LANG=fr/);
      const ja = run(box, ["doctor", "--json"], { CCS_LANG: "fr", LANG: "ja_JP.UTF-8" });
      assert.equal(lines(ja.stderr).length, 1, `one line:\n${ja.stderr}`);
      assert.match(ja.stderr, /CCS_LANG=fr/);
      const esc = run(box, ["doctor", "--json"], { CCS_LANG: "\u001b[31mfr‮", LANG: "en_US.UTF-8" });
      assert.equal(lines(esc.stderr).length, 1, `one line:\n${esc.stderr}`);
      assert.doesNotMatch(esc.stderr, /[\u001b‮]/, JSON.stringify(esc.stderr));
      const known = run(box, ["doctor", "--json"], { CCS_LANG: "ja", LANG: "en_US.UTF-8" });
      assert.equal(known.stderr, "", "no warning for a known value");
    } finally {
      await cleanupAll();
    }
  });

  test("an unknown defaults.language: one warning line, read as auto, not an error", async () => {
    try {
      for (const [locale, cancelled] of [
        ["en_US.UTF-8", "Cancelled."],
        ["ja_JP.UTF-8", "やめました。"],
      ] as const) {
        const box = await makeBox();
        await writeFile(box.reposYml, withDefaults("language: fr"));
        // The list opens (stub fzf leaves as on Esc), in the locale's language.
        const res = run(box, [], { LANG: locale });
        assert.equal(res.code, 0, res.stderr);
        assert.ok(res.stdout.startsWith(cancelled), `${locale}: ${res.stdout}`);
        const warned = lines(res.stderr).filter((l) => l.includes("defaults.language"));
        assert.equal(warned.length, 1, `one warning line:\n${res.stderr}`);
        assert.match(warned[0], /fr/);
        assert.ok(await exists(box.fzfRows), "the list was shown");

        const doctor = parseAnswer(run(box, ["doctor", "--json"], { LANG: locale }), "doctor");
        assert.equal(doctor.status, "ok");
        const cfg = (doctor.checks as Answer[]).find((c) => c.name === "config");
        assert.equal(cfg?.status, "ok");
        assert.equal(cfg?.unknown_keys, 0, "not counted as an unknown key");
        const get = parseAnswer(run(box, ["config", "get", "--json"], { LANG: locale }), "config get");
        assert.equal((get.settings as Answer)["defaults.language"], "auto");
      }
    } finally {
      await cleanupAll();
    }
  });

  test("config set defaults.language: what it writes is what bin/ccs reads", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const env = { LANG: "en_US.UTF-8" };
      const lang = () => (parseAnswer(run(box, ["doctor", "--json"], env), "doctor").settings as Answer).language;
      const getLang = () => (parseAnswer(run(box, ["config", "get", "--json"], env), "config get").settings as Answer)["defaults.language"];
      assert.equal(getLang(), "auto", "not written = auto");
      assert.deepEqual(
        (parseAnswer(run(box, ["config", "get", "--json"], env), "config get").allowed as Answer)["defaults.language"],
        ["auto", "ja", "en"],
      );
      assert.equal(lang(), "en");
      for (const [value, want] of [
        ["ja", "ja"],
        ["en", "en"],
        ["auto", "en"],
        ["ja", "ja"],
      ] as const) {
        const set = run(box, ["config", "set", "defaults.language", value, "--json"], env);
        assert.equal(set.code, 0, set.stdout + set.stderr);
        assert.equal(getLang(), value);
        assert.equal(lang(), want, `after config set defaults.language ${value}`);
      }
      const before = await readFile(box.reposYml, "utf-8");
      const bad = run(box, ["config", "set", "defaults.language", "fr", "--json"], env);
      assert.equal(bad.code, 6);
      const a = parseAnswer(bad, "config set");
      assert.equal(a.status, "rejected");
      assert.equal((a.reasons as Answer[])[0].code, "invalid_value");
      assert.equal(await readFile(box.reposYml, "utf-8"), before, "nothing written");
    } finally {
      await cleanupAll();
    }
  });

  test("a module started on its own: CCS_LANG_RESOLVED, then CCS_LANG, then the locale, then English", () => {
    const table: [EnvPatch, Lang][] = [
      [{}, "en"],
      [{ CCS_LANG_RESOLVED: "ja", CCS_LANG: "en", LC_ALL: "en_US.UTF-8" }, "ja"],
      [{ CCS_LANG_RESOLVED: "en", CCS_LANG: "ja", LC_ALL: "ja_JP.UTF-8" }, "en"],
      [{ CCS_LANG_RESOLVED: "fr", CCS_LANG: "ja", LANG: "en_US.UTF-8" }, "ja"],
      [{ CCS_LANG: "ja", LANG: "en_US.UTF-8" }, "ja"],
      [{ CCS_LANG: "fr", LANG: "ja_JP.UTF-8" }, "ja"],
      [{ LC_ALL: "C", LANG: "ja_JP.UTF-8" }, "en"],
      [{ LC_ALL: "", LC_MESSAGES: "ja", LANG: "C" }, "ja"],
      [{ LANG: "POSIX" }, "en"],
    ];
    const got = inModule("ccs-i18n.ts", `console.log(JSON.stringify(JSON.parse(process.env.CASES).map((e) => m.currentLang(e))));`, {
      CASES: JSON.stringify(table.map(([e]) => e)),
    });
    assert.deepEqual(got, table.map(([, want]) => want));
  });
});

// ---------------------------------------------------------------------------
// 2. --lang= as an argument
// ---------------------------------------------------------------------------

describe("--lang= on the command line", () => {
  const COMMANDS: string[][] = [
    [],
    ["--new"],
    ["--help"],
    ["init"],
    ["doctor"],
    ["doctor", "--json"],
    ["list", "--json"],
    ["sessions", "--json"],
    ["config", "get", "--json"],
    ["config", "set", "defaults.language", "ja", "--json"],
    ["repo", "add", "proj/one", "--json"],
    ["repo", "remove", "one", "--json"],
    ["open", "--repo", "one", "--json"],
  ];

  test("an unknown value is exit 2 for every command, first or last; --json gets the outer JSON", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const before = await readFile(box.reposYml, "utf-8");
      const jobs: { args: string[]; bad: string }[] = [];
      for (const cmd of COMMANDS) {
        for (const bad of ["--lang=fr", "--lang="]) {
          jobs.push({ args: [bad, ...cmd], bad }, { args: [...cmd, bad], bad });
        }
      }
      const results = await pool(jobs, 8, (j) => runAsync(box, j.args, { LANG: "en_US.UTF-8" }));
      const wrong: string[] = [];
      jobs.forEach((j, i) => {
        const res = results[i];
        const label = j.args.join(" ") || "(no arguments)";
        if (res.code !== 2) wrong.push(`${label}: exit ${res.code}`);
        if (!res.stderr.includes(j.bad)) wrong.push(`${label}: stderr does not name ${j.bad}: ${res.stderr}`);
        if (j.args.includes("--json")) {
          try {
            const a = parseAnswer(res, label);
            if (a.status !== "usage") wrong.push(`${label}: status ${String(a.status)}`);
            const reasons = a.reasons as Answer[];
            if (reasons?.[0]?.code !== "unknown_option" || reasons?.[0]?.vocab !== "ccs.cli") {
              wrong.push(`${label}: reasons ${JSON.stringify(reasons)}`);
            }
            for (const k of ["schema_version", "product_id", "product_version", "command", "written_at"]) {
              if (!(k in a)) wrong.push(`${label}: no ${k}`);
            }
          } catch (e) {
            wrong.push(`${label}: ${(e as Error).message}`);
          }
        } else if (res.stdout !== "") {
          wrong.push(`${label}: stdout ${JSON.stringify(res.stdout)}`);
        }
      });
      assert.deepEqual(wrong, []);
      assert.equal(await readFile(box.reposYml, "utf-8"), before, "nothing written");
      assert.equal(await exists(box.claudeArgs), false, "nothing launched");
    } finally {
      await cleanupAll();
    }
  });

  test("the outer JSON of an unknown --lang= names the command as the other answers do", async () => {
    // machine-interface.md 1.3: `command` is the command's name up to its
    // second word (config get, repo add, …), as in every other answer.
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const cases: [string[], string][] = [
        [["doctor", "--json"], "doctor"],
        [["list", "--json"], "list"],
        [["sessions", "--json"], "sessions"],
        [["open", "--repo", "one", "--json"], "open"],
        [["config", "get", "--json"], "config get"],
        [["config", "set", "defaults.language", "ja", "--json"], "config set"],
        [["repo", "add", "proj/one", "--json"], "repo add"],
        [["repo", "remove", "one", "--json"], "repo remove"],
      ];
      const got: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const [args, command] of cases) {
        const a = parseAnswer(run(box, ["--lang=fr", ...args], {}), args.join(" "));
        got[args.join(" ")] = a.command;
        want[args.join(" ")] = command;
      }
      assert.deepEqual(got, want);
    } finally {
      await cleanupAll();
    }
  });

  test("before a bare --, --lang= is taken out; after it, the launched command gets it", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const pick = { FAKE_FZF_PICK: "new:one", LANG: "en_US.UTF-8" };

      const a = run(box, ["--lang=ja", "--x-flag"], pick);
      assert.equal(a.code, 0, a.stderr);
      assert.deepEqual(await nulList(box.claudeArgs), ["--x-flag"], "taken out when first");
      assert.match(a.stdout, /Claude Code を開きます/, "and it set the language");

      await rm(box.claudeArgs, { force: true });
      const b = run(box, ["--x-flag", "--lang=ja"], pick);
      assert.equal(b.code, 0, b.stderr);
      assert.deepEqual(await nulList(box.claudeArgs), ["--x-flag"], "taken out when last");
      assert.match(b.stdout, /Claude Code を開きます/);

      await rm(box.claudeArgs, { force: true });
      const c = run(box, ["--lang=ja", "--x-flag", "--", "--lang=en"], pick);
      assert.equal(c.code, 0, c.stderr);
      const got = await nulList(box.claudeArgs);
      assert.deepEqual(got.filter((x) => x.startsWith("--lang")), ["--lang=en"], JSON.stringify(got));
      assert.ok(got.includes("--x-flag"), JSON.stringify(got));
      assert.ok(got.indexOf("--lang=en") > got.indexOf("--"), JSON.stringify(got));
      assert.match(c.stdout, /Claude Code を開きます/, "the --lang=en after -- did not set ccs's language");

      await rm(box.claudeArgs, { force: true });
      const d = run(box, ["--", "--lang=fr"], pick);
      assert.equal(d.code, 0, `an unknown value after -- is not ccs's: ${d.stderr}`);
      assert.ok((await nulList(box.claudeArgs)).includes("--lang=fr"));
      assert.match(d.stdout, /Opening Claude Code/);
    } finally {
      await cleanupAll();
    }
  });

  test("a machine command never sees --lang=", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      for (const args of [
        ["list", "--json", "--lang=ja"],
        ["--lang=en", "list", "--json"],
        ["config", "get", "--lang=ja", "--json"],
      ]) {
        const res = run(box, args, {});
        assert.equal(res.code, 0, `${args.join(" ")}: ${res.stdout}${res.stderr}`);
        assert.equal(parseAnswer(res, args.join(" ")).status, "ok");
      }
    } finally {
      await cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The string tables
// ---------------------------------------------------------------------------

const KEY = /^[a-z][a-z0-9_]*$/;
const KEY_LINE = /^([a-z][a-z0-9_]*)(\+?)=(.*)$/;

interface Table {
  values: Map<string, string>;
  problems: string[];
}

/** The table format, read independently of ccs's own reader. */
function readTable(lang: Lang): Table {
  const file = join(BIN_DIR, `ccs-lang-${lang}.txt`);
  const text = readFileSync(file, "utf-8");
  const values = new Map<string, string>();
  const problems: string[] = [];
  let last: string | null = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const where = `ccs-lang-${lang}.txt:${i + 1}`;
    if (line.trim() === "") return;
    if (line.startsWith("#")) return;
    const m = KEY_LINE.exec(line);
    if (!m) {
      problems.push(`${where}: not key=text, key+=text or a # comment: ${JSON.stringify(line)}`);
      return;
    }
    const [, key, more, value] = m;
    if (more) {
      if (key !== last) problems.push(`${where}: ${key}+= does not follow ${key}= (follows ${last ?? "nothing"})`);
      else values.set(key, `${values.get(key) ?? ""}\\n${value}`);
      return;
    }
    if (values.has(key)) problems.push(`${where}: ${key} is defined twice`);
    values.set(key, value);
    last = key;
  });
  return { values, problems };
}

const insertions = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]))].sort();

interface Used {
  keys: Map<string, string>; // key → first place seen
  odd: string[]; // calls whose key could not be read
}

/** Keys the TS modules ask for: every call of the name they import `t` as. */
function keysInTs(): Used {
  const keys = new Map<string, string>();
  const odd: string[] = [];
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']\.\/ccs-i18n\.(?:ts|js)["']/g;
  for (const file of readdirSyncTs()) {
    const src = readFileSync(join(BIN_DIR, file), "utf-8");
    const names: string[] = [];
    for (const m of src.matchAll(importRe)) {
      for (const part of m[1].split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        const as = /^t\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
        if (p === "t") names.push("t");
        else if (as) names.push(as[1]);
      }
    }
    for (const name of names) {
      const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(\\s*`, "g");
      for (const m of src.matchAll(call)) {
        const rest = src.slice((m.index ?? 0) + m[0].length);
        const lit = /^(["'])([^"'\n]*)\1/.exec(rest);
        const line = src.slice(0, m.index).split("\n").length;
        if (lit && KEY.test(lit[2])) {
          if (!keys.has(lit[2])) keys.set(lit[2], `${file}:${line}`);
        } else {
          odd.push(`${file}:${line}: ${name}(${rest.slice(0, 30)}`);
        }
      }
    }
  }
  return { keys, odd };
}

function readdirSyncTs(): string[] {
  return readdirSync(BIN_DIR).filter((f) => /^ccs-.*\.ts$/.test(f) && f !== "ccs-i18n.ts");
}

/** Keys the bash scripts ask for: say KEY, say_err KEY, tx VAR KEY. */
function keysInBash(): Used {
  const keys = new Map<string, string>();
  const odd: string[] = [];
  // bin/ccs and the .sh scripts that load the tables.
  const files = readdirSync(BIN_DIR).filter((f) => (f === "ccs" || f.endsWith(".sh")) && f !== "ccs-i18n.sh");
  assert.ok(files.includes("ccs"), "bin/ccs is read");
  for (const file of files) {
    const src = readFileSync(join(BIN_DIR, file), "utf-8");
    if (!src.includes("ccs-i18n.sh")) continue;
    src.split("\n").forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      const where = `${file}:${i + 1}`;
      for (const m of line.matchAll(/(?:^|[\s;&|({])(say|say_err)\s+(\S+)/g)) {
        if (KEY.test(m[2])) {
          if (!keys.has(m[2])) keys.set(m[2], where);
        } else odd.push(`${where}: ${m[0].trim()}`);
      }
      for (const m of line.matchAll(/(?:^|[\s;&|({])tx\s+(\S+)\s+(\S+)/g)) {
        if (KEY.test(m[2])) {
          if (!keys.has(m[2])) keys.set(m[2], where);
        } else odd.push(`${where}: ${m[0].trim()}`);
      }
    });
  }
  return { keys, odd };
}

// The texts that go into fzf actions (change-header(...), a single-quoted echo,
// and, for the three Enter answers, a double-quoted echo inside bash -c '…').
const FZF_ACTION_KEYS = ["list_copied_cmd", "list_copied_id", "list_no_repo_delete", "list_on_group", "list_on_separator", "list_no_match"];
const IN_BASH_C = ["list_on_group", "list_on_separator", "list_no_match"];

describe("the string tables", () => {
  const en = readTable("en");
  const ja = readTable("ja");

  test("both follow the format: key=text, key+=text after its key, # comments, no key twice", () => {
    assert.deepEqual([...en.problems, ...ja.problems], []);
    assert.ok(en.values.size > 100, `the English table has its keys (${en.values.size})`);
    assert.ok(ja.values.size > 100, `the Japanese table has its keys (${ja.values.size})`);
  });

  test("the Japanese table has every English key, and none that English lacks", () => {
    const missing = [...en.values.keys()].filter((k) => !ja.values.has(k));
    const extra = [...ja.values.keys()].filter((k) => !en.values.has(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });

  test("each key has the same insertions in both languages", () => {
    const differ: Record<string, { en: string[]; ja: string[] }> = {};
    for (const [key, text] of en.values) {
      const other = ja.values.get(key);
      if (other === undefined) continue;
      const a = insertions(text);
      const b = insertions(other);
      if (a.join(",") !== b.join(",")) differ[key] = { en: a, ja: b };
    }
    assert.deepEqual(differ, {});
  });

  test("every key the TS modules use is in the English table", () => {
    const used = keysInTs();
    assert.deepEqual(used.odd, [], "calls whose key is not a plain string");
    // The reader found what it should: a fair number, and known ones from
    // several modules and both import forms (t, t as tr).
    assert.ok(used.keys.size >= 80, `keys found in TS: ${used.keys.size}`);
    for (const k of ["card_repo_title", "list_heading_groups", "cfg_language_unknown", "time_just_now", "time_month_names", "note_key_not_settable"]) {
      assert.ok(used.keys.has(k), `the reader sees ${k}`);
    }
    const missing = [...used.keys].filter(([k]) => !en.values.has(k)).map(([k, at]) => `${k} (${at})`);
    assert.deepEqual(missing, []);
  });

  test("every key the bash scripts use is in the English table", () => {
    const used = keysInBash();
    assert.deepEqual(used.odd, [], "calls whose key is not a plain word");
    assert.ok(used.keys.size >= 40, `keys found in bash: ${used.keys.size}`);
    for (const k of ["lang_env_unknown", "help", "list_copied_cmd", "list_label", "fzf_too_old", "delete_done", "delete_confirm"]) {
      assert.ok(used.keys.has(k), `the reader sees ${k}`);
    }
    const missing = [...used.keys].filter(([k]) => !en.values.has(k)).map(([k, at]) => `${k} (${at})`);
    assert.deepEqual(missing, []);
  });

  test("texts that go into fzf actions hold no ASCII ( ) or ' in either language", () => {
    const bad: string[] = [];
    for (const [lang, table] of [
      ["en", en],
      ["ja", ja],
    ] as const) {
      for (const key of FZF_ACTION_KEYS) {
        const text = table.values.get(key);
        if (text === undefined) {
          bad.push(`${lang} ${key}: missing`);
          continue;
        }
        if (/[()']/.test(text)) bad.push(`${lang} ${key}: ${text}`);
        // These three are also inside "…" in bash -c '…'.
        if (IN_BASH_C.includes(key) && /["`$\\]/.test(text)) bad.push(`${lang} ${key} (in bash -c): ${text}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

// ---------------------------------------------------------------------------
// 4. --json does not change with the language
// ---------------------------------------------------------------------------

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

/** The answer without what may differ: the time it was written, and doctor's settings.language. */
function comparable(a: Answer): Answer {
  const copy = JSON.parse(JSON.stringify(a)) as Answer;
  delete copy.written_at;
  if (copy.command === "doctor" && copy.settings && typeof copy.settings === "object") {
    delete (copy.settings as Answer).language;
  }
  return copy;
}

describe("--json answers are the same in Japanese and English", () => {
  test("list, sessions, config get, config set (error), doctor, repo add (error)", async () => {
    try {
      const box = await makeBox();
      await mkdir(join(box.home, "team", "web"), { recursive: true });
      await writeFile(
        box.reposYml,
        `version: 1\ndefaults:\n  update_check: false\nrepos:\n  - name: one\n    path: ~/proj/one\n    description: made-up project\n` +
          `  - name: team\n    path: ~/team\n    launch: false\n  - name: web\n    path: ~/team/web\n  - name: gone\n    path: ~/nowhere\n`,
      );
      await conversation(box, "00000001-1111-4222-8333-444444444444", join(box.home, "proj", "one"), 30, "made-up first words");
      await conversation(box, "00000002-1111-4222-8333-444444444444", join(box.home, "team", "web"), 90, "made-up other words");
      // Build the cache once, so every run below sees the same state.
      assert.equal(run(box, ["sessions", "--json"]).code, 0);

      const commands: string[][] = [
        ["list", "--json"],
        ["list", "--json", "--with-paths"],
        ["sessions", "--json"],
        ["sessions", "--json", "--with-titles"],
        ["config", "get", "--json"],
        ["config", "set", "defaults.language", "fr", "--json"],
        ["config", "set", "defaults.nosuch", "x", "--json"],
        ["doctor", "--json"],
        ["repo", "add", "/elsewhere/not-home", "--json"],
        ["repo", "add", "proj/missing", "--json"],
        ["repo", "add", "proj/one", "--json"],
      ];
      const yml = await readFile(box.reposYml, "utf-8");
      for (const args of commands) {
        const label = args.join(" ");
        const en = run(box, ["--lang=en", ...args]);
        const ja = run(box, ["--lang=ja", ...args]);
        const env = run(box, args, { CCS_LANG: "ja" });
        assert.equal(ja.code, en.code, `${label}: exit codes`);
        assert.equal(env.code, en.code, `${label}: exit codes (CCS_LANG)`);
        const a = parseAnswer(en, `${label} (en)`);
        const b = parseAnswer(ja, `${label} (ja)`);
        const c = parseAnswer(env, `${label} (CCS_LANG=ja)`);
        assert.deepEqual(comparable(b), comparable(a), label);
        assert.deepEqual(comparable(c), comparable(a), `${label} (CCS_LANG=ja)`);
        if (args[0] === "doctor") {
          // The one field that does differ, so the language really changed.
          assert.equal((a.settings as Answer).language, "en");
          assert.equal((b.settings as Answer).language, "ja");
          assert.equal((c.settings as Answer).language, "ja");
        }
      }
      assert.equal(await readFile(box.reposYml, "utf-8"), yml, "the errors wrote nothing");
    } finally {
      await cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Representative texts in both languages
// ---------------------------------------------------------------------------

interface Texts {
  heading: string[];
  label: string;
  inputLabel: string;
  updateNote: string;
  updateLabel: string;
  uiRemoved: string;
  fzfOld: string;
  helpFirst: string;
  card: string;
  times: string[];
}

const EXPECT: Record<Lang, Texts> = {
  en: {
    heading: ["Groups", "Projects"],
    label: "Pick",
    inputLabel: "Search",
    updateNote: "[ccs] ccs v9.9.9 is out (you have v",
    updateLabel: "ccs v9.9.9 is out",
    uiRemoved: "[ccs] --ui= was removed",
    fzfOld: "[ccs] ccs needs fzf 0.61 or newer (this fzf: 0.40.0). To upgrade fzf: brew upgrade fzf",
    helpFirst: `ccs v${VERSION} - Claude Code Station (fzf-powered launcher)`,
    card: "✨ Start Claude Code in one",
    times: ["just now", "5 min ago", "Oct 9", "Oct 9, 2025"],
  },
  ja: {
    heading: ["グループ", "プロジェクト"],
    label: "えらぶ",
    inputLabel: "さがす",
    updateNote: "[ccs] 新しい ccs v9.9.9 が出ています（いまは v",
    updateLabel: "ccs v9.9.9 が出ています",
    uiRemoved: "[ccs] --ui= はなくなりました",
    fzfOld: "[ccs] ccs には fzf 0.61 以上が要ります（いまの fzf: 0.40.0）。fzf を新しくするには: brew upgrade fzf",
    helpFirst: `ccs v${VERSION} - Claude Code Station（fzf で動くランチャー）`,
    card: "✨ one で、新しく Claude Code を始めます",
    times: ["たった今", "5 分前", "10月9日", "2025年10月9日"],
  },
};

const fzfOption = (args: string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

describe("representative texts in both languages", () => {
  for (const lang of ["en", "ja"] as const) {
    const want = EXPECT[lang];
    // The other language is set everywhere but CCS_LANG, which wins.
    const other = lang === "ja" ? "en_US.UTF-8" : "ja_JP.UTF-8";
    const env: EnvPatch = { CCS_LANG: lang, LANG: other };

    test(`${lang}: the list's headings, frame labels, the update notice and the card`, async () => {
      try {
        const box = await makeBox();
        await mkdir(join(box.home, "team", "web"), { recursive: true });
        await writeFile(
          box.reposYml,
          `version: 1\nrepos:\n  - name: one\n    path: ~/proj/one\n  - name: team\n    path: ~/team\n    launch: false\n  - name: web\n    path: ~/team/web\n`,
        );
        // A newer version in the update cache, checked just now: read at
        // start, no request made (stdout is not a terminal).
        await mkdir(join(box.home, ".cache", "ccs"), { recursive: true });
        await writeFile(
          join(box.home, ".cache", "ccs", "update-check"),
          `latest=9.9.9\nchecked=${Math.floor(Date.now() / 1000)}\n`,
        );
        const res = run(box, [], { ...env, CCS_NO_UPDATE_CHECK: undefined });
        assert.equal(res.code, 0, res.stderr);
        const rows = stripAnsi(await readFile(box.fzfRows, "utf-8"));
        for (const h of want.heading) assert.match(rows, new RegExp(`─ ${h} ─`), `heading ${h}`);
        const args = await nulList(box.fzfArgs);
        const listLabel = fzfOption(args, "list-label") ?? "";
        assert.ok(listLabel.trim().startsWith(want.label), `list label: ${listLabel}`);
        assert.ok(listLabel.includes(want.updateLabel), `list label: ${listLabel}`);
        assert.equal(fzfOption(args, "input-label")?.trim(), want.inputLabel);
        assert.ok(res.stderr.includes(want.updateNote), `update notice:\n${res.stderr}`);

        // The card, started as the fzf binding starts it.
        const card = spawnSync(BASH, [join(BIN_DIR, "ccs-tsx.sh"), join(BIN_DIR, "ccs-preview.ts"), "new:one", join(box.home, "proj", "one")], {
          encoding: "utf-8",
          env: envFor(box, { CCS_LANG_RESOLVED: lang, LANG: other, CCS_TSX_REAL: process.execPath }),
          cwd: box.root,
          timeout: 30_000,
        });
        assert.equal(card.status, 0, card.stderr);
        assert.ok(stripAnsi(card.stdout).includes(want.card), `card:\n${card.stdout}`);
      } finally {
        await cleanupAll();
      }
    });

    test(`${lang}: errors (--ui=, an old fzf) and the first line of --help`, async () => {
      try {
        const box = await makeBox();
        await writeFile(box.reposYml, ONE);
        const ui = run(box, ["--ui=simple"], env);
        assert.equal(ui.code, 2);
        assert.ok(ui.stderr.startsWith(want.uiRemoved), ui.stderr);
        const old = run(box, [], { ...env, FAKE_FZF_VERSION: "0.40.0" });
        assert.equal(old.code, 1);
        assert.equal(old.stderr.trim(), want.fzfOld);
        const help = run(box, ["--help"], env);
        assert.equal(help.code, 0);
        assert.equal(help.stdout.split("\n")[0], want.helpFirst);
        // Flag and variable say the same.
        const flag = run(box, [`--lang=${lang}`, "--help"], { CCS_LANG: lang === "ja" ? "en" : "ja", LANG: other });
        assert.equal(flag.stdout.split("\n")[0], want.helpFirst);
      } finally {
        await cleanupAll();
      }
    });

    test(`${lang}: relative times and dates`, () => {
      const got = inModule(
        "ccs-utils.ts",
        `const now = new Date(2026, 11, 20, 12).getTime();
         const at = (d) => new Date(d).toISOString();
         console.log(JSON.stringify([
           m.formatFriendlyTime(at(now - 10_000), { nowMs: now }),
           m.formatFriendlyTime(at(now - 5 * 60_000), { nowMs: now }),
           m.formatFriendlyTime(at(new Date(2026, 9, 9, 12)), { nowMs: now }),
           m.formatFriendlyTime(at(new Date(2025, 9, 9, 12)), { nowMs: now }),
         ]));`,
        { CCS_LANG_RESOLVED: lang, LANG: other },
      );
      assert.deepEqual(got, want.times);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. tx in bash 3.2
// ---------------------------------------------------------------------------

function bashVersion(bash: string): string {
  const res = spawnSync(bash, ["-c", 'printf "%s" "$BASH_VERSION"'], { encoding: "utf-8" });
  return res.status === 0 ? res.stdout : "";
}

describe("tx puts a value in as it is", () => {
  const version = bashVersion(BASH);
  const skip = version.startsWith("3.2") ? false : `/bin/bash is ${version || "missing"}, not 3.2 (macOS)`;

  test("&, a literal \\n, $(…), `…` and {name} in a value stay as written (bash 3.2)", { skip }, async () => {
    const root = await mkdtemp(join(tmpdir(), "ccs-i18n-tx-"));
    try {
      const marker = join(root, "ran");
      const script = `
set -euo pipefail
SCRIPT_DIR=$1
source "$SCRIPT_DIR/ccs-i18n.sh"
CCS_T_zz_two='<{a}|{b}>\\n.'
out=""
tx out zz_two "a=$2" "b=B&B"
printf '%s\\0' "$out"
tx out zz_two "a=A" "b=$2"
printf '%s\\0' "$out"
tx out zz_two "a={b}" "b=Y"
printf '%s\\0' "$out"
tx out zz_two "b={a}" "a=X"
printf '%s\\0' "$out"
tx out zz_two "a=x=y" "b="
printf '%s\\0' "$out"
`;
      const value = `1&2 \\n $(touch ${marker}) \`touch ${marker}\` {b} \${HOME} ~`;
      const res = spawnSync(BASH, ["-c", script, "tx-test", BIN_DIR, value], {
        encoding: "utf-8",
        env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "en_US.UTF-8" },
        cwd: root,
      });
      assert.equal(res.status, 0, res.stderr);
      const got = res.stdout.split("\0").slice(0, -1);
      assert.deepEqual(got, [
        `<${value}|B&B>\n.`,
        `<A|${value}>\n.`,
        "<{b}|Y>\n.",
        "<X|{a}>\n.",
        "<x=y|>\n.",
      ]);
      assert.equal(await exists(marker), false, "nothing in a value ran");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the same values through the TS fill", () => {
    const value = "1&2 \\n $(touch x) `touch x` {b} ${HOME} ~ $&";
    const got = inModule(
      "ccs-i18n.ts",
      `const v = process.env.VALUE;
       const text = "<{a}|{b}>\\\\n.";
       console.log(JSON.stringify([
         m.fill(text, { a: v, b: "B&B" }),
         m.fill(text, { a: "A", b: v }),
         m.fill(text, { a: "{b}", b: "Y" }),
         m.fill(text, { b: "{a}", a: "X" }),
       ]));`,
      { VALUE: value },
    );
    assert.deepEqual(got, [`<${value}|B&B>\n.`, `<A|${value}>\n.`, "<{b}|Y>\n.", "<X|{a}>\n."]);
  });
});

// ---------------------------------------------------------------------------
// 7. A missing string table
// ---------------------------------------------------------------------------

const BROKEN_INSTALL_EN = (pkg: string): string =>
  `[ccs] ccs is not installed completely: bin/ccs-lang-en.txt is missing. Install ccs again (npm install -g ${pkg}).`;
const MISSING_KEY_TEXT = "[ccs] ccs is not installed completely (a string table is missing); install it again";
const PACKAGE_NAME = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf-8")).name as string;

/** A copy of bin/ (and package.json, node_modules beside it) with the named tables taken out. */
async function binWithout(box: Box, tables: string[]): Promise<string> {
  const pkg = join(box.root, "pkg");
  await cp(BIN_DIR, join(pkg, "bin"), { recursive: true });
  await cp(join(BIN_DIR, "..", "package.json"), join(pkg, "package.json"));
  await symlink(join(BIN_DIR, "..", "node_modules"), join(pkg, "node_modules"));
  for (const name of tables) await rm(join(pkg, "bin", name));
  return join(pkg, "bin", "ccs");
}

function runBin(bin: string, box: Box, args: string[], patch: EnvPatch = {}): Result {
  const res = spawnSync(BASH, [bin, ...args], {
    encoding: "utf-8",
    env: envFor(box, patch),
    cwd: box.root,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("a missing string table", () => {
  test("the Japanese table missing: Japanese asked for, English is read, with no warning", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const bin = await binWithout(box, ["ccs-lang-ja.txt"]);
      const help = runBin(bin, box, ["--help"], { CCS_LANG: "ja" });
      assert.equal(help.code, 0, help.stderr);
      assert.equal(help.stdout.split("\n")[0], EXPECT.en.helpFirst);
      assert.equal(help.stderr, "");
      const pick = runBin(bin, box, [], { CCS_LANG: "ja" });
      assert.equal(pick.code, 0, pick.stderr);
      const args = await nulList(box.fzfArgs);
      const label = (fzfOption(args, "list-label") ?? "").trim();
      assert.ok(label.startsWith(EXPECT.en.label), `the picker reads in English: ${JSON.stringify(label)}`);
      assert.ok(!pick.stderr.includes("ccs-lang"), `no warning about the table: ${pick.stderr}`);
      assert.ok(!pick.stderr.includes("not installed completely"), pick.stderr);
    } finally {
      await cleanupAll();
    }
  });

  test("the English table missing: one fixed line and exit 1 for a person; --version and the machine commands go on", async () => {
    try {
      const box = await makeBox();
      await writeFile(box.reposYml, ONE);
      const bin = await binWithout(box, ["ccs-lang-en.txt"]);
      for (const lang of ["en", "ja"]) {
        for (const args of [[], ["--new"], ["--help"], ["init"]]) {
          const what = `CCS_LANG=${lang} ccs ${args.join(" ")}`;
          const res = runBin(bin, box, args, { CCS_LANG: lang });
          assert.equal(res.code, 1, `${what}: ${res.stdout}${res.stderr}`);
          assert.equal(res.stderr, BROKEN_INSTALL_EN(PACKAGE_NAME) + "\n", what);
          assert.equal(res.stdout, "", what);
          assert.equal(await exists(box.fzfArgs), false, `${what}: fzf is not started`);
          assert.equal(await exists(box.claudeArgs), false, `${what}: claude is not started`);
        }
      }
      const version = runBin(bin, box, ["--version"]);
      assert.equal(version.code, 0, version.stderr);
      assert.ok(version.stdout.includes(VERSION), version.stdout);
      for (const args of [["doctor", "--json"], ["list", "--json"], ["config", "get", "--json"]]) {
        const res = runBin(bin, box, args);
        assert.ok([0, 1].includes(res.code), `ccs ${args.join(" ")}: ${res.stderr}`);
        const a = JSON.parse(res.stdout) as { command: string };
        assert.equal(a.command, args.slice(0, args[0] === "config" ? 2 : 1).join(" "));
        assert.ok(!res.stderr.includes("ccs-lang-en.txt is missing"), `ccs ${args.join(" ")} goes on: ${res.stderr}`);
      }
    } finally {
      await cleanupAll();
    }
  });

  test("a key no table has: the fixed line, never the key, in TS and in bash alike", () => {
    const ts = inModule(
      "ccs-i18n.ts",
      `console.log(JSON.stringify([m.t("zz_no_such_key", {}, "en"), m.t("zz_no_such_key", {}, "ja"), m.MISSING_TABLE_TEXT]));`,
      {},
    );
    assert.deepEqual(ts, [MISSING_KEY_TEXT, MISSING_KEY_TEXT, MISSING_KEY_TEXT]);
    const res = spawnSync(
      BASH,
      ["-c", 'SCRIPT_DIR=$1; source "$SCRIPT_DIR/ccs-i18n.sh"; ccs_lang_use ja; tx out zz_no_such_key "x=1"; printf "%s" "$out"', "tx-missing", BIN_DIR],
      { encoding: "utf-8", env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, MISSING_KEY_TEXT);
    assert.ok(!res.stdout.includes("zz_no_such_key"));
  });
});
