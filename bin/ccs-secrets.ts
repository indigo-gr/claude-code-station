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

/*
 * Pattern origins:
 *   anthropic     = Anthropic API key (sk-ant-...)
 *   openai        = OpenAI API key (sk-... excluding sk-ant-)
 *   github-pat    = GitHub Personal Access Token
 *   github-oauth  = GitHub OAuth access token
 *   github-server = GitHub server-to-server token (GitHub Apps)
 *   github-user   = GitHub user-to-server token
 *   github-refresh= GitHub OAuth refresh token
 *   aws-access    = AWS long-lived access key ID (AKIA prefix)
 *   aws-sts       = AWS STS temporary session credentials (ASIA prefix)
 *   google-api    = Google API key (AIza prefix)
 *   stripe-live   = Stripe live-mode secret/restricted key (sk_live / rk_live)
 *   stripe-test   = Stripe test-mode secret/restricted key (sk_test / rk_test)
 *   twilio-account= Twilio Account SID (AC + 32 hex chars)
 *   slack-token   = Slack bot/user/app/refresh/OAuth token family (xox[baprs])
 *   jwt           = JSON Web Token (3 base64url segments separated by dots)
 *   bearer        = "Bearer " Authorization header token
 *   op-ref        = 1Password op:// secret reference
 *   db-url        = Database connection URL with embedded credentials
 *                   (postgres/mysql/mongodb/redis, incl. +srv variants)
 *   private-key   = PEM-encoded private key block
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
  { name: "aws-sts", re: /ASIA[A-Z0-9]{16}/g },
  { name: "google-api", re: /AIza[A-Za-z0-9_-]{35}/g },
  { name: "stripe-live", re: /[sr]k_live_[A-Za-z0-9]{24,}/g },
  { name: "stripe-test", re: /[sr]k_test_[A-Za-z0-9]{24,}/g },
  { name: "twilio-account", re: /AC[a-f0-9]{32}/g },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "op-ref", re: /op:\/\/[A-Za-z0-9._/-]+/g },
  {
    name: "db-url",
    re: /\b(?:postgres|mysql|mongodb|redis)(?:\+srv)?:\/\/[^\s@]+:[^\s@]+@[^\s]+/gi,
  },
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
