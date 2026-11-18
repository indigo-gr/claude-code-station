/**
 * ccs-list-json.ts — `ccs list --json [--with-paths]`.
 *
 * repos.yml after ccs's checks, read directly (not the cache: no wait for a
 * scan, nothing stale after --no-scan). Names, labels and descriptions are
 * printed — that is what this command is for — but paths only with
 * --with-paths, and never `command`, `cwd`, `custom` or `scan`.
 * Contract: docs/design/machine-interface.md 2.2.
 *
 * Creates nothing: a missing repos.yml is exit 4 (config_missing), not a
 * template.
 */
import { statSync } from "node:fs";
import { readConfig } from "./ccs-config.js";
import { cliOutcome, configFailure, emit, okOutcome, onInterrupt, parseFlags, wantsJson, } from "./ccs-machine.js";
import { readLogicalGroups } from "./ccs-groups.js";
import { findParentRepo } from "./ccs-utils.js";
const COMMAND = "list";
function isDirectory(p) {
    if (!p)
        return false;
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/** One repos[] item of the output, in the documented key order. */
export function listItem(repo, parent, withPaths) {
    const item = {
        name: repo.name,
        label: repo.label,
        description: repo.description,
        icon: repo.icon,
        kind: repo.launch ? "repo" : "group",
        launch: repo.launch,
        lead: repo.lead,
        disabled: repo.disabled,
        parent: parent ? parent.name : null,
        tags: [...repo.tags],
        exists: isDirectory(repo.path),
    };
    if (withPaths)
        item.path = repo.path || null;
    return item;
}
/**
 * `groups[]`: the logical groups in defaults.groups_dir, read now (not from
 * the cache), with their members' repos.yml names in the file's order.
 */
function logicalGroupsJson(dir, repos) {
    return readLogicalGroups(dir, repos).groups.map((g) => ({
        id: g.id,
        label: g.label,
        kind: "logical",
        members: g.members,
        unregistered_members: g.unregistered,
    }));
}
/** The outcome of `ccs list` for these arguments (no printing). */
export function listOutcome(args) {
    const flags = parseFlags(args, { booleans: ["--json", "--with-paths"] });
    if (!flags.ok)
        return cliOutcome(flags.code);
    if (flags.positionals.length > 0 || flags.rest.length > 0) {
        return cliOutcome("extra_argument");
    }
    if (!flags.booleans.has("--json")) {
        return cliOutcome("json_required", {}, "`ccs list` needs --json (to pick a repo by hand, run ccs)");
    }
    const withPaths = flags.booleans.has("--with-paths");
    let repos;
    let groupsDir = null;
    try {
        const result = readConfig();
        if (!result.found) {
            return cliOutcome("config_missing", {}, "no repos.yml yet (config_missing); `ccs init` creates one");
        }
        repos = result.config.repos;
        groupsDir = result.config.settings.groupsDir;
    }
    catch (err) {
        return configFailure(err);
    }
    // The list tree's rule (ccs-list): the deepest enabled entry whose path
    // holds this one; a disabled entry is never anyone's parent.
    const enabled = repos.filter((r) => !r.disabled);
    return okOutcome({
        repos: repos.map((r) => listItem(r, findParentRepo(r, enabled), withPaths)),
        groups: groupsDir ? logicalGroupsJson(groupsDir, repos) : [],
    });
}
export function runList(args) {
    const json = wantsJson(args);
    onInterrupt(COMMAND, json);
    return emit(COMMAND, listOutcome(args), json);
}
