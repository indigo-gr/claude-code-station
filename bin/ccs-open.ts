/**
 * ccs-open.ts — `ccs open (--repo <name> | --session <uuid>) [--here |
 * --new-window] [--terminal <app>] [--json] [-- <args>…]`.
 *
 * Starts Claude Code without fzf, through the same rules as a row picked in
 * the list: the working folder must be under $HOME, the command passes the
 * metacharacter check, a session ID must look like one. Callers pass a name
 * or a UUID — never a path or a command. Contract:
 * docs/design/machine-interface.md 4.6.
 *
 * This module decides; it does not start anything in this terminal.
 *  --here        bin/ccs gives it CCS_OPEN_PLAN (a file) and CCS_OPEN_TTY.
 *                On success the plan (kind, key, cwd, command; NUL-separated)
 *                goes to that file, stdout stays empty, and bin/ccs checks it
 *                again and runs the command as the list does.
 *  --new-window  macOS only: a one-shot `.command` file that runs
 *                `ccs open --here …` is handed to the terminal app with
 *                `open -a`, and this returns without waiting. The file
 *                deletes itself (and its folder) when it starts.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  getPaths,
  isTerminalApp,
  isUnderHome,
  TERMINAL_APPS,
  readConfig,
  type CcsConfig,
  type TerminalApp,
} from "./ccs-config.ts";
import {
  cliOutcome,
  configFailure,
  emit,
  hasAnswered,
  okOutcome,
  parseFlags,
  wantsJson,
  type Outcome,
} from "./ccs-machine.ts";
import { sanitizeSessionCwd, SHELL_METACHARS } from "./ccs-sanitize.ts";

const COMMAND = "open";
const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Each terminal app: the name `open -a` takes and where the .app may live. */
export const TERMINAL_APP_INFO: Readonly<
  Record<TerminalApp, { openName: string; bundles: (home: string) => string[] }>
> = {
  terminal: {
    openName: "Terminal",
    bundles: () => [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app",
    ],
  },
};

