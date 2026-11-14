/**
 * ccs-repo.ts — the writing commands and the settings read:
 *
 *   ccs repo add <path> [--name <name>] [--description <text>] [--with-paths] [--json]
 *   ccs repo remove <name> [--json]
 *   ccs config get [--with-paths] [--json]
 *   ccs config set [--repo <name>] <key> <value> [--json]
 *
 * Every write goes through ccs-config-edit (lock, check, `.bak`, write in
 * place, check again, put back). Only the values a screen can offer are
 * settable: a fixed list of words, and an entry's label and description —
 * never a command string or a path (people who want those edit the file).
 * Contract: docs/design/machine-interface.md 2.4, 3 and 4.1–4.5.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { isMap, isSeq, type Document } from "yaml";

import {
  expandPath,
  isTerminalApp,
  isUnderHome,
  readConfig,
  TERMINAL_APPS,
  type CcsConfig,
} from "./ccs-config.ts";
import {
  codePointLength,
  EditStop,
  hasControlChars,
  needsQuoting,
  reposIsFlow,
  runEditAsync,
  type EditCode,
} from "./ccs-config-edit.ts";
import {
  cliOutcome,
  configFailure,
  emit,
  hasAnswered,
  okOutcome,
  parseFlags,
  wantsJson,
  type CliCode,
  type Outcome,
} from "./ccs-machine.ts";
import { SHELL_METACHARS } from "./ccs-sanitize.ts";
import { UI_MODES } from "./ccs-utils.ts";

const NAME_MAX = 100;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 200;

/** The first lines of a repos.yml that `repo add` creates. */
const NEW_CONFIG_HEAD = "# Claude Code Station — Repository Definitions\nversion: 1\n";

// ---------------------------------------------------------------------------
// SIGINT outside an edit
// ---------------------------------------------------------------------------

let editing = false;

/**
 * SIGINT before or after the write: answer interrupted (130). During the
 * write, runEditAsync handles it (puts the old text back first).
 */
function interruptOutsideEdit(command: string, json: boolean): void {
  process.on("SIGINT", () => {
    if (editing || hasAnswered()) return;
    process.exitCode = emit(command, cliOutcome("interrupted"), json);
    process.exit();
  });
}

async function edit(opts: Parameters<typeof runEditAsync>[0]) {
  editing = true;
  try {
    return await runEditAsync(opts);
  } finally {
    editing = false;
  }
}

/** An EditStop as an outcome; the message (it may name the file) stays off stderr. */
function stopOutcome(err: unknown): Outcome {
  if (err instanceof EditStop) {
    if (err.code === "config_invalid" && err.configError) return configFailure(err.configError);
    if (err.code === "validation_after_write_failed" || err.code === "restore_failed") {
      const extra = err.configError ? { detail: err.configError.code } : {};
      return cliOutcome(
        err.code,
        extra,
        err.code === "restore_failed"
          ? "could not put the previous repos.yml back (restore_failed); the previous text is in repos.yml.bak"
          : "the written repos.yml failed ccs's checks; the previous text was put back (validation_after_write_failed)",
      );
    }
    return cliOutcome(err.code as CliCode);
  }
  return cliOutcome("internal_error");
}

function stop(code: EditCode, message = code): never {
  throw new EditStop(code, message);
}

// ---------------------------------------------------------------------------
// repo add
// ---------------------------------------------------------------------------

/** `~/…` for a path under $HOME (`~/` for $HOME itself: a bare `~` is YAML null). */
export function tildeForm(abs: string, home: string = homedir()): string {
  if (abs === home) return "~/";
  return `~/${relative(home, abs)}`;
}

function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Checks on the name (4.1): length, characters, quoting. */
function checkName(name: string): void {
  if (name.length === 0 || codePointLength(name) > NAME_MAX) stop("invalid_value");
  if (SHELL_METACHARS.test(name)) stop("unsafe_characters");
  if (needsQuoting(name)) stop("needs_quoting");
}

