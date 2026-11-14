# repos.yml スキーマ設計

> `version: 1` の形 — ccs が読むリポジトリ定義ファイルの形と、ほかの道具との約束（契約）

本体の正は `bin/ccs-config.ts`（読む・検証する）と `bin/ccs-init.ts`（`ccs init` で書き足す）。この資料と本体が食い違ったら本体に合わせて資料を直す。

## 配置

- パス: `$XDG_CONFIG_HOME/ccs/repos.yml`（`XDG_CONFIG_HOME` が無ければ `~/.config/ccs/repos.yml`）
- ccs を起動するたびに置き場を確かめ、無ければ作る（フォルダは 0700）。`repos.yml` と `README.md` が無ければテンプレートから 0600 で作る
- 機械で読む口（`ccs doctor`・`ccs list --json` など・`machine-interface.md`）は置き場も `repos.yml` も作らない。`ccs repo add` だけは、`repos.yml` が無い時に最小の形で作る
- `ccs init` も同じ置き場を作り、場所を出して終わる。`ccs init --auto-discover` は `$HOME` の下の git のリポを探し、選んだ物を `repos.yml` に書き足す（下の「ccs が書く時」）

## トップレベル構造

```yaml
version: 1                    # スキーマのバージョン（必須・整数の 1 だけ）
defaults:                     # 全リポジトリの既定（任意）
  command: "claude"           # 起動コマンドの既定
  ui: simple                  # 一覧の見た目（classic / simple）
  terminal: terminal          # ccs open --new-window で開く端末のアプリ（v0.5.0〜）
  update_check: false         # 更新の知らせを止める（v0.5.0〜）
  groups_dir: ~/groups        # 外のグループの定義を読むフォルダ（v0.5.0〜・既定は off）
repos:                        # リポジトリ定義の配列（必須・1 件以上）
  - name: Example Project
    path: ~/projects/example
    description: 見本の項目
    ...
```

| キー | 型 | 必須 | 既定 | 説明 |
|---|---|:---:|---|---|
| `version` | integer | ✅ | — | `1` だけ受け付ける（文字列の `"1"` はエラー） |
| `defaults` | object | — | `{}` | 下のキー。中の未知のキーは警告なしで無視する（前のバージョンの ccs が新しいキーで壊れないための前方互換） |
| `defaults.command` | string | — | `CCS_CMD` → `CCR_CMD` → `"claude"` | `command` を書いていない項目の起動コマンド（優先順は下の「環境変数との優先順位」） |
| `defaults.ui` | string | — | `"classic"` | 一覧とプレビューの見た目。`classic` か `simple`。ほかの値はエラー。空（YAML の null）は未指定。`simple` は fzf 0.61 以上が要り、古い fzf では `classic` で開く。`--ui=` と `CCS_UI` が勝つ |
| `defaults.terminal` | string | — | 未指定 | v0.5.0〜。`ccs open --new-window` で開く端末のアプリ。`terminal`（macOS のターミナル）だけ（iTerm2 は確かめてから足す）。ほかの値はエラー。空（YAML の null）は未指定。macOS だけで使う（`machine-interface.md` の 4.5） |
| `defaults.update_check` | boolean | — | `true` | v0.5.0〜。`false` で更新の確認と知らせを止める（`CCS_NO_UPDATE_CHECK` と同じ）。真偽値だけ（`"false"` などの文字列はエラー） |
| `defaults.groups_dir` | string | — | 未指定（off） | v0.5.0〜。外のグループの定義（`*.json`）を読むフォルダ。`~` を展開する。`$HOME` の下・シェルのメタ文字不可。ccs はこのフォルダに書かない（`machine-interface.md` の 5 章） |
| `repos` | array | ✅ | — | 1 件以上の項目（下の表） |

トップレベルの未知のキーは、標準エラーに `[ccs] unknown key "<key>" in top-level (ignored)` を出して無視する。

## `repos[]` エントリのフィールド

