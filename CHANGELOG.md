# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (v0.2.1 features)
- **`ccs init --auto-discover [--depth N]`** — scans `$HOME` (depth 5 default) for git checkout roots, excludes noise dirs (`node_modules`, `Library`, hidden dirs, ...), stops at repo roots, skips symlinks, subtracts repos already in `repos.yml`, and presents the rest in an fzf multi-select. Selections are appended to `repos.yml` comment/format-preservingly (yaml `parseDocument`) with a `.bak` backup and a full-validation rollback, then indexed immediately. Plain `ccs init` scaffolds the config template.
- **Account-free npm install** — `npm install -g github:indigo-gr/claude-code-station` now works end-to-end: `bin/ccs` resolves `$0` through npm's global-bin symlink to find its sibling modules, `tsx` ships as a runtime dependency and the package-local copy is preferred over PATH (a global tsx is only needed for bare-checkout use), and the `files` field keeps the tarball lean. Verified via `npm pack` + sandbox-prefix global install.

### Fixed (review 2026-06-12 — 4-perspective defensive review cleanup)
- **C-2 (High)** — `ccs-delete.sh` no longer dies silently under `set -e` when `rm` fails: the failure is reported, the "Press Enter" prompt still runs, and the script exits 1. `du` failure (file vanished mid-flow) falls back to `?` instead of killing the script.
- **C-1 (High)** — `git log` parsing uses NUL (`%x00`) separators instead of tabs, so a commit subject containing a literal TAB can no longer shift the split and persist subject fragments into `last_commit_at`. Regression test commits a tab-in-subject fixture.
- **C-4** — a session JSONL growing past the 50MB cap now keeps its (stale but resumable) row, stamps the new size/mtime, and stops being re-parsed on every scan; previously the row was permanently stale AND re-attempted forever.
- **C-5** — `ccs-list` cold-start friendly hint was dead code: the `isMissing` patterns never matched `openDb()`'s actual "state.db not found" message. Pattern added; the regression test now asserts the friendly branch specifically (the old test passed via the raw fatal path).
- **C-3** — Twilio Account SID masking accepts uppercase hex (`AC[a-fA-F0-9]{32}`).
- **DA-3** — `buildRepoResolver` registers each repo root under its realpath too, so repos registered via symlinked paths (or macOS `/var` aliasing) claim their sessions.
- **A-8** — sessions not mapped to any repo now launch with the documented fallback chain (`defaults.command` > `CCS_CMD` > `"claude"`) via the new `meta.defaults_command` value, instead of a hardcoded `"claude"`.
- **A-10** — `--current-only` filters in SQL (`cwd = ? OR (cwd >= ? AND cwd < ?)`) so `idx_sessions_cwd` applies; sibling dirs sharing the cwd as a string prefix are excluded by construction.
- **A-6** — the resolved `defaults.command` (including `CCS_CMD`/`CCR_CMD` origin) is SHELL_METACHARS-validated in `loadConfig()` even when no repo inherits it.
- **K-4** — `command` / `custom` ConfigError messages carry the `repos.yml: repos[i].field` prefix like every other validation error (the Phase 6 "at index" phrasing is retired).
- **K-9** — `npm test` runs via `node --import tsx --test` (works on the documented Node >= 20, not just Node >= 23.6 type-stripping); `"type": "module"` added to silence `MODULE_TYPELESS_PACKAGE_JSON`.
- **K-10** — `install.sh` lists installed files with `find -maxdepth 1` instead of `ls | grep` (SC2010).