function checkText(value: string, max: number): void {
  if (hasControlChars(value) || codePointLength(value) > max) stop("invalid_value");
}

export async function repoAdd(args: readonly string[]): Promise<Outcome> {
  const flags = parseFlags(args, {
    booleans: ["--json", "--with-paths"],
    values: ["--name", "--description"],
  });
  if (!flags.ok) return cliOutcome(flags.code);
  if (flags.rest.length > 0 || flags.positionals.length > 1) return cliOutcome("extra_argument");
  const rawPath = flags.positionals[0];
  if (rawPath === undefined || rawPath === "") return cliOutcome("missing_argument");
  const wantName = flags.values.get("--name");
  const description = flags.values.get("--description");
  const home = homedir();
  // A relative path is taken from the folder ccs was run in (CCS_CWD: bin/ccs
  // starts this module from its own folder; see ccs-tsx.sh).
  const abs = resolve(process.env.CCS_CWD || process.cwd(), expandPath(rawPath));

  let added: { name: string; path: string } | null = null;
  try {
    const result = await edit({
      createWith: NEW_CONFIG_HEAD,
      transform: ({ doc, config }) => {
        if (config && reposIsFlow(doc)) stop("flow_style_repos");
        if (!isUnderHome(abs)) stop("path_outside_home");
        let st;
        try {
          st = statSync(abs);
        } catch {
          stop("path_not_found");
        }
        if (!st.isDirectory()) stop("path_not_directory");
        if (SHELL_METACHARS.test(abs)) stop("unsafe_characters");
        const written = tildeForm(abs, home);
        if (needsQuoting(written)) stop("needs_quoting");
        const repos = config?.repos ?? [];
        const real = realOrSame(abs);
        if (repos.some((r) => r.path !== "" && (r.path === abs || realOrSame(r.path) === real))) {
          stop("path_taken");
        }
        const taken = new Set(repos.map((r) => r.name));
        let name: string;
        if (wantName !== undefined) {
          checkName(wantName);
          if (taken.has(wantName)) stop("name_taken");
          name = wantName;
        } else {
          const base = abs === home ? "home" : basename(abs);
          checkName(base);
          name = base;
          for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
          checkName(name);
        }
        if (description !== undefined) checkText(description, DESCRIPTION_MAX);

        const item: Record<string, string> = { name, path: written };
        if (description !== undefined && description !== "") item.description = description;
        if (config) {
          const node = doc.get("repos", true);
          if (!isSeq(node)) stop("config_invalid");
          node.add(doc.createNode(item));
        } else {
          doc.set("repos", doc.createNode([item]));
        }
        added = { name, path: abs };
      },
    });
    const done = added as { name: string; path: string } | null;
    if (!done) return cliOutcome("internal_error");
    const repo: Record<string, unknown> = { name: done.name, created_config: result.createdConfig };
    if (flags.booleans.has("--with-paths")) repo.path = done.path;
    return okOutcome({ repo });
  } catch (err) {
    return stopOutcome(err);
  }
}

// ---------------------------------------------------------------------------
// repo remove
// ---------------------------------------------------------------------------

