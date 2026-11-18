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
import { tmpdir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isPlainRelease,
  registryBase,
  distTagsUrl,
  latestFromDistTags,
  renderCache,
  cachedLatest,
  nodeFloorFromManifest,
} from "../bin/ccs-update-check.ts";
import { DEAD_REGISTRY, startRegistry, type FakeRegistry, type LoggedRequest } from "./tty/fake_registry.ts";

const SCRIPT = fileURLToPath(new URL("../bin/ccs-update-check.ts", import.meta.url));
// The modules run on Node itself (it strips the types of the .ts sources).
const NODE = process.execPath;
const PACKAGE = "@indigo-gr/claude-code-station";
const DAY = 86_400;
const HOUR = 3_600;
const DIST_TAGS_PATH = "/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags";
const MANIFEST_PATH = "/%40indigo-gr%2Fclaude-code-station/9.9.9";

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

  test("nodeFloorFromManifest: >=X, >=X.Y, >=X.Y.Z (with or without v) as X.Y.Z, '' for anything else", () => {
    const floor = (node: unknown) => nodeFloorFromManifest({ name: PACKAGE, version: "9.9.9", engines: { node } });
    assert.equal(floor(">=26"), "26.0.0");
    assert.equal(floor(">=24.12"), "24.12.0");
    assert.equal(floor(">=24.12.0"), "24.12.0");
    assert.equal(floor(">=v24.12.0"), "24.12.0");
    assert.equal(floor(">=v26"), "26.0.0");
    for (const other of [
      "^24", ">=24 <26", "24.x", "24", "=24.12.0", ">24", "<=26", "*", "", ">=", ">=x", "latest",
      ">=24 || >=26", ">=24.12.0.1", ">=24.12.0-rc.1", ">=24.x", ">=26\nlatest=1.0.0", ">=$(touch pwned)",
      "\u001b[31m>=26", 26, null, undefined, true, {}, [">=26"],
    ]) {
      assert.equal(floor(other), "", JSON.stringify(other));
    }
    // No engines, or engines that is not an object, or no manifest at all.
    for (const body of [{ name: PACKAGE }, { engines: null }, { engines: ">=26" }, { engines: {} }, null, ">=26", 26, []]) {
      assert.equal(nodeFloorFromManifest(body), "", JSON.stringify(body));
    }
  });

  test("the cache text round-trips and hostile lines come back empty", () => {
    assert.equal(renderCache("1.2.3", 100), "latest=1.2.3\nchecked=100\n");
    assert.equal(renderCache("1.2.3", 100, "24.12.0"), "latest=1.2.3\nchecked=100\nnode=24.12.0\n");
    assert.equal(cachedLatest(renderCache("1.2.3", 100, "24.12.0")), "1.2.3");
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
  const r = spawnSync(NODE, [SCRIPT, ...args], {
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

/** The cache: latest= and checked=, then node= only when the floor is known. */
async function readCache(run: Run): Promise<{ latest: string; checked: number; node: string | undefined; text: string }> {
  const text = await readFile(run.cacheFile, "utf-8");
  const m = /^latest=(.*)\nchecked=(\d+)\n(?:node=(.*)\n)?$/.exec(text);
  assert.ok(m, `cache shape: ${JSON.stringify(text)}`);
  return { latest: m[1], checked: Number(m[2]), node: m[3], text };
}

// A fake registry that answers by path (the shared one answers every request
// the same way). A child process, as the tests block in spawnSync. Each route
// takes a mode like the shared one: body:<text>, status:<n>, hang, stall. Any
// other path gets a 404.
const ROUTED_REGISTRY = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const [routesJson, log] = process.argv.slice(1);
const routes = JSON.parse(routesJson);
const server = createServer((req, res) => {
  appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers }) + "\\n");
  const mode = routes[req.url] ?? "status:404";
  if (mode === "hang") return;
  if (mode === "stall") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"eng');
    return;
  }
  if (mode.startsWith("status:")) {
    res.writeHead(Number(mode.slice("status:".length)));
    res.end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(mode.slice("body:".length));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

async function startRoutedRegistry(routes: Record<string, string>, log: string): Promise<FakeRegistry> {
  const child = spawn(NODE, ["--input-type=module", "-e", ROUTED_REGISTRY, JSON.stringify(routes), log], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (d: Buffer) => resolve(d.toString().trim()));
    child.once("exit", (code) => reject(new Error(`routed registry exited: ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: async () => {
      const text = await readFile(log, "utf-8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LoggedRequest);
    },
    stop: () => {
      child.removeAllListeners("exit");
      child.kill();
    },
  };
}

const distTags = (latest: string) => `body:${JSON.stringify({ latest, beta: "10.0.0-b.1" })}`;
const manifest = (node: unknown) => `body:${JSON.stringify({ name: PACKAGE, version: "9.9.9", engines: { node } })}`;

/** Run the script, holding the time bound over up to three attempts (see the failure tests). */
async function runBounded(run: Run, registry: string, seed: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    if (seed !== undefined) {
      await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
      await writeFile(run.cacheFile, seed);
    }
    const res = runScript(run, registry);
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
    if (res.ms < 6_000) return res;
    assert.ok(attempt < 3, `took ${res.ms} ms, three times in a row`);
  }
}

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= 30, `${what}: ${actual} vs ${expected}`);
const nowS = () => Math.floor(Date.now() / 1000);

describe("bin/ccs-update-check.ts against a fake registry", () => {
  test("a good answer: two bare GETs (dist-tags, then that version's manifest), cache written privately, nothing printed", async () => {
    const run = await makeRun();
    const reg = await startRoutedRegistry(
      { [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: manifest(">=26") },
      join(run.home, "log"),
    );
    try {
      const res = runScript(run, reg.url);
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
      const cache = await readCache(run);
      assert.equal(cache.latest, "9.9.9");
      near(cache.checked, nowS(), "checked");
      assert.equal(cache.node, "26.0.0");
      assert.equal(cache.text, `latest=9.9.9\nchecked=${cache.checked}\nnode=26.0.0\n`);
      assert.equal((await stat(run.cacheFile)).mode & 0o777, 0o600);
      assert.equal((await stat(join(run.home, ".cache", "ccs"))).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(join(run.home, ".cache", "ccs")), ["update-check"], "no temp file left");

      const requests = await reg.requests();
      assert.deepEqual(
        requests.map((r) => [r.method, r.url]),
        [
          ["GET", DIST_TAGS_PATH],
          ["GET", MANIFEST_PATH],
        ],
      );
      // The README promises nothing about ccs, the repos or the machine is sent:
      // not in the path, a query or a header, in either request.
      const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")).version as string;
      assert.notEqual(version, "9.9.9", "the fake latest must differ from this ccs version");
      const machine = [version, run.home, process.versions.node, process.version, hostname(), userInfo().username].filter(
        (v) => v.length >= 3,
      );
      for (const request of requests) {
        const sent = JSON.stringify(request);
        assert.ok(!request.url.includes("?"), sent);
        for (const detail of machine) assert.ok(!sent.includes(detail), `${detail} in ${sent}`);
        assert.deepEqual(
          Object.keys(request.headers).filter((k) => !["host", "connection", "accept", "accept-language", "accept-encoding", "sec-fetch-mode", "user-agent"].includes(k)),
          [],
          sent,
        );
      }
    } finally {
      reg.stop();
      await run.cleanup();
    }
  });

  test("a manifest whose engines.node is not >=X[.Y[.Z]]: latest is written, no node= line", async () => {
    for (const node of ["^24", ">=24 <26", "24.x", ">=26\nlatest=1.0.0", ">=$(touch pwned)", null, 26]) {
      const run = await makeRun();
      const reg = await startRoutedRegistry(
        { [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: manifest(node) },
        join(run.home, "log"),
      );
      try {
        await runBounded(run, reg.url, undefined);
        const cache = await readCache(run);
        assert.equal(cache.latest, "9.9.9", JSON.stringify(node));
        assert.equal(cache.node, undefined, JSON.stringify(node));
        near(cache.checked, nowS(), "checked");
        assert.equal((await reg.requests()).length, 2);
      } finally {
        reg.stop();
        await run.cleanup();
      }
    }
  });

  test("a manifest with no engines: latest is written, no node= line", async () => {
    const run = await makeRun();
    const reg = await startRoutedRegistry(
      { [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: `body:${JSON.stringify({ name: PACKAGE, version: "9.9.9" })}` },
      join(run.home, "log"),
    );
    try {
      await runBounded(run, reg.url, undefined);
      const cache = await readCache(run);
      assert.deepEqual([cache.latest, cache.node], ["9.9.9", undefined]);
      near(cache.checked, nowS(), "checked");
    } finally {
      reg.stop();
      await run.cleanup();
    }
  });

  test("same latest as last time, and the new manifest has no readable floor: the new manifest wins, the old node= goes", async () => {
    const noEngines = `body:${JSON.stringify({ name: PACKAGE, version: "9.9.9" })}`;
    const answers: Array<[string, string]> = [
      ["^24", manifest("^24")],
      [">=24 <26", manifest(">=24 <26")],
      ["24.x", manifest("24.x")],
      ["null", manifest(null)],
      ["no engines", noEngines],
    ];
    for (const [name, answer] of answers) {
      const run = await makeRun();
      const reg = await startRoutedRegistry({ [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: answer }, join(run.home, "log"));
      try {
        await runBounded(run, reg.url, "latest=9.9.9\nchecked=1\nnode=24.12.0\n");
        const cache = await readCache(run);
        assert.deepEqual([cache.latest, cache.node], ["9.9.9", undefined], name);
        near(cache.checked, nowS(), "checked");
        assert.equal((await reg.requests()).length, 2, name);
      } finally {
        reg.stop();
        await run.cleanup();
      }
    }
  });

  // The second request failing does not make the check a failure: the version
  // is still worth telling, and the next check is a day away.
  const SECOND_FAILURES: Array<[string, string]> = [
    ["404", "status:404"],
    ["503", "status:503"],
    ["no answer (time out)", "hang"],
    ["a body that stops", "stall"],
    ["not JSON", "body:<html>nope</html>"],
  ];
  for (const [name, mode] of SECOND_FAILURES) {
    test(`second GET fails (${name}), no earlier cache: latest is written, no node= line, silent, bounded`, async () => {
      const run = await makeRun();
      const reg = await startRoutedRegistry({ [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: mode }, join(run.home, "log"));
      try {
        await runBounded(run, reg.url, undefined);
        const cache = await readCache(run);
        assert.deepEqual([cache.latest, cache.node], ["9.9.9", undefined]);
        near(cache.checked, nowS(), "checked");
        assert.deepEqual(
          (await reg.requests()).map((r) => r.url),
          [DIST_TAGS_PATH, MANIFEST_PATH],
        );
      } finally {
        reg.stop();
        await run.cleanup();
      }
    });

    test(`second GET fails (${name}), same latest as last time: the node already known is kept`, async () => {
      const run = await makeRun();
      const reg = await startRoutedRegistry({ [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: mode }, join(run.home, "log"));
      try {
        await runBounded(run, reg.url, "latest=9.9.9\nchecked=1\nnode=24.12.0\n");
        const cache = await readCache(run);
        assert.deepEqual([cache.latest, cache.node], ["9.9.9", "24.12.0"]);
        near(cache.checked, nowS(), "checked");
      } finally {
        reg.stop();
        await run.cleanup();
      }
    });

    test(`second GET fails (${name}), a different latest: the old node is not carried to the new version`, async () => {
      const run = await makeRun();
      const reg = await startRoutedRegistry({ [DIST_TAGS_PATH]: distTags("9.9.9"), [MANIFEST_PATH]: mode }, join(run.home, "log"));
      try {
        await runBounded(run, reg.url, "latest=9.9.8\nchecked=1\nnode=24.12.0\n");
        const cache = await readCache(run);
        assert.deepEqual([cache.latest, cache.node], ["9.9.9", undefined]);
        near(cache.checked, nowS(), "checked");
      } finally {
        reg.stop();
        await run.cleanup();
      }
    });
  }

  test("a prerelease or hostile latest is a successful check that remembers no version", async () => {
    for (const latest of ["2.0.0-beta.1", "9.9.9\u001b[31m", "9.9.9\nchecked=0", "$(touch pwned)", "1.2.3.4", "'; rm -rf x; '"]) {
      const run = await makeRun();
      const reg = await startRegistry(`body:${JSON.stringify({ latest })}`, join(run.home, "log"));
      try {
        await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
        await writeFile(run.cacheFile, "latest=1.2.3\nchecked=1\nnode=24.12.0\n");
        const res = runScript(run, reg.url);
        assert.equal(res.code, 0);
        const cache = await readCache(run);
        assert.equal(cache.latest, "", JSON.stringify(latest));
        assert.equal(cache.node, undefined, JSON.stringify(latest));
        near(cache.checked, nowS(), "checked");
        // No version to ask about: what the registry said never becomes a URL.
        assert.deepEqual(
          (await reg.requests()).map((r) => r.url),
          [DIST_TAGS_PATH],
          JSON.stringify(latest),
        );
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
    test(`failure (${name}): keeps the last good version and its node, retries in an hour, silent, bounded`, async () => {
      const run = await makeRun();
      const reg = await startRegistry(mode, join(run.home, "log"));
      try {
        await mkdir(join(run.home, ".cache", "ccs"), { recursive: true });
        // The request gives up after 3 s. The time measured here includes
        // starting Node, which a busy machine stretches by chance; a check with
        // no limit would be slow every time, so the bound is held over up to
        // three attempts.
        for (let attempt = 1; ; attempt++) {
          await writeFile(run.cacheFile, "latest=1.2.3\nchecked=1\nnode=24.12.0\n");
          const res = runScript(run, reg.url);
          assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
          if (res.ms < 6_000) break;
          assert.ok(attempt < 3, `took ${res.ms} ms, three times in a row`);
        }
        const cache = await readCache(run);
        assert.equal(cache.latest, "1.2.3");
        assert.equal(cache.node, "24.12.0");
        near(cache.checked, nowS() - DAY + HOUR, "checked");
        // The first request failed, so there is no second one.
        const urls = (await reg.requests()).map((r) => r.url);
        assert.ok(urls.length > 0 && urls.every((u) => u === DIST_TAGS_PATH), JSON.stringify(urls));
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
