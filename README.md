# Claude Code Station — ccs

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

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

- [Node.js](https://nodejs.org/) **20+**
- [fzf](https://github.com/junegunn/fzf) — fuzzy finder
- [tsx](https://github.com/privatenumber/tsx) — TypeScript runner (`npm install -g tsx`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
- `better-sqlite3` and `yaml` npm packages (installed via `npm install`)

### Quick install / クイックインストール

```bash
git clone https://github.com/indigo-gr/claude-code-station.git
cd claude-code-station
npm install
./install.sh
```

`install.sh --with-deps` で `npm install` も install.sh に任せられる。

### Manual install / 手動インストール

```bash
npm install
cp bin/ccs bin/ccs-*.ts bin/ccs-*.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/ccs ~/.claude/scripts/ccs-delete.sh

# Add to ~/.zshrc or ~/.bashrc
export PATH="$HOME/.claude/scripts:$PATH"
```

---

## Quick start / クイックスタート

1. Run `ccs` once — it creates `~/.config/ccs/repos.yml` template and a `README.md` next to it. / 初回実行で `~/.config/ccs/repos.yml` のテンプレートと README を生成
2. Edit `repos.yml` to add your projects (see [Configuration](#configuration--設定)) / プロジェクトを追記
3. Run `ccs` again — fzf opens with your repos + past sessions. / 再実行でfzfが起動

```
$ ccs
ccs> ils                                ┃ ━━━ Repo ━━━
                                        ┃ 📁 ~/pj/ILS
  NEW   ClaudeCode                      ┃ 🌿 main (clean)
        Claude Code設定                 ┃ 📨 handoff: 2 files
> NEW   ILS事業部                       ┃ 📌 pendings: 1
        ILS本番リポジトリ               ┃ ━━━ Integrations ━━━
  RESUME ~/pj/ILS  2h ago               ┃ Plane:  ed1ec22d-…
         Fix the billing webhook…       ┃ Slack:  #ils-dev
  RESUME ~/pj/ILS  1d ago               ┃ GitHub: indigo-gr/ils
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
  - name: ILS
    path: ~/pj/ILS
    description: ILS本番リポジトリ
    tags: [work]
```

### With integrations / 連携情報付き

```yaml
version: 1
repos:
  - name: ILS事業部
    path: ~/pj/ILS
    description: ILS本番リポジトリ
    tags: [work]
    custom:
      plane_project_id: "ed1ec22d-xxxx"
      plane_url: "https://plane.example.com/ils"
      slack_channel: "#ils-dev"
      github_repo: "indigo-gr/ils"
      notion_db: "abc123"
```

Known keys: `plane_project_id`, `plane_url`, `attio_workspace`, `notion_db`, `linear_team`, `slack_channel`, `github_repo`, `figma_file`. Unknown keys are rendered verbatim under "Other Integrations". / 未知キーは "Other Integrations" にそのまま表示。

### Special command (Strapi dev server) / 特殊コマンド

```yaml
version: 1
defaults:
  command: "claude"
repos:
  - name: Strapi CMS
    path: ~/Website/strapi-cms
    command: "npm run develop"   # overrides claude entirely
    icon: "🚀"
    scan: false                  # not a Claude repo — skip state scan
    tags: [dev-server]
```

Precedence: `repos[].command` > `defaults.command` > `$CCS_CMD` > `"claude"`.

### Preview pane sample / プレビュー表示例

```
━━━ Repo: ILS事業部 ━━━
📁 ~/pj/ILS           🌿 main (2 modified)
📨 handoff: 2 files   📌 pendings: 1

━━━ Integrations ━━━
Plane:    ✅ ed1ec22d-xxxx → https://plane.example.com/ils
Slack:    ✅ #ils-dev
GitHub:   ✅ indigo-gr/ils
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
| `--help` / `-h` | Help / ヘルプ |
| `--version` / `-v` | Version / バージョン |
| _anything else_ | Passed through to the launched command / 起動コマンドへパススルー |

### Keyboard / キーボード

| Key | Action |
|---|---|
| Enter | Launch (NEW) or resume (RESUME) / 起動または再開 |
| Ctrl-Y | Copy full `cd … && cmd [--resume …]` to clipboard / シェルコマンド全体をコピー |
| Ctrl-I | Copy session UUID or repo path / セッションIDまたはパスをコピー |
| Ctrl-R | Refresh DB and reload list / DB再走査してリロード |
| Ctrl-D | Delete session (RESUME rows only) / セッション削除（再開行のみ） |
| Esc / Ctrl-C | Cancel / キャンセル |

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
cd ~/pj/ILS
ccs .
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
 ├─ ccs-scan.ts     → writes ~/.cache/ccs/state.db
 ├─ ccs-list.ts     → reads DB, emits fzf rows (NEW + RESUME)
 ├─ ccs-preview.ts  → preview pane (repo badges / session head)
 ├─ ccs-config.ts   → loads ~/.config/ccs/repos.yml
 ├─ ccs-db.ts       → better-sqlite3 wrapper (WAL, FK on)
 └─ ccs-delete.sh   → Ctrl-D handler
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

> **Trust note / 注意**: the `command:` field in `repos.yml` is executed as-is. It's your config — don't paste anything you wouldn't type into a shell. / `repos.yml` の `command:` はそのまま実行される。自分の設定ファイルなので信頼されるが、シェルに打ちたくない文字列は書かないこと。

---

## Contributing / コントリビュート

Issues and PRs welcome. See [`REVIEW.md`](REVIEW.md) for review standards and [`CHANGELOG.md`](CHANGELOG.md) for release history.

---

## License / ライセンス

MIT. See [LICENSE](LICENSE).
