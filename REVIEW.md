# Code Review Guidelines — ccs

Target: **0 Critical, 0 High** before release. Older review notes are kept in `docs/` for history.

## Components

- `bin/ccs` — bash entry point, argument parsing, version and copyright label, fzf bindings for both looks, command execution
- `bin/ccs-config.ts` — `repos.yml` loader, validation, precedence resolution (`ui`, `lead`, `launch`, groups)
- `bin/ccs-db.ts` — better-sqlite3 wrapper (WAL, FK, prepared statements, migrations)
- `bin/ccs-scan.ts` / `ccs-scan-sessions.ts` — state scanner (git / handoff / pendings / session JSONL), writes DB
- `bin/ccs-list.ts` — DB reader, emits the 6-column tab-separated rows fzf shows (classic and simple)
- `bin/ccs-preview.ts` / `ccs-preview-session.ts` — preview pane renderers
- `bin/ccs-update-check.ts` — background request for npm's latest version, writes the cache `bin/ccs` reads
- `bin/ccs-init.ts` — `ccs init` (discover repos, append to `repos.yml`)
- `bin/ccs-delete.sh` / `ccs-delete-session.ts` — Ctrl-D session delete handler
- `bin/ccs-sanitize.ts` / `ccs-secrets.ts` / `ccs-utils.ts` / `ccs-time.ts` — shared cleaning, masking and formatting helpers

## Always check — security

- **Command injection**: UUID regex validation before `claude --resume <uuid>`; `name` / `command:` reject shell metachars; a wildcard in `command:` is passed as written, not expanded
- **Row columns**: every row `ccs-list` prints has exactly 6 columns; no field (`icon`, `label`, `description`, `tags`, a session's text) can add a tab, a newline or `\x1f` and so choose the command
- **Path traversal**: every `cwd` must resolve under `$HOME` after `..` is applied; fallback to `.` with a warning otherwise
- **Files a repo brings**: a scan does not follow a symlink out of the repo (`handoff/`, `pendings/`), and does not run what the repo's own git config names (`core.fsmonitor`, hooks)
- **Secret masking**: API key / token patterns masked in preview output and in the DB. Mask first, then cut, so a key across the cut is still hidden
- **Terminal control**: display fields lose C0, C1 and bidirectional controls before they reach the list or the preview
- **Update check**: one GET of public data, with nothing about the user in it; a time limit; never waited for at startup; only a plain `X.Y.Z` is stored or shown; `CCS_NO_UPDATE_CHECK` turns it off
- **SQLite hygiene**: DB file created with `0600`; config/cache dirs `0700`; `PRAGMA foreign_keys = ON`; **prepared statements only** (no string concat)
- **No `eval`**; no `bash -c` with interpolated user input
- **File size cap**: 50MB per JSONL file when parsing (memory exhaustion guard)
- **YAML loading**: `yaml` parser with default (safe) mode; no `!!js/function` or custom tags
- **CCS_CMD**: split by whitespace, executed directly (documented trust boundary); `CCR_CMD` only warns and migrates

## Always check — code quality

- Shell: `set -euo pipefail`, all variables quoted, arrays expanded with `"${arr[@]+"${arr[@]}"}"` for empty-array safety. A command that may fail on the way to a fallback needs `|| …`, or `set -e` ends the script without a word
- bash 3.2 (macOS) and newer: no associative arrays, no `mapfile`
- TypeScript: `strict: true`, no `any`, explicit return types on exported functions
- SQLite: transactions for multi-row writes, WAL mode enabled once per connection
- Cross-platform: macOS + Linux (X11/Wayland/headless) for clipboard and paths

## Always check — the screen

- Both looks: `ccs v<version>` from `package.json`, the copyright holder, and a frame whose corners survive at narrow widths (a label wider than the frame overwrites them)
- A new line on the screen takes no row from the list. `test/ccs-tty.test.ts` compares with what the previous look showed
- The label survives whatever replaces the header (`change-header`)
- `ui: simple` keeps its plain Japanese wording and needs fzf 0.61+; older fzf falls back to classic

## Always check — what ships

- Name and license agree everywhere: `LICENSE`, `package.json` (`author`, SPDX `license`), the README's License section, the screen
- `npm pack --dry-run` lists only `bin/`, `docs/`, `CHANGELOG.md`, `LICENSE`, `README.md`, `package.json`
- `version` is the same in `package.json` and both places in `package-lock.json`, and `CHANGELOG.md` has its section
- No personal or local details: addresses, home paths, internal names or tracker numbers, in the files or in the commit messages that touch them
- Test data is fictional, and secrets in tests are fake and built at run time, so the source holds no text shaped like a key

## Attack surface

| Surface | Mitigation |
|---|---|
| `~/.cache/ccs/state.db` | `0600`, under `$XDG_CACHE_HOME` or `~/.cache`, secrets masked before they are stored |
| `~/.cache/ccs/update-check` | `0600`, plain `X.Y.Z` only, validated again when `bin/ccs` reads it |
| `~/.config/ccs/repos.yml` | User-owned config, trust boundary documented; `name`/`path`/`command` validated, display fields cleaned |
| `custom:` object | Stored as JSON, displayed verbatim, size capped; README warns against storing API keys |
| JSONL parsing | 50MB cap; text masked and cleaned; `cwd` rejected rather than cleaned when unusable |
| Registered repos | Read through git with the repo's own commands switched off; symlinks out of the repo not followed |
| npm registry answer | Untrusted text: never reaches a terminal, an fzf option or a shell unless it is a plain `X.Y.Z` |

## Style

- Shell: `set -euo pipefail`, quote all variables
- TypeScript: strict, no `any`, focused modules
- Immutable patterns preferred in TS helpers

## Skip

- Formatting-only changes
- Comment-only diffs unrelated to security