| フィールド | 型 | 必須 | デフォルト | 説明 |
|---|---|:---:|---|---|
| `name` | string | ✅ | — | 一意のキー兼、既定の表示名（fzf の行に出る・日本語可）。空はエラー。`label` があれば新規起動の行・`‹親›` の表示・プレビューの見出しは `label` を出す。過去セッションの行は常に `name` |
| `path` | string | ✅* | `""` | リポジトリのパス。先頭の `~` を展開する。`$HOME` の下に限る |
| `description` | string | — | `""` | プレビューと一覧の補助の文。空（YAML の null）は未指定（v0.5.0〜。前は文字列の `"null"` になった） |
| `command` | string | — | `defaults.command` → `CCS_CMD` → `CCR_CMD` → `"claude"` | 起動コマンド。特殊な場合は丸ごと上書き |
| `cwd` | string | — | `path` | 起動時の作業ディレクトリ（通常は書かない）。`~` の展開と `$HOME` の下の制限は `path` と同じ |
| `tags` | string[] | — | `[]` | プレビューに出すタグ（例: `["work", "backend"]`）。文字列の配列以外はエラー |
| `disabled` | bool | — | `false` | true なら一覧に出さず、状態も走査しない。真偽値のみ（v0.5.0〜。`"false"` などの文字列はエラー） |
| `scan` | bool | — | `true` | false なら状態の走査をしない（git でないフォルダや、Claude Code を起こさない項目）。真偽値のみ（v0.5.0〜。文字列はエラー） |
| `icon` | string | — | `📁` | 行に出すアイコン（絵文字 1 文字を勧める）。空（YAML の null）は未指定（v0.5.0〜） |
| `launch` | bool | — | `true` | false なら表示だけのグループ見出し（行の種類 `group:<name>`）。Enter で起動しない・バッジなし・状態を走査しない。`command`/`cwd` は使われない。`path` の中のリポがこの下に並ぶ。真偽値のみ（`"false"` などの文字列はエラー） |
| `label` | string | — | `""` | 新規起動の行・`‹親›` の表示・プレビューの見出しに `name` の代わりに出す名前。表示専用（シェルのメタ文字は可、制御文字は表示の時に除く）。空（YAML の null）は未指定。空・空白だけなら `name` を出す |
| `lead` | bool | — | `false` | true ならグループの統括。同じ親の下の兄弟の中で一番上に並ぶ（トップレベルの並びは変えない）。`ui: simple` では 👑 で出る。真偽値のみ（`"true"` などの文字列はエラー） |
| `custom` | object | — | `{}` | 外部システム連携の情報。任意のキーと値（後述）。ほかの道具が自分の値を置く場所 |

\* ccs の検証が `path` を必ず求めるのは `launch: false` の項目だけ（無いとエラー）。契約では、ほかの項目でも `path` を必ず書く（ほかの道具は `path` の無い項目を読めない）。`version: 1` の間は、`path` を省いた `launch: true` の項目もエラーにせず今のまま読む（今の動き: 読む時は何も言わず、起動の時に「`$HOME` の外」の警告を出して、いまいるフォルダで開く）。

- `repos[i]` がマッピングでなければエラー。項目の中の未知のキーは、標準エラーに `[ccs] unknown key "<key>" in repos[<i>] (ignored)` を出して無視する
- `disabled`・`scan` は真偽値で書く（v0.4 までの本体は値を真偽に丸め、`"false"` と書くと true になった。v0.5.0 から `launch`・`lead` と同じくエラーにする）
- `description`・`icon` は文字列で書く（本体は値を文字列にする。YAML の null は v0.5.0 から未指定として扱う）

### `custom` フィールド（外部システム連携）

ユーザー固有の連携情報を自由に保持できる。プレビューに「連携バッジ」として出し、無い・空なら出さない。

**よくある例:**

```yaml
repos:
  - name: My Project
    path: ~/projects/my-project
    custom:
      plane_project_id: "abc12345-xxxx"
      plane_url: "https://plane.example.com/my-project"
      attio_workspace: "acme-corp"
      notion_db: "abc123"
      linear_team: "PROJ"
      slack_channel: "#dev-general"
      figma_file: "https://www.figma.com/file/example123"
```