### Changed (review 2026-06-12 — structure)
- **A-4** — session indexing extracted from `ccs-scan.ts` (999 lines) into `bin/ccs-scan-sessions.ts`; `parseSessionJsonl` / `buildRepoResolver` / `scanSessions` are exported and unit-testable.
- **A-1 / A-2 / A-3 / K-8** — new `bin/ccs-utils.ts` is the single source for `truncate`, `timeBucket` / `formatRelativeTime` / `formatDateTime`, `extractText` (tool blocks behind an explicit option), `UUID_RE`, and `MAX_JSONL_SIZE`. The list/preview copies (which had already drifted in whitespace handling and 日本語/English suffixes) are gone; relative time renders uniformly as English ("5m ago"). List session badges show `-` for unparseable timestamps instead of echoing the raw DB string.
- **Schema v2** — new `meta(key, value)` table (idempotent migration; `getMeta` degrades to null on pre-v2 caches read by readonly consumers).

### Tests (review 2026-06-12)
- New `test/ccs-utils.test.ts` pins the unified helper semantics (thresholds, control-char stripping, tool-block extraction, UUID gate).
- New regression tests: tab-in-commit-subject (C-1), oversized-JSONL keep/touch/skip via sparse `ftruncate` (C-4), symlinked-repo session mapping (DA-3), cold-start friendly hint (C-5), unmapped-session command fallback incl. pre-v2 cache degradation (A-8), `--current-only` exact/subdir/sibling-prefix (A-10), `defaults.command`/`CCS_CMD` origin validation (A-6), uppercase Twilio SID (C-3), meta round-trip + v1→v2 upgrade.
- `freshImport()` comment in the config tests now states the truth: the ESM cache is NOT busted; module state resets go through exported hooks (C-6).
- 110 tests, all green.

### Docs (review 2026-06-12)
- Regression checklist #4 (secret patterns: 26 unified) and #18 (risky-command warning removed in Phase 6 S2) corrected; stale `isUnderHome` backlog entry closed (fixed by audit M-4); README architecture diagram lists all 14 bin/ modules; `REVIEW.md` reflects the metachar hard-reject reality; `sqlite-schema.md` documents schema v2 + the sessions-first scan order; `repos-yml-schema.md` documents the NEW-3 name policy, unified error formats, and the unmapped-session fallback.

### Fixed (review 2026-06-12 — follow-up batch)
- **COUNT(*) in-transaction** — `scanOneRepo` reads its session aggregates inside the write transaction, so a concurrent process committing session changes can no longer slip between the read and the `repo_stats` upsert.
- **Advisory scan lock** — `<cacheDir>/scan.lock` (O_EXCL create, 5-minute stale takeover): a second concurrent scan skips with a stderr note instead of racing the sessions cleanup (original CR2 H3). `ScanResult.lockSkipped` exposes the skip.
- **PRAGMA tuning** — write-path connections set `cache_size = -8000`, `temp_store = MEMORY`, `mmap_size = 64MB` (readonly preview path untouched).
- **install.sh runtime deps** — `node_modules` is symlinked from the repo checkout into the install dir so installed scripts resolve `better-sqlite3`/`yaml` (closes the backlog HIGH short-term; npm-package distribution remains the long-term plan).
- **Prompt visibility on piped stdin** — `ccs-delete.sh` and `install.sh` print prompts explicitly to stderr (`prompt_read` helper) instead of relying on `read -p`, which bash renders only when stdin is a TTY. TTY behavior is unchanged (`read -p` also writes to stderr); scripted/piped use no longer loses the prompts, and the shell tests now assert them.

### Tests (review 2026-06-12 — follow-up batch)
- New `test/ccs-shell.test.ts`: the previously-untested bash surfaces — `bin/ccs --version/--help` and the full `ccs-delete.sh` matrix (non-UUID rejection, not-found, confirmed delete incl. subagent-dir removal, declined delete, and the C-2 rm-failure branch) — driven by node:test + spawnSync with sandboxed HOME/XDG. No bats dependency.
- Advisory-lock test: fresh lock → skip; stale lock → takeover + release.
- 118 tests, all green.

