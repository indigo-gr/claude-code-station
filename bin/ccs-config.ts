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
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import { SHELL_METACHARS } from "./ccs-sanitize.ts";
import { isUiMode, UI_MODES, type UiMode } from "./ccs-utils.ts";

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
  /** false = display-only group header: listed, never launched. */
  launch: boolean;
  /** Display name for the NEW row / preview ("" = show `name`). */
  label: string;
  /** true = the group's lead: listed first among its siblings (👑 in ui: simple). */
  lead: boolean;
  custom: Record<string, unknown>;
  configHash: string;
}

/**
 * Terminal apps `ccs open --new-window` can open (defaults.terminal). Only
 * apps whose way of opening was tried on a real Mac are listed, and the list
 * is only added to (iTerm2 did not run the launcher file when tried).
 */
export const TERMINAL_APPS = ["terminal"] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

export function isTerminalApp(v: unknown): v is TerminalApp {
  return typeof v === "string" && (TERMINAL_APPS as readonly string[]).includes(v);
}

export interface CcsConfig {
  version: 1;
  /** ui: list/preview look — "classic" (default) or "simple" (friendly, Japanese). */
  defaults: { command: string; ui: UiMode };
  /** The other `defaults.*` keys (kept apart so `defaults` stays as the contract tests pin it). */
  settings: {
    /** defaults.terminal: the app `ccs open --new-window` opens; null = not chosen. */
    terminal: TerminalApp | null;
    /** defaults.update_check: false stops the update check like CCS_NO_UPDATE_CHECK. */
    updateCheck: boolean;
    /** defaults.groups_dir, `~` expanded and resolved; null = off. */
    groupsDir: string | null;
  };
  repos: RepoEntry[];
}

export interface ConfigPaths {
  configDir: string;
  cacheDir: string;
  reposYml: string;
  stateDb: string;
  readme: string;
}

/**
 * Why repos.yml failed ccs's checks, as a word machines can match on
 * (docs/design/machine-interface.md: the `config` check of `ccs doctor` and
 * the `detail` of `config_invalid`). Words are only ever added.
 */
export type ConfigErrorCode =
  | "config_not_readable"
  | "yaml_parse_error"
  | "not_a_mapping"
  | "unsupported_version"
  | "defaults_invalid"
  | "command_unsafe"
  | "repos_empty"
  | "entry_invalid"
  | "name_unsafe"
  | "duplicate_name"
  | "path_outside_home"
  | "path_unsafe"
  | "custom_too_large";

export class ConfigError extends Error {
  /** The reason word. Errors built without one count as entry_invalid. */
  readonly code: ConfigErrorCode;
  /** Index into repos[] when one entry is at fault. */
  readonly entryIndex: number | undefined;
  constructor(
    message: string,
    code: ConfigErrorCode = "entry_invalid",
    entryIndex?: number,
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.entryIndex = entryIndex;
  }
}

/**
 * Something about repos.yml worth knowing that does not stop ccs. The launcher
 * prints `message`; the machine interface counts by `code` and prints nothing
 * (the message names paths and repos).
 */
export interface ConfigWarning {
  code: "unknown_key" | "path_missing";
  message: string;
}

export type WarningSink = (w: ConfigWarning) => void;

/** The launcher's sink: each warning as one stderr line, as before. */
const consoleSink: WarningSink = (w) => console.warn(w.message);

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
  "launch",
  "label",
  "lead",
  "custom",
]);

