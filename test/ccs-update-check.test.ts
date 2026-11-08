/**
 * Tests for bin/ccs-update-check.ts: what it asks, what it remembers, and that
 * nothing it is told can reach a terminal or a shell.
 *
 * The requests go to a fake registry on 127.0.0.1; these tests never leave the
 * machine. How bin/ccs uses the cache is in ccs-shell.test.ts (stub fzf) and
 * ccs-tty.test.ts (a real pty).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isPlainRelease,
  registryBase,
  distTagsUrl,
  latestFromDistTags,
  renderCache,
  cachedLatest,
} from "../bin/ccs-update-check.ts";
import { DEAD_REGISTRY, startRegistry } from "./tty/fake_registry.ts";

const SCRIPT = fileURLToPath(new URL("../bin/ccs-update-check.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE = "@indigo-gr/claude-code-station";
const DAY = 86_400;
const HOUR = 3_600;

describe("helpers", () => {
  test("isPlainRelease accepts X.Y.Z only", () => {
    for (const ok of ["0.0.0", "1.2.3", "10.20.30", "999999999.0.0"]) assert.equal(isPlainRelease(ok), true, ok);
    for (const bad of [
      "", "1.2", "1.2.3.4", "1.2.3-beta.1", "v1.2.3", " 1.2.3", "1.2.3\n", "1000000000.0.0",
      "1.2.3;x", "$(x)", "\u001b[31m1.2.3", 123, null, undefined, {},
    ]) {
      assert.equal(isPlainRelease(bad), false, JSON.stringify(bad));
    }
  });

  test("registryBase takes http(s) only and drops trailing slashes", () => {
    assert.equal(registryBase(undefined), "https://registry.npmjs.org");
    assert.equal(registryBase(""), "https://registry.npmjs.org");
    assert.equal(registryBase("ftp://example.invalid"), "https://registry.npmjs.org");
    assert.equal(registryBase("example.invalid"), "https://registry.npmjs.org");
    assert.equal(registryBase("http://a b"), "https://registry.npmjs.org");
    assert.equal(registryBase("https://example.invalid/npm//"), "https://example.invalid/npm");
    assert.equal(registryBase("http://127.0.0.1:9"), "http://127.0.0.1:9");
  });

  test("distTagsUrl encodes the scoped name as one path segment", () => {
    assert.equal(
      distTagsUrl("https://example.invalid", PACKAGE),
      "https://example.invalid/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags",
    );
  });

  test("latestFromDistTags: plain release, '' for a prerelease, throws on anything unusable", () => {
    assert.equal(latestFromDistTags({ latest: "1.2.3", beta: "2.0.0-beta.1" }), "1.2.3");
    assert.equal(latestFromDistTags({ latest: "2.0.0-beta.1" }), "");
    assert.equal(latestFromDistTags({ latest: "\u001b[31m1.2.3" }), "");
    for (const bad of [null, "1.2.3", 1, {}, { latest: 1 }, { beta: "1.0.0" }]) {
      assert.throws(() => latestFromDistTags(bad), JSON.stringify(bad));
    }
  });

  test("the cache text round-trips and hostile lines come back empty", () => {
    assert.equal(renderCache("1.2.3", 100), "latest=1.2.3\nchecked=100\n");
    assert.equal(cachedLatest(renderCache("1.2.3", 100)), "1.2.3");
    assert.equal(cachedLatest(""), "");
    assert.equal(cachedLatest("checked=1\n"), "");
    assert.equal(cachedLatest("latest=$(touch x)\n"), "");
  });
});

interface Run {
  home: string;
  cacheFile: string;
  cleanup: () => Promise<void>;
}

async function makeRun(): Promise<Run> {
  const home = await mkdtemp(join(tmpdir(), "ccs-update-"));
  return {
    home,
    cacheFile: join(home, ".cache", "ccs", "update-check"),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

function runScript(run: Run, registry: string, args: string[] = [PACKAGE]) {
  const started = Date.now();
  const r = spawnSync(TSX, [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      HOME: run.home,
      XDG_CONFIG_HOME: join(run.home, ".config"),
      XDG_CACHE_HOME: join(run.home, ".cache"),
      CCS_UPDATE_REGISTRY: registry,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

async function readCache(run: Run): Promise<{ latest: string; checked: number; text: string }> {
  const text = await readFile(run.cacheFile, "utf-8");
  const m = /^latest=(.*)\nchecked=(\d+)\n$/.exec(text);
  assert.ok(m, `cache shape: ${JSON.stringify(text)}`);
  return { latest: m[1], checked: Number(m[2]), text };
}

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= 30, `${what}: ${actual} vs ${expected}`);
const nowS = () => Math.floor(Date.now() / 1000);

describe("bin/ccs-update-check.ts against a fake registry", () => {
  test("a good answer: one bare GET, cache written privately, nothing printed", async () => {
    const run = await makeRun();
    const reg = await startRegistry(`body:${JSON.stringify({ latest: "9.9.9", beta: "10.0.0-b.1" })}`, join(run.home, "log"));
    try {
      const res = runScript(run, reg.url);
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
      const cache = await readCache(run);
      assert.equal(cache.latest, "9.9.9");
      near(cache.checked, nowS(), "checked");
      assert.equal((await stat(run.cacheFile)).mode & 0o777, 0o600);
      assert.equal((await stat(join(run.home, ".cache", "ccs"))).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(join(run.home, ".cache", "ccs")), ["update-check"], "no temp file left");

      const requests = await reg.requests();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "GET");
      assert.equal(requests[0].url, "/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags");
      // The README promises nothing about ccs, the repos or the machine is sent.
      const sent = JSON.stringify(requests[0]);
      const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")).version as string;
      assert.ok(!sent.includes(version), sent);
      assert.ok(!sent.includes(run.home), sent);
      assert.deepEqual(
        Object.keys(requests[0].headers).filter((k) => !["host", "connection", "accept", "accept-language", "accept-encoding", "sec-fetch-mode", "user-agent"].includes(k)),
        [],
        sent,
      );
    } finally {
      reg.stop();
      await run.cleanup();
    }
  });

  test("a prerelease or hostile latest is a successful check that remembers no version", async () => {
    for (const latest of ["2.0.0-beta.1", "9.9.9\u001b[31m", "9.9.9\nchecked=0", "$(touch pwned)", "1.2.3.4", "'; rm -rf x; '"]) {
      const run = await makeRun();
      const reg = await startRegistry(`body:${JSON.stringify({ latest })}`, join(run.home, "log"));
      try {
        await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
        await writeFile(run.cacheFile, "latest=1.2.3\nchecked=1\n");
        const res = runScript(run, reg.url);
        assert.equal(res.code, 0);
        const cache = await readCache(run);
        assert.equal(cache.latest, "", JSON.stringify(latest));
        near(cache.checked, nowS(), "checked");
      } finally {
        reg.stop();
        await run.cleanup();
      }
    }
  });

  const FAILURES: Array<[string, string]> = [
    ["503", "status:503"],
    ["404", "status:404"],
    ["not JSON", "body:<html>nope</html>"],
    ["null", "body:null"],
    ["an array", "body:[]"],
    ["no latest", 'body:{"beta":"1.0.0"}'],
    ["a number for latest", 'body:{"latest":1}'],
    ["no answer at all", "hang"],
    ["a body that stops", "stall"],
  ];
  for (const [name, mode] of FAILURES) {
    test(`failure (${name}): keeps the last good version, retries in an hour, silent, bounded`, async () => {
      const run = await makeRun();
      const reg = await startRegistry(mode, join(run.home, "log"));
      try {
        await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
        await writeFile(run.cacheFile, "latest=1.2.3\nchecked=1\n");
        const res = runScript(run, reg.url);
        assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
        assert.ok(res.ms < 6_000, `took ${res.ms} ms`);
        const cache = await readCache(run);
        assert.equal(cache.latest, "1.2.3");
        near(cache.checked, nowS() - DAY + HOUR, "checked");
      } finally {
        reg.stop();
        await run.cleanup();
      }
    });
  }

  test("offline with no cache: an empty entry, so ccs waits an hour before trying again", async () => {
    const run = await makeRun();
    try {
      const res = runScript(run, DEAD_REGISTRY);
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
      const cache = await readCache(run);
      assert.equal(cache.latest, "");
      near(cache.checked, nowS() - DAY + HOUR, "checked");
    } finally {
      await run.cleanup();
    }
  });

  test("offline with a corrupt cache: the bad line is not carried over", async () => {
    const run = await makeRun();
    try {
      await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
      await writeFile(run.cacheFile, "latest=$(touch pwned)\nchecked=1\n");
      assert.equal(runScript(run, DEAD_REGISTRY).code, 0);
      assert.equal((await readCache(run)).latest, "");
    } finally {
      await run.cleanup();
    }
  });

  test("an unwritable cache: still exit 0, still silent", async () => {
    const run = await makeRun();
    const reg = await startRegistry('body:{"latest":"9.9.9"}', join(run.home, "log"));
    try {
      await mkdir(run.cacheFile, { recursive: true }); // a directory where the file goes
      const res = runScript(run, reg.url);
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
    } finally {
      reg.stop();
      await run.cleanup();
    }
  });

  test("no package name: no request", async () => {
    const run = await makeRun();
    const reg = await startRegistry('body:{"latest":"9.9.9"}', join(run.home, "log"));
    try {
      assert.equal(runScript(run, reg.url, []).code, 0);
      assert.deepEqual(await reg.requests(), []);
    } finally {
      reg.stop();
      await run.cleanup();
    }
  });
});