**プレビュー表示例:**

```
🔗 Integrations
   Plane:    ✅ abc12345-xxxx
   Attio:    ✅ acme-corp
   Notion:   ✅ abc123
   Slack:    ✅ #dev-general
```

**仕様:**
- `custom` の値は文字列・数値・bool・配列・入れ子の object 何でも可（JSON にして state.db に保存）
- 既知キー（下の表）は専用の表示でバッジにする
- 未知キーは「Other」の下に `key: value` の形で出す（値が null なら出さない）

**組み込み既知キー:**

| キー | 表示 | 備考 |
|---|---|---|
| `plane_project_id` | Plane バッジ | |
| `plane_url` | — | 補助のキー（単独では出さない） |
| `attio_workspace` | Attio バッジ | |
| `notion_db` | Notion バッジ | |
| `linear_team` | Linear バッジ | |
| `slack_channel` | Slack バッジ | `#` を自動で付ける |
| `github_repo` | GitHub バッジ | `owner/repo` 形式 |
| `figma_file` | Figma バッジ | URL でも ID でも可 |

**検証:**
- `custom` が object でない → エラー
- JSON にして 64,000 文字を超える → エラー
- 中身の型は問わない（ユーザーの責任）
- 秘密の値を混ぜない（API キーなどは書かない。URL・ID だけを勧める）

## バリデーションルール

エラーは `ConfigError` で、文の先頭に `repos.yml` のフルパスが付く（下の表では `<repos.yml>` と書く）。警告は標準エラーに出し、読むのは続ける。

| ルール | 種類 | 出る文の例 |
|---|---|---|
| トップレベルはマッピング | エラー | `<repos.yml>: top-level must be a mapping/object` |
| YAML として読めること | エラー | `<repos.yml>: YAML parse error: ...` |
| `version` は整数の `1` だけ | エラー | `<repos.yml>: unsupported version: 2, only 1 is supported` |
| `defaults` は object | エラー | `<repos.yml>: defaults must be an object` |
| `defaults.command` は文字列 | エラー | `<repos.yml>: defaults.command must be a string` |
| `defaults.ui` は `classic` か `simple` | エラー | `<repos.yml>: defaults.ui must be one of classic / simple (got "fancy")` |
| `defaults.terminal` は `terminal` だけ（v0.5.0〜） | エラー | `<repos.yml>: defaults.terminal must be one of terminal (got "x")` |
| `defaults.update_check` は真偽値のみ（v0.5.0〜） | エラー | `<repos.yml>: defaults.update_check must be true or false (got "false")` |
| `defaults.groups_dir` は文字列・`$HOME` の下・シェルのメタ文字不可（v0.5.0〜） | エラー | `<repos.yml>: defaults.groups_dir "/etc" is outside $HOME (security)` |
| 解決した既定のコマンド（`defaults.command` / `CCS_CMD` / `CCR_CMD` 由来）にシェルのメタ文字不可 | エラー | `<repos.yml>: defaults.command (resolved from defaults.command / CCS_CMD / CCR_CMD) contains shell metacharacter(s): "..."` |
| `repos` は 1 件以上の配列 | エラー | `<repos.yml>: repos must be a non-empty array` |
| `name` は空でない文字列 | エラー | `<repos.yml>: repos[0].name is required and must be a non-empty string` |
| `name` にシェルのメタ文字・制御文字不可（`SHELL_METACHARS`。`path`/`cwd`/`command` と同じ） | エラー | `<repos.yml>: repos[0].name contains shell metacharacter(s) or control char(s): "..."` |
| `name` は一意 | エラー | `<repos.yml>: duplicate name "foo" at indexes [0, 2]` |
| `launch` は真偽値のみ | エラー | `<repos.yml>: repos[0].launch must be true or false (got "false")` |
| `launch: false` は `path` 必須 | エラー | `<repos.yml>: repos[0].path is required when launch is false` |
| `path`・`cwd`・`command` は文字列 | エラー | `<repos.yml>: repos[0].path must be a string` |
| `path`・`cwd` は `$HOME` の下（書いたままの形と、実在する時はシンボリックリンクを解いた先の両方） | エラー | `<repos.yml>: repos[0].path "/etc/foo" is outside $HOME (security)` |
| `path`・`cwd`（展開した後）・`command`（継いだ値を含む）にシェルのメタ文字不可 | エラー | `<repos.yml>: repos[0].command contains shell metacharacter(s): "claude;..."` |
| `path` が無い（`disabled: true` の時は確かめない） | 警告 | `[ccs] path not found: ~/projects/foo (repos[0] "foo") — set disabled: true to silence` |
| `label` は文字列のみ（空の `label:` = YAML の null は未指定） | エラー | `<repos.yml>: repos[0].label must be a string` |
| `lead` は真偽値のみ | エラー | `<repos.yml>: repos[0].lead must be true or false (got "true")` |
| `disabled`・`scan` は真偽値のみ（v0.5.0〜） | エラー | `<repos.yml>: repos[0].disabled must be true or false (got "false")` |
| `description`・`icon` の YAML の null は未指定（v0.5.0〜） | — | — |
| `tags` は文字列の配列 | エラー | `<repos.yml>: repos[0].tags must be an array of strings` |
| `custom` は object | エラー | `<repos.yml>: repos[0].custom must be an object` |
| `custom` は JSON にして 64,000 文字まで | エラー | `<repos.yml>: repos[0].custom exceeds the 64KB limit (measured as 64,000 characters of JSON; got 70000)`（v0.5.0〜。前の文は `exceeds 64KB JSON size limit (got 70000 bytes)` で、数えているのは文字数） |
| 未知のキー（トップレベルと `repos[i]`） | 警告 | `[ccs] unknown key "foo" in repos[0] (ignored)` |
| 未知のキー（`defaults` の中） | 黙って無視 | —（前方互換） |
| `disabled: true` の項目は一覧に出さず、走査も `path` の確認もしない | — | — |

