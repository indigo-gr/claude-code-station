#!/usr/bin/env tsx
/**
 * ccs-init.ts — repos.yml bootstrap helpers for `ccs init`.
 *
 * Three modes, wired by bin/ccs:
 *   scaffold            ensure ~/.config/ccs/ exists, print where config lives
 *   discover [--depth N]  walk $HOME for git repos not yet in repos.yml and
 *                         emit fzf candidate lines: "<name>\t<~/path>"
 *   append              read selected candidate lines from stdin and append
 *                         them to repos.yml (comment/format-preserving), with
 *                         backup + post-write validation rollback
 *
 * Spec: docs/v0.2.1-backlog.md "ccs init --auto-discover".
 */

import { readdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { parseDocument, isSeq } from "yaml";

import { ensureConfigDir, getPaths, loadConfig } from "./ccs-config.ts";
import { hasShellMetachars } from "./ccs-sanitize.ts";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 5;

// Non-hidden directories that never contain the user's own repos. Hidden
// directories (.venv, .cache, .Trash*, .next, ...) are skipped wholesale by
// the dot rule below, so only visible noise needs listing here.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "Library",
  "Applications",
  "__pycache__",
  "dist",
  "build",
  "target",
]);

export interface DiscoverOptions {
  /** Levels below `home` to descend (default 5). */
  maxDepth?: number;
  /** Walk root — overridable for tests (default homedir()). */
  home?: string;
}

/**
 * Find git checkout roots under $HOME. A directory containing a `.git`
 * entry (dir for normal clones, file for worktrees/submodules) is emitted
 * and NOT descended into — nested repos inside a found repo are the found
 * repo's business. Symlinked directories are skipped (cycle safety).
 *
 * Exception: the walk root itself ($HOME-as-dotfiles-repo pattern) is
 * emitted but still descended, otherwise one `.git` at $HOME would mask
 * every real project below it.
 */
export async function discoverGitRepos(
  opts: DiscoverOptions = {},
): Promise<string[]> {
  const home = opts.home ?? homedir();
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — not ours to report
    }
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      if (depth > 0) return; // stop at repo roots (root-dir exception above)
    }
    if (depth >= maxDepth) return;
    const subdirs = entries.filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        !EXCLUDED_DIR_NAMES.has(e.name),
    );
    await Promise.all(subdirs.map((e) => walk(join(dir, e.name), depth + 1)));
  }

  await walk(home, 0);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Candidate building
// ---------------------------------------------------------------------------

export interface Candidate {
  name: string;
  /** Stored form: "~" or "~/<relative>" so repos.yml stays portable. */
  path: string;
}

export interface ExistingConfig {
  names: Set<string>;
  /** Resolved absolute repo paths (RepoEntry.path). */
  paths: Set<string>;
}

/**
 * Turn discovered absolute paths into repos.yml candidates: subtract repos
 * already registered, skip paths the SHELL_METACHARS policy would reject at
 * load time anyway, suggest names from the directory basename, and uniquify
 * against existing + already-suggested names ("foo", "foo-2", ...).
 */
