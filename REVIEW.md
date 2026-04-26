# Code Review Guidelines — ccs v0.2.0

Target: **0 Critical, 0 High** before release. Medium/Low tracked in `docs/review-notes.md` if present.

## Components reviewed (v0.2.0)

- `bin/ccs` — bash entry point, argument parsing, fzf bindings, command execution
- `bin/ccs-config.ts` — `repos.yml` loader, validation, precedence resolution
- `bin/ccs-db.ts` — better-sqlite3 wrapper (WAL, FK, prepared statements)
- `bin/ccs-scan.ts` — state scanner (git / handoff / pendings), writes DB
- `bin/ccs-list.ts` — DB reader, emits fzf-compatible tab-separated rows
- `bin/ccs-preview.ts` / `ccs-preview-session.ts` — preview pane renderers
- `bin/ccs-delete.sh` — Ctrl-D session delete handler

## Always check — security

- **Command injection**: UUID regex validation before `claude --resume <uuid>`; repo `name` rejects shell metachars (`; & | < > $ \``); `command:` field is user config, trust documented in README but never composed from external input
- **Path traversal**: every `cwd` must be under `$HOME`; fallback to `.` with a warning otherwise
- **Secret masking**: API key / token patterns masked in preview output (JSONL + integration URLs)
- **SQLite hygiene**: DB file created with `0600`; config/cache dirs `0700`; `PRAGMA foreign_keys = ON`; **prepared statements only** (no string concatenation of SQL)
- **No `eval`**; no `bash -c` with interpolated user input
- **File size cap**: 50MB per JSONL file when parsing (memory exhaustion guard — carried over from v0.1.x)
- **YAML loading**: `yaml` parser with default (safe) mode; no `!!js/function` or custom tags
- **CCR_CMD / CCS_CMD**: split by whitespace, executed directly (documented trust boundary)

## Always check — code quality

- Shell: `set -euo pipefail`, all variables quoted, arrays expanded with `"${arr[@]+"${arr[@]}"}"` for empty-array safety
- TypeScript: `strict: true`, no `any`, explicit return types on exported functions
- SQLite: transactions for multi-row writes, WAL mode enabled once per connection
- Cross-platform: macOS + Linux (X11/Wayland/headless) for clipboard and paths

## Attack surface additions vs v0.1.x

| Surface | Mitigation |
|---|---|
| `~/.cache/ccs/state.db` (new) | `0600`, under `$XDG_CACHE_HOME` or `~/.cache`, no secrets stored |
| `~/.config/ccs/repos.yml` (new) | User-owned config, trust boundary documented; `name`/`path` validated |
| `custom:` object (new) | Stored as JSON, displayed verbatim; README warns against storing API keys |
| JSONL parsing (carried) | 50MB cap retained |

## Style

- Shell: `set -euo pipefail`, quote all variables
- TypeScript: strict, no `any`, small focused modules (<400 LOC)
- Immutable patterns preferred in TS helpers

## Skip

- Formatting-only changes
- Comment-only diffs unrelated to security