`SHELL_METACHARS` は `` ;&|<>$`"'\ `` と、改行・CR を含む全部の制御文字（U+0000〜U+001F）。

## 例1: シンプル

```yaml
version: 1
repos:
  - name: dotfiles
    path: ~/dotfiles
    description: 手元の設定
  - name: My Project
    path: ~/projects/my-project
    description: Main development repository
    tags: [work]
```

## 例2: 特殊コマンド対応（CMS の dev server 起動など）

```yaml
version: 1
defaults:
  command: "claude"
repos:
  - name: dotfiles
    path: ~/dotfiles

  - name: CMS (dev server)
    path: ~/sites/blog-cms
    command: "npm run develop"
    icon: "🚀"
    scan: false                # Claude Code を起こさないので状態の走査は要らない
    tags: [dev-server]

  - name: personal-notes
    path: ~/projects/personal-notes
    tags: [personal]
    disabled: true             # 今は使わない
```

## 例3: ラッパー経由の起動

```yaml
version: 1
defaults:
  command: "my-wrapper claude" # 全リポジトリでラッパー経由
repos:
  - name: Startup MVP
    path: ~/work/startup-mvp
  - name: My Project
    path: ~/projects/my-project
```

## 例4: グループ見出しと統括

```yaml
version: 1
defaults:
  command: "claude"
  ui: simple
repos:
  - name: studio
    path: ~/studio
    launch: false              # 見出しだけ。Enter で起動しない
    label: Studio
  - name: studio-hq
    path: ~/studio/hq
    lead: true                 # 兄弟の中で一番上・simple では 👑
    label: HQ
  - name: studio-web
    path: ~/studio/web