export function buildCandidates(
  foundAbsPaths: string[],
  existing: ExistingConfig,
  home: string,
): Candidate[] {
  const out: Candidate[] = [];
  const taken = new Set(existing.names);
  for (const abs of foundAbsPaths) {
    if (existing.paths.has(abs)) continue;
    if (hasShellMetachars(abs)) {
      process.stderr.write(
        `[ccs-init] skipped (shell metacharacters in path): ${JSON.stringify(abs)}\n`,
      );
      continue;
    }
    const base = abs === home ? "home" : basename(abs);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    out.push({
      name,
      path: abs === home ? "~" : `~/${relative(home, abs)}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// YAML append (comment/format-preserving)
// ---------------------------------------------------------------------------

/**
 * Append candidates to the `repos:` sequence of a repos.yml source string.
 * parseDocument round-trips comments and the user's existing formatting —
 * never re-serialize the whole config from plain objects.
 */
export function appendReposToYaml(
  source: string,
  candidates: Candidate[],
): string {
  const doc = parseDocument(source);
  const repos = doc.get("repos", true);
  if (!isSeq(repos)) {
    throw new Error("repos.yml: top-level `repos` sequence not found");
  }
  for (const c of candidates) {
    repos.add(doc.createNode({ name: c.name, path: c.path }));
  }
  // lineWidth: 0 — never re-fold long lines the user wrote on one line;
  // flowCollectionPadding: false — keep `tags: [work]`, not `[ work ]`.
  // Without these, toString() normalizes UNTOUCHED lines (observed on a real
  // config: every tags entry repadded + a long description folded in two).
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/**
 * Write candidates into repos.yml with a `.bak` backup, then re-run the full
 * loadConfig() validation. On any validation failure the original file is
 * restored — `ccs init` must never leave a config the launcher cannot load.
 */
export function appendAndValidate(
  reposYmlPath: string,
  candidates: Candidate[],
): void {
  const source = readFileSync(reposYmlPath, "utf-8");
  const updated = appendReposToYaml(source, candidates);
  writeFileSync(reposYmlPath + ".bak", source, { mode: 0o600 });
  writeFileSync(reposYmlPath, updated, { mode: 0o600 });
  try {
    loadConfig();
  } catch (err) {
    writeFileSync(reposYmlPath, source, { mode: 0o600 });
    throw new Error(
      `[ccs-init] validation failed after append — repos.yml restored (backup kept at .bak): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseDepth(argv: string[]): number {
  const i = argv.indexOf("--depth");
  if (i < 0) return DEFAULT_MAX_DEPTH;
  const n = parseInt(argv[i + 1] ?? "", 10);
  if (!Number.isFinite(n) || n < 1 || n > 12) {
    throw new Error(`[ccs-init] --depth must be an integer 1-12, got: ${argv[i + 1]}`);
  }
  return n;
}

async function cliDiscover(argv: string[]): Promise<number> {
  const maxDepth = parseDepth(argv);
  ensureConfigDir();
  const config = loadConfig(); // throws ConfigError on a broken repos.yml
  const existing: ExistingConfig = {
    names: new Set(config.repos.map((r) => r.name)),
    paths: new Set(config.repos.map((r) => r.path)),
  };
  const home = homedir();
  const found = await discoverGitRepos({ maxDepth, home });
  const candidates = buildCandidates(found, existing, home);
  for (const c of candidates) {
    process.stdout.write(`${c.name}\t${c.path}\n`);
  }
  return 0;
}

async function cliAppend(): Promise<number> {
  const stdin = readFileSync(0, "utf-8");
  const candidates: Candidate[] = [];
  for (const line of stdin.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      process.stderr.write(`[ccs-init] malformed candidate line skipped: ${JSON.stringify(line)}\n`);
      continue;
    }
    candidates.push({ name: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  if (candidates.length === 0) {
    process.stderr.write("[ccs-init] nothing selected — repos.yml unchanged\n");
    return 0;
  }
  const paths = getPaths();
  appendAndValidate(paths.reposYml, candidates);
  process.stderr.write(
    `[ccs-init] added ${candidates.length} repo(s) to ${paths.reposYml}\n`,
  );
  return 0;
}

function cliScaffold(): number {
  ensureConfigDir();
  const paths = getPaths();
  process.stdout.write(
    `Config ready: ${paths.reposYml}\n` +
      `Edit it directly, or run \`ccs init --auto-discover\` to scan $HOME for git repos.\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "";
  const rest = process.argv.slice(3);
  try {
    if (mode === "discover") return await cliDiscover(rest);
    if (mode === "append") return await cliAppend();
    if (mode === "scaffold") return cliScaffold();
    process.stderr.write(
      "Usage: ccs-init.ts <scaffold | discover [--depth N] | append>\n",
    );
    return 1;
  } catch (err) {
    process.stderr.write(
      `[ccs-init] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `[ccs-init] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
