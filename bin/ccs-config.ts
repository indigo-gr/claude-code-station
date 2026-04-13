/**
 * ccs-config.ts — Config parser for Claude Code Station (ccs) v0.2.0
 *
 * Reads, validates, and resolves ~/.config/ccs/repos.yml into typed RepoEntry
 * records. Handles XDG paths, first-run scaffolding, path-expansion security,
 * defaults resolution, and SHA256 content hashing for cache invalidation.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoEntry {
  name: string;
  path: string;
  description: string;
  command: string;
  cwd: string;
  tags: string[];
  disabled: boolean;
  scan: boolean;
  icon: string;
  custom: Record<string, unknown>;
  configHash: string;
}

export interface CcsConfig {
  version: 1;
  defaults: { command: string };
  repos: RepoEntry[];
}

export interface ConfigPaths {
  configDir: string;
  cacheDir: string;
  reposYml: string;
  stateDb: string;
  readme: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_TOP_KEYS = new Set(["version", "defaults", "repos"]);
const KNOWN_REPO_KEYS = new Set([
  "name",
  "path",
  "description",
  "command",
  "cwd",
  "tags",
  "disabled",
  "scan",
  "icon",
  "custom",
]);

const TEMPLATE_REPOS_YML = `# Claude Code Station — Repository Definitions
# https://github.com/indigo-gr/claude-code-station

version: 1

defaults:
  command: "claude"

repos:
  - name: Example Project
    path: ~/path/to/your/project
    description: Edit this entry to add your real repos
    tags: [example]
`;

const TEMPLATE_README = `# Claude Code Station (ccs)

This directory holds your Claude Code Station configuration.

- \`repos.yml\`: Repository definitions — edit to register your projects
- (auto-generated cache lives in $XDG_CACHE_HOME/ccs/state.db)

Docs: https://github.com/indigo-gr/claude-code-station
`;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getPaths(): ConfigPaths {
  const home = homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const xdgCache = process.env.XDG_CACHE_HOME || join(home, ".cache");
  const configDir = join(xdgConfig, "ccs");
  const cacheDir = join(xdgCache, "ccs");
  return {
    configDir,
    cacheDir,
    reposYml: join(configDir, "repos.yml"),
    stateDb: join(cacheDir, "state.db"),
    readme: join(configDir, "README.md"),
  };
}

function expandPath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function isUnderHome(absPath: string): boolean {
  const home = homedir();
  const resolved = resolve(absPath);
  return resolved === home || resolved.startsWith(home + "/");
}

// Shell metacharacters forbidden in path/cwd/command to prevent injection
// through fzf `execute(...)` bindings that interpolate row columns into bash,
// and through the final direct invocation in bin/ccs.
// \x00-\x1f covers TAB (0x09), NL (0x0a), CR (0x0d), and other control chars.
const SHELL_METACHARS = /[;&|<>$`"'\\\n\r\x00-\x1f]/;

function rejectShellMetachars(
  field: string,
  value: string,
  idx: number,
  reposYmlPath: string,
): void {
  if (SHELL_METACHARS.test(value)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${idx}].${field} contains shell metacharacter(s): ${JSON.stringify(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

export function ensureConfigDir(): void {
  const paths = getPaths();
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.reposYml)) {
    writeFileSync(paths.reposYml, TEMPLATE_REPOS_YML, { mode: 0o600 });
  }
  if (!existsSync(paths.readme)) {
    writeFileSync(paths.readme, TEMPLATE_README, { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

function hashEntry(raw: unknown): string {
  return createHash("sha256").update(canonicalJson(raw)).digest("hex");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  context: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      console.warn(`[ccs] unknown key "${key}" in ${context} (ignored)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command resolution (with CCR_CMD migration warning)
// ---------------------------------------------------------------------------

let migrationWarned = false;

/**
 * Reset the CCR_CMD deprecation warning flag. Test-only hook —
 * production code re-warns once per process by design.
 */
export function resetMigrationWarning(): void {
  migrationWarned = false;
}

