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

export interface SessionPreviewOptions {
  /**
   * ui: simple — print only the conversation, under a Japanese heading and
   * with "あなた" / "Claude" speakers (the caller already drew the card with
   * the folder and time); errors are one Japanese line each.
   */
  simple?: boolean;
}

export async function renderSessionPreview(
  sessionId: string,
  opts: SessionPreviewOptions = {},
): Promise<void> {
  const simple = opts.simple ?? false;
  const say = (classic: string, ja: string) => console.log(simple ? ja : classic);
  if (!sessionId) {
    say("No session ID provided", "会話の記録が見つかりません");
    return;
  }

  // UUID validation (injection prevention)
  if (!UUID_RE.test(sessionId)) {
    say("Invalid session ID format", "会話の記録が見つかりません");
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
    say("Cannot read projects directory", "会話の記録の置き場を読めませんでした");
    return;
  }

  if (!targetFile) {
    say("Session file not found", "会話の記録のファイルが見つかりません（消された会話かもしれません）");
    return;
  }

  // File size check
  try {
    const stats = await stat(targetFile);
    if (stats.size > MAX_JSONL_SIZE) {
      const mb = Math.round(stats.size / 1024 / 1024);
      say(
        `⚠️ File too large (${mb}MB). Skipping preview.`,
        `長い会話なので、ここには中身を出しません（${mb}MB）。Enter で開けます`,
      );
      return;
    }
  } catch {
    say("Cannot stat session file", "会話の記録のファイルを読めませんでした");
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
        // The simple look leaves out the "[tool: …]" / "[tool result]"
        // placeholders: they are machinery, not the conversation a person
        // remembers (a tool-result-only turn then has no text and is skipped).
        const text = extractText(entry.message.content, {
          includeToolBlocks: !simple,
        });
        if (text) {
          messages.push({
            role: simple
              ? entry.type === "user"
                ? "👤 あなた:"
                : "🤖 Claude:"
              : entry.type === "user"
                ? "👤"
                : "🤖",
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

  if (simple) {
    console.log("  ──── これまでの会話 ────");
    console.log();
    if (messages.length === 0) {
      console.log("  （まだやりとりはありません）");
      return;
    }
    for (const msg of messages.slice(-MAX_PREVIEW_MESSAGES)) {
      console.log(`  ${msg.role} ${msg.text}`);
      console.log();
    }
    return;
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
