/**
 * ccs-machine.ts — the machine interface's common ground.
 *
 * GUI launchers, scripts and other tools call ccs without a terminal:
 * `ccs doctor`, `ccs list --json`, `ccs sessions --json`, `ccs repo
 * add|remove`, `ccs config get|set` and `ccs open`. Every one of them shares what lives here: the outer JSON object,
 * the exit codes and their status words, the two reason vocabularies, flag
 * parsing, and the SIGINT rule. The contract is docs/design/machine-interface.md
 * (chapter 1); change that document before changing the shapes here.
 *
 * Run as a script, this module dispatches every machine word but `doctor`
 * (bin/ccs runs bin/ccs-doctor.ts itself, in two stages):
 *
 *   node ccs-machine.ts list --json [--with-paths]
 *   node ccs-machine.ts sessions --json [--project <name>] [--limit <n>] …
 *   node ccs-machine.ts repo add|remove …    config get|set …
 *   node ccs-machine.ts open …               (through bin/ccs: it starts the command)
 *
 * None of these commands opens fzf, reads stdin, asks anything, goes to the
 * network, or creates the config template. Only `repo add` may create
 * repos.yml, and only `sessions` (its scan) writes the cache.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "./ccs-config.js";
import { jsonForTerminal } from "./ccs-sanitize.js";
import { t } from "./ccs-i18n.js";
// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
/** The machine interface's own version: minor = additions, major = breaks. */
export const SCHEMA_VERSION = "1.0.0";
export const PRODUCT_ID = "ccs";
/** The package whose package.json may name the version (as bin/ccs reads it). */
const CCS_PACKAGE = "@indigo-gr/claude-code-station";
export const EXIT_CODE = {
    ok: 0,
    failed: 1,
    usage: 2,
    unverifiable: 3,
    missing_prerequisite: 4,
    not_found: 5,
    rejected: 6,
    partial: 7,
    interrupted: 130,
};
/** The status each ccs.cli word goes with (the table in 1.5). */
export const CLI_CODE_STATUS = {
    ok: "ok",
    unknown_option: "usage",
    missing_argument: "usage",
    extra_argument: "usage",
    invalid_argument: "usage",
    json_required: "usage",
    conflicting_options: "usage",
    config_not_readable: "unverifiable",
    cache_not_readable: "unverifiable",
    config_missing: "missing_prerequisite",
    config_invalid: "missing_prerequisite",
    cache_missing: "missing_prerequisite",
    no_tty: "missing_prerequisite",
    unsupported_os: "missing_prerequisite",
    terminal_not_set: "missing_prerequisite",
    terminal_app_missing: "missing_prerequisite",
    unsafe_install_path: "missing_prerequisite",
    dependency_missing: "missing_prerequisite",
    repo_not_found: "not_found",
    session_not_found: "not_found",
    path_outside_home: "rejected",
    path_not_found: "rejected",
    path_not_directory: "rejected",
    path_taken: "rejected",
    name_taken: "rejected",
    unsafe_characters: "rejected",
    needs_quoting: "rejected",
    invalid_value: "rejected",
    invalid_uuid: "rejected",
    key_not_settable: "rejected",
    last_entry: "rejected",
    flow_style_repos: "rejected",
    not_launchable: "rejected",
    repo_disabled: "rejected",
    session_cwd_unknown: "rejected",
    command_unsafe: "rejected",
    config_changed: "failed",
    config_locked: "failed",
    write_failed: "failed",
    validation_after_write_failed: "failed",
    restore_failed: "partial",
    launch_failed: "failed",
    invalid_package_config: "failed",
    internal_error: "failed",
    interrupted: "interrupted",
};
// ---------------------------------------------------------------------------
// Product version
// ---------------------------------------------------------------------------
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
/**
 * The version `ccs --version` prints: package.json next to bin/, only when it
 * is this package's; `0.0.0-dev` otherwise (copy install, unreadable file).
 * Same rule as bin/ccs's read_package_version.
 */
export function productVersion(binDir = BIN_DIR) {
    try {
        const raw = JSON.parse(readFileSync(join(binDir, "..", "package.json"), "utf-8"));
        if (raw &&
            typeof raw === "object" &&
            raw.name === CCS_PACKAGE &&
            typeof raw.version === "string" &&
            VERSION_RE.test(raw.version)) {
            return raw.version;
        }
    }
    catch {
        // fall through
    }
    return "0.0.0-dev";
}
const BIN_DIR = dirname(fileURLToPath(import.meta.url));
// ---------------------------------------------------------------------------
// Building and printing
// ---------------------------------------------------------------------------
export function envelope(command, status, reasons, body = {}) {
    return {
        schema_version: SCHEMA_VERSION,
        product_id: PRODUCT_ID,
        product_version: productVersion(),
        command,
        written_at: new Date().toISOString(),
        status,
        reasons,
        ...body,
    };
}
/** One ccs.cli reason, its status taken from the table. */
export function cliOutcome(code, extra = {}, note) {
    return {
        status: CLI_CODE_STATUS[code],
        reasons: [{ vocab: "ccs.cli", code, ...extra }],
        note,
    };
}
export function okOutcome(body) {
    return { status: "ok", reasons: [{ vocab: "ccs.cli", code: "ok" }], body };
}
/**
 * Print an outcome and return its exit code. With --json, stdout gets exactly
 * one JSON object and a newline, on success and on failure alike; the body is
 * printed only on success (1.3). The note goes to stderr either way.
 */
