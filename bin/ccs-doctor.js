/**
 * ccs-doctor.ts — stage 2 of `ccs doctor [--json]`.
 *
 * bin/ccs runs stage 1 in bash (node, tsx, fzf, claude: what must hold before
 * any module can load; tsx is no longer needed and stage 1 always passes it
 * as ok, so checks[] keeps its names and order) and passes the results here; this stage adds what
 * needs Node (the modules themselves, better-sqlite3, repos.yml, the cache)
 * and prints the whole answer. When this stage cannot start or answer, bin/ccs
 * builds the answer from stage 1 alone. Contract:
 * docs/design/machine-interface.md 2.1.
 *
 *   node ccs-doctor.ts [--json] --node <check> --tsx <check> --fzf <check> --claude <check>
 *   <check> = <status>:<code>[:<version>]   e.g. ok:ok:24.1.0, fail:fzf_missing
 *
 * Writes nothing, anywhere: no config template, no cache directory, no
 * state.db (it is opened read-only and must already exist), no status file.
 * No network, no update check. Prints no repo name or path, only words,
 * counts, versions and times. Exit code: 0 works, 1 does not, 3 cannot tell.
 *
 * Imports nothing that loads better-sqlite3 up front: that module is one of
 * the things checked, so it is loaded inside the check.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { getPaths, readConfig, ConfigError } from "./ccs-config.js";
import { readLogicalGroups } from "./ccs-groups.js";
import { envelope, EXIT_CODE } from "./ccs-machine.js";
import { jsonForTerminal } from "./ccs-sanitize.js";
import { pathToFileURL } from "node:url";
import { currentLang, t } from "./ccs-i18n.js";
const COMMAND = "doctor";
/** checks[] order, and which of them decide the answer. */
export const CHECK_ORDER = [
    "node",
    "tsx",
    "modules",
    "sqlite",
    "fzf",
    "claude",
    "config",
    "config_layout",
    "cache",
    "terminal",
    "groups_dir",
];
export const REQUIRED = new Set([
    "node",
    "tsx",
    "modules",
    "sqlite",
    "fzf",
    "claude",
    "config",
]);
const STATUSES = new Set(["ok", "warn", "fail", "unknown", "skipped"]);
const WORD_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
/**
 * Read one stage-1 result from bin/ccs. Anything not in the expected shape
 * counts as a crashed check rather than being trusted.
 */
export function parseStage1(name, raw) {
    const parts = (raw ?? "").split(":");
    const [status, code, version] = parts;
    if (parts.length < 2 ||
        parts.length > 3 ||
        !STATUSES.has(status) ||
        !WORD_RE.test(code ?? "") ||
        (version !== undefined && !VERSION_RE.test(version))) {
        return { name, status: "unknown", code: "check_crashed" };
    }
    const check = { name, status: status, code };
    if (version !== undefined)
        check.version = version;
    return check;
}
/** `sqlite`: better-sqlite3 loads and opens an in-memory database. */
export function checkSqlite() {
    try {
        const require = createRequire(import.meta.url);
        const Database = require("better-sqlite3");
        const db = new Database(":memory:");
        db.close();
        return { name: "sqlite", status: "ok", code: "ok" };
    }
    catch (err) {
        const msg = String(err?.message ?? err);
        const missing = /Cannot find module|Could not locate the bindings file|MODULE_NOT_FOUND|ENOENT/.test(msg) ||
            err?.code === "MODULE_NOT_FOUND";
        return {
            name: "sqlite",
            status: "fail",
            code: missing ? "sqlite_native_module_missing" : "sqlite_load_failed",
        };
    }
}
/**
 * `config` and `config_layout`: repos.yml through ccs's checks, read-only.
 * Only counts come out — which entries are meant is for a person to see in
 * the list's own message.
 */
