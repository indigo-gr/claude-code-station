# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — Unreleased

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
