#!/usr/bin/env tsx
/**
 * ccs-preview-session.ts - Display conversation history in fzf preview pane
 * Args: sessionId
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { maskSecrets } from "./ccs-secrets.ts";
import {
  extractText,
  truncate,
  MAX_JSONL_SIZE,
  UUID_RE,
} from "./ccs-utils.ts";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_PREVIEW_MESSAGES = 20;
const MAX_MSG_LEN = 200;

// extractText / truncate / UUID_RE / MAX_JSONL_SIZE come from ccs-utils.ts —
// shared with the scanner so the preview and topic extraction can no longer
// drift apart (review A-1/A-2). The preview passes includeToolBlocks below
// because tool activity is part of the conversation flow it renders.

export async function renderSessionPreview(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.log("No session ID provided");
    return;
  }

  // UUID validation (injection prevention)
  if (!UUID_RE.test(sessionId)) {
    console.log("Invalid session ID format");
    return;
  }

  // Find session file
  let targetFile = "";
  try {
    const projDirs = await readdir(PROJECTS_DIR);
    for (const projDir of projDirs) {
      const projPath = join(PROJECTS_DIR, projDir);
      try {
        const files = await readdir(projPath);
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
    return;
  }

  if (!targetFile) {
    console.log("Session file not found");
    return;
  }

  // File size check
  try {
    const stats = await stat(targetFile);
    if (stats.size > MAX_JSONL_SIZE) {
      console.log(`⚠️ File too large (${Math.round(stats.size / 1024 / 1024)}MB). Skipping preview.`);
      return;
    }
  } catch {
    console.log("Cannot stat session file");
    return;
  }

  const content = await readFile(targetFile, "utf-8");
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
        const text = extractText(entry.message.content, {
          includeToolBlocks: true,
        });
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

  // Header — cwd/gitBranch/version are untrusted JSONL fields read straight
  // from disk (NOT the sanitized DB copy), so apply the same two-step
  // treatment as message text: maskSecrets for credential leakage (audit
  // M-2), truncate to strip control chars / escape sequences (audit NEW-1).
  console.log("━━━ Session Info ━━━");
  console.log(`📁 ${maskSecrets(truncate(cwd, 200))}`);
  if (gitBranch) console.log(`🌿 ${maskSecrets(truncate(gitBranch, 100))}`);
  if (version) console.log(`📌 Claude ${maskSecrets(truncate(version, 50))}`);
  console.log(`💬 ${messages.length} messages`);
  console.log("━━━ Conversation ━━━");
  console.log();

  const display = messages.slice(-MAX_PREVIEW_MESSAGES);
  for (const msg of display) {
    console.log(`${msg.role} ${msg.text}`);
    console.log();
  }
}

// CLI bootstrap: only run when invoked directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.log("Usage: ccs-preview-session.ts <session-uuid>");
    process.exit(1);
  }
  renderSessionPreview(sessionId).catch((err) => {
    console.error(`[ccs-preview-session] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
