/**
 * ccs-scan-sessions.ts — Session indexing for the ccs scan engine.
 *
 * Extracted from ccs-scan.ts (review A-4): walks ~/.claude/projects/,
 * parses session JSONL files with mtime-based caching, resolves each
 * session's cwd to a registered repo, and keeps the sessions table in sync
 * (upsert / delete-missing / remap-unmapped).
 *
 * ccs-scan.ts owns orchestration (repos.yml sync, repo_stats scan, CLI) and
 * calls scanSessions() BEFORE the repo pass so repo_stats aggregates see
 * fresh session data (audit C-1).
 *
 * Source of truth: docs/design/sqlite-schema.md
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

import { getAllRepos, type RepoRow } from "./ccs-db.ts";
import { maskSecrets } from "./ccs-secrets.ts";
import { sanitizeSessionCwd, stripControlChars } from "./ccs-sanitize.ts";
import { extractText, nowIso, MAX_JSONL_SIZE, UUID_RE } from "./ccs-utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOPIC_LEN = 200;
const MAX_SUMMARY_LEN = 1000;
const SUMMARY_RE =
  /<!--\s*ECC:SUMMARY:START\s*-->([\s\S]*?)<!--\s*ECC:SUMMARY:END\s*-->/;

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

export interface SessionParseResult {
  uuid: string;
  project_dir: string;
  cwd: string;
  branch: string | null;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  topic: string | null;
  summary: string | null;
  jsonl_size: number;
  jsonl_mtime: string;
}

export async function parseSessionJsonl(
  filePath: string,
  projectDir: string,
  size: number,
  mtimeIso: string,
): Promise<SessionParseResult | null> {
  const fileBase = basename(filePath).replace(/\.jsonl$/, "");
  if (!UUID_RE.test(fileBase)) return null;
  if (size === 0 || size > MAX_JSONL_SIZE) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let cwd = "";
  let branch: string | null = null;
  let firstTs = "";
  let lastTs = "";
  let firstUserMsg = "";
  let msgCount = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // message_count means CONVERSATION messages (audit logic H-4) — JSONL
    // also carries summary/meta/tool rows which must not inflate the count.
    // ccs-preview-session.ts counts the same way.
    if (entry.type === "user" || entry.type === "assistant") msgCount++;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!branch && typeof entry.gitBranch === "string") {
      branch = entry.gitBranch || null;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (ts) {
      // min/max by value, not by line order (audit logic M-6): sidechain rows
      // can be appended out of chronological order. ISO 8601 (always Z here)
      // sorts lexicographically, so string comparison is safe.
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    if (
      !firstUserMsg &&
      entry.type === "user" &&
      entry.message &&
      typeof entry.message === "object"
    ) {
      const raw = extractText(
        (entry.message as { content?: unknown }).content,
      );
      if (raw && !raw.includes("[Request interrupted by user")) {
        firstUserMsg = raw
          .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  // summary: search whole content
  // Pipeline order matters: strip control chars first so secret patterns see
  // clean text, mask BEFORE truncation so a token straddling the
  // MAX_SUMMARY_LEN/MAX_TOPIC_LEN boundary is still redacted intact.
  let summary: string | null = null;
  const summaryMatch = SUMMARY_RE.exec(content);
  if (summaryMatch) {
    summary = maskSecrets(stripControlChars(summaryMatch[1].trim())).slice(
      0,
      MAX_SUMMARY_LEN,
    );
  }

  const topic = firstUserMsg
    ? maskSecrets(stripControlChars(firstUserMsg)).slice(0, MAX_TOPIC_LEN)
    : null;

  // Trust boundary (audit H-1/M-2/NEW-1): the JSONL cwd field is attacker
  // controllable and later reaches the fzf row, the Ctrl-Y clipboard command
  // and a shell `cd`. Gate on the RAW value first — reject any shell
  // metacharacter / control char (a rejected cwd degrades to the "unknown"
  // sentinel, which bin/ccs treats as non-launchable) — then mask any secret
  // embedded in an otherwise-clean path before it is stored/displayed (M-2).
  const cleanCwd = cwd ? sanitizeSessionCwd(cwd) : null;
  const safeCwd = cleanCwd ? maskSecrets(cleanCwd) : null;

  return {
    uuid: fileBase,
    project_dir: projectDir,
    cwd: safeCwd ?? "unknown",
    branch: branch ? stripControlChars(branch) || null : null,
    started_at: firstTs || mtimeIso,
    last_activity_at: lastTs || mtimeIso,
    message_count: msgCount,
    topic,
    summary,
    jsonl_size: size,
    jsonl_mtime: mtimeIso,
  };
}

// ---------------------------------------------------------------------------
// cwd → repo resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a session cwd to a registered repo by LONGEST prefix match
 * (audit logic M-4): a session started in ~/Workspace/foo/packages/bar must
 * map to the repo registered at ~/Workspace/foo, and when repos nest, the
 * deepest path wins. Exact matches naturally win via longest-first ordering.
 *
 * Each root is also registered under its realpath (review DA-3): sessions
 * record the cwd the process actually ran in, so a repo registered via a
 * symlinked path (or under macOS /var -> /private/var aliasing) would never
 * match its sessions on the lexical path alone.
 */
