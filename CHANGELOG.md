# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-26

### Changed
- **Renamed** from `claude-code-recall` (ccr) to `claude-code-station` (ccs). Binary, repo, and config paths all follow the new name.
- Environment variable `CCR_CMD` → `CCS_CMD`. `CCR_CMD` is still honored (with a stderr deprecation warning) when `CCS_CMD` is unset.
- Minimum Node.js version raised to **20**.

### Added
- **Mixed-mode launcher**: a single fzf list now shows both `NEW` repo rows (launch fresh) and `RESUME` session rows (resume past).
- **Repository state badges** in the preview pane: git status, handoff/ file count, pendings/ file count, and integration links.
- **SQLite-backed state cache** at `~/.cache/ccs/state.db` (or `$XDG_CACHE_HOME/ccs/state.db`). WAL mode, foreign keys on, prepared statements only, `0600` permissions.
- **Configuration file** `~/.config/ccs/repos.yml` with schema validation. Auto-generated template on first run. Full schema: `docs/design/repos-yml-schema.md`.
- **Per-repo custom integration fields** (`custom:` map): built-in known keys for Plane, Attio, Notion, Linear, Slack, GitHub, Figma. Unknown keys rendered verbatim under "Other Integrations".
- **New flags**: `--new`, `--resume`, `--refresh`, `--no-scan`, plus pass-through for unknown flags.
- **New key binding**: `Ctrl-R` to force DB refresh from within fzf.
- **Dependency**: `better-sqlite3 ^11.3.0`, `yaml ^2.6.0`.
- `install.sh --with-deps` opt-in flag to run `npm install` as part of install.

### Security
- All SQLite access uses prepared statements; FK enforced.
- Config/cache directories created with mode `0700`; DB with `0600`.
- `custom:` values documented as trusted user config; README warns against storing API keys.

### Security (Phase 6 hardening)
- Reject shell metacharacters in `command:` config field (S1/S2 — prevents injection via malicious repos.yml)
- Cap `custom` field JSON size at 64KB to prevent local DoS
- Apply `maskSecrets` to `sessions.topic` and `sessions.summary` columns (was only applied to handoff/pending first_line)
- Expand secret patterns from 13 → 19: AWS STS (ASIA), Stripe live/test, Twilio, JWT, database URLs

### Fixed (Phase 6 quality)
- `ccs-list.ts` now opens SQLite in readonly mode with migrate skipped (regression of prior M4 fix)
- `ccs-scan.ts` CLI bootstrap correctly exits non-zero on synchronous throws
- `ccs-preview-session.ts` converted from sync fs to async fs/promises; CLI guards `undefined` session ID
- `deleteReposNotIn` uses `json_each` to avoid SQLite 999-variable limit (supports 500+ repos)
- Replaced unquoted `cut -f` result with `IFS`-based read for space-safe row parsing
- Unified `node:` prefix on all fs/path imports
- Fixed stale `ccr-delete.sh` header comment to `ccs-delete.sh`
- Corrected `sqlite-schema.md` dependency note (removed misleading `npm install -g`)
- `ccs-list.ts` uses `homedir()` instead of `process.env.HOME || ""` for tilde substitution

### Added (Phase 8 — UX polish)
- `ccs-list.ts` emits a dim `── Past Sessions ──` divider between NEW repos and RESUME sessions when both are present. Selecting the divider is a no-op.
- RESUME sessions not mapped to a registered repo now display `❓` as a visible "either one-off run or repo not registered yet" cue. Mapped sessions show the repo's icon (default `📁`).
- `Ctrl-Y` / `Ctrl-I` no longer abort fzf after copying — they flash a `📋 Copied…` header and keep the picker open so you can launch or copy again without re-running `ccs`.
- Label column now has a dim `│` separator between the repo/session name and the description for visual clarity even when the description is empty.

### Fixed (Phase 8 — CR4 remediations)
- `bin/ccs`: separator-row Enter no longer prints `❌ Could not parse selection` — the empty-`ROW_CMD` guard is now scoped to actionable rows only.
- `bin/ccs`: narrow-terminal safety — header line 2 shortened from 81 → 63 chars so it no longer wraps at 80-column terminals.
- `bin/ccs`: `read -r -n1 _` for the new-row Ctrl-D notice accepts any key (was waiting for Enter despite the "press any key" message).
- `bin/ccs-list.ts`: removed an unnecessary non-null assertion in `sessionToRow` by testing `s.repo_display` directly for TS narrowing.
- `bin/ccs-list.ts`: section-separator emit guard uses the explicit `wantRepos` flag instead of the indirect `lines.length > 0` so adding future preamble rows can't spuriously trigger it.
- `install.sh`: checks `fzf >= 0.42.0` (required for the `change-header` binding used by the copy-toast).
- `README.md`: pins `fzf ≥ 0.42.0`, documents the new `^Y`/`^I` copy-keep-open behavior, the `❓` unmapped-session icon, and the section divider.

### Fixed (Phase 7 — CR3 remediations)
- `ccs-list.ts`: cold-start error (state.db not yet created) now prints friendly hint instead of raw stack trace
- `ccs-scan.ts`: apply `maskSecrets` to `last_commit_subject` and `scan_error` before DB write and stderr log
- `ccs-db.ts`: `DbHandle.close()` performs `wal_checkpoint(PASSIVE)` to keep WAL file from accumulating
- `ccs-preview-session.ts`: switched remaining bare `"path"` / `"os"` imports to `node:` prefix
- `docs/design/repos-yml-schema.md`: added `command` shell-metachar validation row to schema table

### Migration
- Existing JSONL sessions under `~/.claude/projects/*/*.jsonl` are auto-discovered on first scan — nothing to migrate manually.
- Remove old binaries: `rm ~/.claude/scripts/ccr*`.
- Rename `CCR_CMD` → `CCS_CMD` in your shell rc.

## [0.1.3] — 2026-03-11

### Fixed
- Use JSONL filename UUID instead of internal `sessionId` for resume/delete. Sidechain sessions whose internal id differed from filename caused "Session file not found" errors on preview and delete.
- Skip `[Request interrupted by user]` messages when generating session summary.

## [0.1.2] — 2026-03-11

### Added
- Adaptive 2-line fzf header for narrow terminals (`<80` cols → short labels, `≥80` cols → full labels).

## [0.1.1] — 2026-03-11

### Fixed
- Replaced `exec` with direct invocation so `CCR_CMD` can be a shell function (e.g., `opr`), not only an external command.

## [0.1.0] — 2026-03-11

### Added
- Initial release as `claude-code-recall` (ccr).
- fzf-powered session picker across all `~/.claude/projects/*/*.jsonl`.
- Live preview pane with conversation history.
- `Ctrl-Y` (copy resume command), `Ctrl-I` (copy session ID), `Ctrl-D` (delete session) keybindings.
- Cross-platform clipboard: `pbcopy` (macOS), `xclip` / `xsel` (X11), `wl-copy` (Wayland).
- `CCR_CMD` environment variable for custom claude wrapper commands.
- UUID validation, `$HOME`-rooted path validation, secret masking in preview, 50MB JSONL size cap.
- MIT License.
