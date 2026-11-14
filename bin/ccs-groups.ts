/**
 * ccs-groups.ts — logical groups from definition files other tools keep.
 *
 * `defaults.groups_dir` (off unless set) names a folder of `*.json` files,
 * each describing one group of projects that may live in unrelated folders.
 * ccs reads five keys and nothing else — `version`, `id`, `label`, `kind`,
 * `members[].path` — and only `kind: logical` groups: a `physical` group's
 * projects already nest by path in the list. ccs never writes these files.
 * Contract: docs/design/machine-interface.md chapter 5.
 *
 * The scan reads them and stores the result in the cache's meta table
 * (`logical_groups`); the list reads that. `ccs list --json` and `ccs doctor`
 * read the folder themselves.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { expandPath } from "./ccs-config.ts";
import { SHELL_METACHARS, stripControlChars } from "./ccs-sanitize.ts";

/** At most this many files are read (the first ones in name order). */
export const GROUP_FILES_MAX = 200;
/** A file larger than this is skipped. */
export const GROUP_FILE_BYTES_MAX = 256 * 1024;
const ID_MAX = 64;
const LABEL_MAX = 80;

export interface LogicalGroup {
  id: string;
  label: string;
  /** repos.yml names, in the order of the file's members[]. */
  members: string[];
  /** members[] entries that matched no repos.yml entry. */
  unregistered: number;
}

export interface GroupsRead {
  /** The folder could not be read (missing, not a folder, no permission). */
  missing: boolean;
  groups: LogicalGroup[];
  /** Files skipped: broken JSON, too large, an unknown version or shape, a repeated id. */
  skipped: number;
}

/** What a repos.yml entry offers for matching: its name and resolved path. */
export interface RepoPath {
  name: string;
  path: string;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The group's id, or null when it is not usable. */
function readId(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || [...v].length > ID_MAX) return null;
  if (SHELL_METACHARS.test(v)) return null;
  return v;
}

/**
 * Read the group files in `dir` and match their members to `repos` by path
 * (`~` expanded; both sides resolved through symlinks when they exist).
 * Never throws: whatever cannot be used is counted in `skipped`.
 */
export function readLogicalGroups(dir: string, repos: readonly RepoPath[]): GroupsRead {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return { missing: true, groups: [], skipped: 0 };
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
  } catch {
    return { missing: true, groups: [], skipped: 0 };
  }

  // Path → name, by the written path and by the real one.
  const byPath = new Map<string, string>();
  for (const r of repos) {
    if (!r.path) continue;
    if (!byPath.has(r.path)) byPath.set(r.path, r.name);
    const real = realOr(r.path);
    if (!byPath.has(real)) byPath.set(real, r.name);
  }

  const groups: LogicalGroup[] = [];
  const seen = new Set<string>();
  let skipped = Math.max(0, names.length - GROUP_FILES_MAX);
  for (const file of names.slice(0, GROUP_FILES_MAX)) {
    let raw: unknown;
    try {
      const full = join(dir, file);
      if (statSync(full).size > GROUP_FILE_BYTES_MAX) {
        skipped++;
        continue;
      }
      raw = JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      skipped++;
      continue;
    }
    if (!isPlainObject(raw) || raw.version !== 1 || typeof raw.kind !== "string") {
      skipped++;
      continue;
    }
    if (raw.kind !== "logical") continue; // physical and others: nested by path already
    const id = readId(raw.id);
    if (id === null || !Array.isArray(raw.members) || seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    const labelRaw = typeof raw.label === "string" ? stripControlChars(raw.label) : "";
    const label = [...(labelRaw || id)].slice(0, LABEL_MAX).join("");
    const members: string[] = [];
    let unregistered = 0;
    for (const m of raw.members) {
      const p = isPlainObject(m) && typeof m.path === "string" && m.path !== "" ? m.path : null;
      const abs = p === null ? null : resolve(expandPath(p));
      const name = abs === null ? undefined : (byPath.get(abs) ?? byPath.get(realOr(abs)));
      if (name === undefined) {
        unregistered++;
      } else if (!members.includes(name)) {
        members.push(name);
      }
    }
    groups.push({ id, label, members, unregistered });
  }
  return { missing: false, groups, skipped };
}

/** The meta table's form (`logical_groups`): what the list needs, nothing more. */
export function groupsToMeta(groups: readonly LogicalGroup[]): string {
  return JSON.stringify(groups.map((g) => ({ id: g.id, label: g.label, members: g.members })));
}

/** Read `logical_groups` back; anything malformed is dropped. */
export function groupsFromMeta(json: string | null): { id: string; label: string; members: string[] }[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: { id: string; label: string; members: string[] }[] = [];
  for (const g of raw) {
    if (!isPlainObject(g)) continue;
    const id = readId(g.id);
    if (id === null || typeof g.label !== "string" || !Array.isArray(g.members)) continue;
    const members = g.members.filter((m): m is string => typeof m === "string" && !SHELL_METACHARS.test(m));
    out.push({ id, label: stripControlChars(g.label) || id, members });
  }
  return out;
}
