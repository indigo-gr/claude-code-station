/**
 * ccs-sanitize.ts — Shared input-sanitization helpers for ccs.
 *
 * Single source of truth for the shell-metacharacter policy and control
 * character stripping. Two consumers:
 *   - ccs-config.ts: rejects repos.yml fields at load time (trusted-ish input)
 *   - ccs-scan.ts:   normalizes session JSONL fields at intake (untrusted
 *     input — any process able to write ~/.claude/projects can plant values)
 *
 * Threat model (audit H-1 / NEW-1, 2026-06-12): session `cwd`/`topic` reach
 * the fzf list, the preview pane, and the Ctrl-Y clipboard command. Shell
 * metacharacters enable deferred command injection on paste; raw ESC/OSC
 * sequences enable terminal spoofing (fzf runs with --ansi). Both classes are
 * neutralized here, at the trust boundary.
 */

// Shell metacharacters forbidden in path/cwd/command values that are ever
// interpolated into a shell line (fzf execute bindings, clipboard, final
// launch in bin/ccs). \x00-\x1f covers TAB, NL, CR, ESC and all other C0
// control characters, so this single class blocks command injection and
// terminal-escape injection at once.
export const SHELL_METACHARS = /[;&|<>$`"'\\\n\r\x00-\x1f]/;

/** True when the value contains any shell metacharacter / control char. */
export function hasShellMetachars(value: string): boolean {
  return SHELL_METACHARS.test(value);
}

// All C0 control characters plus DEL. \n and \t are NOT exempted: every ccs
// display surface is single-line-per-field (TSV rows, preview lines), and the
// TSV protocol between ccs-list and fzf breaks on embedded tabs/newlines.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]+/g;

/**
 * Strip C0 control characters (incl. ESC) and DEL from display text,
 * collapsing each run into a single space. Defense against terminal-escape
 * injection (audit NEW-1) for fields that are rendered but never executed:
 * topic, summary, branch, first_line, commit subjects.
 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sanitize a session-provided cwd at intake (audit H-1).
 *
 * Unlike display text, cwd is later interpolated into a shell `cd` command
 * (clipboard via Ctrl-Y, launch via bin/ccs), so a tainted value cannot be
 * "cleaned" — it must be rejected outright. Returns null when the value is
 * unusable; callers store the "unknown" sentinel instead.
 */
export function sanitizeSessionCwd(cwd: string): string | null {
  if (cwd.length === 0) return null;
  if (hasShellMetachars(cwd)) return null;
  if (!cwd.startsWith("/")) return null;
  return cwd;
}