const TEMPLATE_REPOS_YML = `# Claude Code Station — Repository Definitions
# https://github.com/indigo-gr/claude-code-station

version: 1

defaults:
  command: "claude"
  # ui: simple   # friendlier full-screen look (Japanese text, needs fzf 0.61+)

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

export function expandPath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// Symlink-aware $HOME containment check (audit M-4).
//
// Two layers:
//   1. Lexical: the resolve()d path must sit under $HOME as written. This is
//      the only possible check for paths that do not exist yet (disabled
//      repos may point at absent directories — loadConfig only warns there).
//   2. Physical: when the path EXISTS, its realpath must also sit under the
//      realpath of $HOME — otherwise `~/escape -> /` style symlinks smuggle
//      the repo outside $HOME while passing the lexical check. Both sides are
//      realpath'd so macOS /var -> /private/var aliasing compares cleanly.
export function isUnderHome(absPath: string): boolean {
  const home = homedir();
  const lexical = resolve(absPath);
  if (lexical !== home && !lexical.startsWith(home + "/")) return false;

  let physical: string;
  try {
    physical = realpathSync(lexical);
  } catch {
    return true; // path absent — lexical check above is all we can assert
  }
  let physicalHome: string;
  try {
    physicalHome = realpathSync(home);
  } catch {
    return true; // home unresolvable (exotic FS) — fall back to lexical result
  }
  return physical === physicalHome || physical.startsWith(physicalHome + "/");
}

// SHELL_METACHARS is shared with the session-intake sanitizer; see
// ccs-sanitize.ts for the policy rationale.

function rejectShellMetachars(
  field: "path" | "cwd" | "command",
  value: string,
  idx: number,
  reposYmlPath: string,
): void {
  if (SHELL_METACHARS.test(value)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${idx}].${field} contains shell metacharacter(s): ${JSON.stringify(value)}`,
      field === "command" ? "command_unsafe" : "path_unsafe",
      idx,
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

/** True when an array or object contains itself (directly or deeper down). */
function containsItself(value: unknown, path: Set<object> = new Set()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (path.has(value)) return true;
  path.add(value);
  const kids = Array.isArray(value) ? value : Object.values(value);
  for (const kid of kids) {
    if (containsItself(kid, path)) return true;
  }
  path.delete(value);
  return false;
}

/**
 * A repo-entry flag (disabled, launch, lead, scan): absent means the default,
 * anything but a YAML true/false is an error. Boolean() would read a quoted
 * "false" as true and flip the flag without a word.
 */
