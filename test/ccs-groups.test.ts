/**
 * `defaults.groups_dir`: groups of projects described in definition files that
 * other tools keep (docs/design/machine-interface.md, chapter 5).
 *
 * What these tests hold:
 *  - off unless set: with the setting absent nothing changes, whatever the
 *    folder holds;
 *  - ccs reads five keys and nothing else: `version`, `id`, `label`, `kind`
 *    and `members[].path`;
 *  - a `logical` group becomes a heading that launches nothing, with its
 *    members under it in the file's order; a `physical` one is left to the
 *    nesting by path; a version other than 1 is skipped;
 *  - a member is matched by path (`~` expanded), and shown with the name, label
 *    and icon repos.yml gives it;
 *  - ccs never writes the definition files, and a broken one never stops the
 *    picker;
 *  - `ccs list --json` gives the groups, `ccs doctor` says whether the folder
 *    could be read, and doctor still names nothing.
 *
 * The definition files are made up, in a temp HOME; fzf and claude are stubs.
 *
 * CCS_TEST_BIN: run the same cases against another build's bin/ccs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CCS_BIN = process.env.CCS_TEST_BIN ?? fileURLToPath(new URL("../bin/ccs", import.meta.url));

// The stub keeps the rows it was given; it picks the row named by
// FAKE_FZF_PICK (the n-th such row with FAKE_FZF_NTH), or leaves as on Esc.
const FAKE_FZF = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "0.65.0 (fake)"; exit 0; fi
rows=$(cat)
printf '%s\\n' "$rows" > "$FAKE_FZF_ROWS"
seen=0
while IFS= read -r row; do
  if [[ -n "\${FAKE_FZF_PICK:-}" && "$(printf '%s' "$row" | cut -f4)" == "$FAKE_FZF_PICK" ]]; then
    seen=$((seen + 1))
    if (( seen == \${FAKE_FZF_NTH:-1} )); then printf '%s\\n' "$row"; exit 0; fi
  fi
done <<< "$rows"
exit 130
`;
const FAKE_CLAUDE = `#!/usr/bin/env bash
{ printf '%s' "$PWD"; for a in "$@"; do printf '|%s' "$a"; done; printf '\\n'; } >> "$FAKE_CLAUDE_LOG"
`;

interface Box {
  root: string;
  home: string;
  reposYml: string;
  defs: string;
  stubBin: string;
  tmp: string;
  fzfRows: string;
  claudeLog: string;
  cleanup: () => Promise<void>;
}

// Two projects in unrelated folders, a header with a child, and one more.
const REPOS = `  - name: web
    path: ~/work/web
    label: Web front
    icon: "W"
  - name: api
    path: ~/work/api
  - name: tools
    path: ~/lab/tools
  - name: studio
    path: ~/studio
    launch: false
  - name: hq
    path: ~/studio/hq
`;
const FOLDERS = ["work/web", "work/api", "lab/tools", "studio/hq"];
const withGroups = (dir = "~/defs"): string => `version: 1\ndefaults:\n  groups_dir: ${dir}\nrepos:\n${REPOS}`;
const WITHOUT = `version: 1\nrepos:\n${REPOS}`;

async function makeBox(reposYml: string): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "ccs-groups-"));
  const home = join(root, "home");
  const stubBin = join(root, "stub-bin");
  const tmp = join(root, "tmp");
  for (const d of [stubBin, tmp, join(home, ".config", "ccs"), join(home, "defs"), ...FOLDERS.map((f) => join(home, f))]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(stubBin, "fzf"), FAKE_FZF, { mode: 0o755 });
  await writeFile(join(stubBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  await writeFile(join(home, ".config", "ccs", "repos.yml"), reposYml);
  return {
    root,
    home,
    reposYml: join(home, ".config", "ccs", "repos.yml"),
    defs: join(home, "defs"),
    stubBin,
    tmp,
    fzfRows: join(root, "fzf-rows.txt"),
    claudeLog: join(root, "claude.log"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One definition file. Anything beyond the five keys is there to be ignored. */