/** The app's bundle is in one of its fixed places (Finder is never asked). */
export function terminalAppInstalled(app: TerminalApp, home: string = homedir()): boolean {
  return TERMINAL_APP_INFO[app].bundles(home).some((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The program a command line starts is runnable (absolute, or found on PATH). */
export function programFound(command: string, pathEnv: string = process.env.PATH ?? ""): boolean {
  const program = command.trim().split(/\s+/)[0] ?? "";
  if (program === "") return false;
  const runnable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (program.includes("/")) return runnable(program);
  return pathEnv.split(delimiter).some((dir) => dir !== "" && runnable(join(dir, program)));
}

/** What to start, after every check. */
export interface LaunchPlan {
  kind: "new" | "resume";
  /** The repo's name, or the session's UUID. */
  key: string;
  cwd: string;
  command: string;
}

type Resolved = { ok: true; plan: LaunchPlan } | { ok: false; outcome: Outcome };

function fail(outcome: Outcome): Resolved {
  return { ok: false, outcome };
}

/** The env's launch command (CCS_CMD, then CCR_CMD), as ccs-config resolves it. */
function envCommand(): string {
  return process.env.CCS_CMD || process.env.CCR_CMD || "claude";
}

/** Find the target and run every check but the terminal's (4.6 table). */
export async function resolveTarget(
  target: { repo?: string; session?: string },
  config: CcsConfig | null,
  configError: unknown,
): Promise<Resolved> {
  let plan: LaunchPlan;
  if (target.repo !== undefined) {
    if (configError !== undefined) return fail(configFailure(configError));
    if (!config) return fail(cliOutcome("config_missing", {}, "no repos.yml yet (config_missing)"));
    const repo = config.repos.find((r) => r.name === target.repo);
    if (!repo) return fail(cliOutcome("repo_not_found"));
    if (!repo.launch) return fail(cliOutcome("not_launchable"));
    if (repo.disabled) return fail(cliOutcome("repo_disabled"));
    plan = { kind: "new", key: repo.name, cwd: repo.cwd || repo.path, command: repo.command };
  } else {
    const uuid = target.session ?? "";
    if (!UUID_RE.test(uuid)) return fail(cliOutcome("invalid_uuid"));
    const { stateDb } = getPaths();
    if (!existsSync(stateDb)) {
      return fail(cliOutcome("cache_missing", {}, "no cache yet (cache_missing); open the list once, or run ccs --refresh"));
    }
    let row: { cwd: string; repo_name: string | null } | undefined;
    try {
      const { openDb } = await import("./ccs-db.ts");
      const handle = openDb(stateDb, { readonly: true, skipMigrate: true });
      try {
        row = handle.db
          .prepare(`SELECT cwd, repo_name FROM sessions WHERE uuid = ?`)
          .get(uuid) as typeof row;
      } finally {
        handle.db.close();
      }
    } catch {
      return fail(cliOutcome("cache_not_readable", {}, "cannot open the cache (cache_not_readable)"));
    }
    if (!row) return fail(cliOutcome("session_not_found"));
    const cwd = typeof row.cwd === "string" ? sanitizeSessionCwd(row.cwd) : null;
    if (!cwd) return fail(cliOutcome("session_cwd_unknown"));
    // The launch command: the matching entry's, else the default chain.
    if (configError !== undefined) return fail(configFailure(configError));
    const repo = config?.repos.find((r) => r.name === row?.repo_name);
    const command = repo ? repo.command : (config?.defaults.command ?? envCommand());
    plan = { kind: "resume", key: uuid, cwd, command };
  }

  if (plan.cwd === "") return fail(cliOutcome("path_not_found"));
  // Unlike the list, never fall back to the current folder: a caller would
  // not notice that Claude Code started somewhere else.
  if (plan.cwd.split("/").includes("..") || !isUnderHome(plan.cwd)) {
    return fail(cliOutcome("path_outside_home"));
  }
  let isDir = false;
  try {
    isDir = statSync(plan.cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return fail(cliOutcome("path_not_found"));
  if (SHELL_METACHARS.test(plan.command) || plan.command.trim() === "") {
    return fail(cliOutcome("command_unsafe"));
  }
  if (!programFound(plan.command)) {
    return fail(cliOutcome("dependency_missing", { detail: "claude" }, "the launch command was not found on PATH (dependency_missing)"));
  }
  return { ok: true, plan };
}

/** The `.command` file's text: deletes itself, then runs `ccs open --here`. */
export function launcherScript(ccsPath: string, target: { repo?: string; session?: string }): string {
  const flag = target.repo !== undefined ? `--repo '${target.repo}'` : `--session '${target.session}'`;
  return (
    "#!/bin/sh\n" +
    'rm -f -- "$0"; rmdir -- "$(dirname -- "$0")" 2>/dev/null\n' +
    `exec '${ccsPath}' open --here ${flag}\n`
  );
}

export interface OpenRun {
  outcome: Outcome;
  /** --here, checks passed: the plan was written; print nothing. */
  silent: boolean;
}

export async function openRun(args: readonly string[]): Promise<OpenRun> {
  const answer = (outcome: Outcome): OpenRun => ({ outcome, silent: false });
  const flags = parseFlags(args, {
    booleans: ["--json", "--here", "--new-window"],
    values: ["--repo", "--session", "--terminal"],
  });
  if (!flags.ok) return answer(cliOutcome(flags.code));
  if (flags.positionals.length > 0) return answer(cliOutcome("extra_argument"));
  const repo = flags.values.get("--repo");
  const session = flags.values.get("--session");
  if (repo !== undefined && session !== undefined) return answer(cliOutcome("conflicting_options"));
  if (repo === undefined && session === undefined) return answer(cliOutcome("missing_argument"));
  const here = flags.booleans.has("--here");
  const newWindow = flags.booleans.has("--new-window");
  const terminalFlag = flags.values.get("--terminal");
  if (here && newWindow) return answer(cliOutcome("conflicting_options"));
  if (!newWindow && (terminalFlag !== undefined)) return answer(cliOutcome("conflicting_options"));
  if (newWindow && flags.rest.length > 0) return answer(cliOutcome("conflicting_options"));
  if (terminalFlag !== undefined && !isTerminalApp(terminalFlag)) {
    return answer(cliOutcome("invalid_argument", {}, `--terminal takes ${TERMINAL_APPS.join(" or ")}`));
  }
  const target = { repo, session };

  let config: CcsConfig | null = null;
  let configError: unknown;
  try {
    const result = readConfig();
    if (result.found) config = result.config;
  } catch (err) {
    configError = err;
  }

  if (!newWindow) {
    const resolved = await resolveTarget(target, config, configError);
    if (!resolved.ok) return answer(resolved.outcome);
    if (process.env.CCS_OPEN_TTY !== "1") {
      return answer(cliOutcome("no_tty", {}, "ccs open --here needs a terminal (no_tty); use --new-window from a script"));
    }
    const planFile = process.env.CCS_OPEN_PLAN;
    if (!planFile) return answer(cliOutcome("internal_error", {}, "run ccs open through bin/ccs"));
    const { kind, key, cwd, command } = resolved.plan;
    writeFileSync(planFile, [kind, key, cwd, command].join("\0") + "\0", { mode: 0o600 });
    return { outcome: okOutcome({ mode: "here" }), silent: true };
  }

  // --new-window (macOS only)
  if (process.platform !== "darwin") {
    return answer(cliOutcome("unsupported_os", {}, "ccs open --new-window works on macOS only (unsupported_os)"));
  }
  if (configError !== undefined && terminalFlag === undefined) {
    return answer(configFailure(configError));
  }
  const app = (terminalFlag as TerminalApp | undefined) ?? config?.settings.terminal ?? null;
  if (!app) {
    return answer(cliOutcome("terminal_not_set", {}, "choose a terminal app first: ccs config set defaults.terminal terminal (terminal_not_set)"));
  }
  if (!terminalAppInstalled(app)) return answer(cliOutcome("terminal_app_missing"));
  const resolved = await resolveTarget(target, config, configError);
  if (!resolved.ok) return answer(resolved.outcome);

  let ccsPath: string;
  try {
    ccsPath = realpathSync(join(BIN_DIR, "ccs"));
  } catch {
    return answer(cliOutcome("internal_error"));
  }
  if (SHELL_METACHARS.test(ccsPath)) return answer(cliOutcome("unsafe_install_path"));

  let dir: string;
  try {
    // bin/ccs runs this module with TMPDIR pointing into its own temporary
    // folder (removed when it exits); the launcher must outlive that.
    dir = mkdtempSync(join(process.env.CCS_OPEN_TMPDIR || tmpdir(), "ccs-open-")); // 0700
    writeFileSync(join(dir, "ccs-open.command"), launcherScript(ccsPath, target), { mode: 0o700 });
  } catch {
    return answer(cliOutcome("launch_failed", {}, "could not write the launcher file (launch_failed)"));
  }
  const res = spawnSync("open", ["-a", TERMINAL_APP_INFO[app].openName, join(dir, "ccs-open.command")], {
    stdio: "ignore",
    timeout: 15_000,
  });
  if (res.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return answer(cliOutcome("launch_failed", {}, "the terminal app did not take the launcher (launch_failed)"));
  }
  return answer(okOutcome({ mode: "new_window", terminal: app }));
}

export async function runOpen(args: readonly string[]): Promise<number> {
  const json = wantsJson(args);
  process.on("SIGINT", () => {
    if (hasAnswered()) return;
    process.exitCode = emit(COMMAND, cliOutcome("interrupted"), json);
    process.exit();
  });
  const { outcome, silent } = await openRun(args);
  if (silent) return 0;
  return emit(COMMAND, outcome, json);
}