function readBoolean(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
  index: number,
  reposYmlPath: string,
): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].${key} must be true or false (got ${JSON.stringify(value)})`,
      "entry_invalid",
      index,
    );
  }
  return value;
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  context: string,
  sink: WarningSink,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      sink({
        code: "unknown_key",
        message: `[ccs] unknown key "${key}" in ${context} (ignored)`,
      });
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
  sink: WarningSink,
): RepoEntry {
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}] must be an object`,
      "entry_invalid",
      index,
    );
  }
  warnUnknownKeys(raw, KNOWN_REPO_KEYS, `repos[${index}]`, sink);

  const name = raw.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].name is required and must be a non-empty string`,
      "entry_invalid",
      index,
    );
  }
  // Same policy as path/cwd/command (audit NEW-3): the name lands in fzf's
  // ANSI-rendered label column and in the `new:<name>` row key, so shell
  // metacharacters and control chars (incl. ESC) are rejected outright.
  if (SHELL_METACHARS.test(name)) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].name contains shell metacharacter(s) or control char(s): ${JSON.stringify(name)}`,
      "name_unsafe",
      index,
    );
  }

  const disabled = readBoolean(raw, "disabled", false, index, reposYmlPath);

  // launch — `launch: false` makes the entry a display-only group header:
  // listed, with the repos inside its path nested under it, but never
  // launched.
  const launch = readBoolean(raw, "launch", true, index, reposYmlPath);
  // A header exists to hold its children, which nest by path — without one
  // it would have nothing under it (command/cwd, by contrast, go unused).
  if (!launch && raw.path === undefined) {
    throw new ConfigError(
      `${reposYmlPath}: repos[${index}].path is required when launch is false`,
      "entry_invalid",
      index,
    );
  }

  // path
  let resolvedPath = "";
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].path must be a string`,
        "entry_invalid",
        index,
      );
    }
    resolvedPath = resolve(expandPath(raw.path));
    if (!isUnderHome(resolvedPath)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].path "${raw.path}" is outside $HOME (security)`,
        "path_outside_home",
        index,
      );
    }
    rejectShellMetachars("path", resolvedPath, index, reposYmlPath);
    if (!disabled && !existsSync(resolvedPath)) {
      sink({
        code: "path_missing",
        message: `[ccs] path not found: ${raw.path} (repos[${index}] "${name}") — set disabled: true to silence`,
      });
    }
  }

  // cwd
  let resolvedCwd = resolvedPath;
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].cwd must be a string`,
        "entry_invalid",
        index,
      );
    }
    resolvedCwd = resolve(expandPath(raw.cwd));
    if (!isUnderHome(resolvedCwd)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].cwd "${raw.cwd}" is outside $HOME (security)`,
        "path_outside_home",
        index,
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
        "entry_invalid",
        index,
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
  // metachar here would break the last line of defense.
  rejectShellMetachars("command", command, index, reposYmlPath);

  // description — a blank `description:` (YAML null) means unset, not "null".
  const description =
    raw.description === undefined || raw.description === null
      ? ""
      : String(raw.description);

  // label — display name for the NEW row and the preview title; `name` stays
  // the unique key (row key, DB, session rows). Display-only like
  // description: it never reaches a shell line (bin/ccs skips the LABEL
  // column; no fzf binding references it), so shell metachars are allowed
  // ("R&D", "Dad's notes") and control chars are stripped at render time
  // (repoDisplayName -> truncate). A blank `label:` (YAML null) means unset.
  let label = "";
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== "string") {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].label must be a string`,
        "entry_invalid",
        index,
      );
    }
    label = raw.label;
  }

  // lead — the entry that leads its group (a director, a coordinator): listed
  // first among its siblings, and marked 👑 in the simple look.
  const lead = readBoolean(raw, "lead", false, index, reposYmlPath);

  // tags
  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === "string")) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].tags must be an array of strings`,
        "entry_invalid",
        index,
      );
    }
    tags = [...raw.tags];
  }

  // scan
  const scan = readBoolean(raw, "scan", true, index, reposYmlPath);

  // icon — a blank `icon:` (YAML null) means unset, so the default shows.
  const icon =
    raw.icon === undefined || raw.icon === null ? "📁" : String(raw.icon);

  // custom
  let custom: Record<string, unknown> = {};
  if (raw.custom !== undefined) {
    if (!isPlainObject(raw.custom)) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].custom must be an object`,
        "entry_invalid",
        index,
      );
    }
    // Reject bloated `custom` blobs before they reach downstream code.
    // Size check only — downstream code re-serializes as needed.
    const customJson = JSON.stringify(raw.custom);
    if (customJson.length > 64_000) {
      throw new ConfigError(
        `${reposYmlPath}: repos[${index}].custom exceeds the 64KB limit (measured as 64,000 characters of JSON; got ${customJson.length})`,
        "custom_too_large",
        index,
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
    launch,
    label,
    lead,
    custom,
    configHash: hashEntry(raw),
  };
}

// ---------------------------------------------------------------------------
// Top-level load
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** false: create nothing (no template, no README); only the cache dir. */
  scaffold?: boolean;
  /** Where warnings go (default: one stderr line each). */
  sink?: WarningSink;
}

/**
 * The launcher's load: scaffolds a missing config (first run), then parses it,
 * printing each warning on stderr. Throws ConfigError.
 *
 * With `scaffold: false` (the machine interface's scan) nothing but the cache
 * directory is created, and a missing repos.yml is config_not_readable.
 */
export function loadConfig(opts: LoadConfigOptions = {}): CcsConfig {
  const paths = getPaths();
  if (opts.scaffold === false) {
    mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  } else {
    ensureConfigDir();
  }

  let source: string;
  try {
    source = readFileSync(paths.reposYml, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `${paths.reposYml}: cannot read config file (${(err as Error).message})`,
      "config_not_readable",
    );
  }
  return parseConfigSource(
    source,
    paths.reposYml,
    opts.sink ?? consoleSink,
    opts.scaffold !== false,
  );
}

/** What readConfig found: no file at all, or the parsed config. */
export type ReadConfigResult =
  | { found: false }
  | { found: true; config: CcsConfig; warnings: ConfigWarning[]; source: string };

/**
 * The read-only load for the machine interface (`ccs doctor`, `ccs list
 * --json`): creates nothing (no directory, no template, no README) and prints
 * nothing — warnings come back to the caller. A missing repos.yml is
 * `{ found: false }`, not an error. Throws ConfigError like loadConfig.
 */
export function readConfig(): ReadConfigResult {
  const paths = getPaths();
  if (!existsSync(paths.reposYml)) return { found: false };
  let source: string;
  try {
    source = readFileSync(paths.reposYml, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `${paths.reposYml}: cannot read config file (${(err as Error).message})`,
      "config_not_readable",
    );
  }
  const warnings: ConfigWarning[] = [];
  const config = parseConfigSource(source, paths.reposYml, (w) => warnings.push(w), false);
  return { found: true, config, warnings, source };
}

/**
 * Validate and resolve the text of a repos.yml. Throws ConfigError.
 *
 * `yamlWarnings: false` keeps the YAML parser's own warnings (an unknown tag,
 * …) off stderr: Node prints them with the offending line, and that line is
 * repos.yml's content. The machine interface always passes false.
 */
export function parseConfigSource(
  source: string,
  reposYmlPath: string,
  sink: WarningSink = consoleSink,
  yamlWarnings = true,
): CcsConfig {
  const paths = { reposYml: reposYmlPath };

  let parsed: unknown;
  try {
    parsed = yamlWarnings ? parseYaml(source) : parseYaml(source, { logLevel: "error" });
  } catch (err) {
    throw new ConfigError(
      `${paths.reposYml}: YAML parse error: ${(err as Error).message}`,
      "yaml_parse_error",
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `${paths.reposYml}: top-level must be a mapping/object`,
      "not_a_mapping",
    );
  }

  // An anchor used inside itself (`disabled: &x [*x]`) gives a value that
  // contains itself; every later check (JSON.stringify, the entry hash) would
  // crash on it instead of naming the key.
  if (Array.isArray(parsed.repos)) {
    parsed.repos.forEach((entry, i) => {
      if (containsItself(entry)) {
        throw new ConfigError(
          `${paths.reposYml}: repos[${i}] has a value that refers to itself (a YAML anchor used inside itself)`,
          "entry_invalid",
          i,
        );
      }
    });
  }
  if (containsItself(parsed)) {
    throw new ConfigError(
      `${paths.reposYml}: a value refers to itself (a YAML anchor used inside itself)`,
      "yaml_parse_error",
    );
  }

  warnUnknownKeys(parsed, KNOWN_TOP_KEYS, "top-level", sink);

  // version
  if (parsed.version !== 1) {
    throw new ConfigError(
      `${paths.reposYml}: unsupported version: ${String(parsed.version)}, only 1 is supported`,
      "unsupported_version",
    );
  }

  // defaults
  let defaultsCommand: string | undefined;
  let defaultsUi: UiMode = "classic";
  let defaultsTerminal: TerminalApp | null = null;
  let defaultsUpdateCheck = true;
  let defaultsGroupsDir: string | null = null;
  if (parsed.defaults !== undefined) {
    if (!isPlainObject(parsed.defaults)) {
      throw new ConfigError(
        `${paths.reposYml}: defaults must be an object`,
        "defaults_invalid",
      );
    }
    const defaults = parsed.defaults;
    if (defaults.command !== undefined) {
      if (typeof defaults.command !== "string") {
        throw new ConfigError(
          `${paths.reposYml}: defaults.command must be a string`,
          "defaults_invalid",
        );
      }
      defaultsCommand = defaults.command;
    }
    // ui — display only (never reaches a shell line), but bin/ccs picks its
    // fzf flags from it, so only the known values pass; a typo fails loudly
    // instead of silently falling back to the classic look.
    if (defaults.ui !== undefined && defaults.ui !== null) {
      if (!isUiMode(defaults.ui)) {
        throw new ConfigError(
          `${paths.reposYml}: defaults.ui must be one of ${UI_MODES.join(" / ")} (got ${JSON.stringify(defaults.ui)})`,
          "defaults_invalid",
        );
      }
      defaultsUi = defaults.ui;
    }
    // terminal — `ccs open --new-window` picks its app from this list only.
    if (defaults.terminal !== undefined && defaults.terminal !== null) {
      if (!isTerminalApp(defaults.terminal)) {
        throw new ConfigError(
          `${paths.reposYml}: defaults.terminal must be one of ${TERMINAL_APPS.join(" / ")} (got ${JSON.stringify(defaults.terminal)})`,
          "defaults_invalid",
        );
      }
      defaultsTerminal = defaults.terminal;
    }
    // update_check — true or false only, as strict as the entry flags: a
    // quoted "false" must not silently leave the check on.
    if (defaults.update_check !== undefined && defaults.update_check !== null) {
      if (typeof defaults.update_check !== "boolean") {
        throw new ConfigError(
          `${paths.reposYml}: defaults.update_check must be true or false (got ${JSON.stringify(defaults.update_check)})`,
          "defaults_invalid",
        );
      }
      defaultsUpdateCheck = defaults.update_check;
    }
    // groups_dir — a folder of group definition files other tools keep
    // (ccs-groups.ts). Held to the same rules as a repo `path`: under $HOME,
    // no shell metacharacters.
    if (defaults.groups_dir !== undefined && defaults.groups_dir !== null) {
      if (typeof defaults.groups_dir !== "string" || defaults.groups_dir === "") {
        throw new ConfigError(
          `${paths.reposYml}: defaults.groups_dir must be a folder path`,
          "defaults_invalid",
        );
      }
      const dir = resolve(expandPath(defaults.groups_dir));
      if (!isUnderHome(dir)) {
        throw new ConfigError(
          `${paths.reposYml}: defaults.groups_dir "${defaults.groups_dir}" is outside $HOME (security)`,
          "path_outside_home",
        );
      }
      if (SHELL_METACHARS.test(dir)) {
        throw new ConfigError(
          `${paths.reposYml}: defaults.groups_dir contains shell metacharacter(s): ${JSON.stringify(defaults.groups_dir)}`,
          "path_unsafe",
        );
      }
      defaultsGroupsDir = dir;
    }
  }

  // defaults.command resolution: explicit defaults > env > "claude"
  const resolvedDefaultsCommand =
    defaultsCommand ?? envCommand() ?? "claude";
  // Gate the resolved default at origin (review A-6): it is persisted to the
  // meta table for unmapped-session fallback and exposed on CcsConfig, so it
  // must satisfy the same metachar policy as per-repo commands even when no
  // repo currently inherits it. resolveRepoEntry re-checks as defense in depth.
  if (SHELL_METACHARS.test(resolvedDefaultsCommand)) {
    throw new ConfigError(
      `${paths.reposYml}: defaults.command (resolved from defaults.command / CCS_CMD / CCR_CMD) contains shell metacharacter(s): ${JSON.stringify(resolvedDefaultsCommand)}`,
      "command_unsafe",
    );
  }

  // repos
  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
    throw new ConfigError(
      `${paths.reposYml}: repos must be a non-empty array`,
      "repos_empty",
    );
  }

  const repos: RepoEntry[] = parsed.repos.map((raw, i) =>
    resolveRepoEntry(raw, i, defaultsCommand, paths.reposYml, sink),
  );

  // uniqueness check
  const byName = new Map<string, number[]>();
  repos.forEach((r, i) => {
    const list = byName.get(r.name) ?? [];
    list.push(i);
    byName.set(r.name, list);
  });
  const dupes: string[] = [];
  let firstDupeIndex: number | undefined;
  for (const [n, idxs] of byName) {
    if (idxs.length > 1) {
      dupes.push(`"${n}" at indexes [${idxs.join(", ")}]`);
      // The entry that repeats an earlier name (the second occurrence).
      if (firstDupeIndex === undefined || idxs[1] < firstDupeIndex) {
        firstDupeIndex = idxs[1];
      }
    }
  }
  if (dupes.length > 0) {
    throw new ConfigError(
      `${paths.reposYml}: duplicate name ${dupes.join("; ")}`,
      "duplicate_name",
      firstDupeIndex,
    );
  }

  return {
    version: 1,
    defaults: { command: resolvedDefaultsCommand, ui: defaultsUi },
    settings: {
      terminal: defaultsTerminal,
      updateCheck: defaultsUpdateCheck,
      groupsDir: defaultsGroupsDir,
    },
    repos,
  };
}
