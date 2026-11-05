# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] — 2026-11-06

### Changed
- Republished to update the package's public contact details on npm. No functional changes.

### Security
- Lockfile: `tsx` 4.23.15, which brings `esbuild` 0.28.2 ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), a path traversal in esbuild's development server on Windows). ccs never runs that server — tsx only uses esbuild to transform code — so ccs was not affected. A fresh `npm install -g` already resolved the newer tsx; this updates the lockfile used by installs from the repository (`install.sh --with-deps`).

## [0.3.2] — 2026-11-05

### Changed
- **npm package renamed to `@indigo-gr/claude-code-station`** — install with `npm install -g @indigo-gr/claude-code-station`. The unscoped `claude-code-station` (0.3.1 and earlier) is deprecated and gets no new versions; switch once with `npm uninstall -g claude-code-station && npm install -g @indigo-gr/claude-code-station`. The `ccs` command, `~/.config/ccs/repos.yml` and the cache are unchanged. No code changes.

## [0.3.1] — 2026-11-04

### Added
- **`lead: true`** — marks the entry that leads its group (a director or coordinator). It is listed first among its siblings instead of in name order — in both looks, in the list and in the group preview — and the simple look draws it with 👑 (its card says "👑 このグループの統括です", the group card tags it （統括）). Must be a real boolean. Stored in the cache as `repos.lead` (**schema v4**, plain `ADD COLUMN ... DEFAULT 0`; readonly readers synthesize the default on a v3 cache, and 0.3.0 keeps working against a v4 cache). Without `lead`, every order is unchanged.

### Fixed
- **Simple look: emoji widths** — the name column was padded counting an emoji that has no emoji presentation (🛰, ✍️, 🛠️, ✴️ — VS16 included) as two columns, while fzf and wcwidth count it as one, so those rows' descriptions started one column left and the glyph ran into the name. Widths now follow wcwidth (2 only for CJK and `Emoji_Presentation`), and the icon cell is always padded to two columns.

## [0.3.0] — 2026-11-04

### Added
- **Friendlier look (`ui: simple`)** — `defaults.ui: simple` in repos.yml (or `ccs --ui=simple`, or `CCS_UI=simple`; flag > variable > repos.yml) opens ccs full screen with rounded frames, four labels (Claude Code をはじめる / さがす / えらぶ / 中身), a Japanese guide line that shows only Enter / ↑↓ / Esc, a ghost hint in the empty search box and a highlighted cursor line. Needs fzf 0.61+ (`--ghost`); on an older fzf the classic look opens with one line saying why. The classic look is the default and is unchanged byte for byte (list rows, preview text, fzf arguments and launcher output were compared against 0.2.4).
  - **Groups first** — the list is ordered groups (`launch: false` headers and everything inside them) → other projects → past conversations, each under a heading row (empty sections get none). Nested entries are indented instead of drawn as a tree, and rows inside a group end with the group's name (dim), so typing the group's name narrows the list to the group, its projects and their conversations. The list keeps its order while filtering (`--no-sort`), every query edit returns the cursor to the top match (`change:first`), the cursor never rests on a heading row, and a far-right match no longer scrolls a row and hides its name (`--no-hscroll`).
  - **Cards instead of badges** — rows carry only the name and description; the preview shows a card per row: what Enter will do, the folder (`~/…`), when it was last used, unsaved changes / handoff notes / pending items / connected services in plain words, recent topics, and — for a past conversation — the conversation itself without tool placeholders. A missing folder is said plainly, with where Enter will open instead. Times read like speech (たった今 / N 分前 / N 時間前 / きのう / N 日前 / 10月25日), calendar-aware.
  - **Guidance at dead ends** — Enter on a heading, a group header or an empty result flashes a one-line reason in the guide line instead of doing nothing; Esc prints how to come back; with nothing to open, ccs prints how to add projects (or that there are no conversations yet, for `.` / `--resume`) instead of an empty picker; a `repos.yml` the scan cannot read is flagged in the frame and its error is printed after the picker closes. Narrow terminals (under ~100 columns) get the preview below the list.
