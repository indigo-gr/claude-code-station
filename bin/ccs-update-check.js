#!/usr/bin/env node
/**
 * ccs-update-check.ts — ask the npm registry for the package's latest version
 * and remember the answer for bin/ccs.
 *
 * bin/ccs starts this in the background (at most once a day) and never waits
 * for it: the launcher only reads the cache this file writes, so a slow or
 * missing network cannot delay or stop the picker. Nothing is printed and the
 * exit code is always 0.
 *
 * Sent: one HTTPS GET for the package's public dist-tags and, when latest is a
 * plain release, one more for that version's public manifest (to read the Node
 * it needs, `engines.node`). No ccs version, repo, session or machine details
 * are in either; the version in the second URL is the registry's own latest.
 *
 * Cache: <cacheDir>/update-check, key=value lines:
 *   latest=<X.Y.Z, or empty when the registry's latest is not a plain release>
 *   checked=<unix seconds>
 *   node=<X.Y.Z the latest needs (from `engines.node: ">=X[.Y[.Z]]"`); the
 *         line is left out when that is unknown — any other range form, or
 *         the second request failed>
 * The registry's answers are untrusted text that ends up in a terminal and in an
 * fzf option, so only a plain X.Y.Z is ever stored. bin/ccs validates the file
 * again when it reads it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./ccs-config.js";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 3_000;
const HARD_EXIT_MS = 5_000;
// bin/ccs asks again once `checked` is a day old (UPDATE_INTERVAL there). A
// failed attempt is back-dated so the next try comes after an hour, not a day.
const CHECK_INTERVAL_S = 86_400;
const RETRY_AFTER_FAILURE_S = 3_600;
const PLAIN_RELEASE = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/;
export function isPlainRelease(version) {
    return typeof version === "string" && PLAIN_RELEASE.test(version);
}
/** Registry base URL: CCS_UPDATE_REGISTRY when it is http(s), else npm's. */
export function registryBase(value) {
    if (value && /^https?:\/\/[^\s]+$/.test(value))
        return value.replace(/\/+$/, "");
    return DEFAULT_REGISTRY;
}
export function distTagsUrl(base, pkg) {
    return `${base}/-/package/${encodeURIComponent(pkg)}/dist-tags`;
}
/**
 * The version the cache should hold after a successful answer: a plain release,
 * or "" when `latest` is a prerelease. Throws on an answer with no usable
 * `latest` (treated like a failed request).
 */
export function latestFromDistTags(body) {
    if (typeof body !== "object" || body === null)
        throw new Error("not an object");
    const latest = body.latest;
    if (typeof latest !== "string")
        throw new Error("no latest tag");
    return isPlainRelease(latest) ? latest : "";
}
/** The public manifest of one version (where `engines.node` is). */
export function versionUrl(base, pkg, version) {
    return `${base}/${encodeURIComponent(pkg)}/${version}`;
}
const NODE_FLOOR = /^\s*>=\s*v?([0-9]{1,4})(?:\.([0-9]{1,4}))?(?:\.([0-9]{1,4}))?\s*$/;
/**
 * The lowest Node a version's manifest asks for, as X.Y.Z, from
 * `engines.node: ">=X[.Y[.Z]]"`; "" for any other form (or none) — then ccs
 * says nothing about Node rather than guess.
 */
export function nodeFloorFromManifest(body) {
    if (typeof body !== "object" || body === null)
        return "";
    const engines = body.engines;
    if (typeof engines !== "object" || engines === null)
        return "";
    const range = engines.node;
    if (typeof range !== "string")
        return "";
    const m = NODE_FLOOR.exec(range);
    if (!m)
        return "";
    return `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}`;
}
/** The `node=` line only when the floor is known, so the file keeps its old shape otherwise. */
export function renderCache(latest, checked, node = "") {
    return `latest=${latest}\nchecked=${checked}\n${node ? `node=${node}\n` : ""}`;
}
/** The last good answer in an existing cache file (empty strings when there is none). */
export function cachedState(text) {
    const state = { latest: "", node: "" };
    for (const line of text.split("\n")) {
        if (line.startsWith("latest=")) {
            const v = line.slice("latest=".length);
            state.latest = isPlainRelease(v) ? v : "";
        }
        else if (line.startsWith("node=")) {
            const v = line.slice("node=".length);
            state.node = isPlainRelease(v) ? v : "";
        }
    }
    return state;
}
/** The last good version in an existing cache file ("" when there is none). */
export function cachedLatest(text) {
    return cachedState(text).latest;
}
function writeCache(cacheDir, state, checked) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const file = join(cacheDir, "update-check");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, renderCache(state.latest, checked, state.node), { mode: 0o600 });
    renameSync(tmp, file);
}
function readCachedState(cacheDir) {
    try {
        return cachedState(readFileSync(join(cacheDir, "update-check"), "utf-8"));
    }
    catch {
        return { latest: "", node: "" };
    }
}
async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return res.json();
}
/**
 * latest, then the Node it needs. A failed second request only leaves `node`
 * empty (the version is still worth telling); the same latest as last time
 * keeps the floor already known.
 */
async function fetchState(base, pkg, previous) {
    const latest = latestFromDistTags(await fetchJson(distTagsUrl(base, pkg)));
    if (!latest)
        return { latest, node: "" };
    try {
        return { latest, node: nodeFloorFromManifest(await fetchJson(versionUrl(base, pkg, latest))) };
    }
    catch {
        return { latest, node: previous.latest === latest ? previous.node : "" };
    }
}
async function main() {
    const pkg = process.argv[2];
    if (!pkg)
        return;
    // A stalled DNS lookup or body must not leave a process behind.
    setTimeout(() => process.exit(0), HARD_EXIT_MS);
    const { cacheDir } = getPaths();
    const now = Math.floor(Date.now() / 1000);
    const previous = readCachedState(cacheDir);
    try {
        const base = registryBase(process.env.CCS_UPDATE_REGISTRY);
        writeCache(cacheDir, await fetchState(base, pkg, previous), now);
    }
    catch {
        // Offline, timed out, bad answer: keep what the last good answer said.
        try {
            const retryAt = now - CHECK_INTERVAL_S + RETRY_AFTER_FAILURE_S;
            writeCache(cacheDir, previous, retryAt);
        }
        catch {
            // Cache not writable: nothing to remember, nothing to report.
        }
    }
}
// Run only as a script (the .ts, or the .js a release builds), so the test
// suite can import the helpers.
if (/ccs-update-check\.[jt]s$/.test(process.argv[1] ?? "")) {
    main().then(() => process.exit(0), () => process.exit(0));
}
