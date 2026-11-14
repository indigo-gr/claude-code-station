# Claude Code Station — ccs

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

A fast, fzf-powered launcher and session picker for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Pick a project to launch fresh **or** resume any past session — all from a single fuzzy finder, across every repo you own.

複数プロジェクトを横断するClaude Code用のfzf起動＆セッション再開ランチャー。新規起動も過去セッション再開も、同じfzfから一発で。

---

## What's new in v0.2.0 / v0.2.0 の新機能

- **Mixed-mode launcher** — NEW repos **and** RESUME sessions in a single fzf list / 新規リポジトリ起動と過去セッション再開を同じfzfで混在表示
- **Repository state badges** — git status, handoff/, pendings/, integration links at a glance / リポジトリの状態（git・handoff・pendings・連携先）をバッジで一目把握
- **SQLite-backed state cache** — `~/.cache/ccs/state.db` keeps multi-repo overview fast / マルチリポ状態キャッシュ（SQLite）で高速起動
- **Per-repo custom integration fields** — Plane, Attio, Notion, Linear, Slack, GitHub, Figma (and any custom key) / リポジトリごとの連携情報（Plane/Attio/Notion/Linear/Slack/GitHub/Figma ほか任意のカスタムキー）
- **Renamed**: `claude-code-recall` (ccr) → `claude-code-station` (ccs). See the [migration section](#migration-from-ccr-v01x--ccr-v01x-からの移行) below. / `claude-code-recall` (ccr) から改名。移行は下記セクション参照。

---

## Why? / なぜ？

`claude --resume` only shows sessions from the current directory and provides no search. And when you have a dozen active projects, you also want to **launch a fresh session** in the right repo without `cd`-ing around.

`claude --resume` はカレントディレクトリのセッションしか出さず、検索もできない。プロジェクトが増えると「新規起動したいリポ」も「続きをやりたいセッション」も、どちらを探すのも手間。

**ccs** solves both / **ccs** が両方まとめて解決：

- Fuzzy search across all projects (repo name, session title, timestamp, content) / 全プロジェクトのファジー検索
- Mixed list: `NEW` repo rows + `RESUME` session rows side by side / 新規起動行と再開行を同じリストに
- Live preview — git status, handoff/pendings summary, integration badges, conversation head / ライブプレビュー（git状態・handoff/pendings・連携バッジ・会話冒頭）
- Enter once, launched in the correct cwd with the correct command / Enter一回で正しいcwd・正しいコマンドで起動

---

## Install / インストール

### Prerequisites / 前提条件

- [Node.js](https://nodejs.org/) **22+**. `better-sqlite3` ships prebuilt modules for macOS and Linux (glibc, musl) on x64 and arm64; anywhere else it has to be built from source (not tested) / それ以外の環境はソースから作る必要がある（未確認）
- [fzf](https://github.com/junegunn/fzf) **≥ 0.42.0** — fuzzy finder (the `change-header` binding used by the copy-toast requires 0.42+; released Aug 2023). With **0.45+** Enter on a group header (`launch: false`) keeps the list open; on older fzf it just closes ccs without launching anything / 0.45 以上なら、グループ見出しの上で Enter を押してもリストは開いたまま（それより古い fzf では何も起動せずに閉じる）
  - The friendlier look (`ui: simple`, below) needs **fzf ≥ 0.61.0** (`--ghost`; the frame and labels need 0.58+). On an older fzf ccs opens the classic look and says so in one line / やさしい見た目（`ui: simple`）は fzf 0.61.0 以上。古い fzf ではいつもの見た目で開き、1 行で知らせる
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
- [tsx](https://github.com/privatenumber/tsx) — TypeScript runner. **Bundled** as a package dependency; a global `tsx` (`npm install -g tsx`) is only needed for the bare-checkout workflow. / npmインストール時は同梱されるため、グローバルtsxは checkout 直接運用時のみ必要

### Quick install (npm, recommended) / クイックインストール（npm直接・推奨）

```bash
npm install -g @indigo-gr/claude-code-station
```

Installs from the [npm registry](https://www.npmjs.com/package/@indigo-gr/claude-code-station). All runtime deps (`better-sqlite3`, `yaml`, `tsx`) come bundled, and `ccs` lands on your PATH via npm's global bin. / npm レジストリから取得。実行時依存は全部同梱、`ccs` はnpmのグローバルbinでPATHに乗る。

Up to 0.3.1 the package was published unscoped as `claude-code-station` (now deprecated). If you installed it under that name, switch once — the `ccs` command, `~/.config/ccs/repos.yml` and the cache stay as they are. / 0.3.1 まではスコープなしの `claude-code-station` で出していた（今は deprecate 済み）。その名前で入れていたら一度だけ入れ替える（`ccs` のコマンド・`~/.config/ccs/repos.yml`・キャッシュはそのまま）。

```bash
npm uninstall -g claude-code-station
npm install -g @indigo-gr/claude-code-station
```

#### From GitHub (latest unreleased) / GitHub直接（未リリース版を使いたい時）

```bash
npm install -g --allow-git=root github:indigo-gr/claude-code-station
```

### Copy install (checkout) / コピーインストール

```bash
git clone https://github.com/indigo-gr/claude-code-station.git
cd claude-code-station
npm install
./install.sh
```

`install.sh --with-deps` で `npm install` も install.sh に任せられる。`install.sh` はランタイム依存解決のため checkout の `node_modules` をインストール先に symlink する（checkout は残しておくこと）。

### Manual install / 手動インストール

```bash
npm install
cp bin/ccs bin/ccs-*.ts bin/ccs-*.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/ccs ~/.claude/scripts/ccs-delete.sh

# Add to ~/.zshrc or ~/.bashrc
export PATH="$PATH:$HOME/.claude/scripts"
```

---

## Quick start / クイックスタート

1. Run `ccs init --auto-discover` — scans `$HOME` (depth 5, `--depth N` to change) for git repos and lets you multi-select which to register via fzf (TAB to toggle). / `$HOME` をスキャンして登録するリポをfzfで複数選択
2. Or edit `~/.config/ccs/repos.yml` by hand (`ccs init` scaffolds the template; see [Configuration](#configuration--設定)) / 手で書くなら `ccs init` でテンプレート生成
3. Run `ccs` — fzf opens with your repos + past sessions. / `ccs` 実行でfzfが起動

```
$ ccs
ccs> my-project                         ┃ ━━━ Repo ━━━
                                        ┃ 📁 ~/projects/my-project
  NEW   ClaudeCode                      ┃ 🌿 main (clean)
        Claude Code設定                 ┃ 📨 handoff: 2 files
> NEW   My Project                      ┃ 📌 pendings: 1
        Main development repository     ┃ ━━━ Integrations ━━━
  RESUME ~/projects/my-project  2h ago  ┃ Plane:  abc12345-…
         Fix the billing webhook…       ┃ Slack:  #dev-general
  RESUME ~/projects/my-project  1d ago  ┃ GitHub: acme-corp/my-project
         Plane work item sync…          ┃
```

---

## Configuration / 設定

Full schema: [`docs/design/repos-yml-schema.md`](docs/design/repos-yml-schema.md)

### Minimal / 最小構成

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

### With integrations / 連携情報付き

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

Known keys: `plane_project_id`, `plane_url`, `attio_workspace`, `notion_db`, `linear_team`, `slack_channel`, `github_repo`, `figma_file`. Unknown keys are rendered verbatim under "Other Integrations". / 未知キーは "Other Integrations" にそのまま表示。

### Special command (CMS dev server) / 特殊コマンド

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

### Group headers and labels / グループ見出しと表示名

For a parent folder that should only hold its children — never be launched itself — mark it `launch: false`. Its children nest under it by `path` (no extra key), and `label` gives any entry a display name of its own. / 中の子を束ねるだけで、自分は起動しない親フォルダには `launch: false` を付ける。子は `path` で自動的にその下に並ぶ（追加のキーは不要）。`label` で行に出す名前を `name` と別にできる。

| Key | Type | Default | Meaning |
|---|---|---|---|
| `launch` | bool | `true` | `false` = display-only **group header**: listed with its children under it, but Enter does not launch it (`command`/`cwd` are ignored). `path` is still required — it decides which repos nest under the header. Must be a real boolean (`"false"` in quotes is an error). / `false` で表示だけの見出し行になる（Enter で起動しない。`command`/`cwd` は使われない）。`path` は必須（どの子がこの下に並ぶかを決める）。引用符付きの `"false"` はエラー |
| `lead` | bool | `false` | `true` = the group's lead (a director / coordinator): listed **first among its siblings** instead of in name order, and drawn with 👑 in the simple look. Must be a real boolean. / `true` でグループの統括。兄弟の中で一番上に並び、やさしい見た目では 👑 で出る |
| `label` | string | `""` (show `name`) | Name shown in the repo row and the preview title instead of `name`. `name` stays the unique key (it is still what past-session rows show), so two entries may share a label. Display-only: control characters are stripped. / 行とプレビューの見出しに `name` の代わりに出す名前。一意のキーは `name` のまま（過去セッションの行も `name` で出る）なので、同じ `label` を複数の項目に付けてもよい。表示専用で、制御文字は取り除かれる |

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
🎬 Studio │                    Production team         ← header: Enter does nothing
  ├ 📱 App team  ‹Studio› │    Mobile app/
  ├ 🎬 Studio │                Coordination hq/
  └ 🌐 Web team  ‹Studio› │    Website web/
```

### Groups from other tools (`groups_dir`) / ほかの道具のグループ定義

Projects that live in unrelated folders can be listed together under one header, following group definition files another tool keeps. Off unless you set it. / フォルダがばらばらのプロジェクトを、ほかの道具が持つグループの定義ファイルに従って 1 つの見出しの下に並べる。書かなければ使わない。

```yaml
defaults:
  groups_dir: ~/tools/groups   # a folder of *.json files; must be under $HOME
```

Each `*.json` directly in that folder (in name order, at most 200, each up to 256 KB) is read for five keys only, and nothing is ever written there: / フォルダの直下の `*.json` から 5 つのキーだけを読み、ccs はこのフォルダに書かない。

```json
{ "version": 1, "id": "team-x", "label": "Team X", "kind": "logical",
  "members": [{ "path": "~/x/beta" }, { "path": "~/w/alpha" }] }
```

- Only `version: 1` and `kind: "logical"` are used. A `physical` group is skipped: its projects already nest by `path` (`launch: false` headers). / 使うのは `version: 1` と `kind: "logical"` だけ。`physical` はフォルダの入れ子で並ぶので読まない
- `members[].path` (`~` expanded) is matched to the `path` of your `repos.yml` entries; the header lists the matches in the file's order, with their own names and icons. Members not in `repos.yml` are not shown. A project may appear both in its own place and under the header. / `members[].path` を `repos.yml` の `path` と比べ、当たった項目をその順に並べる（名前とアイコンは `repos.yml` の物）
- In the classic look the headers come after all projects; in the simple look after the `launch: false` headers. Enter on a header does nothing. / classic は全部のプロジェクトの後、simple は `launch: false` の見出しの後
- Broken or unknown files are skipped, never stopping the list; `ccs doctor` counts them (`groups_dir`: `group_files_skipped`), and `ccs list --json` gives the groups in `groups[]`. The scan reads the folder, so changes show after the next scan (`ccs --refresh` or `Ctrl-R`). / 読めないファイルは飛ばす（一覧は止めない）。`ccs doctor` が数を出す

### Friendlier look (`ui: simple`) / やさしい見た目

For people who are new to the terminal, `defaults.ui: simple` switches ccs to a full-screen look with rounded frames and plain Japanese words. The default (`classic`) does not change. / ターミナルに慣れていない人向けに、`defaults.ui: simple` で全画面・角の丸い枠・日本語の言葉の見た目に切り替わる。既定（`classic`）は変わらない。

```yaml
version: 1
defaults:
  ui: simple        # or classic (default). Any other value is an error
```

- **Order** — groups first (`launch: false` headers with everything inside them), then the other projects, then past conversations, each under a heading row. Nested entries are indented instead of drawn as a tree, and every row inside a group ends with the group's name (dim), so **typing a group's name narrows the list to that group**, its projects and their conversations. The list keeps this order while you type. / 並びはグループ（`launch: false` の見出しと中身）→ ほかのプロジェクト → 前の会話。グループの名前を打つと、そのグループの中身だけに絞れる
- **Leads first** — an entry with `lead: true` (the group's director / coordinator) is the first row inside its group, marked 👑. / `lead: true` の席はグループの一番上に 👑 で出る
- **Rows** — name and description only. Branch / uncommitted / handoff / integration badges move into the preview "card", and times read like speech (たった今・3 時間前・きのう・3 日前・10月25日). / バッジは右の欄のカードへ。時刻は「3 時間前」「きのう」
- **Guidance** — the guide line shows only Enter / ↑↓ / Esc (`^Y` `^I` `^R` `^D` still work). Enter on a heading, a group header or an empty result says why nothing opened; Esc says how to come back; with nothing to open, ccs prints how to add projects instead of an empty picker. A broken `repos.yml` is flagged in the frame and explained after the picker closes. / 見出しや空振りで Enter を押すと理由が出る。Esc の後・空の時・設定の誤りも 1 行で案内する
- **Narrow terminals** — under ~100 columns the preview moves below the list (80x24 keeps 8 list rows). / 狭い端末では右の欄が下に回る
- **Override per launch** — `ccs --ui=simple` / `ccs --ui=classic`, or `CCS_UI=simple|classic` (the flag wins over the variable, the variable over `repos.yml`). / 起動ごとの切り替えは `--ui=` か `CCS_UI`

The list part of the screen (the frame around it carries the labels Claude Code をはじめる / さがす / えらぶ / 中身, and the right-hand card explains the focused row):

```
──────── グループ ────────
🎬 Studio          Production team
   📱 App team     Mobile app/  （Studio）
   🌐 Web team     Website web/  （Studio）
──────── プロジェクト ────────
📁 notes           Daily notes
──────── 前の会話のつづき ────────
💬 3 時間前    Studio・Web team  Make the top headline bigger
```

### Preview pane sample / プレビュー表示例

```
━━━ Repo: My Project ━━━
📁 ~/projects/my-project  🌿 main (2 modified)
📨 handoff: 2 files       📌 pendings: 1

━━━ Integrations ━━━
Plane:    ✅ abc12345-xxxx → https://plane.example.com/my-project
Slack:    ✅ #dev-general
GitHub:   ✅ acme-corp/my-project
Notion:   ✅ abc123
```

---

## Usage / 使い方

### Flags / フラグ

| Flag | Action |
|---|---|
| (none) | Mixed list: NEW repos + RESUME sessions / 混在表示 |
| `.` | Only sessions whose cwd is under current dir / カレント配下のセッションのみ |
| `--new` | Only NEW repo entries / 新規起動行のみ |
| `--resume` | Only past sessions / 再開行のみ |
| `--refresh` | Force DB rebuild before showing list / 走査を強制してから表示 |
| `--no-scan` | Skip implicit pre-scan (use stale DB) / 事前走査をスキップ |
| `--ui=simple` / `--ui=classic` | Friendlier look / classic look for this launch (wins over `CCS_UI` and `defaults.ui`) / この起動だけ見た目を切り替える |
| `--help` / `-h` | Help / ヘルプ |
| `--version` / `-v` | Version / バージョン |
| `doctor` / `list` / `sessions` / `repo` / `config` / `open` as the first argument | Commands for scripts and tools, see [below](#for-scripts-and-tools--スクリプトや道具から呼ぶ) / スクリプト向けの口（最初の引数の時だけ） |
| _anything else_ | Passed through to the launched command / 起動コマンドへパススルー |

### Keyboard / キーボード

| Key | Action |
|---|---|
| Enter | Launch (NEW) or resume (RESUME); does nothing on a group header / 起動または再開（グループ見出しの上では何もしない） |
| Ctrl-Y | Copy `cd … && cmd [--resume …]` to clipboard; fzf stays open with a "📋 Copied" header (nothing to copy on a group header) / クリップボードコピー後もfzfは開いたまま、ヘッダーに📋通知（グループ見出しはコピーする物なし） |
| Ctrl-I | Copy session UUID or repo path (group headers too); fzf stays open / コピー後も開いたまま（グループ見出しはパス） |
| Ctrl-R | Refresh DB and reload list / DB再走査してリロード |
| Ctrl-D | Delete session (RESUME rows only). To remove a repo, edit `~/.config/ccs/repos.yml` directly / セッション削除はRESUME行のみ。リポ削除は`repos.yml`を直接編集 |
| Esc / Ctrl-C | Cancel / キャンセル |

**Visual cues / 見た目のガイド:**
- NEW rows and RESUME rows are separated by a dim `── Past Sessions ──` divider. Selecting the divider is a no-op.
- RESUME sessions mapped to a registered repo show that repo's icon (e.g., `🔄 📁 ClaudeCode`). Unmapped sessions (cwd that isn't in `repos.yml`) show `❓` — a visual cue that the session was either a one-off or that the repo isn't registered yet.
- A repo whose `path` sits inside another registered repo's `path` is listed right under that repo as a tree (`├` / `└`, with `│` continuing past deeper levels), with the parent's name dimmed at the end. Nothing to configure — the nesting follows from `path`. The dim `‹parent›` keeps the relation visible when a search hides the parent row, and searching for the parent's name lists its children too; it is left out when it would just repeat the row's own name. A parent marked `launch: false` is a [group header](#group-headers-and-labels--グループ見出しと表示名). / `path` が別の登録リポの `path` の中にあるリポは、そのリポのすぐ下にツリー（`├` / `└`、深い段は `│` でつなぐ）で並び、行の末尾に親の名前が薄く出る。設定は要らない（`path` から決まる）。絞り込みで親の行が隠れても `‹親›` で親子がわかり、親の名前で絞り込むと子も一緒に出る。行の名前と同じになる時は `‹親›` を出さない。`launch: false` の親はグループ見出しになる。

  ```
  📁 my-company
    ├ 📁 mobile-app  ‹my-company›
    │ └ 📁 ios  ‹mobile-app›
    └ 📁 web-app  ‹my-company›
  📁 side-project
  ```

### Workflows / 主な使い方

**1. Launch a project fresh / プロジェクトを新規起動**

```bash
ccs --new
# pick repo → Enter → claude starts in repo cwd
```

**2. Resume yesterday's work / 昨日の続き**

```bash
ccs --resume
# fuzzy search by content → Enter → cd + claude --resume <id>
```

**3. Resume in current directory / カレントディレクトリで再開**

```bash
cd ~/projects/my-project
ccs .
```

---

## For scripts and tools / スクリプトや道具から呼ぶ

Commands for GUI launchers, scripts and other tools. They never open fzf, read stdin or ask anything, so they run without a terminal (`ccs open --here` alone starts Claude Code in the terminal it runs in). They do not go to the network (no update check) and never create the `repos.yml` template. The read commands (`doctor`, `list`, `config get`) write nothing to ccs's config or cache folders; they may put a temporary file in `TMPDIR` and remove it before they end. `sessions` refreshes the cache the way opening the list does; `repo add`, `repo remove` and `config set` write `repos.yml`. The full contract is [`docs/design/machine-interface.md`](docs/design/machine-interface.md). / GUI のランチャー・スクリプト・ほかの道具が呼ぶ口。fzf を開かず、標準入力を読まず、問いかけないので、端末が無くても動く（`ccs open --here` だけは、走らせた端末で Claude Code を起こす）。ネットに出ず（更新の確認もしない）、`repos.yml` のひな形を作らない。読む口（`doctor`・`list`・`config get`）は設定とキャッシュの置き場に何も書かない（`TMPDIR` に一時の物を作ることがあり、終わる時に消す）。`sessions` は一覧を開く時と同じにキャッシュを更新し、`repo add`・`repo remove`・`config set` は `repos.yml` を書く。約束の全体は上の資料。

| Command | What it does |
|---|---|
| `ccs doctor [--json]` | Does ccs work here? Checks Node, tsx, ccs's own modules, better-sqlite3, fzf, `claude`, `repos.yml`, the cache and the terminal app for `open --new-window`. Exit 0 works, 1 does not, 2 bad arguments, 3 could not tell. / ccs がここで動くか。終了コード 0 動く・1 動かない・2 引数の誤り・3 確かめられない |
| `ccs list --json [--with-paths]` | The entries of `repos.yml` after ccs's checks, in file order: name, label, description, icon, kind (`repo` / `group`), launch, lead, disabled, parent, tags, and whether the folder exists. Paths only with `--with-paths`. / ccs の検証を通した `repos.yml` の一覧。パスは `--with-paths` の時だけ |
| `ccs sessions --json [--project NAME] [--limit N] [--with-titles] [--no-scan]` | Past conversations per project, newest first, at most `N` (default 5, up to 50) each: the session UUID and when it was last active, plus `more` (how many were left out). Titles (the first request, one line, at most 80 characters) only with `--with-titles`; never the summary, the folder or the conversation. / プロジェクトごとの前の会話（新しい順・既定 5 件）。題は `--with-titles` の時だけ |
| `ccs repo add PATH [--name NAME] [--description TEXT] [--with-paths] [--json]` | Adds a folder under `$HOME` to `repos.yml` (at the end, in the block form, the path written as `~/…`). The name defaults to the folder's name (`-2`, `-3`… when taken). Creates a minimal `repos.yml` when there is none. / `$HOME` の下のフォルダを `repos.yml` に足す |
| `ccs repo remove NAME [--json]` | Takes the entry out of `repos.yml`. The folder, its conversations and the cache are not touched. The last entry cannot be removed. / 台帳から外す（フォルダは消さない） |
| `ccs config get [--with-paths] [--json]` | The settings `config set` can change, with their current values and the values allowed. / 変えられる設定の今の値と、受ける値 |
| `ccs config set [--repo NAME] KEY VALUE [--json]` | Changes one setting: `defaults.ui` (`classic` / `simple`), `defaults.terminal` (`terminal`, or `""` to unset), `defaults.update_check` (`true` / `false`), or with `--repo` an entry's `label` / `description` (`""` removes it). Launch commands, paths and the other keys are not settable here — edit the file for those. / 決まった値から選ぶ設定と、項目の表示名・説明だけを変える |
| `ccs open (--repo NAME \| --session UUID) [--here \| --new-window] [--terminal APP] [--json] [-- ARGS…]` | Starts Claude Code without the list, through the same checks as a picked row (the folder under `$HOME`, the command's characters, the session ID's form). `--here` (the default) runs it in this terminal; `--new-window` (macOS) opens a new window of `defaults.terminal` and returns at once. Unlike the list, `open` never falls back to the current folder: it refuses. / 一覧を開かずに起こす。`--here` はこの端末で、`--new-window`（macOS）は新しいウィンドウで |

- **These words are commands only as the first argument**: `doctor`, `list`, `sessions`, `repo`, `config`, `open`. Until 0.4.x they went to the launched command (`ccs doctor` opened the list and started `claude doctor`). To pass one on, put a flag first: `ccs --new doctor`. / 最初の引数の時だけ ccs の口になる。起動するコマンドに渡したい時は前にフラグを置く
- **With `--json`**, stdout carries exactly one JSON object, on failure too, with `schema_version`, `product_version`, `command`, `status` and `reasons` (`[{ "vocab", "code" }]`). Match on the exit code and on those words; messages on stderr are for people and may change. Without `--json`, `repo` and `config set` print nothing on stdout and one line on stderr. / `--json` の時は標準出力に JSON を 1 つだけ出す（失敗の時も）。機械は終了コードと語で分ける
- **What is never printed**: secrets, the commands repos launch with, `custom`, user and host names. `doctor` prints no repo name or path at all — only words, counts and versions. Paths only with `--with-paths`, conversation titles only with `--with-titles`. / 秘密・起動コマンド・`custom`・ユーザー名とホスト名は出さない。パスは `--with-paths`、会話の題は `--with-titles` の時だけ
- **How `repos.yml` is written** — one writer at a time (`repos.yml.lock`), the previous text kept in `repos.yml.bak`, the file written in place (a symlinked `repos.yml` stays a symlink), checked again, and put back when that check fails. A one-line `repos:` list (`repos: [ … ]`) is not added to (`flow_style_repos`). Names and paths are written only when they need no YAML quotes (`needs_quoting` otherwise). Comments and the order of keys are kept; spaces before an end-of-line comment may be reduced to one. / 書く時はロック・`.bak`・その場で書く・書いた後に検証・落ちたら元に戻す
- **`ccs open --new-window`** writes a one-shot launcher file in `TMPDIR` (it deletes itself when it starts) and hands it to the terminal app with `open -a`; no AppleScript, so no Automation permission is asked for. The new window runs `ccs open --here` with the same checks. Choose the app first: `ccs config set defaults.terminal terminal` (macOS Terminal; other apps are added once their way of opening has been tried). The exit code of `--here` after Claude Code started is Claude Code's own; scripts should use `--new-window`. / 端末のアプリは先に `defaults.terminal` で決める。`--here` の起こした後の終了コードは Claude Code の物
- **Called from a GUI app**, `PATH` is often short and `node` or `claude` is not found (`dependency_missing`). Pass the user's shell `PATH` to ccs. / GUI のアプリから呼ぶと `PATH` が短く `node` が見つからないことがある。利用者のシェルの `PATH` を渡す

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

## State cache / 状態キャッシュ

ccs keeps a SQLite cache at `~/.cache/ccs/state.db` (or `$XDG_CACHE_HOME/ccs/state.db`) with repo metadata, git state badges, session summaries, and handoff/pending file lists.

`~/.cache/ccs/state.db` にリポジトリ情報・git状態・セッション要約などをキャッシュ。

- Auto-refresh on every `ccs` run (cheap — 10s TTL per repo) / 毎回の起動で自動走査（リポジトリ単位で10秒TTL）
- Manual force: `ccs --refresh` or press `Ctrl-R` in fzf / 手動強制: `--refresh` または fzf 内で `Ctrl-R`
- Reset: `rm ~/.cache/ccs/state.db` — next `ccs` run rebuilds it / リセットは DB を削除するだけ（設定 `repos.yml` は無事）

Schema details: [`docs/design/sqlite-schema.md`](docs/design/sqlite-schema.md).

---

## Update check / 更新の確認

ccs tells you when npm has a newer version. The classic look prints one line with the upgrade command above the picker. The simple look says so in the list's frame and prints the command after the picker closes. / npm に新しいバージョンがあると知らせる。classic は一覧の上に上げ方を 1 行、simple は枠に知らせを出し、閉じた後に上げ方を出す。

- **What is sent, and where** — one HTTPS `GET https://registry.npmjs.org/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags`, at most once a day (an hour after a failed attempt). It carries no ccs version, repo, session or machine details; the registry sees only the request itself, your IP address and Node's default User-Agent. / 送るのは公開情報を読む GET が 1 日に 1 回まで（失敗の後は 1 時間後）。ccs のバージョン・リポジトリ・会話・マシンの情報は送らない。npm が受け取るのはリクエストそのもの・IP アドレス・Node の既定の User-Agent だけ
- **Never in the way** — the check runs in the background with a 3-second limit and its answer is used on the next launch; startup only reads `~/.cache/ccs/update-check` (or `$XDG_CACHE_HOME/ccs/update-check`). Offline, or when the answer is unusable, ccs behaves as before. HTTP proxy settings are not used, so behind a proxy the check simply fails quietly. / 確認は裏で行い、結果は次の起動で使う。起動を遅らせず、オフラインでも止まらない。プロキシの設定は使わないので、プロキシの内側では確認が静かに失敗する
- **When there is no notice** — when you are on the latest version or newer, when npm's latest is a prerelease, and when your own version is a prerelease or a copy install (`0.0.0-dev`). A failed check shows no notice of its own, but a version found by an earlier check is still reported. / 最新かそれより新しい時・npm の latest がプレリリースの時・手元がプレリリースかコピーインストールの時は知らせない。確認の失敗だけでは知らせないが、前回までに見つけたバージョンは知らせる
- **Turn it off** — set `CCS_NO_UPDATE_CHECK=1` (any non-empty value), or put `update_check: false` under `defaults:` in `repos.yml` (`ccs config set defaults.update_check false`): no request, and the cache is not read. The variable wins over the file (`update_check: true` does not turn a set variable back on). Useful when another tool manages ccs's updates. / `CCS_NO_UPDATE_CHECK=1`（空でない値）か `repos.yml` の `defaults.update_check: false` で止まる。通信せず、キャッシュも読まない
- **Another registry** — `CCS_UPDATE_REGISTRY=https://registry.example.com` asks that server instead. / `CCS_UPDATE_REGISTRY` で問い合わせ先を替えられる

---

## Migration from ccr v0.1.x / ccr v0.1.x からの移行

Existing sessions are stored under `~/.claude/projects/*/*.jsonl` — **nothing to migrate manually**. ccs auto-discovers them on first scan.

既存の JSONL セッション（`~/.claude/projects/*/*.jsonl`）は初回走査で自動発見される。**手動移行不要**。

### Command & env rename / コマンド・環境変数のリネーム

| Before (ccr v0.1.x) | After (ccs v0.2.0) |
|---|---|
| `ccr` | `ccs` |
| `CCR_CMD` env | `CCS_CMD` env |
| GitHub: `indigo-gr/claude-code-recall` | `indigo-gr/claude-code-station` |

`CCR_CMD` is still honored for now (with a deprecation warning to stderr). Rename it in your shell rc at your earliest convenience. / `CCR_CMD` は当面 deprecation warning 付きで尊重。なるべく早めに `CCS_CMD` にリネームを。

### Uninstall old ccr / 旧 ccr のアンインストール

```bash
rm -f ~/.claude/scripts/ccr ~/.claude/scripts/ccr-*.ts ~/.claude/scripts/ccr-*.sh
# Remove any `export CCR_CMD=...` from ~/.zshrc or ~/.bashrc
```

---

## Architecture / 設計

```
ccs (bash)
 ├─ ccs-scan.ts           → scans repos, orchestrates, writes state.db
 │   └─ ccs-scan-sessions.ts  (session walk, JSONL parse, cwd→repo resolve)
 ├─ ccs-list.ts           → reads DB, emits fzf rows (NEW + RESUME)
 ├─ ccs-preview.ts        → preview pane renderer (repo badges)
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

## Security / セキュリティ

- Session IDs validated as UUID before shell execution / セッションIDはUUID形式を検証してからシェル実行
- `$HOME`-rooted path validation for every `cwd` / 全cwdが`$HOME`配下であることを検証
- Known secret patterns (API keys, tokens) masked in preview / プレビュー内の既知シークレットパターンはマスク
- SQLite DB created with `0600` permissions; config/cache dirs `0700` / DBは0600、設定/キャッシュディレクトリは0700
- No `eval`; all invocations are direct / `eval`不使用
- Prepared statements only for SQLite; foreign keys enforced / SQLiteはprepared statementsのみ、FK有効
- 50MB per-file cap when parsing JSONL sessions / JSONLパーサは1ファイル50MB上限

> **Trust note / 注意**: the `command:` field in `repos.yml` is validated for shell metacharacters at load time — only safe, sanitized commands are executed. / `repos.yml` の `command:` はロード時にシェルメタ文字を検証し、安全な文字列のみが実行される。

---

## Contributing / コントリビュート

Issues and PRs welcome. See [`REVIEW.md`](REVIEW.md) for review standards and [`CHANGELOG.md`](CHANGELOG.md) for release history.

---

## License / ライセンス

MIT. Copyright © INDIGO GROUP LLC. See [LICENSE](LICENSE). / ライセンスは MIT、著作権者は INDIGO GROUP LLC.

The version on screen leads to everything about that release / 画面のバージョンから、そのリリースの中身をたどれる:

- **Source** — git tag `vX.Y.Z` in [indigo-gr/claude-code-station](https://github.com/indigo-gr/claude-code-station/tags) / ソースは同じ番号の tag
- **Changes** — the `[X.Y.Z]` section of [CHANGELOG.md](CHANGELOG.md) / 変更点は CHANGELOG の同じ番号の節
- **Terms** — [LICENSE](LICENSE) at that tag / 配布条件はその tag の LICENSE