### Security (audit 2026-06-12 hardening)
- **H-1 / NEW-1 — session intake sanitization**: a session `.jsonl` `cwd` no longer reaches the Ctrl-Y clipboard command unchecked. Session `cwd`/`topic`/`summary`/`branch` and workspace `first_line` are now gated at scan time via a shared `bin/ccs-sanitize.ts`: shell metacharacters reject the `cwd` to an `"unknown"` sentinel (blocks deferred command injection on paste), and control characters incl. ESC are stripped (blocks ANSI/terminal-escape spoofing in the `--ansi` fzf list and preview).
- Ctrl-Y clipboard line now `%q`-quotes the `cwd`/`uuid` (defense-in-depth for H-1); list/preview renderers strip control chars on the display side too (defense-in-depth for NEW-1).
- **NEW-3** — `repos.yml` `name` now rejects the full `SHELL_METACHARS` set (was only `\t \n \\`), matching the `path`/`cwd`/`command` policy.
- **NEW-2** — `bin/ccs` `new:` row validation rejects control chars (incl. ESC) in addition to shell metacharacters.
- **M-1** — secret patterns expanded 19 → 26: GitLab PAT, GitHub fine-grained PAT, Google OAuth secret, SendGrid, npm token, Slack webhook URL, generic `KEY=value`, and any-scheme `user:pass@` URL credentials.
- **M-2** — session `cwd` is now run through `maskSecrets`; preview-pane header fields (`cwd`/`branch`/`version`) are masked too.
- **M-3** — `ccs-delete.sh` cache cleanup uses a bound-parameter delete (`bin/ccs-delete-session.ts`) instead of string-concatenated SQL.
- **M-4** — `isUnderHome` resolves symlinks (`realpathSync`), closing the `~/escape -> /` HOME-escape.
- **L-1** — `bin/ccs` HOME check requires `$HOME` itself or a `$HOME/` child (rejects sibling dirs like `/Users/xEVIL`).
- **L-2** — `rm -rf` of the subagent dir is guarded by a final-form `<projects>/<dir>/<uuid>` check.

### Fixed (audit 2026-06-12 logic)
- **C-1 (critical)** — `scan()` now runs the sessions pass before the repo pass, so `repo_stats.session_count_total` / `session_last_at` are correct after a single `--refresh` (previously lagged one scan; a fresh DB showed every repo as `💤 未使用`).
- **logic H-1** — `--no-sessions` scans preserve the previous session aggregates instead of rewinding them to 0.
- **H-2 / M-1 (time)** — list and preview parse DB timestamps through a shared `bin/ccs-time.ts` that treats naive SQLite `datetime('now')` values as UTC (no more JST skew); `sessions.indexed_at` is written as ISO 8601 for a single in-DB time format.
- **H-3** — preview "Recent" sessions use the same `WHERE repo_name = ?` population as the "Total" count (no more Total/Recent disagreement).
- **H-4** — `message_count` counts only `user`/`assistant` rows, matching the preview.
- **M-4 (logic)** — sessions started in a repo subdirectory map to the repo via longest-prefix matching.
- **M-3 (logic)** — sessions left unmapped (repo added after the session) are re-resolved on later scans.
- **M-2 (logic)** — `scan: false` repos show a `[scan off]` badge so their frozen stats aren't read as current.
- **M-5** — `extractUserText` joins all text blocks (matches the preview), so topics aren't truncated to the first block.
- **M-6** — `started_at` / `last_activity_at` use min/max of timestamps, not first/last line order.
- **L-1 (logic)** — `parseInt` results are `Number.isFinite`-guarded before DB writes.
- **L-3 / L-4 (perf/robustness)** — workspace dir previews `stat` in parallel and read only the first 4 KB per file; chmod failures on the cache (and WAL side files) now warn instead of failing silently.
- **NEW-4** — `busy_timeout = 3000` set on the DB connection so concurrent `--force` scans don't fail with `SQLITE_BUSY`.
- Stale `ccr-preview.ts` header comment in `ccs-preview-session.ts` corrected.

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