```

## 環境変数との優先順位

起動コマンド: `repos[].command` > `defaults.command` > `CCS_CMD` 環境変数 > `CCR_CMD` 環境変数 > `"claude"`

**設計意図**: 項目ごとの明示（`command:`）が常に最優先。`CCS_CMD` は「全リポジトリ共通のラッパー（例: `my-wrapper claude`）を、`defaults.command` が無い時に入れたい」用のフォールバック。CMS 起動のような特殊コマンドが環境変数で潰れないよう、環境変数を一番弱くする。

旧名の `CCR_CMD` は、`CCS_CMD` が無い時だけ使い、標準エラーに改名を勧める警告を 1 回出す。

**Security note**: `CCS_CMD` / `CCR_CMD` env values are subject to the same shell metacharacter rejection as `command:` in YAML. If env-sourced value contains any forbidden character, `loadConfig()` throws `ConfigError` before launch.

**登録の無いセッションへの適用**: `repos.yml` に登録されていない cwd のセッション（fzf 上で `❓` 表示）も、`defaults.command` から後の優先順に従う。走査の時に解決した既定が state.db の `meta.defaults_command` に保存され、一覧が過去セッションの行の起動コマンドに使う。

見た目: `--ui=` フラグ > `CCS_UI` 環境変数 > `defaults.ui` > `classic`

更新の確認: `CCS_NO_UPDATE_CHECK` が空でない → 止める > `defaults.update_check: false` → 止める > 確かめる（設定の `true` は環境変数の「止める」に勝たない）

## JSON Schema（抜粋）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "repos"],
  "properties": {
    "version": { "const": 1 },
    "defaults": {
      "type": "object",
      "properties": {
        "command": { "type": "string" },
        "ui": { "enum": ["classic", "simple", null] },
        "terminal": { "enum": ["terminal", null] },
        "update_check": { "type": "boolean" },
        "groups_dir": { "type": "string", "pattern": "^[^;&|<>$`\"'\\\\\\u0000-\\u001f]+$" }
      }
    },
    "repos": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "minLength": 1, "pattern": "^[^;&|<>$`\"'\\\\\\u0000-\\u001f]+$" },
          "path": { "type": "string" },
          "description": { "type": ["string", "null"] },
          "command": { "type": "string" },
          "cwd": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } },
          "disabled": { "type": "boolean" },
          "scan": { "type": "boolean" },
          "icon": { "type": ["string", "null"] },
          "launch": { "type": "boolean" },
          "label": { "type": ["string", "null"] },
          "lead": { "type": "boolean" },
          "custom": { "type": "object", "additionalProperties": true }
        },
        "if": { "properties": { "launch": { "const": false } }, "required": ["launch"] },
        "then": { "required": ["path"] }
      }
    }
  }
}
```

抜粋で表せない検証（`name` の一意・`path`/`cwd`/`defaults.groups_dir` が `$HOME` の下・展開した後の `path`/`cwd` と継いだ `command` のメタ文字・`custom` の大きさ）は上の「バリデーションルール」が正。未知のキーは Schema でも拒まない（ccs は警告して無視する）。

## 契約（ほかの道具との約束）

`repos.yml` は ccs のほかに、ほかの道具（hook・スクリプト・入れる手順）も「プロジェクトの一覧の正」として読み、書く。変える時に読む側が壊れないよう、ここに約束を置く。

### 頼ってよいキー

まず頼ってよい物（`version: 1` の間、意味を変えない・消さない）:

| キー | 約束 |
|---|---|
| `version` | 整数の `1` |
| `repos[].name` | 項目の一意のキー（同じ名前は ccs がエラーにする） |
| `repos[].path` | リポのパス。`$HOME` の下。先頭の `~` を `$HOME` に展開して読む |
| `repos[].description` | 説明の文 |
| `defaults.command` | 起動コマンドの既定 |
| `defaults.ui` | `classic` か `simple` |

次に頼ってよい物: `repos[].launch`・`repos[].lead`・`repos[].label`・`repos[].disabled`・`repos[].custom`（意味は上の表）。

v0.5.0 で足した物（足すだけの変更）: `defaults.terminal`・`defaults.update_check`・`defaults.groups_dir`。前のバージョンの ccs は `defaults` の中の未知のキーを黙って無視するので、書いても壊れない。

ほかの道具が `repos.yml` を直に読まずに済むよう、ccs は同じ検証を通した結果を `ccs list --json` で出す（`machine-interface.md` の 2.2）。

### `version: 1` の間の変え方

- 足すだけ。キーの意味を変えない・消さない
- 読む側は未知のキーを無視する（ccs はトップレベルと項目の中は警告を出して、`defaults` の中は黙って無視する）
- ほかの道具が自分の値を置く場所は `repos[].custom`（ccs は中身の型を問わず、プレビューに出すだけ）。トップレベルや項目の直下に自分のキーを足さない
- 壊す変更（キーの意味を変える・消す・必須を足す）は `version: 2` にし、両方を読める移る期間を置く

### 勧める書き方

- ブロックの形で書く（`repos: [{name: …, path: …}]` のような 1 行の形にしない）
- 各項目の直下に `name:` と `path:` を書く（`- name:` で始め、次の行に `path:`）。YAML のパーサを使わず行で読む読む側でも、`name:` と `path:` を引ける
- `path` は `~/…` か `$HOME` の下のフルパスで書く。`$HOME` そのものは `~/`（`~` だけは YAML の null になり、引用符なしで書けない）
- ccs が書く時（初回のテンプレート・`ccs init --auto-discover` の書き足し・`ccs repo add`・`ccs repo remove`・`ccs config set`）は、必ずこの形で書く。書き足しは元のファイルのコメントと書き方を残し（例外: 行の終わりのコメントの前の空白は 1 つに揃う）、`.bak` を残し、書いた後の検証に落ちたら元に戻す（手順は `machine-interface.md` の 3 章）
- `repos:` が 1 行の形（`repos: [ … ]`）の時、ccs は項目を書き足さずに断る（`ccs init --auto-discover` は終了コード 1・`ccs repo add` は 6・どちらも理由の語 `flow_style_repos`・ファイルを書き換えない）。`ccs init --auto-discover` の書き足しは、ほかの検査より先に断る（`repos: []` も）。1 行の形のまま足すと、行で読む道具が新しい項目を読めないため
- ccs が書く `name`・`path` は、YAML で引用符なしに書ける値だけ（`machine-interface.md` の 1.6）

### 最小の形の見本

入れる手順などが書く最小の `repos.yml`。ccs はこの形を `version: 1` の間読み続ける（値は架空）。

```yaml
version: 1
defaults:
  command: "claude"
  ui: simple