export function checkConfig() {
    let result;
    try {
        result = readConfig();
    }
    catch (err) {
        const code = err instanceof ConfigError ? err.code : "config_not_readable";
        return {
            config: { name: "config", status: "fail", code },
            layout: { name: "config_layout", status: "skipped", code: "blocked" },
        };
    }
    if (!result.found) {
        return {
            config: { name: "config", status: "warn", code: "config_missing" },
            layout: { name: "config_layout", status: "skipped", code: "not_set" },
        };
    }
    const { config, warnings, source } = result;
    const unknownKeys = warnings.filter((w) => w.code === "unknown_key").length;
    const pathsMissing = warnings.filter((w) => w.code === "path_missing").length;
    const counts = {
        repos: config.repos.length,
        disabled: config.repos.filter((r) => r.disabled).length,
        paths_missing: pathsMissing,
        unknown_keys: unknownKeys,
    };
    let code = "ok";
    if (unknownKeys > 0)
        code = "unknown_keys";
    else if (pathsMissing > 0)
        code = "paths_missing";
    return {
        config: { name: "config", status: code === "ok" ? "ok" : "warn", code, ...counts },
        layout: checkLayout(source),
        terminal: config.settings.terminal,
        updateCheck: config.settings.updateCheck,
        groupsDir: checkGroupsDir(config),
    };
}
/**
 * `config_layout`: can a reader that does not use a YAML parser read it?
 * That needs a block list under `repos:`, and every item starting `- name:`
 * with `path:` right after (repos-yml-schema.md, the recommended form).
 */
export function checkLayout(source) {
    const doc = parseDocument(source, { logLevel: "error" });
    const repos = isMap(doc.contents) ? doc.contents.get("repos", true) : undefined;
    if (isSeq(repos) && repos.flow) {
        return { name: "config_layout", status: "warn", code: "flow_style_repos" };
    }
    if (isSeq(repos)) {
        for (const item of repos.items) {
            if (!isMap(item) || item.flow) {
                return { name: "config_layout", status: "warn", code: "name_path_not_direct" };
            }
            const keys = item.items.map((p) => (isScalar(p.key) ? p.key.value : undefined));
            const pathAt = keys.indexOf("path");
            if (keys[0] !== "name" || (pathAt !== -1 && pathAt !== 1)) {
                return { name: "config_layout", status: "warn", code: "name_path_not_direct" };
            }
        }
    }
    return { name: "config_layout", status: "ok", code: "ok" };
}
/**
 * `cache`: state.db opens read-only and its schema version is known. Never
 * creates it (a missing file is a warning, and stays missing).
 */
export async function checkCache() {
    const { stateDb } = getPaths();
    if (!existsSync(stateDb))
        return { name: "cache", status: "warn", code: "cache_missing" };
    try {
        const { openDb, getCurrentSchemaVersion, CURRENT_SCHEMA_VERSION } = await import("./ccs-db.js");
        const handle = openDb(stateDb, { readonly: true, skipMigrate: true });
        try {
            const schema = getCurrentSchemaVersion(handle.db);
            if (schema > CURRENT_SCHEMA_VERSION) {
                return { name: "cache", status: "warn", code: "cache_schema_newer", schema };
            }
            return { name: "cache", status: "ok", code: "ok", schema };
        }
        finally {
            handle.db.close();
        }
    }
    catch {
        return { name: "cache", status: "warn", code: "cache_open_failed" };
    }
}
// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------
/**
 * Overall status from the checks (2.1): a required `fail` → failed, with
 * every failing code; else a required `unknown` → unverifiable; else ok
 * (warnings stay ok).
 */
export function decide(checks) {
    const required = checks.filter((c) => REQUIRED.has(c.name));
    const failed = required.filter((c) => c.status === "fail");
    if (failed.length > 0)
        return { status: "failed", codes: failed.map((c) => c.code) };
    const unknown = required.filter((c) => c.status === "unknown");
    if (unknown.length > 0)
        return { status: "unverifiable", codes: unknown.map((c) => c.code) };
    return { status: "ok", codes: ["ok"] };
}
/**
 * `groups_dir`: when defaults.groups_dir is set, can its folder be read, and
 * was every group file usable? Counts only (no file or group name).
 */
export function checkGroupsDir(config) {
    const dir = config.settings.groupsDir;
    if (!dir)
        return { name: "groups_dir", status: "skipped", code: "not_set" };
    const read = readLogicalGroups(dir, config.repos);
    if (read.missing)
        return { name: "groups_dir", status: "warn", code: "groups_dir_missing" };
    const counts = { groups: read.groups.length, files_skipped: read.skipped };
    if (read.skipped > 0) {
        return { name: "groups_dir", status: "warn", code: "group_files_skipped", ...counts };
    }
    return { name: "groups_dir", status: "ok", code: "ok", ...counts };
}
/**
 * `terminal`: when defaults.terminal is set, can `ccs open --new-window` use
 * it here (macOS, and the app's bundle in its fixed place)?
 */
