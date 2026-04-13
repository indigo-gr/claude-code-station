# repos.yml スキーマ設計

> ccs v0.2.0 — リポジトリ定義ファイルのフォーマット仕様

## 配置

- パス: `~/.config/ccs/repos.yml`
- 初回 `ccs` 実行時、存在しなければテンプレートと `README.md` を自動生成

## トップレベル構造

```yaml
version: 1                    # スキーマバージョン（必須、現在 1）
defaults:                     # 全リポジトリのデフォルト値（任意）
  command: "claude"
repos:                        # リポジトリ定義配列（必須、1件以上）
  - name: ClaudeCode
    path: ~/.claude
    description: Claude Code設定
    ...
```

## `repos[]` エントリのフィールド

| フィールド | 型 | 必須 | デフォルト | 説明 |
|---|---|:---:|---|---|
| `name` | string | ✅ | — | 表示名（fzf行に出る、日本語可） |
| `path` | string | ✅* | — | リポジトリのフルパス。`~` 展開あり |
| `description` | string | — | `""` | プレビュー補助情報 |
| `command` | string | — | `defaults.command` or `claude` | 起動コマンド。特殊な場合は丸ごと上書き |
| `cwd` | string | — | `path` | 起動時の作業ディレクトリ（通常は `path` と同じ） |
| `tags` | string[] | — | `[]` | 絞り込み用タグ（例: `["work", "ils"]`） |
| `disabled` | bool | — | `false` | true ならリストから除外 |
| `scan` | bool | — | `true` | false なら状態走査をスキップ（非git含む） |
| `icon` | string | — | `📁` | 表示アイコン（絵文字1文字推奨） |
| `custom` | object | — | `{}` | 外部システム連携情報。任意のキー/値ペア（後述） |

\* `path` は `command` に `cwd:` が含まれる特殊ケースを除き必須。

### `custom` フィールド（外部システム連携）

ユーザー固有の連携情報を自由に保持できる。プレビューペインで「連携バッジ」として表示され、未入力なら表示しない。

**よくある例:**

```yaml
repos:
  - name: ILS事業部
    path: ~/pj/ILS
    custom:
      plane_project_id: "ed1ec22d-xxxx"
      plane_url: "https://plane.example.com/ils"
      attio_workspace: "ils-corp"
      notion_db: "abc123"
      linear_team: "ILS"
      slack_channel: "#ils-dev"
      figma_file: "https://www.figma.com/file/xxx"
```

**プレビュー表示例:**

```
🔗 Integrations
   Plane:    ✅ ed1ec22d-xxxx
   Attio:    ✅ ils-corp
   Notion:   ✅ abc123
   Slack:    ✅ #ils-dev
```

**仕様:**
- `custom` の値は文字列・数値・bool・配列・ネストobject 何でも可（JSON保存）
- 既知キー（後述の組み込み連携）は専用の表示ロジックでバッジ化
- 未知キーは `key: value` の形でそのまま表示

**組み込み既知キー（v0.2.0）:**

| キー | 表示 | 備考 |
|---|---|---|
| `plane_project_id` | Plane バッジ | `plane_url` あればURL併記 |
| `plane_url` | — | バッジリンク用 |
| `attio_workspace` | Attio バッジ | |
| `notion_db` | Notion バッジ | |
| `linear_team` | Linear バッジ | |
| `slack_channel` | Slack バッジ | `#` 自動付与 |
| `github_repo` | GitHub バッジ | `owner/repo` 形式 |
| `figma_file` | Figma バッジ | URL でも ID でも可 |

**未知キーの扱い:**
- そのまま `key: value` 形式で「Other Integrations」セクションに表示
- 将来需要が高まったキーは組み込み既知キーに昇格

**バリデーション:**
- `custom` がobjectでない → エラー
- 中身の型は問わない（ユーザー責任）
- シークレット混入注意（APIキー等は書かない、URL/IDのみ推奨）

## バリデーションルール

| ルール | エラー例 |
|---|---|
| `version` は整数、現在サポートは `1` のみ | `unsupported version: 2` |
| `name` はユニーク | `duplicate name: "ClaudeCode"` |
| `path` 存在チェック | `path not found: ~/pj/foo`（警告扱い、disabled 推奨） |
| `path` は `$HOME` 配下必須 | `path outside $HOME: /etc/foo`（セキュリティ） |
| `name` に `\t \n \\` 不可 | `invalid chars in name` |
| `command` に shell metachar 不可 (`;&\|<>$\`"'\\` + 制御文字) | `command for repo at index 0 contains shell metacharacter(s): "claude;..."` |
| `disabled: true` の場合 scan/command 無視 | — |

## 例1: シンプル

```yaml
version: 1
repos:
  - name: ClaudeCode
    path: ~/.claude
    description: Claude Code設定
  - name: ILS事業部
    path: ~/pj/ILS
    description: ILS本番リポジトリ
    tags: [work]
```

## 例2: 特殊コマンド対応（Strapi起動など）

```yaml
version: 1
defaults:
  command: "claude"
repos:
  - name: ClaudeCode
    path: ~/.claude

  - name: Strapi (dev server)
    path: ~/Website/strapi-cms
    command: "npm run develop"
    icon: "🚀"
    scan: false                # Claude起動じゃないので状態走査不要
    tags: [dev-server]

  - name: PRIVATE
    path: ~/Workspace/private
    tags: [personal]
    disabled: true             # 今は使わない
```

## 例3: 1Passwordラッパー付き（CCR_CMD互換）

```yaml
version: 1
defaults:
  command: "opr claude"        # 全リポジトリで opr ラッパー経由
repos:
  - name: SaaSHub
    path: ~/Workspace/ExecutiveAssistant
  - name: ILS事業部
    path: ~/pj/ILS
```

## 環境変数との優先順位

`repos[].command` > `defaults.command` > `CCS_CMD` 環境変数 > `"claude"`

**設計意図**: per-repo の明示的指定（`command:` フィールド）が常に最優先。`CCS_CMD` env は「全リポジトリ共通のラッパー（例: `opr claude`）を `defaults.command` 未指定時に注入したい」用途のフォールバックとして機能する。Strapi 起動のような特殊コマンドが env で踏み潰されるのを防ぐため、env を最弱に置く。

ccr v0.1.3 の `CCR_CMD` は `CCS_CMD` にリネーム（移行ガイドで明記、CCR_CMD指定時は警告ログ + 暫定honor）。

**Security note**: `CCS_CMD` / `CCR_CMD` env values are subject to the same shell metacharacter rejection as `command:` in YAML. If env-sourced value contains any forbidden character, `loadConfig()` throws `ConfigError` before launch.

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
        "command": { "type": "string" }
      }
    },
    "repos": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "pattern": "^[^\\t\\n\\\\]+$" },
          "path": { "type": "string" },
          "description": { "type": "string" },
          "command": { "type": "string" },
          "cwd": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } },
          "disabled": { "type": "boolean" },
          "scan": { "type": "boolean" },
          "icon": { "type": "string", "maxLength": 4 },
          "custom": { "type": "object", "additionalProperties": true }
        }
      }
    }
  }
}
```

## 将来拡張（v0.3.0以降・未実装）

- `group`: リポジトリのグループ化（fzfヘッダーでグループ切替）
- `env`: リポジトリ毎の環境変数注入
- `post_launch`: 起動後に実行するフック
- `priority`: ソート重み（上に出したいリポジトリ）