repos:
  - name: example
    path: ~/projects/example
```

### `repos.yml` のほかに約束に入る事

- `ccs --version`（`-v` も同じ）: 標準出力に `ccs v<バージョン>` の 1 行を出し、exit 0。バージョンは配った `package.json` の `version`（読めない置き方では `0.0.0-dev`）
- 起動の形: コマンドの名前は `ccs`。`ccs init`・`ccs init --auto-discover`・`--version`。v0.5.0 から、最初の引数が `doctor`・`list`・`sessions`・`repo`・`config`・`open` の時は ccs の口になる（前は起動するコマンドに渡っていた。渡したい時は `ccs --new doctor` のように前にフラグを置く）。Claude Code は、選んだ項目のフォルダ（`cwd`、無ければ `path`）へ cd し、上の優先順で決めたコマンドで起こす。過去セッションの再開はそのコマンドに `--resume <UUID>` を付ける。ccs が知らないフラグはそのコマンドに渡す
- Node の下限: `package.json` の `engines.node`
- 機械で読む口（コマンド・JSON の形・終了コード・理由の語）の約束は `machine-interface.md`

上の物を変えるバージョンは、出す前に読む側に知らせる。壊す変更は、読む側が替え終えてから出す。

### 約束の外

- 画面の言葉と並び（一覧・プレビュー・警告の文。`ui: simple` と `classic` のどちらも）
- キーの割り当て（Enter・Ctrl-Y など）
- state.db のスキーマ（`sqlite-schema.md` は設計の記録で、約束ではない）

## 将来拡張（未実装の案）

- `env`: リポジトリごとの環境変数の注入
- `post_launch`: 起動後に実行するフック
- `priority`: 並びの重み（上に出したいリポジトリ）

グループ化（fzf のヘッダーでの切り替え）の案は、`launch: false` の見出しと `path` での入れ子・`lead` で形を変えて入った。足す時は上の「`version: 1` の間の変え方」に従う。
