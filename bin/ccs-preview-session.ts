#!/usr/bin/env node
/**
 * ccs-preview-session.ts - Display conversation history in fzf preview pane
 * Args: sessionId
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { maskSecrets } from "./ccs-secrets.ts";
import { stripControlChars } from "./ccs-sanitize.ts";
import {
  extractText,
  truncate,
  MAX_JSONL_SIZE,
  UUID_RE,
} from "./ccs-utils.ts";
import { pathToFileURL } from "node:url";
import { t } from "./ccs-i18n.ts";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_PREVIEW_MESSAGES = 20;
const MAX_MSG_LEN = 200;

/** Hide secrets before cutting: a key across the cut no longer matches its pattern. */
function safeText(text: string, max: number): string {
  return truncate(maskSecrets(stripControlChars(text)), max);
}

// extractText / truncate / UUID_RE / MAX_JSONL_SIZE come from ccs-utils.ts —
// shared with the scanner so the preview and topic extraction can no longer
// drift apart (review A-1/A-2). The preview passes includeToolBlocks below
// because tool activity is part of the conversation flow it renders.

/**
 * Print only the conversation, under a heading and with "you" / "Claude"
 * speakers in the run's language (the caller already drew the card with the folder and
 * time); errors are one Japanese line each.
 */
export async function renderSessionPreview(sessionId: string): Promise<void> {
  const say = (ja: string) => console.log(ja);
  if (!sessionId) {
    say(t("session_not_found"));
    return;
  }

  // UUID validation (injection prevention)
  if (!UUID_RE.test(sessionId)) {
    say(t("session_not_found"));
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
    say(t("session_dir_unreadable"));
    return;
  }

  if (!targetFile) {
    say(t("session_file_missing"));
    return;
  }

  // File size check
  try {
    const stats = await stat(targetFile);
    if (stats.size > MAX_JSONL_SIZE) {
      const mb = Math.round(stats.size / 1024 / 1024);
      say(t("session_too_large", { mb }));
      return;
    }
  } catch {
    say(t("session_file_unreadable"));
    return;
  }

  const content = await readFile(targetFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const messages: { role: string; text: string }[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (
        (entry.type === "user" || entry.type === "assistant") &&
        entry.message?.content
      ) {
        // The "[tool: …]" / "[tool result]" placeholders are left out: they
        // are machinery, not the conversation a person remembers (a
        // tool-result-only turn then has no text and is skipped).
        const text = extractText(entry.message.content, {
          includeToolBlocks: false,
        });
        if (text) {
          messages.push({
            role: entry.type === "user" ? t("session_role_user") : t("session_role_claude"),
            text: safeText(text, MAX_MSG_LEN),
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

  console.log(t("session_heading"));
  console.log();
  if (messages.length === 0) {
    console.log(t("session_empty"));
    return;
  }
  for (const msg of messages.slice(-MAX_PREVIEW_MESSAGES)) {
    console.log(`  ${msg.role} ${msg.text}`);
    console.log();
  }
}

// CLI bootstrap: only run when invoked directly (not when imported)
// pathToFileURL, not `file://${argv[1]}`: a folder with a space (or any
// character a URL escapes) in its name would never match.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
