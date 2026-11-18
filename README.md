# Claude Code Station — ccs

[日本語](README.ja.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24.12+](https://img.shields.io/badge/node-%3E%3D24.12-brightgreen.svg)](https://nodejs.org/)

A fast, fzf-powered launcher and session picker for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Pick a project to launch fresh **or** resume any past session — all from a single fuzzy finder, across every repo you own.

---

## What's new in v0.2.0

- **Mixed-mode launcher** — NEW repos **and** RESUME sessions in a single fzf list
- **Repository state at a glance** — git status, handoff/, pendings/, integration links in the preview card
- **SQLite-backed state cache** — `~/.cache/ccs/state.db` keeps multi-repo overview fast
- **Per-repo custom integration fields** — Plane, Attio, Notion, Linear, Slack, GitHub, Figma (and any custom key)
- **Renamed**: `claude-code-recall` (ccr) → `claude-code-station` (ccs). See the [migration section](#migration-from-ccr-v01x) below.

---

## Why?

`claude --resume` only shows sessions from the current directory and provides no search. And when you have a dozen active projects, you also want to **launch a fresh session** in the right repo without `cd`-ing around.

**ccs** solves both:

- Fuzzy search across all projects (repo name, session title, timestamp, content)
- Mixed list: `NEW` repo rows + `RESUME` session rows side by side
- Live preview — git status, handoff/pendings summary, integrations, conversation head
- Enter once, launched in the correct cwd with the correct command

---

## Install

The steps below are everything someone new needs: check the prerequisites, install with npm, register projects, open `ccs`.

### 1. Check the prerequisites

| Tool | Check | Needed |
|---|---|---|
| [Node.js](https://nodejs.org/) | `node -v` | **24.12+** (24.12.0 or newer) |
| [fzf](https://github.com/junegunn/fzf) | `fzf --version` | **0.61.0 or newer** |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI | `claude --version` | any |

- **fzf versions** — 0.61.0 is the floor (the list uses `--style`, the frame labels and `--ghost`). On an older fzf ccs does not open the list and says so in one line; `ccs doctor` reports it as `fzf_too_old`.
- **No TypeScript runner** — the npm package runs prebuilt JavaScript; a checkout or the copy install runs the `.ts` sources with Node itself (type stripping, Node 24.12+).

By OS:

- **macOS** (Apple silicon, Intel) — `brew install node fzf`, or Node from [nodejs.org](https://nodejs.org/) or a version manager (nvm, fnm, Volta).
- **Linux** (x64, arm64; glibc distributions and musl ones such as Alpine) — Node from [nodejs.org](https://nodejs.org/), your distribution or a version manager. The fzf in `apt` and other package managers is often older than 0.61 (`fzf --version`); if so, install it from fzf's repository: `git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf && ~/.fzf/install`.
- **Windows** — use **WSL** (Ubuntu or another Linux in WSL) and follow the Linux steps inside it. ccs itself is a bash script, and the native database module (`better-sqlite3`) is only known to work from prebuilt files on macOS and Linux. Run Claude Code inside WSL too, so the paths of your sessions match.

`better-sqlite3` ships prebuilt modules for macOS and Linux (glibc, musl) on x64 and arm64; anywhere else npm has to build it from source (Python, make and a C++ compiler; not tested).

### 2. Install

```bash
npm install -g @indigo-gr/claude-code-station
ccs --version        # ccs v0.x.y
ccs doctor           # first line: "ccs doctor: ccs works (ok)"
```

Installs from the [npm registry](https://www.npmjs.com/package/@indigo-gr/claude-code-station). All runtime deps (`better-sqlite3`, `yaml`) come bundled, and `ccs` lands on your PATH via npm's global bin. `ccs doctor` checks Node, fzf, `claude`, `repos.yml` and the cache, and names what is missing. Right after installing, `config` and `cache` say `warn` (`config_missing`, `cache_missing`) until step 3 has run; that is expected.

### 3. Register projects, then open ccs

```bash
ccs init --auto-discover          # pick repos with TAB, add them with Enter
ccs repo remove "Example Project" # drop the template entry
ccs                               # the picker opens
```

1. `ccs init --auto-discover` creates `~/.config/ccs/repos.yml`, scans `$HOME` (depth 5, `--depth N` to change) for git repositories not yet registered, and opens fzf: **TAB** marks a repo, **Enter** adds the marked ones, **Esc** cancels.
2. The new file starts with a template entry, `Example Project`, whose folder does not exist (ccs warns `path not found` about it). Remove it once your own entries are in.
3. `ccs` opens the list. Enter on a project starts Claude Code there; Enter on a past session resumes it. See [Usage](#usage) for keys and flags.

More projects later: `ccs repo add ~/path/to/folder`, run `ccs init --auto-discover` again, or edit `repos.yml` ([Configuration](#configuration)).

### 4. Claude Code skill (optional)

The package carries a Claude Code skill, `ccs`. With it, Claude Code can explain how to use ccs and register projects or add integration fields to `repos.yml` for you ("add ~/projects/my-app to ccs", "put the GitHub repo on my-app"). Nothing is installed into `~/.claude` automatically; copy it yourself:

```bash
mkdir -p ~/.claude/skills
cp -R "$(npm root -g)/@indigo-gr/claude-code-station/docs/skills/ccs" ~/.claude/skills/
```

- Start a new Claude Code session afterwards so it picks up the skill.
- **After upgrading ccs, run the same `cp` again** — the copy does not follow the package.
- To remove it: `rm -r ~/.claude/skills/ccs`
- To use it in one project only, copy into that project's `.claude/skills/` instead.

### Switching from the unscoped package

Up to 0.3.1 the package was published unscoped as `claude-code-station` (now deprecated). If `npm ls -g claude-code-station` lists it, switch once — the `ccs` command, `~/.config/ccs/repos.yml` and the cache stay as they are.

```bash
npm uninstall -g claude-code-station
npm install -g @indigo-gr/claude-code-station
```

### Upgrade

```bash
npm install -g @indigo-gr/claude-code-station@latest
ccs --version
```

(`npm update -g @indigo-gr/claude-code-station` works too.) ccs tells you when a newer version is out ([Update check](#update-check)). `repos.yml` and the cache are kept. If you copied the skill, copy it again (step 4). After a Node major upgrade, reinstall ccs so `better-sqlite3` matches the new Node.

### Uninstall

```bash
npm uninstall -g @indigo-gr/claude-code-station
rm -r ~/.claude/skills/ccs     # if you copied the skill
rm -r ~/.cache/ccs             # the cache (rebuilt if you install again)
rm -r ~/.config/ccs            # your project list — only if you no longer want it
```

With `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` set, the last two folders are under those instead. Your Claude Code sessions (`~/.claude/projects/`) are not ccs's and stay.

### Troubleshooting

| Symptom | What to do |
|---|---|
| `ccs: command not found` | npm's global bin is not on `PATH`. Add `export PATH="$(npm prefix -g)/bin:$PATH"` to `~/.zshrc` or `~/.bashrc` and open a new terminal. |
| `EACCES` / permission denied on `npm install -g` | npm's global folder belongs to root. Install Node with a version manager (nvm, fnm, Volta) or Homebrew instead of using `sudo`. |
| `EEXIST` … `ccs` on install | The old unscoped package still owns `ccs`. See [Switching from the unscoped package](#switching-from-the-unscoped-package). |
| `ccs doctor`: `fzf_too_old`, or ccs closes when you press Enter on a header | fzf is older than ccs needs. Install a newer one (step 1). |
| `node_too_old`, `EBADENGINE`, or `better-sqlite3` errors | Node is older than 24.12.0, or Node was upgraded after ccs was installed. Use Node 24.12.0 or newer, then `npm install -g @indigo-gr/claude-code-station` again. |
| `better-sqlite3` tries to compile (`gyp`, `make`) | No prebuilt module for this system (for example native Windows). Use macOS, Linux or WSL. |
| The list is empty, or only `Example Project` | No projects registered yet. Run `ccs init --auto-discover` (step 3). |
| `path not found` warning | An entry's folder was moved or deleted. Fix its `path` in `repos.yml`, `ccs repo remove NAME`, or set `disabled: true`. |
| ccs stops with a `repos.yml` message | The message names the key and the entry. Fix it, or put back `repos.yml.bak` if a ccs command just wrote the file. `ccs doctor` shows the same check. |

`ccs doctor --json` gives the same checks as words for scripts ([below](#for-scripts-and-tools)).

### Other ways to install

**npm is the recommended way** (step 2 above). The GitHub repository carries the same released versions as npm — nothing unreleased — so installing from GitHub gives you nothing newer, only a slower install.

#### From GitHub

```bash
npm install -g --allow-git=root github:indigo-gr/claude-code-station
```

The same released version as npm. To upgrade, use the npm command (`npm install -g @indigo-gr/claude-code-station`), which replaces it.

#### Copy install (checkout)

```bash
git clone https://github.com/indigo-gr/claude-code-station.git
cd claude-code-station
npm install
./install.sh
```

`install.sh --with-deps` runs `npm install` for you as well. To resolve the runtime dependencies, `install.sh` symlinks the checkout's `node_modules` into the install folder, so keep the checkout. Node runs the copied `.ts` files directly (24.12.0 or newer); no `tsx` is needed.

#### Manual install

```bash
npm install
cp bin/ccs bin/ccs-*.ts bin/ccs-*.sh bin/ccs-lang-*.txt ~/.claude/scripts/
chmod +x ~/.claude/scripts/ccs ~/.claude/scripts/ccs-delete.sh

# Add to ~/.zshrc or ~/.bashrc
export PATH="$PATH:$HOME/.claude/scripts"
```

---

## Quick start

After [installing](#install):

1. `ccs init --auto-discover` — pick the repos to register (TAB to toggle, Enter to add).
2. Or edit `~/.config/ccs/repos.yml` by hand (`ccs init` scaffolds the template; see [Configuration](#configuration)), or `ccs repo add PATH`.
3. Run `ccs` — fzf opens with your repos + past sessions.

```
──────── Projects ────────
📁 ClaudeCode      Claude Code settings
📁 My Project      Main development repository
──────── Past sessions ────────
💬 2 h ago     My Project  Fix the billing webhook…
💬 yesterday   My Project  Plane work item sync…
```

The samples in this README show the screen in English; in Japanese (see [Language](#language)) the same places read in Japanese. The frame around the list carries four labels (Start Claude Code / Search / Pick / Details), and the card on the right explains the focused row (see [The list](#the-list)).

---

## Configuration

Full schema: [`docs/design/repos-yml-schema.md`](docs/design/repos-yml-schema.md)

### Minimal

```yaml
version: 1
repos:
  - name: ClaudeCode
    path: ~/.claude
  - name: my-project
    path: ~/projects/my-project
    description: Main development repository
    tags: [work]
```

### With integrations

```yaml
version: 1
repos:
  - name: My Project
    path: ~/projects/my-project
    description: Main development repository
    tags: [work]
    custom:
      plane_project_id: "abc12345-xxxx"
      plane_url: "https://plane.example.com/my-project"
      slack_channel: "#dev-general"
      github_repo: "acme-corp/my-project"
      notion_db: "abc123"
```

Known keys: `plane_project_id`, `plane_url`, `attio_workspace`, `notion_db`, `linear_team`, `slack_channel`, `github_repo`, `figma_file`. Unknown keys are rendered verbatim under "Other Integrations".

### Special command (CMS dev server)

```yaml
version: 1
defaults:
  command: "claude"
repos:
  - name: CMS
    path: ~/sites/blog-cms
    command: "npm run develop"   # overrides claude entirely
    icon: "🚀"
    scan: false                  # not a Claude repo — skip state scan
    tags: [dev-server]
```

Precedence: `repos[].command` > `defaults.command` > `$CCS_CMD` > `"claude"`.

### Group headers and labels

For a parent folder that should only hold its children — never be launched itself — mark it `launch: false`. Its children nest under it by `path` (no extra key), and `label` gives any entry a display name of its own.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `launch` | bool | `true` | `false` = display-only **group header**: listed with its children under it, but Enter does not launch it (`command`/`cwd` are ignored). `path` is still required — it decides which repos nest under the header. Must be a real boolean (`"false"` in quotes is an error). |
| `lead` | bool | `false` | `true` = the group's lead (a director / coordinator): listed **first among its siblings** instead of in name order, and drawn with 👑. Must be a real boolean. |
| `label` | string | `""` (show `name`) | Name shown in the repo row and the preview title instead of `name`. `name` stays the unique key (it is still what past-session rows show), so two entries may share a label. Display-only: control characters are stripped. |

```yaml
repos:
  - name: Studio
    path: ~/studio
    launch: false               # header only — Enter does not launch ~/studio
    icon: "🎬"
    description: Production team
  - name: Studio-hq
    path: ~/studio/hq
    label: Studio               # shown instead of "Studio-hq"
    icon: "🎬"
    description: Coordination hq/
  - name: Studio-web
    path: ~/studio/web
    label: Web team
    icon: "🌐"
    description: Website web/
  - name: Studio-app
    path: ~/studio/app
    label: App team
    icon: "📱"
    description: Mobile app/
```

```
──────── Groups ────────
🎬 Studio          Production team         ← header: Enter does nothing
   📱 App team     Mobile app/  (Studio)
   🎬 Studio       Coordination hq/
   🌐 Web team     Website web/  (Studio)
```

### Groups from other tools (`groups_dir`)

Projects that live in unrelated folders can be listed together under one header, following group definition files another tool keeps. Off unless you set it.

```yaml
defaults:
  groups_dir: ~/tools/groups   # a folder of *.json files; must be under $HOME
```

Each `*.json` directly in that folder (in name order, at most 200, each up to 256 KB) is read for five keys only, and nothing is ever written there:

```json
{ "version": 1, "id": "team-x", "label": "Team X", "kind": "logical",
  "members": [{ "path": "~/x/beta" }, { "path": "~/w/alpha" }] }
```

- Only `version: 1` and `kind: "logical"` are used. A `physical` group is skipped: its projects already nest by `path` (`launch: false` headers).
- `members[].path` (`~` expanded) is matched to the `path` of your `repos.yml` entries; the header lists the matches in the file's order, with their own names and icons. Members not in `repos.yml` are not shown. A project may appear both in its own place and under the header.
- These headers come after the `launch: false` headers. Enter on a header does nothing.
- Broken or unknown files are skipped, never stopping the list; `ccs doctor` counts them (`groups_dir`: `group_files_skipped`), and `ccs list --json` gives the groups in `groups[]`. The scan reads the folder, so changes show after the next scan (`ccs --refresh` or `Ctrl-R`).

### The list

ccs opens full-screen with rounded frames and plain words in your language (Japanese or English, see [Language](#language)), made for people who are new to the terminal too. Since v0.6.0 this is the only look: the older `classic` look, `--ui=` and `CCS_UI` are gone. `defaults.ui: simple` in `repos.yml` is still read (it changes nothing); `defaults.ui: classic` prints one warning and opens this look.

- **Order** — groups first (`launch: false` headers with everything inside them), then the other projects, then past sessions, each under a heading row. Nested entries are indented, and every row inside a group ends with the group's name (dim), so **typing a group's name narrows the list to that group**, its projects and their conversations. The list keeps this order while you type.
- **Leads first** — an entry with `lead: true` (the group's director / coordinator) is the first row inside its group, marked 👑.
- **Rows** — name and description only. Branch / uncommitted / handoff / integration details are in the preview "card", and times read like speech (just now · 3 h ago · yesterday · 3 days ago · Oct 25).
- **Guidance** — the guide line shows only Enter / ↑↓ / Esc (`^Y` `^I` `^R` `^D` still work). Enter on a heading, a group header or an empty result says why nothing opened; Esc says how to come back; with nothing to open, ccs prints how to add projects instead of an empty picker. A broken `repos.yml` is flagged in the frame and explained after the picker closes.
- **Narrow terminals** — under ~100 columns the preview moves below the list (80x24 keeps 8 list rows).

The list part of the screen (the frame around it carries the four labels Start Claude Code / Search / Pick / Details, and the right-hand card explains the focused row):

```
──────── Groups ────────
🎬 Studio          Production team
   📱 App team     Mobile app/  (Studio)
   🌐 Web team     Website web/  (Studio)
──────── Projects ────────
📁 notes           Daily notes
──────── Past sessions ────────
💬 3 h ago     Studio / Web team  Make the top headline bigger
```

### Language

ccs shows its own text in Japanese or English: the list, the preview, notices, warnings, errors, `--help`, `ccs init` and the `ccs doctor` table. What you wrote in `repos.yml` (`label`, `description`, `custom`) is shown as written and never translated. `--json` output, exit codes and the code words (`status`, `reasons[].code`) are the same in both languages, so scripts do not need to care.

ccs picks the language from the first of these that gives one:

1. **`--lang=ja` or `--lang=en`** on the command line. Any other value is a usage error (exit 2).
2. **`CCS_LANG`** in the environment (`ja` or `en`). Another value prints one warning and is skipped.
3. **`defaults.language` in `repos.yml`** (`auto`, `ja` or `en`). `auto` or an empty value means "not set". Another value prints one warning and is skipped — it never stops the list. Set it with `ccs config set defaults.language ja`.
4. **The OS locale**: the first non-empty one of `LC_ALL`, `LC_MESSAGES` and `LANG`. A value starting with `ja` (such as `ja_JP.UTF-8`) gives Japanese; anything else (`C`, `POSIX`, `en_US.UTF-8`, …) gives English.
5. **English**, when none of the above says anything.

On macOS the locale is often `en_US.UTF-8` even when the system is set to Japanese, and a terminal started from the GUI may have no locale at all, so ccs opens in English there. To always get Japanese, put `language: ja` under `defaults:` in `repos.yml` (or run `ccs config set defaults.language ja`):

```yaml
defaults:
  language: ja
```

### Preview card sample

```
  ✨ Start Claude Code in My Project

  Main development repository

  📂 Folder
     ~/projects/my-project
  🕒 Last opened
     yesterday 18:20
  📝 Changes
     2 file(s) with changes not saved (committed) yet
  📌 Handoff notes
     2 note(s) from earlier work
  🔗 Connected services
     Plane, Slack, GitHub

  Press Enter to open Claude Code in this folder
```

---

## Usage

### Flags

| Flag | Action |
|---|---|
| (none) | Mixed list: NEW repos + RESUME sessions |
| `.` | Only sessions whose cwd is under current dir |
| `--new` | Only NEW repo entries |
| `--resume` | Only past sessions |
| `--refresh` | Force DB rebuild before showing list |
| `--no-scan` | Skip implicit pre-scan (use stale DB) |
| `--lang=ja\|en` | Language for this launch; wins over `CCS_LANG` and `defaults.language` (see [Language](#language)) |
| `--help` / `-h` | Help |
| `--version` / `-v` | Version |
| `doctor` / `list` / `sessions` / `repo` / `config` / `open` as the first argument | Commands for scripts and tools, see [below](#for-scripts-and-tools) |
| _anything else_ | Passed through to the launched command |

### Keyboard

| Key | Action |
|---|---|
| Enter | Launch (NEW) or resume (RESUME); does nothing on a group header |
| Ctrl-Y | Copy `cd … && cmd [--resume …]` to clipboard; fzf stays open with a "📋 Copied" header (nothing to copy on a group header) |
| Ctrl-I | Copy session UUID or repo path (group headers too); fzf stays open |
| Ctrl-R | Refresh DB and reload list |
| Ctrl-D | Delete session (RESUME rows only). To remove a repo, edit `~/.config/ccs/repos.yml` directly |
| Esc / Ctrl-C | Cancel |

**Visual cues:**
- Groups, the other projects and past sessions each come under their own heading row (Groups / Projects / Past sessions). Enter on a heading does nothing.
- Past conversations show their project's name (the `label` when set); a conversation whose folder is not in `repos.yml` shows the folder instead — either a one-off run or a repo not registered yet.
- A repo whose `path` sits inside another registered repo's `path` is listed right under that repo, indented, with the parent's name dimmed at the end. Nothing to configure — the nesting follows from `path`. The dim name keeps the relation visible when a search hides the parent row, and searching for the parent's name lists its children too. A parent marked `launch: false` is a [group header](#group-headers-and-labels).

### Workflows

**1. Launch a project fresh**

```bash
ccs --new
# pick repo → Enter → claude starts in repo cwd
```

**2. Resume yesterday's work**

```bash
ccs --resume
# fuzzy search by content → Enter → cd + claude --resume <id>
```

**3. Resume in current directory**

```bash
cd ~/projects/my-project
ccs .
```

---

## For scripts and tools

Commands for GUI launchers, scripts and other tools. They never open fzf, read stdin or ask anything, so they run without a terminal (`ccs open --here` alone starts Claude Code in the terminal it runs in). They do not go to the network (no update check) and never create the `repos.yml` template. The read commands (`doctor`, `list`, `config get`) write nothing to ccs's config or cache folders; they may put a temporary file in `TMPDIR` and remove it before they end. `sessions` refreshes the cache the way opening the list does; `repo add`, `repo remove` and `config set` write `repos.yml`. The full contract is [`docs/design/machine-interface.md`](docs/design/machine-interface.md).

| Command | What it does |
|---|---|
| `ccs doctor [--json]` | Does ccs work here? Checks Node, ccs's own modules, better-sqlite3, fzf, `claude`, `repos.yml`, the cache and the terminal app for `open --new-window`. Exit 0 works, 1 does not, 2 bad arguments, 3 could not tell. |
| `ccs list --json [--with-paths]` | The entries of `repos.yml` after ccs's checks, in file order: name, label, description, icon, kind (`repo` / `group`), launch, lead, disabled, parent, tags, and whether the folder exists. Paths only with `--with-paths`. |
| `ccs sessions --json [--project NAME] [--limit N] [--with-titles] [--no-scan]` | Past conversations per project, newest first, at most `N` (default 5, up to 50) each: the session UUID and when it was last active, plus `more` (how many were left out). Titles (the first request, one line, at most 80 characters) only with `--with-titles`; never the summary, the folder or the conversation. |
| `ccs repo add PATH [--name NAME] [--description TEXT] [--with-paths] [--json]` | Adds a folder under `$HOME` to `repos.yml` (at the end, in the block form, the path written as `~/…`). The name defaults to the folder's name (`-2`, `-3`… when taken). Creates a minimal `repos.yml` when there is none. |
| `ccs repo remove NAME [--json]` | Takes the entry out of `repos.yml`. The folder, its conversations and the cache are not touched. The last entry cannot be removed. |
| `ccs config get [--with-paths] [--json]` | The settings `config set` can change, with their current values and the values allowed. |
| `ccs config set [--repo NAME] KEY VALUE [--json]` | Changes one setting: `defaults.ui` (only `simple` since v0.6.0), `defaults.language` (`auto` / `ja` / `en`), `defaults.terminal` (`terminal`, or `""` to unset), `defaults.update_check` (`true` / `false`), or with `--repo` an entry's `label` / `description` (`""` removes it). Launch commands, paths and the other keys are not settable here — edit the file for those. |
| `ccs open (--repo NAME \| --session UUID) [--here \| --new-window] [--terminal APP] [--json] [-- ARGS…]` | Starts Claude Code without the list, through the same checks as a picked row (the folder under `$HOME`, the command's characters, the session ID's form). `--here` (the default) runs it in this terminal; `--new-window` (macOS) opens a new window of `defaults.terminal` and returns at once. Unlike the list, `open` never falls back to the current folder: it refuses. |

- **These words are commands only as the first argument**: `doctor`, `list`, `sessions`, `repo`, `config`, `open`. Until 0.4.x they went to the launched command (`ccs doctor` opened the list and started `claude doctor`). To pass one on, put a flag first: `ccs --new doctor`.
- **With `--json`**, stdout carries exactly one JSON object, on failure too, with `schema_version`, `product_version`, `command`, `status` and `reasons` (`[{ "vocab", "code" }]`). Match on the exit code and on those words; messages on stderr are for people and may change. DEL, C1 characters and text-direction marks inside strings are written as `\uXXXX` (the parsed value is the same). Without `--json`, `repo` and `config set` print nothing on stdout and one line on stderr.
- **What is never printed**: secrets, the commands repos launch with, `custom`, user and host names. `doctor` prints no repo name or path at all — only words, counts and versions. Paths only with `--with-paths`, conversation titles only with `--with-titles`.
- **How `repos.yml` is written** — one writer at a time (`repos.yml.lock`), the previous text kept in `repos.yml.bak`, the file written in place (a symlinked `repos.yml` stays a symlink), checked again, and put back when that check fails. A one-line `repos:` list (`repos: [ … ]`) is not added to (`flow_style_repos`). Names and paths are written only when they need no YAML quotes (`needs_quoting` otherwise). A name with DEL, a C1 character or a text-direction mark is refused like a description (`invalid_value`). Comments and the order of keys are kept; spaces before an end-of-line comment may be reduced to one.
- **`ccs open --new-window`** writes a one-shot launcher file in `TMPDIR` (it deletes itself when it starts) and hands it to the terminal app with `open -a`; no AppleScript, so no Automation permission is asked for. The new window runs `ccs open --here` with the same checks. Choose the app first: `ccs config set defaults.terminal terminal` (macOS Terminal; other apps are added once their way of opening has been tried). The exit code of `--here` after Claude Code started is Claude Code's own; scripts should use `--new-window`.
- **Called from a GUI app**, `PATH` is often short and `node` or `claude` is not found (`dependency_missing`). Pass the user's shell `PATH` to ccs.

| Exit | `status` | Meaning |
|:---:|---|---|
| 0 | `ok` | Done (`doctor`: ccs works) |
| 1 | `failed` | Failed (`doctor`: ccs does not work); also `config_locked`, `config_changed` — try again |
| 2 | `usage` | Bad arguments (`list` / `sessions` without `--json` too) |
| 3 | `unverifiable` | Could not tell (no permission, a check timed out) |
| 4 | `missing_prerequisite` | Not run: something it needs is missing (no `repos.yml`, a broken one, no cache, no terminal, no Node) — not used by `doctor` |
| 5 | `not_found` | No such entry or session |
| 6 | `rejected` | Refused by a check (outside `$HOME`, a name already taken, a value not allowed, …) |
| 7 | `partial` | Written, failed the check, and could not be put back: the previous text is in `repos.yml.bak` |
| 130 | `interrupted` | Stopped by Ctrl-C (a write in progress is undone) |

```bash
ccs doctor --json | jq -r '.status, (.checks[] | select(.status != "ok") | "\(.name): \(.code)")'
ccs list --json | jq -r '.repos[] | select(.kind == "repo" and (.disabled | not)) | .name'
ccs sessions --json --project studio-web --limit 3 | jq -r '.projects[].sessions[].uuid'
ccs repo add ~/projects/studio/web --json | jq -r '.status'
ccs open --repo studio-web --new-window
```

---

## State cache

ccs keeps a SQLite cache at `~/.cache/ccs/state.db` (or `$XDG_CACHE_HOME/ccs/state.db`) with repo metadata, git state, session summaries, and handoff/pending file lists.

- Auto-refresh on every `ccs` run (cheap — 10s TTL per repo)
- Manual force: `ccs --refresh` or press `Ctrl-R` in fzf
- Reset: `rm ~/.cache/ccs/state.db` — next `ccs` run rebuilds it (your `repos.yml` is not touched)

Schema details: [`docs/design/sqlite-schema.md`](docs/design/sqlite-schema.md).

---

## Update check

ccs tells you when npm has a newer version: the list's frame says so, and the upgrade command is printed after the picker closes.

- **The command matches how you installed** — `npm install -g @indigo-gr/claude-code-station` for an npm install (also for one from `github:…`, which the npm package replaces), or `cd <your clone> && git pull && npm install` when you run `bin/ccs` from a clone.
- **Node first, when needed** — when the newer version needs a newer Node than yours (its `engines.node`), the notice says which Node it needs and to upgrade Node before ccs; the frame adds "upgrade Node first" on a wide enough terminal.

- **What is sent, and where** — at most once a day (an hour after a failed attempt), one HTTPS `GET https://registry.npmjs.org/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags` and, when that names a release, one more for that release's public manifest (`GET https://registry.npmjs.org/%40indigo-gr%2Fclaude-code-station/<latest>`, to read the Node it needs). They carry no ccs version, repo, session or machine details (the version in the second URL is npm's own latest); the registry sees only the requests themselves, your IP address and Node's default User-Agent.
- **Never in the way** — the check runs in the background with a 3-second limit and its answer is used on the next launch; startup only reads `~/.cache/ccs/update-check` (or `$XDG_CACHE_HOME/ccs/update-check`). Offline, or when the answer is unusable, ccs behaves as before. HTTP proxy settings are not used, so behind a proxy the check simply fails quietly.
- **When there is no notice** — when you are on the latest version or newer, when npm's latest is a prerelease, and when your own version is a prerelease or a copy install (`0.0.0-dev`). A failed check shows no notice of its own, but a version found by an earlier check is still reported.
- **Turn it off** — set `CCS_NO_UPDATE_CHECK=1` (any non-empty value), or put `update_check: false` under `defaults:` in `repos.yml` (`ccs config set defaults.update_check false`): no request, and the cache is not read. The variable wins over the file (`update_check: true` does not turn a set variable back on). Useful when another tool manages ccs's updates.
- **Another registry** — `CCS_UPDATE_REGISTRY=https://registry.example.com` asks that server instead.

---

## Migration from ccr v0.1.x

Existing sessions are stored under `~/.claude/projects/*/*.jsonl` — **nothing to migrate manually**. ccs auto-discovers them on first scan.

### Command & env rename

| Before (ccr v0.1.x) | After (ccs v0.2.0) |
|---|---|
| `ccr` | `ccs` |
| `CCR_CMD` env | `CCS_CMD` env |
| GitHub: `indigo-gr/claude-code-recall` | `indigo-gr/claude-code-station` |

`CCR_CMD` is still honored for now (with a deprecation warning to stderr). Rename it in your shell rc at your earliest convenience.

### Uninstall old ccr

```bash
rm -f ~/.claude/scripts/ccr ~/.claude/scripts/ccr-*.ts ~/.claude/scripts/ccr-*.sh
# Remove any `export CCR_CMD=...` from ~/.zshrc or ~/.bashrc
```

---

## Architecture

```
ccs (bash)
 ├─ ccs-scan.ts           → scans repos, orchestrates, writes state.db
 │   └─ ccs-scan-sessions.ts  (session walk, JSONL parse, cwd→repo resolve)
 ├─ ccs-list.ts           → reads DB, emits fzf rows (NEW + RESUME)
 ├─ ccs-preview.ts        → preview pane renderer (cards)
 │   └─ ccs-preview-session.ts (session conversation head)
 ├─ ccs-config.ts         → loads/validates ~/.config/ccs/repos.yml
 ├─ ccs-init.ts           → `ccs init` scaffold / $HOME repo auto-discovery
 ├─ ccs-db.ts             → better-sqlite3 wrapper (WAL, FK, migrations)
 ├─ ccs-delete.sh         → Ctrl-D session delete handler
 │   └─ ccs-delete-session.ts  (cache row removal, bound params)
 └─ shared helpers (imported by scan / list / preview):
    ├─ ccs-sanitize.ts    (SHELL_METACHARS, stripControlChars)
    ├─ ccs-secrets.ts     (26-pattern maskSecrets)
    ├─ ccs-time.ts        (UTC-safe DB timestamp parsing)
    └─ ccs-utils.ts       (truncate, relative time, extractText, UUID_RE)
```

Design docs: [`docs/design/`](docs/design/).

---

## Security

- Session IDs validated as UUID before shell execution
- `$HOME`-rooted path validation for every `cwd`
- Known secret patterns (API keys, tokens) masked in preview
- SQLite DB created with `0600` permissions; config/cache dirs `0700`
- No `eval`; all invocations are direct
- Prepared statements only for SQLite; foreign keys enforced
- 50MB per-file cap when parsing JSONL sessions

> **Trust note**: the `command:` field in `repos.yml` is validated for shell metacharacters at load time — only safe, sanitized commands are executed.

---

## Contributing

Issues and PRs welcome. See [`REVIEW.md`](REVIEW.md) for review standards and [`CHANGELOG.md`](CHANGELOG.md) for release history.

---

## License

MIT. Copyright © INDIGO GROUP LLC. See [LICENSE](LICENSE).

The version on screen leads to everything about that release:

- **Source** — git tag `vX.Y.Z` in [indigo-gr/claude-code-station](https://github.com/indigo-gr/claude-code-station/tags)
- **Changes** — the `[X.Y.Z]` section of [CHANGELOG.md](CHANGELOG.md)
- **Terms** — [LICENSE](LICENSE) at that tag
