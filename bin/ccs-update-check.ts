#!/usr/bin/env tsx
/**
 * ccs-update-check.ts — ask the npm registry for the package's latest version
 * and remember the answer for bin/ccs.
 *
 * bin/ccs starts this in the background (at most once a day) and never waits
 * for it: the launcher only reads the cache this file writes, so a slow or
 * missing network cannot delay or stop the picker. Nothing is printed and the
 * exit code is always 0.
 *
 * Sent: one HTTPS GET for the package's public dist-tags. No ccs version, repo,
 * session or machine details are in it.
 *
 * Cache: <cacheDir>/update-check, two key=value lines:
 *   latest=<X.Y.Z, or empty when the registry's latest is not a plain release>
 *   checked=<unix seconds>
 * The registry's answer is untrusted text that ends up in a terminal and in an
 * fzf option, so only a plain X.Y.Z is ever stored. bin/ccs validates the file
 * again when it reads it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPaths } from "./ccs-config.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 3_000;
const HARD_EXIT_MS = 5_000;
// bin/ccs asks again once `checked` is a day old (UPDATE_INTERVAL there). A
// failed attempt is back-dated so the next try comes after an hour, not a day.
const CHECK_INTERVAL_S = 86_400;
const RETRY_AFTER_FAILURE_S = 3_600;

const PLAIN_RELEASE = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/;

export function isPlainRelease(version: unknown): version is string {
  return typeof version === "string" && PLAIN_RELEASE.test(version);
}

/** Registry base URL: CCS_UPDATE_REGISTRY when it is http(s), else npm's. */
export function registryBase(value: string | undefined): string {
  if (value && /^https?:\/\/[^\s]+$/.test(value)) return value.replace(/\/+$/, "");
  return DEFAULT_REGISTRY;
}

export function distTagsUrl(base: string, pkg: string): string {
  return `${base}/-/package/${encodeURIComponent(pkg)}/dist-tags`;
}

/**
 * The version the cache should hold after a successful answer: a plain release,
 * or "" when `latest` is a prerelease. Throws on an answer with no usable
 * `latest` (treated like a failed request).
 */
export function latestFromDistTags(body: unknown): string {
  if (typeof body !== "object" || body === null) throw new Error("not an object");
  const latest = (body as { latest?: unknown }).latest;
  if (typeof latest !== "string") throw new Error("no latest tag");
  return isPlainRelease(latest) ? latest : "";
}

export function renderCache(latest: string, checked: number): string {
  return `latest=${latest}\nchecked=${checked}\n`;
}

/** The last good version in an existing cache file ("" when there is none). */
export function cachedLatest(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith("latest=")) {
      const v = line.slice("latest=".length);
      return isPlainRelease(v) ? v : "";
    }
  }
  return "";
}

function writeCache(cacheDir: string, latest: string, checked: number): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const file = join(cacheDir, "update-check");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, renderCache(latest, checked), { mode: 0o600 });
  renameSync(tmp, file);
}

function readCachedLatest(cacheDir: string): string {
  try {
    return cachedLatest(readFileSync(join(cacheDir, "update-check"), "utf-8"));
  } catch {
    return "";
  }
}

async function fetchLatest(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return latestFromDistTags(await res.json());
}

async function main(): Promise<void> {
  const pkg = process.argv[2];
  if (!pkg) return;
  // A stalled DNS lookup or body must not leave a process behind.
  setTimeout(() => process.exit(0), HARD_EXIT_MS);

  const { cacheDir } = getPaths();
  const now = Math.floor(Date.now() / 1000);
  try {
    const url = distTagsUrl(registryBase(process.env.CCS_UPDATE_REGISTRY), pkg);
    writeCache(cacheDir, await fetchLatest(url), now);
  } catch {
    // Offline, timed out, bad answer: keep what the last good answer said.
    try {
      const retryAt = now - CHECK_INTERVAL_S + RETRY_AFTER_FAILURE_S;
      writeCache(cacheDir, readCachedLatest(cacheDir), retryAt);
    } catch {
      // Cache not writable: nothing to remember, nothing to report.
    }
  }
}

// Run only as a script, so the test suite can import the helpers.
if (process.argv[1]?.endsWith("ccs-update-check.ts")) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