/** One answer per process: set once emit() has run. */
let answered = false;
/**
 * True once this process has given its answer. SIGINT handlers check it: a
 * runner that starts the module in a child (tsx did) passes a SIGINT on, so
 * the module's process can get it twice (from the terminal's process group
 * and from the runner), and the second one must not
 * print a second JSON object (1.8: exactly one).
 */
export function hasAnswered() {
    return answered;
}
export function emit(command, outcome, json) {
    if (answered)
        return EXIT_CODE[outcome.status];
    answered = true;
    if (json) {
        const body = outcome.status === "ok" ? outcome.body : undefined;
        process.stdout.write(jsonForTerminal(envelope(command, outcome.status, outcome.reasons, body)) + "\n");
    }
    if (outcome.note)
        process.stderr.write(`[ccs] ${outcome.note}\n`);
    else if (outcome.status !== "ok") {
        const words = outcome.reasons
            .map((r) => (r.detail ? `${r.code} (${r.detail})` : r.code))
            .join(", ");
        process.stderr.write(`[ccs] ${command}: ${outcome.status}: ${words}\n`);
    }
    return EXIT_CODE[outcome.status];
}
/**
 * The reason for a repos.yml that could not be used (1.5): no file →
 * config_missing (4), no permission → config_not_readable (3), anything the
 * checks refuse → config_invalid (4) with the check's word in `detail`.
 */
export function configFailure(err) {
    if (err instanceof ConfigError) {
        if (err.code === "config_not_readable") {
            return cliOutcome("config_not_readable", {}, t("note_config_not_readable"));
        }
        const extra = { detail: err.code };
        if (err.entryIndex !== undefined)
            extra.entry_index = err.entryIndex;
        return cliOutcome("config_invalid", extra, `repos.yml fails ccs's checks (config_invalid: ${err.code}` +
            (err.entryIndex !== undefined ? `, repos[${err.entryIndex}]` : "") +
            "); run `ccs doctor` or open the list to see the message");
    }
    return cliOutcome("internal_error");
}
/**
 * Parse a command's arguments against its flags. Unknown flags are an error
 * (unknown_option) — the machine interface never passes flags on, except
 * after a bare `--`.
 */
export function parseFlags(argv, spec) {
    const booleans = new Set();
    const values = new Map();
    const positionals = [];
    const valueFlags = new Set(spec.values ?? []);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
            return { ok: true, booleans, values, positionals, rest: argv.slice(i + 1) };
        }
        if (!a.startsWith("-") || a === "-") {
            positionals.push(a);
            continue;
        }
        const eq = a.indexOf("=");
        const name = eq === -1 ? a : a.slice(0, eq);
        if (spec.booleans.includes(name) && eq === -1) {
            booleans.add(name);
        }
        else if (valueFlags.has(name)) {
            if (eq !== -1) {
                values.set(name, a.slice(eq + 1));
            }
            else if (i + 1 < argv.length) {
                values.set(name, argv[++i]);
            }
            else {
                return { ok: false, code: "missing_argument" };
            }
        }
        else {
            return { ok: false, code: "unknown_option" };
        }
    }
    return { ok: true, booleans, values, positionals, rest: [] };
}
/** True when `--json` is among the arguments (before a bare `--`). */
export function wantsJson(argv) {
    for (const a of argv) {
        if (a === "--")
            return false;
        if (a === "--json")
            return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// SIGINT
// ---------------------------------------------------------------------------
/**
 * On SIGINT: run `cleanup` (undo a half-done write, drop a lock), print the
 * interrupted outcome and exit 130 (1.4). The read-only commands have nothing
 * to undo, but still answer with the outer object.
 */
export function onInterrupt(command, json, cleanup) {
    process.on("SIGINT", () => {
        if (answered)
            return;
        try {
            cleanup?.();
        }
        finally {
            process.exitCode = emit(command, cliOutcome("interrupted"), json);
            process.exit();
        }
    });
}
// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
/** First-argument words bin/ccs hands to the machine interface. */
export const MACHINE_WORDS = ["doctor", "list", "sessions", "repo", "config", "open"];
async function main(argv) {
    const [word, ...args] = argv;
    const json = wantsJson(args);
    switch (word) {
        case "list": {
            const { runList } = await import("./ccs-list-json.js");
            return runList(args);
        }
        case "sessions": {
            const { sessionsOutcome } = await import("./ccs-sessions.js");
            onInterrupt("sessions", json);
            return emit("sessions", await sessionsOutcome(args), json);
        }
        case "repo":
        case "config": {
            const { runRepoOrConfig } = await import("./ccs-repo.js");
            return runRepoOrConfig(word, args);
        }
        case "open": {
            const { runOpen } = await import("./ccs-open.js");
            return runOpen(args);
        }
        default:
            return emit(String(word ?? ""), cliOutcome("internal_error", {}, t("note_unknown_command")), json);
    }
}
// pathToFileURL, not `file://${argv[1]}`: a folder with a space (or any
// character a URL escapes) in its name would never match.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const argv = process.argv.slice(2);
    const command = argv[0] ?? "";
    const json = wantsJson(argv.slice(1));
    main(argv)
        .then((code) => {
        process.exitCode = code;
    })
        .catch(() => {
        process.exitCode = emit(command, cliOutcome("internal_error"), json);
    });
}
