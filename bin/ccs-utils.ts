/**
 * ccs-utils.ts — Shared helpers for ccs scan/list/preview modules.
 *
 * Single source of truth for display-text truncation, repo display names and
 * nesting, relative-time bucketing, JSONL message-content extraction, and
 * cross-module constants (review A-1/A-2/A-3/K-8). Before this module
 * existed, each renderer kept its own copy of these helpers with "keep in
 * sync" comments — and they drifted. Behavioral differences must now be
 * expressed as explicit options, never as parallel implementations.
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

/** A repos.yml icon as drawn: never a tab or an escape, 📁 when nothing is left. */
export function displayIcon(icon: string | null | undefined): string {
  return stripControlChars(icon ?? "") || "📁";
}

// ---------------------------------------------------------------------------
// Repo display name & nesting
// ---------------------------------------------------------------------------

/** Display cap for repos.yml `label` (it is a name, not a sentence). */
export const LABEL_MAX = 40;

/**
 * Name shown for a repo in the NEW row and the repo/group preview: the
 * repos.yml `label` when set, else the unique `name`. The label is
 * display-only (never part of a row key or a shell line), so like
 * `description` it is not rejected at load time — control chars are stripped
 * here by truncate(). A label that strips down to nothing falls back to name.
 */
export function repoDisplayName(r: { name: string; label?: string | null }): string {
  return truncate(r.label ?? "", LABEL_MAX) || r.name;
}

/**
 * True when `child` sits strictly inside `parent` (path-segment aware). An
 * empty parent (a repos.yml entry without `path`) contains nothing — as a
 * bare prefix it would have claimed every absolute path.
 */
export function isUnderPath(child: string, parent: string): boolean {
  if (!parent) return false;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

/**
 * The repo in `repos` whose path most deeply contains `repo`'s own — the
 * deepest-path-wins rule buildRepoResolver uses for sessions. Shared by the
 * list tree (ccs-list) and the group preview (ccs-preview) so the two can
 * never disagree on whose child a repo is. Null for a top-level repo.
 */
export function findParentRepo<T extends { path: string }>(
  repo: T,
  repos: T[],
): T | null {
  let parent: T | null = null;
  for (const p of repos) {
    if (p === repo || !isUnderPath(repo.path, p.path)) continue;
    if (!parent || p.path.length > parent.path.length) parent = p;
  }
  return parent;
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

// ---------------------------------------------------------------------------
// Friendly (ui: simple) time — Japanese, calendar-aware
// ---------------------------------------------------------------------------

export interface FriendlyTimeOptions {
  /** Reference time (tests pin it). */
  nowMs?: number;
  /** Append the local clock ("きのう 17:40", "11月1日 09:05"). */
  clock?: boolean;
  /** Returned for null/unparseable input. */
  invalid?: string;
}

function localDayIndex(ms: number): number {
  const d = new Date(ms);
  // Local calendar day number: only the local Y/M/D parts are used, so a
  // DST shift cannot move a timestamp into the neighbouring day.
  return Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000,
  );
}

/**
 * Relative time for the simple UI, written the way people say it:
 * たった今 / N 分前 / N 時間前 / きのう / N 日前 / M月D日 (YYYY年 when the
 * year differs). "きのう" and "N 日前" follow the local calendar, not 24-hour
 * blocks, so a session from last night reads "きのう" the next morning —
 * except within the first 6 hours, where "N 時間前" is the clearer answer
 * (23:00 seen at 01:00 is "2 時間前", not "きのう").
 */
export function formatFriendlyTime(
  iso: string | null | undefined,
  opts: FriendlyTimeOptions = {},
): string {
  const invalid = opts.invalid ?? "-";
  if (!iso) return invalid;
  const t = parseDbTime(iso);
  if (Number.isNaN(t)) return invalid;
  const now = opts.nowMs ?? Date.now();
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const withClock = (s: string) => (opts.clock ? `${s} ${hm}` : s);

  const diffMs = now - t;
  if (diffMs < 60_000) return "たった今";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  const days = localDayIndex(now) - localDayIndex(t);
  if (days <= 0 || hours < 6) return `${hours} 時間前`;
  if (days === 1) return withClock("きのう");
  if (days < 7) return withClock(`${days} 日前`);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const date =
    d.getFullYear() === new Date(now).getFullYear()
      ? md
      : `${d.getFullYear()}年${md}`;
  return withClock(date);
}

// ---------------------------------------------------------------------------
// Terminal display width (ui: simple column alignment)
// ---------------------------------------------------------------------------

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd], // CJK Ext B+
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

/**
 * Terminal column width of plain (ANSI-free) text, the way wcwidth and fzf
 * count it: CJK and emoji with emoji presentation (🧠 🎬 👑) count 2;
 * combining marks, ZWJ and variation selectors count 0; everything else 1 —
 * including symbols that only become emoji with VS16 (✍️ 🛠️ ✴️) and
 * text-presentation pictographs (🛰). Counting those as 2 (what some
 * terminals draw) put the description one column left of fzf's own layout.
 * Used only to pad the simple UI's columns.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      cp === 0x200d ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      continue;
    }
    w += isWide(cp) || EMOJI_PRESENTATION.test(ch) ? 2 : 1;
  }
  return w;
}

/** Pad plain text with spaces to `width` terminal columns (never truncates). */
export function padDisplay(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Shorten an absolute path under $HOME to `~/…` for display. */
export function tildePath(p: string, home: string): string {
  if (!p) return "";
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

// ---------------------------------------------------------------------------
// UI mode (repos.yml `defaults.ui`)
// ---------------------------------------------------------------------------

export type UiMode = "classic" | "simple";
export const UI_MODES: readonly UiMode[] = ["classic", "simple"];

export function isUiMode(v: unknown): v is UiMode {
  return typeof v === "string" && (UI_MODES as readonly string[]).includes(v);
}

/** `--ui=simple` / `--ui=classic` from argv; anything else → classic. */
export function uiFromArgv(argv: string[]): UiMode {
  for (const a of argv) {
    if (a.startsWith("--ui=")) {
      const v = a.slice("--ui=".length);
      return isUiMode(v) ? v : "classic";
    }
  }
  return "classic";
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