export function buildRepoResolver(
  repos: RepoRow[],
): (cwd: string) => string | null {
  const roots: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();
  const addRoot = (path: string, name: string) => {
    const key = `${path} ${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path, name });
  };
  for (const r of repos) {
    for (const p of [r.path, r.cwd]) {
      if (!p) continue;
      addRoot(p, r.name);
      try {
        const real = realpathSync(p);
        if (real !== p) addRoot(real, r.name);
      } catch {
        // path absent — the lexical root above is all we can match on
      }
    }
  }
  roots.sort((a, b) => b.path.length - a.path.length);
  return (cwd: string) => {
    for (const root of roots) {
      if (cwd === root.path || cwd.startsWith(root.path + "/")) {
        return root.name;
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Sessions scan
// ---------------------------------------------------------------------------

export async function scanSessions(
  db: Database.Database,
): Promise<{ indexed: number; skipped: number }> {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return { indexed: 0, skipped: 0 };

  const repos = getAllRepos(db);
  const resolveRepoName = buildRepoResolver(repos);

  // Existing session mtimes
  const existing = new Map<string, string>();
  for (const row of db
    .prepare(`SELECT uuid, jsonl_mtime FROM sessions`)
    .all() as Array<{ uuid: string; jsonl_mtime: string }>) {
    existing.set(row.uuid, row.jsonl_mtime);
  }

  const validUuids = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return { indexed: 0, skipped: 0 };
  }

  // indexed_at is written as an explicit ISO 8601 value rather than
  // SQLite's naive `datetime('now')` so all timestamps in state.db share one
  // format (audit logic M-1).
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (
       uuid, repo_name, project_dir, cwd, branch,
       started_at, last_activity_at, message_count,
       topic, summary, jsonl_size, jsonl_mtime, indexed_at
     ) VALUES (
       @uuid, @repo_name, @project_dir, @cwd, @branch,
       @started_at, @last_activity_at, @message_count,
       @topic, @summary, @jsonl_size, @jsonl_mtime, @indexed_at
     )
     ON CONFLICT(uuid) DO UPDATE SET
       repo_name = excluded.repo_name,
       project_dir = excluded.project_dir,
       cwd = excluded.cwd,
       branch = excluded.branch,
       started_at = excluded.started_at,
       last_activity_at = excluded.last_activity_at,
       message_count = excluded.message_count,
       topic = excluded.topic,
       summary = excluded.summary,
       jsonl_size = excluded.jsonl_size,
       jsonl_mtime = excluded.jsonl_mtime,
       indexed_at = excluded.indexed_at`,
  );

  // Oversized JSONLs are still resumable sessions: keep the last good row
  // but stamp the new size/mtime so the mtime cache skips the file on the
  // next scan instead of re-attempting (and re-skipping) it forever
  // (review C-4).
  const touchStmt = db.prepare(
    `UPDATE sessions
        SET jsonl_size = @jsonl_size,
            jsonl_mtime = @jsonl_mtime,
            indexed_at = @indexed_at
      WHERE uuid = @uuid`,
  );

  for (const projName of projectDirs) {
    const projPath = join(projectsDir, projName);
    let projStat;
    try {
      projStat = await stat(projPath);
    } catch {
      continue;
    }
    if (!projStat.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const uuid = f.replace(/\.jsonl$/, "");
      if (!UUID_RE.test(uuid)) continue;
      const full = join(projPath, f);

      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      validUuids.add(uuid);
      const mtimeIso = new Date(st.mtimeMs).toISOString();

      if (existing.get(uuid) === mtimeIso) {
        skipped++;
        continue;
      }

      if (st.size > MAX_JSONL_SIZE) {
        if (existing.has(uuid)) {
          touchStmt.run({
            jsonl_size: st.size,
            jsonl_mtime: mtimeIso,
            indexed_at: nowIso(),
            uuid,
          });
        }
        // Never indexed before it crossed the limit: nothing usable can be
        // extracted without reading 50MB+, so it stays unlisted by design.
        skipped++;
        continue;
      }

      try {
        const parsed = await parseSessionJsonl(
          full,
          projName,
          st.size,
          mtimeIso,
        );
        if (!parsed) {
          skipped++;
          continue;
        }
        const repoName = resolveRepoName(parsed.cwd);
        upsertStmt.run({
          uuid: parsed.uuid,
          repo_name: repoName,
          project_dir: parsed.project_dir,
          cwd: parsed.cwd,
          branch: parsed.branch,
          started_at: parsed.started_at,
          last_activity_at: parsed.last_activity_at,
          message_count: parsed.message_count,
          topic: parsed.topic,
          summary: parsed.summary,
          jsonl_size: parsed.jsonl_size,
          jsonl_mtime: parsed.jsonl_mtime,
          indexed_at: nowIso(),
        });
        indexed++;
      } catch (err) {
        process.stderr.write(
          `[ccs-scan] session ${uuid}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // Delete sessions whose JSONL no longer exists (chunked).
  const allExisting = Array.from(existing.keys());
  const toDelete = allExisting.filter((u) => !validUuids.has(u));
  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM sessions WHERE uuid IN (${ph})`).run(...chunk);
  }

  // Re-resolve unmapped sessions (audit logic M-3): mtime-skipped rows keep
  // the repo_name decided when they were first indexed, so a repo added to
  // repos.yml afterwards would never claim its past sessions. Cheap pass —
  // only rows still NULL are reconsidered.
  const remapTx = db.transaction(() => {
    const nullRows = db
      .prepare(`SELECT uuid, cwd FROM sessions WHERE repo_name IS NULL`)
      .all() as Array<{ uuid: string; cwd: string }>;
    const updStmt = db.prepare(
      `UPDATE sessions SET repo_name = ? WHERE uuid = ?`,
    );
    for (const row of nullRows) {
      const name = resolveRepoName(row.cwd);
      if (name) updStmt.run(name, row.uuid);
    }
  });
  remapTx();

  return { indexed, skipped };
}
