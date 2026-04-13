/**
 * ccs-secrets.ts — Unified secret detection for ccs (scan + preview).
 *
 * Single source of truth for secret-masking patterns. Both the scan engine
 * (which writes `first_line` columns into state.db) and the fzf preview pane
 * (which renders session text live) import from here so no credential can
 * land in cache or terminal output through pattern drift.
 *
 * All matches are replaced with the sentinel [REDACTED].
 */

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai", re: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: "github-oauth", re: /gho_[A-Za-z0-9]{36,}/g },
  { name: "github-server", re: /ghs_[A-Za-z0-9]{36,}/g },
  { name: "github-user", re: /ghu_[A-Za-z0-9]{36,}/g },
  { name: "github-refresh", re: /ghr_[A-Za-z0-9]{36,}/g },
  { name: "aws-access", re: /AKIA[A-Z0-9]{16}/g },
  { name: "google-api", re: /AIza[A-Za-z0-9_-]{35}/g },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "op-ref", re: /op:\/\/[A-Za-z0-9._/-]+/g },
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

const REPLACEMENT = "[REDACTED]";

/**
 * Mask all known secret patterns in the given string.
 * Returns a new string; the original is not mutated.
 */
export function maskSecrets(input: string): string {
  let out = input;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REPLACEMENT);
  }
  return out;
}
