/**
 * ccs-config.ts — Config parser for Claude Code Station (ccs) v0.2.0
 *
 * Reads, validates, and resolves ~/.config/ccs/repos.yml into typed RepoEntry
 * records. Handles XDG paths, first-run scaffolding, path-expansion security,
 * defaults resolution, and SHA256 content hashing for cache invalidation.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { SHELL_METACHARS } from "./ccs-sanitize.js";
import { isLanguageSetting, t } from "./ccs-i18n.js";
/**
 * Terminal apps `ccs open --new-window` can open (defaults.terminal). Only
 * apps whose way of opening was tried on a real Mac are listed, and the list
 * is only added to (iTerm2 did not run the launcher file when tried).
 */
export const TERMINAL_APPS = ["terminal"];
export function isTerminalApp(v) {
    return typeof v === "string" && TERMINAL_APPS.includes(v);
}
export class ConfigError extends Error {
    /** The reason word. Errors built without one count as entry_invalid. */
    code;
    /** Index into repos[] when one entry is at fault. */
    entryIndex;
    constructor(message, code = "entry_invalid", entryIndex) {
        super(message);
        this.name = "ConfigError";
        this.code = code;
        this.entryIndex = entryIndex;
    }
}
/** The launcher's sink: each warning as one stderr line, as before. */
const consoleSink = (w) => console.warn(w.message);
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
export function getPaths() {
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
export function expandPath(p) {
    const home = homedir();
    if (p === "~")
        return home;
    if (p.startsWith("~/"))
        return join(home, p.slice(2));
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
export function isUnderHome(absPath) {
    const home = homedir();
    const lexical = resolve(absPath);
    if (lexical !== home && !lexical.startsWith(home + "/"))
        return false;
    let physical;
    try {
        physical = realpathSync(lexical);
    }
    catch {
        return true; // path absent — lexical check above is all we can assert
    }
    let physicalHome;
    try {
        physicalHome = realpathSync(home);
    }
    catch {
        return true; // home unresolvable (exotic FS) — fall back to lexical result
    }
    return physical === physicalHome || physical.startsWith(physicalHome + "/");
}
// SHELL_METACHARS is shared with the session-intake sanitizer; see
// ccs-sanitize.ts for the policy rationale.
function rejectShellMetachars(field, value, idx, reposYmlPath) {
    if (SHELL_METACHARS.test(value)) {
        throw new ConfigError(t("cfg_metachars", { file: reposYmlPath, where: `repos[${idx}].${field}`, got: JSON.stringify(value) }), field === "command" ? "command_unsafe" : "path_unsafe", idx);
    }
}
// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------
export function ensureConfigDir() {
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
function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return ("{" +
        keys
            .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
            .join(",") +
        "}");
}
function hashEntry(raw) {
    return createHash("sha256").update(canonicalJson(raw)).digest("hex");
}
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function isPlainObject(v) {
    return (typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) === Object.prototype);
}
/** True when an array or object contains itself (directly or deeper down). */
function containsItself(value, path = new Set()) {
    if (typeof value !== "object" || value === null)
        return false;
    if (path.has(value))
        return true;
    path.add(value);
    const kids = Array.isArray(value) ? value : Object.values(value);
    for (const kid of kids) {
        if (containsItself(kid, path))
            return true;
    }
    path.delete(value);
    return false;
}
/**
 * A repo-entry flag (disabled, launch, lead, scan): absent means the default,
 * anything but a YAML true/false is an error. Boolean() would read a quoted
 * "false" as true and flip the flag without a word.
 */
function readBoolean(raw, key, fallback, index, reposYmlPath) {
    const value = raw[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean") {
        throw new ConfigError(t("cfg_must_be_bool", { file: reposYmlPath, where: `repos[${index}].${key}`, got: JSON.stringify(value) }), "entry_invalid", index);
    }
    return value;
}
function warnUnknownKeys(obj, known, context, sink) {
    for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
            sink({
                code: "unknown_key",
                message: t("cfg_unknown_key", { key, where: context }),
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
export function resetMigrationWarning() {
    migrationWarned = false;
}
function envCommand() {
    if (process.env.CCS_CMD)
        return process.env.CCS_CMD;
    if (process.env.CCR_CMD) {
        if (!migrationWarned) {
            console.warn(t("ccr_cmd_deprecated"));
            migrationWarned = true;
        }
        return process.env.CCR_CMD;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Repo entry resolution
// ---------------------------------------------------------------------------
function resolveRepoEntry(raw, index, defaultsCommand, reposYmlPath, sink) {
    if (!isPlainObject(raw)) {
        throw new ConfigError(t("cfg_must_be_object", { file: reposYmlPath, where: `repos[${index}]` }), "entry_invalid", index);
    }
    warnUnknownKeys(raw, KNOWN_REPO_KEYS, `repos[${index}]`, sink);
    const name = raw.name;
    if (typeof name !== "string" || name.length === 0) {
        throw new ConfigError(t("cfg_name_required", { file: reposYmlPath, where: `repos[${index}].name` }), "entry_invalid", index);
    }
    // Same policy as path/cwd/command (audit NEW-3): the name lands in fzf's
    // ANSI-rendered label column and in the `new:<name>` row key, so shell
    // metacharacters and control chars (incl. ESC) are rejected outright.
    if (SHELL_METACHARS.test(name)) {
        throw new ConfigError(t("cfg_name_unsafe", { file: reposYmlPath, where: `repos[${index}].name`, got: JSON.stringify(name) }), "name_unsafe", index);
    }
    const disabled = readBoolean(raw, "disabled", false, index, reposYmlPath);
    // launch — `launch: false` makes the entry a display-only group header:
    // listed, with the repos inside its path nested under it, but never
    // launched.
    const launch = readBoolean(raw, "launch", true, index, reposYmlPath);
    // A header exists to hold its children, which nest by path — without one
    // it would have nothing under it (command/cwd, by contrast, go unused).
    if (!launch && raw.path === undefined) {
        throw new ConfigError(t("cfg_path_required_group", { file: reposYmlPath, where: `repos[${index}].path` }), "entry_invalid", index);
    }
    // path
    let resolvedPath = "";
    if (raw.path !== undefined) {
        if (typeof raw.path !== "string") {
            throw new ConfigError(t("cfg_must_be_string", { file: reposYmlPath, where: `repos[${index}].path` }), "entry_invalid", index);
        }
        resolvedPath = resolve(expandPath(raw.path));
        if (!isUnderHome(resolvedPath)) {
            throw new ConfigError(t("cfg_outside_home", { file: reposYmlPath, where: `repos[${index}].path`, path: String(raw.path) }), "path_outside_home", index);
        }
        rejectShellMetachars("path", resolvedPath, index, reposYmlPath);
        if (!disabled && !existsSync(resolvedPath)) {
            sink({
                code: "path_missing",
                message: t("cfg_path_missing", { path: String(raw.path), where: `repos[${index}]`, name }),
            });
        }
    }
    // cwd
    let resolvedCwd = resolvedPath;
    if (raw.cwd !== undefined) {
        if (typeof raw.cwd !== "string") {
            throw new ConfigError(t("cfg_must_be_string", { file: reposYmlPath, where: `repos[${index}].cwd` }), "entry_invalid", index);
        }
        resolvedCwd = resolve(expandPath(raw.cwd));
        if (!isUnderHome(resolvedCwd)) {
            throw new ConfigError(t("cfg_outside_home", { file: reposYmlPath, where: `repos[${index}].cwd`, path: String(raw.cwd) }), "path_outside_home", index);
        }
        rejectShellMetachars("cwd", resolvedCwd, index, reposYmlPath);
    }
    // command
    let command;
    if (raw.command !== undefined) {
        if (typeof raw.command !== "string") {
            throw new ConfigError(t("cfg_must_be_string", { file: reposYmlPath, where: `repos[${index}].command` }), "entry_invalid", index);
        }
        command = raw.command;
    }
    else if (defaultsCommand !== undefined) {
        command = defaultsCommand;
    }
    else {
        command = envCommand() ?? "claude";
    }
    // Reject shell metachars in resolved command (S1 hardening). The command
    // string is re-executed unquoted by bin/ccs via `${ROW_CMD} ...`, so any
    // metachar here would break the last line of defense.
    rejectShellMetachars("command", command, index, reposYmlPath);
    // description — a blank `description:` (YAML null) means unset, not "null".
    const description = raw.description === undefined || raw.description === null
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
            throw new ConfigError(t("cfg_must_be_string", { file: reposYmlPath, where: `repos[${index}].label` }), "entry_invalid", index);
        }
        label = raw.label;
    }
    // lead — the entry that leads its group (a director, a coordinator): listed
    // first among its siblings, and marked 👑 in the list.
    const lead = readBoolean(raw, "lead", false, index, reposYmlPath);
    // tags
    let tags = [];
    if (raw.tags !== undefined) {
        if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === "string")) {
            throw new ConfigError(t("cfg_tags", { file: reposYmlPath, where: `repos[${index}].tags` }), "entry_invalid", index);
        }
        tags = [...raw.tags];
    }
    // scan
    const scan = readBoolean(raw, "scan", true, index, reposYmlPath);
    // icon — a blank `icon:` (YAML null) means unset, so the default shows.
    const icon = raw.icon === undefined || raw.icon === null ? "📁" : String(raw.icon);
    // custom
    let custom = {};
    if (raw.custom !== undefined) {
        if (!isPlainObject(raw.custom)) {
            throw new ConfigError(t("cfg_must_be_object", { file: reposYmlPath, where: `repos[${index}].custom` }), "entry_invalid", index);
        }
        // Reject bloated `custom` blobs before they reach downstream code.
        // Size check only — downstream code re-serializes as needed.
        const customJson = JSON.stringify(raw.custom);
        if (customJson.length > 64_000) {
            throw new ConfigError(t("cfg_custom_too_large", { file: reposYmlPath, where: `repos[${index}].custom`, got: customJson.length }), "custom_too_large", index);
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
/**
 * The launcher's load: scaffolds a missing config (first run), then parses it,
 * printing each warning on stderr. Throws ConfigError.
 *
 * With `scaffold: false` (the machine interface's scan) nothing but the cache
 * directory is created, and a missing repos.yml is config_not_readable.
 */
export function loadConfig(opts = {}) {
    const paths = getPaths();
    if (opts.scaffold === false) {
        mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
    }
    else {
        ensureConfigDir();
    }
    let source;
    try {
        source = readFileSync(paths.reposYml, "utf-8");
    }
    catch (err) {
        throw new ConfigError(t("cfg_unreadable", { file: paths.reposYml, reason: err.message }), "config_not_readable");
    }
    return parseConfigSource(source, paths.reposYml, opts.sink ?? consoleSink, opts.scaffold !== false);
}
/**
 * The read-only load for the machine interface (`ccs doctor`, `ccs list
 * --json`): creates nothing (no directory, no template, no README) and prints
 * nothing — warnings come back to the caller. A missing repos.yml is
 * `{ found: false }`, not an error. Throws ConfigError like loadConfig.
 */
export function readConfig() {
    const paths = getPaths();
    if (!existsSync(paths.reposYml))
        return { found: false };
    let source;
    try {
        source = readFileSync(paths.reposYml, "utf-8");
    }
    catch (err) {
        throw new ConfigError(t("cfg_unreadable", { file: paths.reposYml, reason: err.message }), "config_not_readable");
    }
    const warnings = [];
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
export function parseConfigSource(source, reposYmlPath, sink = consoleSink, yamlWarnings = true) {
    const paths = { reposYml: reposYmlPath };
    let parsed;
    try {
        parsed = yamlWarnings ? parseYaml(source) : parseYaml(source, { logLevel: "error" });
    }
    catch (err) {
        throw new ConfigError(t("cfg_yaml_error", { file: paths.reposYml, reason: err.message }), "yaml_parse_error");
    }
    if (!isPlainObject(parsed)) {
        throw new ConfigError(t("cfg_top_not_object", { file: paths.reposYml }), "not_a_mapping");
    }
    // An anchor used inside itself (`disabled: &x [*x]`) gives a value that
    // contains itself; every later check (JSON.stringify, the entry hash) would
    // crash on it instead of naming the key.
    if (Array.isArray(parsed.repos)) {
        parsed.repos.forEach((entry, i) => {
            if (containsItself(entry)) {
                throw new ConfigError(t("cfg_self_reference", { file: paths.reposYml, where: `repos[${i}]` }), "entry_invalid", i);
            }
        });
    }
    if (containsItself(parsed)) {
        throw new ConfigError(t("cfg_self_reference_file", { file: paths.reposYml }), "yaml_parse_error");
    }
    warnUnknownKeys(parsed, KNOWN_TOP_KEYS, "top-level", sink);
    // version
    if (parsed.version !== 1) {
        throw new ConfigError(t("cfg_version", { file: paths.reposYml, got: String(parsed.version) }), "unsupported_version");
    }
    // defaults
    let defaultsCommand;
    let defaultsTerminal = null;
    let defaultsUpdateCheck = true;
    let defaultsLanguage = "auto";
    let defaultsGroupsDir = null;
    if (parsed.defaults !== undefined) {
        if (!isPlainObject(parsed.defaults)) {
            throw new ConfigError(t("cfg_must_be_object", { file: paths.reposYml, where: "defaults" }), "defaults_invalid");
        }
        const defaults = parsed.defaults;
        if (defaults.command !== undefined) {
            if (typeof defaults.command !== "string") {
                throw new ConfigError(t("cfg_must_be_string", { file: paths.reposYml, where: "defaults.command" }), "defaults_invalid");
            }
            defaultsCommand = defaults.command;
        }
        // ui — one look since v0.6.0. The key stays (repos.yml version 1 keeps
        // its keys and their meaning): simple or empty is read without a word,
        // classic gets one warning and opens the simple look, anything else is
        // still an error.
        if (defaults.ui !== undefined && defaults.ui !== null && defaults.ui !== "simple") {
            if (defaults.ui !== "classic") {
                throw new ConfigError(t("cfg_ui_value", { file: paths.reposYml, got: JSON.stringify(defaults.ui) }), "defaults_invalid");
            }
            sink({
                code: "ui_classic_dropped",
                message: t("cfg_ui_classic"),
            });
        }
        // terminal — `ccs open --new-window` picks its app from this list only.
        if (defaults.terminal !== undefined && defaults.terminal !== null) {
            if (!isTerminalApp(defaults.terminal)) {
                throw new ConfigError(t("cfg_one_of", { file: paths.reposYml, where: "defaults.terminal", allowed: TERMINAL_APPS.join(" / "), got: JSON.stringify(defaults.terminal) }), "defaults_invalid");
            }
            defaultsTerminal = defaults.terminal;
        }
        // language — the language of ccs's own text (docs/design/i18n.md). An
        // unknown value is skipped with one warning, never an error: a typo here
        // must not keep the list from opening. bin/ccs reads the same line itself
        // (no Node at start) and skips such a value too.
        if (defaults.language !== undefined && defaults.language !== null && defaults.language !== "") {
            if (isLanguageSetting(defaults.language)) {
                defaultsLanguage = defaults.language;
            }
            else {
                sink({
                    code: "language_unknown",
                    message: t("cfg_language_unknown", {
                        got: String(JSON.stringify(defaults.language)).slice(0, 40),
                    }),
                });
            }
        }
        // update_check — true or false only, as strict as the entry flags: a
        // quoted "false" must not silently leave the check on.
        if (defaults.update_check !== undefined && defaults.update_check !== null) {
            if (typeof defaults.update_check !== "boolean") {
                throw new ConfigError(t("cfg_must_be_bool", { file: paths.reposYml, where: "defaults.update_check", got: JSON.stringify(defaults.update_check) }), "defaults_invalid");
            }
            defaultsUpdateCheck = defaults.update_check;
        }
        // groups_dir — a folder of group definition files other tools keep
        // (ccs-groups.ts). Held to the same rules as a repo `path`: under $HOME,
        // no shell metacharacters.
        if (defaults.groups_dir !== undefined && defaults.groups_dir !== null) {
            if (typeof defaults.groups_dir !== "string" || defaults.groups_dir === "") {
                throw new ConfigError(t("cfg_groups_dir", { file: paths.reposYml }), "defaults_invalid");
            }
            const dir = resolve(expandPath(defaults.groups_dir));
            if (!isUnderHome(dir)) {
                throw new ConfigError(t("cfg_outside_home", { file: paths.reposYml, where: "defaults.groups_dir", path: String(defaults.groups_dir) }), "path_outside_home");
            }
            if (SHELL_METACHARS.test(dir)) {
                throw new ConfigError(t("cfg_metachars", { file: paths.reposYml, where: "defaults.groups_dir", got: JSON.stringify(defaults.groups_dir) }), "path_unsafe");
            }
            defaultsGroupsDir = dir;
        }
    }
    // defaults.command resolution: explicit defaults > env > "claude"
    const resolvedDefaultsCommand = defaultsCommand ?? envCommand() ?? "claude";
    // Gate the resolved default at origin (review A-6): it is persisted to the
    // meta table for unmapped-session fallback and exposed on CcsConfig, so it
    // must satisfy the same metachar policy as per-repo commands even when no
    // repo currently inherits it. resolveRepoEntry re-checks as defense in depth.
    if (SHELL_METACHARS.test(resolvedDefaultsCommand)) {
        throw new ConfigError(t("cfg_metachars", { file: paths.reposYml, where: "defaults.command / CCS_CMD / CCR_CMD", got: JSON.stringify(resolvedDefaultsCommand) }), "command_unsafe");
    }
    // repos
    if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
        throw new ConfigError(t("cfg_repos_empty", { file: paths.reposYml }), "repos_empty");
    }
    const repos = parsed.repos.map((raw, i) => resolveRepoEntry(raw, i, defaultsCommand, paths.reposYml, sink));
    // uniqueness check
    const byName = new Map();
    repos.forEach((r, i) => {
        const list = byName.get(r.name) ?? [];
        list.push(i);
        byName.set(r.name, list);
    });
    const dupes = [];
    let firstDupeIndex;
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
        throw new ConfigError(t("cfg_duplicate_name", { file: paths.reposYml, names: dupes.join("; ") }), "duplicate_name", firstDupeIndex);
    }
    return {
        version: 1,
        defaults: { command: resolvedDefaultsCommand, ui: "simple" },
        settings: {
            terminal: defaultsTerminal,
            updateCheck: defaultsUpdateCheck,
            language: defaultsLanguage,
            groupsDir: defaultsGroupsDir,
        },
        repos,
    };
}