export async function repoRemove(args: readonly string[]): Promise<Outcome> {
  const flags = parseFlags(args, { booleans: ["--json"] });
  if (!flags.ok) return cliOutcome(flags.code);
  if (flags.rest.length > 0 || flags.positionals.length > 1) return cliOutcome("extra_argument");
  const name = flags.positionals[0];
  if (name === undefined || name === "") return cliOutcome("missing_argument");
  try {
    await edit({
      transform: ({ doc, config }) => {
        const repos = (config as CcsConfig).repos;
        const index = repos.findIndex((r) => r.name === name);
        if (index === -1) stop("repo_not_found");
        if (repos.length === 1) stop("last_entry");
        const node = doc.get("repos", true);
        if (!isSeq(node)) stop("config_invalid");
        node.items.splice(index, 1);
      },
    });
    return okOutcome({ repo: { name } });
  } catch (err) {
    return stopOutcome(err);
  }
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

/** The values `config set` takes, per key (shown by `config get` as `allowed`). */
export const SETTABLE_DEFAULTS = {
  "defaults.ui": [...UI_MODES] as unknown[],
  "defaults.terminal": [...TERMINAL_APPS] as unknown[],
  "defaults.update_check": [true, false] as unknown[],
} as const;

export function configGet(args: readonly string[]): Outcome {
  const flags = parseFlags(args, { booleans: ["--json", "--with-paths"] });
  if (!flags.ok) return cliOutcome(flags.code);
  if (flags.positionals.length > 0 || flags.rest.length > 0) return cliOutcome("extra_argument");
  let config: CcsConfig | null = null;
  try {
    const result = readConfig();
    if (result.found) config = result.config;
  } catch (err) {
    return configFailure(err);
  }
  const groupsDir: Record<string, unknown> = { set: Boolean(config?.settings.groupsDir) };
  if (flags.booleans.has("--with-paths") && config?.settings.groupsDir) {
    groupsDir.path = resolve(expandPath(config.settings.groupsDir));
  }
  return okOutcome({
    settings: {
      "defaults.ui": config?.defaults.ui ?? "classic",
      "defaults.terminal": config?.settings.terminal ?? null,
      "defaults.update_check": config?.settings.updateCheck ?? true,
      "defaults.groups_dir": groupsDir,
    },
    allowed: SETTABLE_DEFAULTS,
  });
}

/** `config get` without --json: one `key = value` line each (for people). */
export function configGetText(outcome: Outcome): string {
  const settings = (outcome.body?.settings ?? {}) as Record<string, unknown>;
  return Object.entries(settings)
    .map(([k, v]) => {
      if (v && typeof v === "object") {
        const o = v as { set?: boolean; path?: string };
        return `${k} = ${o.path ?? (o.set ? "(set)" : "(not set)")}`;
      }
      return `${k} = ${v === null ? "(not set)" : String(v)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// config set
// ---------------------------------------------------------------------------

type SetKey =
  | "defaults.ui"
  | "defaults.terminal"
  | "defaults.update_check"
  | "label"
  | "description";

const DEFAULT_KEYS = new Set<SetKey>(["defaults.ui", "defaults.terminal", "defaults.update_check"]);
const ENTRY_KEYS = new Set<SetKey>(["label", "description"]);

/** The value to write for this key, or undefined to delete the key. Throws EditStop. */
function parseSetValue(key: SetKey, raw: string): unknown {
  switch (key) {
    case "defaults.ui":
      if (!(UI_MODES as readonly string[]).includes(raw)) stop("invalid_value");
      return raw;
    case "defaults.terminal":
      if (raw === "") return undefined;
      if (!isTerminalApp(raw)) stop("invalid_value");
      return raw;
    case "defaults.update_check":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return stop("invalid_value");
    case "label":
      checkText(raw, LABEL_MAX);
      return raw === "" ? undefined : raw;
    case "description":
      checkText(raw, DESCRIPTION_MAX);
      return raw === "" ? undefined : raw;
  }
}

/** Put `defaults:` before `repos:` when there is none (line readers stop at `repos:`). */
function ensureDefaults(doc: Document): void {
  if (doc.has("defaults")) return;
  const top = doc.contents;
  if (!isMap(top)) stop("config_invalid");
  const pair = doc.createPair("defaults", {});
  const at = top.items.findIndex((p) => {
    const k = p.key as { value?: unknown } | unknown;
    return (k && typeof k === "object" && "value" in k ? k.value : k) === "repos";
  });
  if (at === -1) top.items.push(pair);
  else top.items.splice(at, 0, pair);
}

export async function configSet(args: readonly string[]): Promise<Outcome> {
  const flags = parseFlags(args, { booleans: ["--json"], values: ["--repo"] });
  if (!flags.ok) return cliOutcome(flags.code);
  if (flags.rest.length > 0 || flags.positionals.length > 2) return cliOutcome("extra_argument");
  if (flags.positionals.length < 2) return cliOutcome("missing_argument");
  const [keyRaw, valueRaw] = flags.positionals;
  const isDefaultKey = DEFAULT_KEYS.has(keyRaw as SetKey);
  if (!isDefaultKey && !ENTRY_KEYS.has(keyRaw as SetKey)) {
    return cliOutcome("key_not_settable", {}, "only defaults.ui, defaults.terminal, defaults.update_check, label and description can be set");
  }
  const key = keyRaw as SetKey;
  const repoName = flags.values.get("--repo");
  if (isDefaultKey && repoName !== undefined) return cliOutcome("extra_argument");
  if (!isDefaultKey && repoName === undefined) return cliOutcome("missing_argument");

  try {
    const result = await edit({
      transform: ({ doc, config }) => {
        const value = parseSetValueOrRepoFirst(key, valueRaw, repoName, config as CcsConfig);
        const path: (string | number)[] = isDefaultKey
          ? ["defaults", key.slice("defaults.".length)]
          : ["repos", (config as CcsConfig).repos.findIndex((r) => r.name === repoName), key];
        const current = doc.getIn(path);
        if (value === undefined) {
          if (current === undefined || current === null) return false;
          doc.deleteIn(path);
          return true;
        }
        if (current === value) return false;
        if (isDefaultKey) {
          ensureDefaults(doc);
          if (!isMap(doc.get("defaults", true))) stop("config_invalid");
        }
        doc.setIn(path, value);
        return true;
      },
    });
    return okOutcome({ key, changed: result.changed });
  } catch (err) {
    return stopOutcome(err);
  }
}

/** For an entry key, a missing entry (5) comes before a bad value (6). */
function parseSetValueOrRepoFirst(
  key: SetKey,
  raw: string,
  repoName: string | undefined,
  config: CcsConfig,
): unknown {
  if (repoName !== undefined && !config.repos.some((r) => r.name === repoName)) {
    stop("repo_not_found");
  }
  return parseSetValue(key, raw);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** `ccs repo …` and `ccs config …`: returns the exit code. */
export async function runRepoOrConfig(word: "repo" | "config", args: readonly string[]): Promise<number> {
  const json = wantsJson(args);
  const sub = args[0];
  const rest = args.slice(1);
  const command = sub && !sub.startsWith("-") ? `${word} ${sub}` : word;
  interruptOutsideEdit(command, json);
  if (sub === undefined || sub.startsWith("-")) {
    return emit(command, cliOutcome("missing_argument", {}, `usage: ccs ${word} ${word === "repo" ? "add|remove" : "get|set"} …`), json);
  }
  // A write without --json: nothing on stdout, one line on stderr (1.8).
  const written = (outcome: Outcome): number => {
    if (!json && outcome.status === "ok" && !outcome.note) {
      const changed = (outcome.body as { changed?: boolean } | undefined)?.changed;
      outcome.note = `${command}: ok${changed === false ? " (already set; nothing written)" : ""}`;
    }
    return emit(command, outcome, json);
  };
  if (word === "repo" && sub === "add") return written(await repoAdd(rest));
  if (word === "repo" && sub === "remove") return written(await repoRemove(rest));
  if (word === "config" && sub === "set") return written(await configSet(rest));
  if (word === "config" && sub === "get") {
    const outcome = configGet(rest);
    if (!json && outcome.status === "ok") {
      process.stdout.write(configGetText(outcome) + "\n");
      return 0;
    }
    return emit(command, outcome, json);
  }
  return emit(command, cliOutcome("invalid_argument", {}, `unknown subcommand for ccs ${word}`), json);
}