- `ccs-scan --print-ui` prints `ui=<mode>` (the launcher learns `defaults.ui` from the pre-scan it already runs, so the default launch costs no extra process); the value is also stored in the cache's meta table (`defaults_ui`) for `ccs --no-scan`, read back with `ccs-list --print-ui`.
- `test/tty/ccs_tty.py` — a stdlib-only pseudo-terminal harness (small VT100 screen model, answers fzf's cursor-position query) and `test/ccs-tty.test.ts`, which run the simple look on a real fzf at 120x36 and 80x24. Skipped when python3 or fzf 0.61+ is missing.

### Changed
- The first-run `repos.yml` template mentions `# ui: simple` (commented out).
- `defaults.ui` must be `simple` or `classic`; any other value is a config error (no silent fallback).

## [0.2.4] — 2026-10-21

### Added
- **Group headers (`launch: false`)** — a repos.yml entry with `launch: false` is listed as a display-only header row (`KIND=group:<name>`) for a parent folder that must not be launched; the repos inside its `path` nest under it by the existing deepest-path rule. Enter (and double-click) on a header keeps the picker open (fzf 0.45+ `transform` binding, detected from `fzf --version`; older fzf accepts the row and ccs exits quietly, like the separator). `^I` copies the header's path, `^Y` copies nothing, `^D` shows the same "edit repos.yml" note as repo rows. The preview shows the header's path, description, a not-launchable note, and its entries (display names + relative dirs). Headers carry no badges and are skipped by the repo scan. `path` is required for a header; `launch` must be a real boolean (a quoted `"false"` is rejected instead of being coerced to `true`).
- **Display names (`label`)** — an optional `label` is shown instead of `name` in the repo row, the `‹parent›` hint and the preview title (with the `name` dimmed after it). `name` stays the unique key everywhere else; past-session rows keep showing `name`. Display-only like `description`: shell metacharacters are allowed and control characters are stripped at render time.

### Changed
- **Nested repos render as a tree** — children use `├ ` for earlier siblings and `└ ` for the last one, and deeper levels draw a `│ ` rail while an ancestor still has later siblings (previously every child used `└ `). The dim `‹parent›` hint uses the parent's display name and is omitted when it equals the row's own display name.
- **Schema v3** — `repos.launch INTEGER NOT NULL DEFAULT 1` and `repos.label TEXT NOT NULL DEFAULT ''` (plain `ADD COLUMN`). ccs-list / ccs-preview (readonly, no migration) synthesize the defaults on a not-yet-migrated v2 cache, and 0.2.3 keeps working against a v3 cache: its repos statements name explicit columns, so the new columns take their defaults on insert and are never read.

### Fixed
- **Empty columns no longer shift the picked row** — `bin/ccs` parsed the picked row with `IFS=$'\t' read`, and TAB is IFS whitespace, so an empty column was merged away: a repo with no `description` could not be launched (`Unknown row kind`, because KIND:KEY held the cwd). Tabs are now swapped for `\x1f` before the read, which keeps empty fields.
- A repos.yml entry without `path` no longer counts as the parent of every other repo in the list nesting (an empty path matched every absolute path as a prefix).

## [0.2.3] — 2026-10-14

### Added
- **Nested repos are grouped in the list** — a repo whose `path` sits inside another listed repo's `path` now comes right after that repo, indented (`  └ 📁 child  ‹parent›`), instead of wherever its name sorts. The nearest enclosing path wins (the same deepest-path rule that maps sessions to repos), deeper nesting indents further, and siblings stay name-sorted. The dim `‹parent›` suffix keeps the relation readable when a fzf query hides the parent row, and a query for the parent's name matches its children too. Derived from `path` at list time — no `repos.yml` key and no cache migration. A disabled parent is not listed, so its children stay top-level.

## [0.2.2] — 2026-06-21

### Fixed
- **Version drift** — `bin/ccs` no longer hardcodes the version string. It now reads `version` from `package.json` next to the script, so `ccs --version` always matches the package version. The 0.2.1 publish shipped `VERSION="0.2.0"` because the bash constant was not bumped in tandem with `package.json`. Copy-install layouts (install.sh drops `bin/ccs` into `~/.claude/scripts/` without `package.json`) fall back to `0.0.0-dev`.

## [0.2.1] — 2026-06-21

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