export async function checkTerminal(app) {
    if (!app)
        return { name: "terminal", status: "skipped", code: "not_set" };
    if (process.platform !== "darwin") {
        return { name: "terminal", status: "warn", code: "terminal_unsupported_os" };
    }
    const { terminalAppInstalled } = await import("./ccs-open.js");
    if (!terminalAppInstalled(app)) {
        return { name: "terminal", status: "warn", code: "terminal_app_missing" };
    }
    return { name: "terminal", status: "ok", code: "ok" };
}
export async function runDoctor(stage1) {
    const node = parseStage1("node", stage1.node);
    const tsx = parseStage1("tsx", stage1.tsx);
    const fzf = parseStage1("fzf", stage1.fzf);
    const claude = parseStage1("claude", stage1.claude);
    const modules = { name: "modules", status: "ok", code: "ok" };
    const sqlite = checkSqlite();
    const found = checkConfig();
    const cache = sqlite.status === "ok"
        ? await checkCache()
        : { name: "cache", status: "skipped", code: "blocked" };
    const terminal = await checkTerminal(found.terminal ?? null);
    const groupsDir = found.groupsDir ?? {
        name: "groups_dir",
        status: "skipped",
        code: found.config.status === "fail" ? "blocked" : "not_set",
    };
    const checks = [
        node,
        tsx,
        modules,
        sqlite,
        fzf,
        claude,
        found.config,
        found.layout,
        cache,
        terminal,
        groupsDir,
    ];
    const { status, codes } = decide(checks);
    const updateOffByEnv = (process.env.CCS_NO_UPDATE_CHECK ?? "") !== "";
    const updateOffByConfig = !updateOffByEnv && found.updateCheck === false;
    const json = envelope(COMMAND, status, codes.map((code) => ({ vocab: "ccs.health", code })), {
        installed: "installed",
        running: "not_applicable",
        checks,
        platform: { os: process.platform, arch: process.arch },
        settings: {
            // One look since v0.6.0; the key stays for readers of the answer.
            ui: "simple",
            update_check: updateOffByEnv || updateOffByConfig ? "off" : "on",
            update_check_off_by: updateOffByEnv ? "env" : updateOffByConfig ? "config" : null,
            // The language bin/ccs decided for this run (docs/design/i18n.md 2).
            language: currentLang(),
        },
    });
    // envelope() puts the outer keys first; the Health frame's installed/running
    // follow status, before reasons.
    const ordered = {};
    for (const key of [
        "schema_version",
        "product_id",
        "product_version",
        "command",
        "written_at",
        "status",
        "installed",
        "running",
        "reasons",
        "checks",
        "platform",
        "settings",
    ]) {
        ordered[key] = json[key];
    }
    return { exitCode: EXIT_CODE[status], json: ordered, checks };
}
/** The people's table (outside the contract: wording may change). */
export function humanTable(answer) {
    const lines = answer.checks.map((c) => {
        const extra = Object.entries(c)
            .filter(([k]) => !["name", "status", "code"].includes(k))
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ");
        const code = c.code === "ok" ? "" : c.code;
        return `  ${c.name.padEnd(14)}${c.status.padEnd(9)}${code}${extra ? (code ? "  " : "") + extra : ""}`.trimEnd();
    });
    // The same lines as bin/ccs prints when stage 2 cannot run (doctor_* keys);
    // the table under them is words and stays as it is in every language.
    const status = String(answer.json.status);
    const head = status === "ok" ? t("doctor_ok") : status === "failed" ? t("doctor_failed") : t("doctor_unknown", { status });
    return `${head}\n${lines.join("\n")}\n`;
}
// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const STAGE1_FLAGS = ["--node", "--tsx", "--fzf", "--claude"];
// pathToFileURL, not `file://${argv[1]}`: a folder with a space (or any
// character a URL escapes) in its name would never match.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const argv = process.argv.slice(2);
    let json = false;
    const stage1 = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json")
            json = true;
        else if (STAGE1_FLAGS.includes(a) && i + 1 < argv.length)
            stage1[a.slice(2)] = argv[++i];
        // Anything else came from bin/ccs, which validated the user's arguments.
    }
    process.once("SIGINT", () => {
        // bin/ccs answers an interrupted doctor itself; leave without output.
        process.exit(130);
    });
    runDoctor(stage1).then((answer) => {
        process.stdout.write(json ? jsonForTerminal(answer.json) + "\n" : humanTable(answer));
        process.exitCode = answer.exitCode;
    });
}
