---
name: ccs
description: Use ccs (Claude Code Station), the fzf launcher that lists your projects and past Claude Code sessions in one picker. Use when the user asks how to set up, open, resume or troubleshoot ccs, or asks to register a project in ccs, rename or describe an entry, group projects, or add integration fields (Plane, Slack, GitHub, Notion, Linear, Attio, Figma) to ~/.config/ccs/repos.yml. Triggers include "ccs", "Claude Code Station", "repos.yml", 「ccs に登録」「ccs の使い方」「プロジェクトを足して」.
---

# ccs (Claude Code Station)

ccs is a command-line launcher for Claude Code. `ccs` opens one fzf list with the user's registered projects (start a new session) and their past Claude Code sessions (resume one). The list of projects lives in `repos.yml`.

Answer in the user's language. Prefer the ccs commands below over editing files by hand, and show the user what you changed.

## Where things are

- Projects: `$XDG_CONFIG_HOME/ccs/repos.yml` (usually `~/.config/ccs/repos.yml`)
- Cache: `~/.cache/ccs/state.db` (rebuilt on demand; safe to delete)
- Full reference: the README and `docs/design/repos-yml-schema.md` in the installed package (`"$(npm root -g)/@indigo-gr/claude-code-station"`)

## First steps

1. `ccs doctor` — checks Node (22+), fzf (0.42+), `claude`, `repos.yml` and the cache. Exit 0 means ccs works; otherwise each failing line names what is missing.
2. `ccs init --auto-discover` — scans `$HOME` (depth 5, `--depth N` to change) for git repositories and lets the user pick which to register (TAB to toggle, Enter to add). It runs fzf, so the user has to run it in their own terminal; you cannot drive it. Suggest they type `! ccs init --auto-discover` in the Claude Code prompt or run it in another terminal.
3. The first run leaves a template entry named `Example Project` (`path: ~/path/to/your/project`). Remove it once real entries exist: `ccs repo remove "Example Project"`.
4. `ccs` — opens the picker. This is interactive too; the user runs it, not you.

## Using the picker

| Command | Shows |
|---|---|
| `ccs` | Projects (start new) and past sessions (resume) |
| `ccs --new` | Projects only |
| `ccs --resume` | Past sessions only |
| `ccs .` | Sessions under the current folder |
| `ccs --refresh` | Rescans before showing |
| `ccs --ui=simple` | Friendlier full-screen look (Japanese text, fzf 0.61+) |

| Key | Action |
|---|---|
| Enter | Start Claude Code in the project, or resume the session |
| Ctrl-Y | Copy the `cd … && claude …` command |
| Ctrl-I | Copy the session ID or the project path |
| Ctrl-R | Rescan and reload |
| Ctrl-D | Delete a past session (session rows only) |
| Esc | Close |

Typing filters the list (project name, session title, time, content).

## Changing repos.yml with commands (preferred)

These never open fzf, so you can run them yourself. Add `--json` when you need to read the result.

```bash
ccs repo add ~/projects/my-app --name my-app --description "Web front end"
ccs repo remove my-app                         # the folder and its sessions are not touched
ccs config set --repo my-app label "My App"    # display name; "" removes it
ccs config set --repo my-app description "…"
ccs config set defaults.ui simple              # or classic
ccs config get                                 # what can be changed, and current values
ccs list --json --with-paths                   # entries after ccs's checks
```

Each write takes a lock, keeps the previous text in `repos.yml.bak`, keeps comments, checks the result and puts the old file back if the check fails.

## Editing repos.yml by hand

Commands cannot set `path` changes, `command`, `icon`, `tags`, `launch`, `lead`, `disabled`, `scan` or `custom`. For those, edit the file. Read it first, change only what was asked, and keep the user's comments and order.

Shape:

```yaml
version: 1
defaults:
  command: "claude"
  ui: simple                # classic (default) or simple
repos:
  - name: my-app            # unique key; shown in the list
    path: ~/projects/my-app # must be under $HOME
    description: Web front end
    icon: "🌐"
    tags: [work]
    custom:                 # integration fields, shown as badges in the preview
      github_repo: "example-org/my-app"
      slack_channel: "#my-app"
```

Rules ccs enforces (breaking one stops ccs with a message naming the key):

- Write the block form: each item starts with `- name:` and the next line is `path:`. Do not write `repos: [ … ]` on one line; ccs refuses to add to that form.
- `version` is the integer `1`.
- `name` is required, unique, with no shell metacharacters (`` ;&|<>$`"'\ ``) or control characters. Use `label` for a display name that needs those or repeats another entry's.
- `path` and `cwd` start with `~/` or are full paths under `$HOME`. Write `~/` for `$HOME` itself (a bare `~` is YAML null). No shell metacharacters.
- `launch`, `lead`, `disabled`, `scan` take bare `true` / `false`. A quoted `"false"` is an error.
- `tags` is a list of strings. `description`, `icon`, `label` are strings.
- `command` overrides the launch command for that entry; no shell metacharacters. Precedence: `repos[].command` > `defaults.command` > `CCS_CMD` > `claude`.

Grouping:

- An entry whose `path` is inside another entry's `path` is listed under it automatically.
- `launch: false` makes a display-only header (Enter does nothing; `path` required). Its children nest under it by `path`.
- `lead: true` puts the entry first among its siblings (shown with 👑 in the simple look).

Integration fields go under `custom` only — never as new keys at the top of an item. Known keys get a badge: `plane_project_id` (with optional `plane_url`), `attio_workspace`, `notion_db`, `linear_team`, `slack_channel`, `github_repo` (`owner/repo`), `figma_file`. Any other key is shown under "Other". Store IDs and URLs only; never put API keys, tokens or passwords in `repos.yml`. `custom` is limited to 64,000 characters of JSON.

After any hand edit, verify:

```bash
ccs list --json | jq -r '.status'   # "ok" means the file passed ccs's checks
ccs doctor
```

If the check fails, show the user the message, fix the named key, or restore `repos.yml.bak` when it came from a ccs command.

## Troubleshooting

- `ccs: command not found` — npm's global bin is not on `PATH`. Add `"$(npm prefix -g)/bin"` to `PATH` in the shell profile.
- `fzf_too_old` in `ccs doctor` — ccs needs fzf 0.42+ (0.61+ for the simple look). Linux package managers often ship older ones; install from the fzf releases.
- Node older than 22 — upgrade Node, then reinstall ccs so better-sqlite3 is built for that Node.
- `path not found` warning — the folder moved or was deleted. Fix `path`, or set `disabled: true`.
- A project does not show up — run `ccs --refresh`, then `ccs list --json` to see whether the entry passed the checks.
- Native Windows is not supported; use WSL and follow the Linux steps there.

## Updating this skill

This file is copied from the npm package. After upgrading ccs, copy it again:

```bash
mkdir -p ~/.claude/skills
cp -R "$(npm root -g)/@indigo-gr/claude-code-station/docs/skills/ccs" ~/.claude/skills/
```