async function define(box: Box, file: string, body: unknown): Promise<void> {
  await writeFile(join(box.defs, file), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
}

const REVIEW = {
  version: 1,
  id: "design-review",
  label: "Design review",
  kind: "logical",
  members: [{ path: "~/lab/tools" }, { path: "~/work/web" }],
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(box: Box, args: string[], extra: Record<string, string> = {}): Result {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${box.stubBin}:${process.env.PATH ?? ""}`,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    TMPDIR: box.tmp,
    COLUMNS: "120",
    CCS_NO_UPDATE_CHECK: "1",
    FAKE_FZF_ROWS: box.fzfRows,
    FAKE_CLAUDE_LOG: box.claudeLog,
    ...extra,
  };
  for (const k of ["CCS_CMD", "CCR_CMD", "CCS_UI"]) delete env[k];
  const res = spawnSync("bash", [CCS_BIN, ...args], { encoding: "utf-8", env, cwd: box.root, stdio: ["ignore", "pipe", "pipe"] });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface Row {
  /** KIND:KEY, the column the launcher acts on. */
  key: string;
  /** What the user reads, without colour codes. */
  text: string;
}

/** Opens the picker (the stub leaves at once) and gives the rows it was offered. */
async function rows(box: Box, look: "classic" | "simple", extra: string[] = []): Promise<Row[]> {
  await rm(box.fzfRows, { force: true });
  const res = run(box, [`--ui=${look}`, ...extra]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  return (await readFile(box.fzfRows, "utf-8"))
    .split("\n")
    .filter((r) => r !== "")
    .map((r) => {
      const cols = r.split("\t");
      // eslint-disable-next-line no-control-regex
      return { key: cols[3] ?? "", text: (cols[0] ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim() };
    });
}

const keys = (r: Row[]): string[] => r.map((x) => x.key);

/** The rows from a group heading down to the next row that is not one of its members. */
function under(r: Row[], heading: string): Row[] {
  const start = r.findIndex((x) => x.key === heading);
  assert.notEqual(start, -1, `${heading} is in the list: ${keys(r).join(", ")}`);
  const out: Row[] = [];
  for (const row of r.slice(start + 1)) {
    if (!row.key.startsWith("new:")) break;
    out.push(row);
  }
  return out;
}

interface Group {
  id: string;
  label: string;
  kind: string;
  members: string[];
  unregistered_members: number;
}
interface Check {
  name: string;
  status: string;
  code: string;
  [key: string]: unknown;
}

function listJson(box: Box): { code: number; groups: Group[]; parents: Record<string, string | null>; res: Result } {
  const res = run(box, ["list", "--json"]);
  const a = JSON.parse(res.stdout) as { groups?: Group[]; repos?: { name: string; parent: string | null }[] };
  return {
    code: res.code,
    groups: a.groups ?? [],
    parents: Object.fromEntries((a.repos ?? []).map((r) => [r.name, r.parent])),
    res,
  };
}

function groupsCheck(box: Box): { code: number; status: string; check: Check; res: Result } {
  const res = run(box, ["doctor", "--json"]);
  const a = JSON.parse(res.stdout) as { status: string; checks: Check[] };
  const check = a.checks.find((c) => c.name === "groups_dir");
  assert.ok(check, "doctor has a groups_dir check");
  return { code: res.code, status: a.status, check, res };
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    const s = await stat(join(dir, name));
    out[name] = `${s.size}:${s.mtimeMs}:${createHash("sha256").update(await readFile(join(dir, name))).digest("hex")}`;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("defaults.groups_dir: off unless set", () => {
  test("without the setting, definition files change nothing", async () => {
    const plain = await makeBox(WITHOUT);
    const box = await makeBox(WITHOUT);
    try {
      await define(box, "review.json", REVIEW);
      for (const look of ["classic", "simple"] as const) {
        const got = await rows(box, look);
        assert.deepEqual(got, await rows(plain, look), `${look}: the same rows as with no definition files`);
        assert.ok(!keys(got).some((k) => k.startsWith("group:@")), look);
      }
      assert.deepEqual(listJson(box).groups, []);
      const d = groupsCheck(box);
      assert.deepEqual([d.code, d.check.status, d.check.code], [0, "skipped", "not_set"]);
    } finally {
      await plain.cleanup();
      await box.cleanup();
    }
  });

  test("the setting is a path under HOME that only the user writes into repos.yml", async () => {
    const box = await makeBox(withGroups("/etc"));
    try {
      const outside = run(box, ["list", "--json"]);
      assert.equal(outside.code, 4, outside.stdout);
      const reason = (JSON.parse(outside.stdout) as { reasons: { code: string; detail?: string }[] }).reasons[0];
      assert.equal(reason.code, "config_invalid");
      await writeFile(box.reposYml, withGroups());
      const set = run(box, ["config", "set", "defaults.groups_dir", "~/elsewhere", "--json"]);
      assert.equal(set.code, 6, set.stdout);
      assert.equal((JSON.parse(set.stdout) as { reasons: { code: string }[] }).reasons[0].code, "key_not_settable");
      assert.equal(await readFile(box.reposYml, "utf-8"), withGroups());
      // Reading the settings shows that it is set, and where only when asked.
      const get = JSON.parse(run(box, ["config", "get", "--json"]).stdout) as { settings: Record<string, unknown> };
      assert.deepEqual(get.settings["defaults.groups_dir"], { set: true });
      const paths = JSON.parse(run(box, ["config", "get", "--json", "--with-paths"]).stdout) as { settings: Record<string, unknown> };
      assert.deepEqual(paths.settings["defaults.groups_dir"], { set: true, path: box.defs });
    } finally {
      await box.cleanup();
    }
  });
});

describe("defaults.groups_dir: a logical group in the picker", () => {
  for (const look of ["classic", "simple"] as const) {
    test(`${look}: a heading that launches nothing, its members under it in the file's order`, async () => {
      const box = await makeBox(withGroups());
      try {
        await define(box, "review.json", REVIEW);
        const got = await rows(box, look);
        const heading = got.find((r) => r.key === "group:@design-review");
        assert.ok(heading?.text.includes("Design review"), `the heading shows the file's label: ${heading?.text}`);
        const members = under(got, "group:@design-review");
        // members[] order (tools, web), not the order of repos.yml (web, …, tools).
        assert.deepEqual(keys(members), ["new:tools", "new:web"]);
        // Shown as repos.yml names them.
        assert.ok(members[1].text.includes("Web front") && members[1].text.includes("W"), members[1].text);
        // Each project is still in its own place too, and the header by path is as before.
        const outside = keys(got.filter((r) => !members.includes(r)));
        for (const k of ["new:web", "new:api", "new:tools", "new:hq", "group:studio"]) assert.ok(outside.includes(k), `${k} keeps its own row`);
      } finally {
        await box.cleanup();
      }
    });
  }

  test("picking the heading starts nothing; picking a member under it starts that project", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", REVIEW);
      const heading = run(box, ["--ui=classic"], { FAKE_FZF_PICK: "group:@design-review" });
      assert.equal(heading.code, 0, heading.stderr);
      assert.equal(await exists(box.claudeLog), false, "a heading launches nothing");
      // The second new:tools row is the one under the heading.
      const member = run(box, ["--ui=classic"], { FAKE_FZF_PICK: "new:tools", FAKE_FZF_NTH: "2" });
      assert.equal(member.code, 0, member.stderr);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "lab", "tools")}\n`);
    } finally {
      await box.cleanup();
    }
  });
});

describe("defaults.groups_dir: what is read from a definition file", () => {
  test("five keys only: whatever else a file says about a project is ignored", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", {
        ...REVIEW,
        command: "zz-evil --from-file",
        icon: "X",
        members: [
          { path: "~/lab/tools", name: "zz-renamed", label: "zz-relabelled", icon: "X", command: "zz-evil", cwd: "/etc" },
          { path: "~/work/web", role: "lead", disabled: true },
        ],
        notes: { anything: ["at", "all"] },
      });
      const got = await rows(box, "classic");
      const members = under(got, "group:@design-review");
      assert.deepEqual(keys(members), ["new:tools", "new:web"]);
      const shown = got.map((r) => r.text).join("\n");
      for (const ignored of ["zz-renamed", "zz-relabelled", "zz-evil"]) assert.ok(!shown.includes(ignored), ignored);
      const res = run(box, ["--ui=classic"], { FAKE_FZF_PICK: "new:tools", FAKE_FZF_NTH: "2" });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(await readFile(box.claudeLog, "utf-8"), `${join(box.home, "lab", "tools")}\n`, "the command and folder are repos.yml's");
      assert.deepEqual(listJson(box).groups, [
        { id: "design-review", label: "Design review", kind: "logical", members: ["tools", "web"], unregistered_members: 0 },
      ]);
    } finally {
      await box.cleanup();
    }
  });

  test("members are matched by path: ~ and the full path are the same folder; the rest are only counted", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", {
        ...REVIEW,
        members: [{ path: join(box.home, "work", "api") }, { path: "~/lab/tools" }, { path: "~/not/registered" }, { path: "~/work" }],
      });
      assert.deepEqual(listJson(box).groups, [
        { id: "design-review", label: "Design review", kind: "logical", members: ["api", "tools"], unregistered_members: 2 },
      ]);
      assert.deepEqual(keys(under(await rows(box, "classic"), "group:@design-review")), ["new:api", "new:tools"]);
    } finally {
      await box.cleanup();
    }
  });

  test("a physical group is left to the nesting by path; a version other than 1 is skipped", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "a-physical.json", { version: 1, id: "studio-team", label: "Studio team", kind: "physical", members: [{ path: "~/studio/hq" }] });
      await define(box, "b-version-2.json", { ...REVIEW, version: 2, id: "from-the-future" });
      await define(box, "c-version-text.json", { ...REVIEW, version: "1", id: "quoted-version" });
      await define(box, "d-review.json", REVIEW);
      const list = listJson(box);
      assert.deepEqual(list.groups.map((g) => g.id), ["design-review"]);
      assert.equal(list.parents.hq, "studio", "hq still nests under its header by path");
      const got = keys(await rows(box, "classic"));
      assert.deepEqual(got.filter((k) => k.startsWith("group:")).sort(), ["group:@design-review", "group:studio"]);
    } finally {
      await box.cleanup();
    }
  });

  test("the id and label: a missing label is the id, a repeated id is the first file's, an unusable one is skipped", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "a.json", { version: 1, id: "no-label", kind: "logical", members: [{ path: "~/work/api" }] });
      await define(box, "b.json", { ...REVIEW, label: "First" });
      await define(box, "c.json", { ...REVIEW, label: "Second" });
      await define(box, "d.json", { ...REVIEW, id: "bad;id" });
      await define(box, "e.json", { ...REVIEW, id: "" });
      await define(box, "f.json", { ...REVIEW, id: "ctl", label: "Clean\u001b[31m me‮" });
      const groups = listJson(box).groups;
      assert.deepEqual(
        groups.map((g) => [g.id, g.label]),
        [["no-label", "no-label"], ["design-review", "First"], ["ctl", groups[2]?.label]],
      );
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(groups[2].label, /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
      assert.ok(groups[2].label.startsWith("Clean"), groups[2].label);
    } finally {
      await box.cleanup();
    }
  });
});

describe("defaults.groups_dir: files ccs cannot use", () => {
  test("a broken file never stops the picker, and doctor counts what was skipped", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "a-broken.json", "{ not json");
      await define(box, "b-array.json", "[1, 2, 3]\n");
      await define(box, "c-no-members.json", { version: 1, id: "empty", kind: "logical" });
      await define(box, "d-review.json", REVIEW);
      await writeFile(join(box.defs, "notes.txt"), "not a definition\n");
      await mkdir(join(box.defs, "nested"));
      await writeFile(join(box.defs, "nested", "deep.json"), JSON.stringify({ ...REVIEW, id: "nested" }));
      for (const look of ["classic", "simple"] as const) {
        const got = keys(await rows(box, look));
        assert.ok(got.includes("group:@design-review") && got.includes("new:api"), `${look}: the list opens with the usable group`);
        assert.ok(!got.includes("group:@nested"), "only the folder itself is read");
      }
      const d = groupsCheck(box);
      assert.deepEqual([d.code, d.status], [0, "ok"], "a warning leaves doctor ok");
      assert.deepEqual([d.check.status, d.check.code], ["warn", "group_files_skipped"]);
      assert.ok(Number(d.check.files_skipped) >= 2, JSON.stringify(d.check));
      assert.equal(d.check.groups, 1);
    } finally {
      await box.cleanup();
    }
  });

  test("the folder is missing: the picker opens without groups and doctor says groups_dir_missing", async () => {
    const box = await makeBox(withGroups("~/no-such-folder"));
    try {
      const got = keys(await rows(box, "classic"));
      assert.ok(got.includes("new:web") && !got.some((k) => k.startsWith("group:@")));
      assert.deepEqual(listJson(box).groups, []);
      const d = groupsCheck(box);
      assert.deepEqual([d.code, d.status, d.check.status, d.check.code], [0, "ok", "warn", "groups_dir_missing"]);
      assert.equal(await exists(join(box.home, "no-such-folder")), false, "ccs does not create it");
    } finally {
      await box.cleanup();
    }
  });

  test("usable files only: doctor's check is ok and counts the groups", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", REVIEW);
      await define(box, "second.json", { ...REVIEW, id: "second", label: "Second group" });
      const d = groupsCheck(box);
      assert.deepEqual([d.code, d.check.status, d.check.code, d.check.groups], [0, "ok", "ok", 2]);
    } finally {
      await box.cleanup();
    }
  });
});

describe("defaults.groups_dir: what ccs leaves alone and keeps to itself", () => {
  test("the definition files are never written", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", REVIEW);
      await define(box, "broken.json", "{ not json");
      const before = await snapshot(box.defs);
      for (const args of [["--ui=classic"], ["--ui=simple"], ["--refresh", "--ui=classic"], ["list", "--json"], ["doctor", "--json"], ["doctor"], ["sessions", "--json"], ["config", "get", "--json"]]) {
        run(box, args);
        assert.deepEqual(await snapshot(box.defs), before, `ccs ${args.join(" ")}`);
      }
    } finally {
      await box.cleanup();
    }
  });

  test("doctor names no group, member or folder; list --json gives ids, labels and names but no path", async () => {
    const box = await makeBox(withGroups());
    try {
      await define(box, "review.json", { ...REVIEW, id: "zz-group-id", label: "zz-group-label" });
      for (const args of [["doctor", "--json"], ["doctor"]]) {
        const res = run(box, args);
        const said = res.stdout + res.stderr;
        for (const secret of ["zz-group-id", "zz-group-label", box.home, "tools", "Web front"]) {
          assert.ok(!said.includes(secret), `ccs ${args.join(" ")} shows ${secret}`);
        }
      }
      const list = listJson(box);
      assert.deepEqual(list.groups.map((g) => [g.id, g.label, g.members]), [["zz-group-id", "zz-group-label", ["tools", "web"]]]);
      assert.ok(!(list.res.stdout + list.res.stderr).includes(box.home), "no path in list --json");
    } finally {
      await box.cleanup();
    }
  });
});
