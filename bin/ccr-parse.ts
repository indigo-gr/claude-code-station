#!/usr/bin/env tsx
/**
 * ccr-parse.ts - Parse Claude Code session JSONLs and output fzf-friendly format
 * Output: {project}\t{timestamp}\t{summary}\t{sessionId}\t{cwd}
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_SUMMARY_LEN = 80;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SessionMeta {
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  summary: string;
  mtime: number;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return "";
}

function parseSessionFile(filePath: string, projectName: string): SessionMeta | null {
  try {
    const stats = statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) return null;
    if (stats.size === 0) return null;

    // Use filename UUID as the canonical session ID (matches preview/delete lookup)
    const fileBasename = filePath.split("/").pop()?.replace(".jsonl", "") ?? "";
    if (!UUID_RE.test(fileBasename)) return null;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const sessionId = fileBasename;
    let cwd = "";
    let timestamp = "";
    let firstUserMsg = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Working directory
        if (!cwd && entry.cwd) {
          cwd = entry.cwd;
        }

        // Keep latest timestamp
        if (entry.timestamp) {
          timestamp = entry.timestamp;
        }

        // First meaningful user message (strip system tags)
        if (!firstUserMsg && entry.type === "user" && entry.message?.content) {
          const raw = extractUserText(entry.message.content);
          // Skip system-generated interrupt markers
          if (raw.includes("[Request interrupted by user")) continue;
          const cleaned = raw
            .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, "")
            .replace(/<[^>]+>/g, "")
            .trim();
          if (cleaned) {
            firstUserMsg = cleaned;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    const summary = firstUserMsg
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SUMMARY_LEN);

    return {
      sessionId,
      project: projectName,
      cwd: cwd || "unknown",
      timestamp,
      summary: summary || "(empty session)",
      mtime: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

function formatTimestamp(ts: string): string {
  if (!ts) return "unknown";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  if (diffMs < 0) return "just now";

  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  const diffMins = Math.floor(diffMs / 60000);
  if (diffHours < 1) return diffMins < 1 ? "just now" : `${diffMins}m ago`;
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;

  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function main() {
  const filterCwd = process.argv.includes(".")
    ? process.cwd()
    : null;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_DIR).filter((d) => {
      try {
        return statSync(join(PROJECTS_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    console.error("Cannot read projects directory:", PROJECTS_DIR);
    process.exit(1);
  }

  const sessions: SessionMeta[] = [];

  for (const projDir of projectDirs) {
    const projPath = join(PROJECTS_DIR, projDir);

    let files: string[];
    try {
      files = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const meta = parseSessionFile(join(projPath, file), projDir);
      if (!meta) continue;
      if (filterCwd && !meta.cwd.startsWith(filterCwd)) continue;
      sessions.push(meta);
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);

  const home = homedir();
  for (const s of sessions) {
    const ts = formatTimestamp(s.timestamp);
    const projFromCwd = s.cwd.replace(home, "~");
    const proj = projFromCwd.length > 30 ? "…" + projFromCwd.slice(-29) : projFromCwd;
    console.log(`${proj}\t${ts}\t${s.summary}\t${s.sessionId}\t${s.cwd}`);
  }
}

main();
