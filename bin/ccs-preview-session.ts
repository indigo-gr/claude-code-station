#!/usr/bin/env tsx
/**
 * ccr-preview.ts - Display conversation history in fzf preview pane
 * Args: sessionId
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_PREVIEW_MESSAGES = 20;
const MAX_MSG_LEN = 200;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Mask known secret patterns in preview output
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[a-zA-Z0-9]{20,}/g, "sk-***"],
  [/sk-ant-[a-zA-Z0-9-]{20,}/g, "sk-ant-***"],
  [/op:\/\/[^\s"']+/g, "op://***"],
  [/ghp_[a-zA-Z0-9]{36}/g, "ghp_***"],
  [/gho_[a-zA-Z0-9]{36}/g, "gho_***"],
  [/ghs_[a-zA-Z0-9]{36}/g, "ghs_***"],
  [/xoxb-[a-zA-Z0-9-]+/g, "xoxb-***"],
  [/xoxp-[a-zA-Z0-9-]+/g, "xoxp-***"],
  [/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "Bearer ***"],
  [/AKIA[A-Z0-9]{16}/g, "AKIA***"],
  [/AIza[a-zA-Z0-9_-]{35}/g, "AIza***"],
];

function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block?.type === "tool_use") {
        texts.push(`[tool: ${block.name}]`);
      } else if (block?.type === "tool_result") {
        texts.push(`[tool result]`);
      }
    }
    return texts.join(" ");
  }
  return "";
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.log("No session ID provided");
    process.exit(1);
  }

  // UUID validation (injection prevention)
  if (!UUID_RE.test(sessionId)) {
    console.log("Invalid session ID format");
    process.exit(1);
  }

  // Find session file
  let targetFile = "";
  try {
    const projDirs = readdirSync(PROJECTS_DIR);
    for (const projDir of projDirs) {
      const projPath = join(PROJECTS_DIR, projDir);
      try {
        const files = readdirSync(projPath);
        const match = files.find((f) => f === `${sessionId}.jsonl`);
        if (match) {
          targetFile = join(projPath, match);
          break;
        }
      } catch {
        continue;
      }
    }
  } catch {
    console.log("Cannot read projects directory");
    process.exit(1);
  }

  if (!targetFile) {
    console.log("Session file not found");
    process.exit(1);
  }

  // File size check
  try {
    const stats = statSync(targetFile);
    if (stats.size > MAX_FILE_SIZE) {
      console.log(`⚠️ File too large (${Math.round(stats.size / 1024 / 1024)}MB). Skipping preview.`);
      process.exit(0);
    }
  } catch {
    console.log("Cannot stat session file");
    process.exit(1);
  }

  const content = readFileSync(targetFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let cwd = "";
  let gitBranch = "";
  let version = "";
  const messages: { role: string; text: string }[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (!cwd && entry.cwd) cwd = entry.cwd;
      if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
      if (!version && entry.version) version = entry.version;

      if (
        (entry.type === "user" || entry.type === "assistant") &&
        entry.message?.content
      ) {
        const text = extractText(entry.message.content);
        if (text) {
          messages.push({
            role: entry.type === "user" ? "👤" : "🤖",
            text: maskSecrets(truncate(text, MAX_MSG_LEN)),
          });
          // Memory optimization: keep at most 2x display limit
          if (messages.length > MAX_PREVIEW_MESSAGES * 2) {
            messages.splice(0, messages.length - MAX_PREVIEW_MESSAGES);
          }
        }
      }
    } catch {
      // skip
    }
  }

  // Header
  console.log("━━━ Session Info ━━━");
  console.log(`📁 ${cwd}`);
  if (gitBranch) console.log(`🌿 ${gitBranch}`);
  if (version) console.log(`📌 Claude ${version}`);
  console.log(`💬 ${messages.length} messages`);
  console.log("━━━ Conversation ━━━");
  console.log();

  const display = messages.slice(-MAX_PREVIEW_MESSAGES);
  for (const msg of display) {
    console.log(`${msg.role} ${msg.text}`);
    console.log();
  }
}

main();
