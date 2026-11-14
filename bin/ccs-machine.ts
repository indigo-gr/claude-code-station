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
 *   tsx ccs-machine.ts list --json [--with-paths]
 *   tsx ccs-machine.ts sessions --json [--project <name>] [--limit <n>] …
 *   tsx ccs-machine.ts repo add|remove …    config get|set …
 *   tsx ccs-machine.ts open …               (through bin/ccs: it starts the command)
 *
 * None of these commands opens fzf, reads stdin, asks anything, goes to the
 * network, or creates the config template. Only `repo add` may create
 * repos.yml, and only `sessions` (its scan) writes the cache.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError } from "./ccs-config.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The machine interface's own version: minor = additions, major = breaks. */
export const SCHEMA_VERSION = "1.0.0";

export const PRODUCT_ID = "ccs";

/** The package whose package.json may name the version (as bin/ccs reads it). */
const CCS_PACKAGE = "@indigo-gr/claude-code-station";

/** Status words, one per exit code (machine-interface.md 1.4). */
export type Status =
  | "ok"
  | "failed"
  | "usage"
  | "unverifiable"
  | "missing_prerequisite"
  | "not_found"
  | "rejected"
  | "partial"
  | "interrupted";

export const EXIT_CODE: Readonly<Record<Status, number>> = {
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

export type Vocab = "ccs.health" | "ccs.cli";

/** Reason words of every command but doctor (machine-interface.md 1.5). */
export type CliCode =
  | "ok"
  | "unknown_option"
  | "missing_argument"
  | "extra_argument"
  | "invalid_argument"
  | "json_required"
  | "conflicting_options"
  | "config_not_readable"
  | "cache_not_readable"
  | "config_missing"
  | "config_invalid"
  | "cache_missing"
  | "no_tty"
  | "unsupported_os"
  | "terminal_not_set"
  | "terminal_app_missing"
  | "unsafe_install_path"
  | "dependency_missing"
  | "repo_not_found"
  | "session_not_found"
  | "path_outside_home"
  | "path_not_found"
  | "path_not_directory"
  | "path_taken"
  | "name_taken"
  | "unsafe_characters"
  | "needs_quoting"
  | "invalid_value"
  | "invalid_uuid"
  | "key_not_settable"
  | "last_entry"
  | "flow_style_repos"
  | "not_launchable"
  | "repo_disabled"
  | "session_cwd_unknown"
  | "command_unsafe"
  | "config_changed"
  | "config_locked"
  | "write_failed"
  | "validation_after_write_failed"
  | "restore_failed"
  | "launch_failed"
  | "invalid_package_config"
  | "internal_error"
  | "interrupted";

/** The status each ccs.cli word goes with (the table in 1.5). */
export const CLI_CODE_STATUS: Readonly<Record<CliCode, Status>> = {
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

export interface Reason {
  vocab: Vocab;
  code: string;
  /** config_invalid: the config check's word (ConfigErrorCode). */
  detail?: string;
  /** config_invalid: index into repos[] when one entry is at fault. */
  entry_index?: number;
}

/** The outer object every command prints (1.3), in this key order. */
export interface Envelope {
  schema_version: string;
  product_id: string;
  product_version: string;
  command: string;
  written_at: string;
  status: Status;
  reasons: Reason[];
  [key: string]: unknown;
}

/** What a command decided: its exit status, reasons and own keys. */
export interface Outcome {
  status: Status;
  reasons: Reason[];
  /** Keys after `reasons` (only on success, per 1.3). */
  body?: Record<string, unknown>;
  /** One line for people on stderr (never a repo path or name). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Product version
// ---------------------------------------------------------------------------

const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * The version `ccs --version` prints: package.json next to bin/, only when it
 * is this package's; `0.0.0-dev` otherwise (copy install, unreadable file).
 * Same rule as bin/ccs's read_package_version.
 */
export function productVersion(binDir: string = BIN_DIR): string {
  try {
    const raw = JSON.parse(readFileSync(join(binDir, "..", "package.json"), "utf-8"));
    if (
      raw &&
      typeof raw === "object" &&
      raw.name === CCS_PACKAGE &&
      typeof raw.version === "string" &&
      VERSION_RE.test(raw.version)
    ) {
      return raw.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0-dev";
}

const BIN_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Building and printing
// ---------------------------------------------------------------------------

export function envelope(
  command: string,
  status: Status,
  reasons: Reason[],
  body: Record<string, unknown> = {},
): Envelope {
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
export function cliOutcome(
  code: CliCode,
  extra: Partial<Reason> = {},
  note?: string,
): Outcome {
  return {
    status: CLI_CODE_STATUS[code],
    reasons: [{ vocab: "ccs.cli", code, ...extra }],
    note,
  };
}

export function okOutcome(body: Record<string, unknown>): Outcome {
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
 * True once this process has given its answer. SIGINT handlers check it: tsx
 * passes a SIGINT on to the module's process, which then gets it twice (from
 * the terminal's process group and from tsx), and the second one must not
 * print a second JSON object (1.8: exactly one).
 */
export function hasAnswered(): boolean {
  return answered;
}

export function emit(command: string, outcome: Outcome, json: boolean): number {
  if (answered) return EXIT_CODE[outcome.status];
  answered = true;
  if (json) {
    const body = outcome.status === "ok" ? outcome.body : undefined;
    process.stdout.write(
      JSON.stringify(envelope(command, outcome.status, outcome.reasons, body)) + "\n",
    );
  }
  if (outcome.note) process.stderr.write(`[ccs] ${outcome.note}\n`);
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
export function configFailure(err: unknown): Outcome {
  if (err instanceof ConfigError) {
    if (err.code === "config_not_readable") {
      return cliOutcome("config_not_readable", {}, "cannot read repos.yml (config_not_readable)");
    }
    const extra: Partial<Reason> = { detail: err.code };
    if (err.entryIndex !== undefined) extra.entry_index = err.entryIndex;
    return cliOutcome(
      "config_invalid",
      extra,
      `repos.yml fails ccs's checks (config_invalid: ${err.code}` +
        (err.entryIndex !== undefined ? `, repos[${err.entryIndex}]` : "") +
        "); run `ccs doctor` or open the list to see the message",
    );
  }
  return cliOutcome("internal_error");
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface FlagSpec {
  /** Flags without a value (`--json`). */
  booleans: readonly string[];
  /** Flags taking a value: `--limit 5` or `--limit=5`. */
  values?: readonly string[];
}

export type ParsedFlags =
  | {
      ok: true;
      booleans: Set<string>;
      values: Map<string, string>;
      positionals: string[];
      /** Everything after a bare `--`, untouched. */
      rest: string[];
    }
  | { ok: false; code: "unknown_option" | "missing_argument" };

/**
 * Parse a command's arguments against its flags. Unknown flags are an error
 * (unknown_option) — the machine interface never passes flags on, except
 * after a bare `--`.
 */
export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
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
    } else if (valueFlags.has(name)) {
      if (eq !== -1) {
        values.set(name, a.slice(eq + 1));
      } else if (i + 1 < argv.length) {
        values.set(name, argv[++i]);
      } else {
        return { ok: false, code: "missing_argument" };
      }
    } else {
      return { ok: false, code: "unknown_option" };
    }
  }
  return { ok: true, booleans, values, positionals, rest: [] };
}

/** True when `--json` is among the arguments (before a bare `--`). */
export function wantsJson(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === "--") return false;
    if (a === "--json") return true;
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
export function onInterrupt(command: string, json: boolean, cleanup?: () => void): void {
  process.on("SIGINT", () => {
    if (answered) return;
    try {
      cleanup?.();
    } finally {
      process.exitCode = emit(command, cliOutcome("interrupted"), json);
      process.exit();
    }
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** First-argument words bin/ccs hands to the machine interface. */
export const MACHINE_WORDS = ["doctor", "list", "sessions", "repo", "config", "open"] as const;

async function main(argv: string[]): Promise<number> {
  const [word, ...args] = argv;
  const json = wantsJson(args);
  switch (word) {
    case "list": {
      const { runList } = await import("./ccs-list-json.ts");
      return runList(args);
    }
    case "sessions": {
      const { sessionsOutcome } = await import("./ccs-sessions.ts");
      onInterrupt("sessions", json);
      return emit("sessions", await sessionsOutcome(args), json);
    }
    case "repo":
    case "config": {
      const { runRepoOrConfig } = await import("./ccs-repo.ts");
      return runRepoOrConfig(word, args);
    }
    case "open": {
      const { runOpen } = await import("./ccs-open.ts");
      return runOpen(args);
    }
    default:
      return emit(
        String(word ?? ""),
        cliOutcome("internal_error", {}, "unknown machine command"),
        json,
      );
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