function envCommand(): string | undefined {
  if (process.env.CCS_CMD) return process.env.CCS_CMD;
  if (process.env.CCR_CMD) {
    if (!migrationWarned) {
      console.warn(
        "[ccs] CCR_CMD is deprecated, please rename to CCS_CMD (using CCR_CMD value for now)",
      );
      migrationWarned = true;
    }
    return process.env.CCR_CMD;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Repo entry resolution
// ---------------------------------------------------------------------------

function resolveRepoEntry(
  raw: unknown,
  index: number,
  defaultsCommand: string | undefined,
  reposYmlPath: string,
): RepoEntry {
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}] must be an object`,
    );
  }
  warnUnknownKeys(raw, KNOWN_REPO_KEYS, `repos[${index}]`);

  const name = raw.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].name is required and must be a non-empty string`,
    );
  }
  if (/[\t\n\\]/.test(name)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].name contains invalid characters (\\t, \\n, or \\)`,
    );
  }

  const disabled =
    raw.disabled === undefined ? false : Boolean(raw.disabled);

  // path
  let resolvedPath = "";
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].path must be a string`,
      );
    }
    resolvedPath = resolve(expandPath(raw.path));
    if (!isUnderHome(resolvedPath)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].path "${raw.path}" is outside $HOME (security)`,
      );
    }
    rejectShellMetachars("path", resolvedPath, index, reposYmlPath);
    if (!disabled && !existsSync(resolvedPath)) {
      console.warn(
        `[ccs] path not found: ${raw.path} (repos[${index}] "${name}") — set disabled: true to silence`,
      );
    }
  }

  // cwd
  let resolvedCwd = resolvedPath;
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].cwd must be a string`,
      );
    }
    resolvedCwd = resolve(expandPath(raw.cwd));
    if (!isUnderHome(resolvedCwd)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].cwd "${raw.cwd}" is outside $HOME (security)`,
      );
    }
    rejectShellMetachars("cwd", resolvedCwd, index, reposYmlPath);
  }

  // command
  let command: string;
  if (raw.command !== undefined) {
    if (typeof raw.command !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].command must be a string`,
      );
    }
    command = raw.command;
  } else if (defaultsCommand !== undefined) {
    command = defaultsCommand;
  } else {
    command = envCommand() ?? "claude";
  }
  // Reject shell metachars in resolved command (S1 hardening). The command
  // string is re-executed unquoted by bin/ccs via `${ROW_CMD} ...`, so any
  // metachar here would break the last line of defense. Error message uses
  // "at index" phrasing (not reposYmlPath prefix) per Phase 6 spec.
  if (SHELL_METACHARS.test(command)) {
    throw new ConfigError(
      `command for repo at index ${index} contains shell metacharacter(s): ${JSON.stringify(command)}`,
    );
  }

  // description
  const description =
    raw.description === undefined ? "" : String(raw.description);

  // tags
  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === "string")) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].tags must be an array of strings`,
      );
    }
    tags = [...raw.tags];
  }

  // scan
  const scan = raw.scan === undefined ? true : Boolean(raw.scan);

  // icon
  const icon = raw.icon === undefined ? "📁" : String(raw.icon);

  // custom
  let custom: Record<string, unknown> = {};
  if (raw.custom !== undefined) {
    if (!isPlainObject(raw.custom)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].custom must be an object`,
      );
    }
    // Reject bloated `custom` blobs before they reach downstream code.
    // Size check only — downstream code re-serializes as needed.
    const customJson = JSON.stringify(raw.custom);
    if (customJson.length > 64_000) {
      throw new ConfigError(
        `custom for repo at index ${index} exceeds 64KB JSON size limit (got ${customJson.length} bytes)`,
      );
    }
    custom = { ...raw.custom };
  }

  return {
    name,
    path: resolvedPath,
    description,
    command,
    cwd: resolvedCwd,
    tags,
    disabled,
    scan,
    icon,
    custom,
    configHash: hashEntry(raw),
  };
}

// ---------------------------------------------------------------------------
// Top-level load
// ---------------------------------------------------------------------------

export function loadConfig(): CcsConfig {
  ensureConfigDir();
  const paths = getPaths();

  let source: string;
  try {
    source = readFileSync(paths.reposYml, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `${paths.reposYml}: cannot read config file (${(err as Error).message})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (err) {
    throw new ConfigError(
      `${paths.reposYml}: YAML parse error: ${(err as Error).message}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `${paths.reposYml}: top-level must be a mapping/object`,
    );
  }

  warnUnknownKeys(parsed, KNOWN_TOP_KEYS, "top-level");

  // version
  if (parsed.version !== 1) {
    throw new ConfigError(
      `${paths.reposYml}: unsupported version: ${String(parsed.version)}, only 1 is supported`,
    );
  }

  // defaults
  let defaultsCommand: string | undefined;
  if (parsed.defaults !== undefined) {
    if (!isPlainObject(parsed.defaults)) {
      throw new ConfigError(
        `${paths.reposYml}: defaults must be an object`,
      );
    }
    const defaults = parsed.defaults;
    if (defaults.command !== undefined) {
      if (typeof defaults.command !== "string") {
        throw new ConfigError(
          `${paths.reposYml}: defaults.command must be a string`,
        );
      }
      defaultsCommand = defaults.command;
    }
  }

  // defaults.command resolution: explicit defaults > env > "claude"
  const resolvedDefaultsCommand =
    defaultsCommand ?? envCommand() ?? "claude";

  // repos
  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
    throw new ConfigError(
      `${paths.reposYml}: repos must be a non-empty array`,
    );
  }

  const repos: RepoEntry[] = parsed.repos.map((raw, i) =>
    resolveRepoEntry(raw, i, defaultsCommand, paths.reposYml),
  );

  // uniqueness check
  const byName = new Map<string, number[]>();
  repos.forEach((r, i) => {
    const list = byName.get(r.name) ?? [];
    list.push(i);
    byName.set(r.name, list);
  });
  const dupes: string[] = [];
  for (const [n, idxs] of byName) {
    if (idxs.length > 1) {
      dupes.push(`"${n}" at indexes [${idxs.join(", ")}]`);
    }
  }
  if (dupes.length > 0) {
    throw new ConfigError(
      `${paths.reposYml}: duplicate name ${dupes.join("; ")}`,
    );
  }

  return {
    version: 1,
    defaults: { command: resolvedDefaultsCommand },
    repos,
  };
}
