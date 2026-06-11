/**
 * ccs-time.ts — Shared timestamp parsing for ccs list/preview renderers.
 *
 * state.db holds two timestamp shapes (audit logic H-2 / M-1):
 *   1. ISO 8601 with offset — e.g. "2026-06-12T03:04:05.000Z"
 *      (written by nowIso() / JSONL timestamps / mtime conversions)
 *   2. SQLite naive datetime — e.g. "2026-06-12 03:04:05"
 *      (written by `datetime('now')` DDL defaults; always UTC per SQLite docs)
 *
 * `Date.parse` interprets shape 2 as LOCAL time on V8, which would skew
 * rendered ages by the UTC offset (+9h in JST). Every consumer must therefore
 * parse DB timestamps through this module instead of calling Date.parse
 * directly.
 */

/** Normalize a DB timestamp to an unambiguous ISO 8601 UTC string. */
export function normalizeDbTime(iso: string): string {
  return iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
}

/**
 * Parse a DB timestamp into epoch milliseconds.
 * Returns NaN for unparseable input (callers decide the fallback).
 */
export function parseDbTime(iso: string): number {
  return Date.parse(normalizeDbTime(iso));
}
