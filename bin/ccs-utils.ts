/**
 * ccs-utils.ts — Shared helpers for ccs scan/list/preview modules.
 *
 * Single source of truth for display-text truncation, relative-time
 * bucketing, JSONL message-content extraction, and cross-module constants
 * (review A-1/A-2/A-3/K-8). Before this module existed, each renderer kept
 * its own copy of these helpers with "keep in sync" comments — and they
 * drifted. Behavioral differences must now be expressed as explicit options,
 * never as parallel implementations.
 */

import { stripControlChars } from "./ccs-sanitize.ts";
import { parseDbTime } from "./ccs-time.ts";

// ---------------------------------------------------------------------------
// Cross-module constants
// ---------------------------------------------------------------------------

/** Session JSONL files above this size are never read into memory. */
export const MAX_JSONL_SIZE = 50 * 1024 * 1024;

/** Canonical session-UUID gate. Bash copies live in bin/ccs and ccs-delete.sh. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Current time as ISO 8601 UTC — the only timestamp format ccs writes. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Display truncation
// ---------------------------------------------------------------------------

/**
 * Single-line display truncation: strips control chars (incl. ESC, DEL),
 * collapses whitespace runs, and clips to `max` with an ellipsis.
 *
 * Display-side defense against terminal-escape injection (audit NEW-1):
 * fzf renders the list with --ansi and the preview pane prints raw to the
 * terminal. Intake sanitization in ccs-scan is the first line of defense.
 */
export function truncate(s: string, max: number): string {
  if (!s) return "";
  const flat = stripControlChars(s);
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export type TimeBucket =
  | { kind: "now" } // < 1 minute (incl. clock skew into the future)
  | { kind: "m" | "h" | "d" | "w"; value: number }
  | { kind: "date"; iso: string } // >= 4 weeks → absolute YYYY-MM-DD
  | { kind: "invalid" };

/**
 * Bucket a DB timestamp for relative display. The thresholds
 * (<1m / <60m / <24h / <7d / <4w / absolute date) are the single source of
 * truth shared by the list badges and the preview pane, so the same
 * timestamp can never render as "52w" in one place and "2025-06-12" in the
 * other (audit logic L-3).
 */
export function timeBucket(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): TimeBucket {
  if (!iso) return { kind: "invalid" };
  // parseDbTime, not Date.parse: naive "YYYY-MM-DD HH:MM:SS" values from
  // SQLite are UTC and must not be parsed as local time (audit logic H-2).
  const t = parseDbTime(iso);
  if (Number.isNaN(t)) return { kind: "invalid" };
  const diffMs = nowMs - t;
  if (diffMs < 60_000) return { kind: "now" };
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return { kind: "m", value: m };
  const h = Math.floor(m / 60);
  if (h < 24) return { kind: "h", value: h };
  const d = Math.floor(h / 24);
  if (d < 7) return { kind: "d", value: d };
  const w = Math.floor(d / 7);
  if (w < 4) return { kind: "w", value: w };
  return { kind: "date", iso: new Date(t).toISOString().slice(0, 10) };
}

/**
 * Render a DB timestamp as relative age ("5m ago", "3d ago") or an absolute
 * date past 4 weeks. `invalid` is returned for null/unparseable input —
 * list badges pass "" (badge omitted), the preview pane passes "-".
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  invalid = "-",
): string {
  const b = timeBucket(iso);
  switch (b.kind) {
    case "invalid":
      return invalid;
    case "now":
      return "<1m ago";
    case "date":
      return b.iso;
    default:
      return `${b.value}${b.kind} ago`;
  }
}

/** Render a DB timestamp as local "YYYY-MM-DD HH:MM"; `invalid` on failure. */
export function formatDateTime(
  iso: string | null | undefined,
  invalid = "-",
): string {
  if (!iso) return invalid;
  const d = new Date(parseDbTime(iso));
  if (Number.isNaN(d.getTime())) return invalid;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// JSONL message-content extraction
// ---------------------------------------------------------------------------

export interface ExtractTextOptions {
  /**
   * Include "[tool: name]" / "[tool result]" placeholders for non-text
   * blocks. The conversation preview wants them (visual flow); topic
   * extraction in the scanner does not (the topic is the user's words).
   */
  includeToolBlocks?: boolean;
}

/**
 * Flatten a Claude Code JSONL `message.content` value (string or block
 * array) into one string. Shared by topic extraction (ccs-scan-sessions)
 * and the conversation preview (ccs-preview-session); the historical bug
 * class here was two copies drifting apart behind a "keep in sync" comment
 * (review A-2) — behavioral differences belong in `opts`, not in forks.
 */
export function extractText(
  content: unknown,
  opts: ExtractTextOptions = {},
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; name?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    } else if (opts.includeToolBlocks && b.type === "tool_use") {
      texts.push(`[tool: ${typeof b.name === "string" ? b.name : "?"}]`);
    } else if (opts.includeToolBlocks && b.type === "tool_result") {
      texts.push("[tool result]");
    }
  }
  return texts.join(" ");
}
