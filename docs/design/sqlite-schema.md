# SQLite スキーマ設計

> ccs v0.2.0 — 状態キャッシュDBのテーブル仕様

## 配置

- パス: `~/.cache/ccs/state.db`
- XDG Base Directory 準拠（`$XDG_CACHE_HOME` があればそちら優先）
- 削除しても設定（`~/.config/ccs/repos.yml`）は無事、次回起動で再構築

## 設計方針

- **Write-Once-per-Scan**: 走査1回につきトランザクション1つ、原子的に更新
- **Foreign Key**: 有効化（`PRAGMA foreign_keys = ON`）
- **WAL モード**: 並列読み書き向上（`PRAGMA journal_mode = WAL`）
- **マイグレーション**: `schema_version` テーブルで管理。後方互換壊す時は version++

## テーブル一覧

| テーブル | 役割 | 行数イメージ |
|---|---|---|
| `schema_version` | DBマイグレーション管理 | 1 |
| `repos` | リポジトリ定義のキャッシュ | 〜50 |
| `repo_stats` | 走査で得た状態バッジ用データ | 〜50（repos と1:1） |
| `sessions` | Claude Code セッション要約キャッシュ | 〜5,000 |
| `handoff_files` | handoff/ 配下のファイル一覧（プレビュー用） | 〜500 |
| `pending_items` | pendings/ 配下のファイル一覧（プレビュー用） | 〜500 |

## DDL

### schema_version

```sql
CREATE TABLE schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### repos

```sql
CREATE TABLE repos (
  name            TEXT PRIMARY KEY,           -- repos.yml の name
  path            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  command         TEXT NOT NULL DEFAULT '',   -- 空なら defaults/CCS_CMD
  cwd             TEXT,                       -- NULL なら path と同じ
  tags_json       TEXT NOT NULL DEFAULT '[]', -- JSON array
  icon            TEXT NOT NULL DEFAULT '📁',
  disabled        INTEGER NOT NULL DEFAULT 0, -- 0/1
  scan_enabled    INTEGER NOT NULL DEFAULT 1,
  custom_json     TEXT NOT NULL DEFAULT '{}', -- repos.yml の custom: をそのまま JSON 保存
  config_hash     TEXT NOT NULL,              -- repos.yml の該当行のSHA256
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_repos_path ON repos(path);
CREATE INDEX idx_repos_disabled ON repos(disabled);
```

### repo_stats

```sql
CREATE TABLE repo_stats (
  name                  TEXT PRIMARY KEY,
  -- Git
  is_git                INTEGER NOT NULL DEFAULT 0,
  branch                TEXT,
  last_commit_hash      TEXT,
  last_commit_subject   TEXT,
  last_commit_at        TEXT,                 -- ISO 8601
  uncommitted_files     INTEGER NOT NULL DEFAULT 0,
  uncommitted_insertions INTEGER NOT NULL DEFAULT 0,
  uncommitted_deletions  INTEGER NOT NULL DEFAULT 0,
  -- Claude Code workspace
  handoff_count         INTEGER NOT NULL DEFAULT 0,
  pending_count         INTEGER NOT NULL DEFAULT 0,
  claude_room_latest    TEXT,                 -- 最新エントリのパス
  claude_room_latest_at TEXT,
  session_count_total   INTEGER NOT NULL DEFAULT 0,
  session_last_at       TEXT,                 -- 最後のセッション日時
  -- Scan metadata
  scanned_at            TEXT NOT NULL DEFAULT (datetime('now')),
  scan_duration_ms      INTEGER NOT NULL DEFAULT 0,
  scan_error            TEXT,                 -- エラー時のメッセージ
  FOREIGN KEY (name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX idx_repo_stats_scanned_at ON repo_stats(scanned_at);
CREATE INDEX idx_repo_stats_session_last_at ON repo_stats(session_last_at DESC);
```

### sessions

```sql
CREATE TABLE sessions (
  uuid            TEXT PRIMARY KEY,
  repo_name       TEXT,                       -- repos.name との紐付け（NULLable）
  project_dir     TEXT NOT NULL,              -- ~/.claude/projects/<encoded>
  cwd             TEXT NOT NULL,              -- セッションの作業ディレクトリ
  branch          TEXT,
  started_at      TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  topic           TEXT,                       -- 先頭user発言のダイジェスト（1行）
  summary         TEXT,                       -- <!-- ECC:SUMMARY --> あれば抽出
  jsonl_size      INTEGER NOT NULL DEFAULT 0,
  jsonl_mtime     TEXT NOT NULL,              -- JSONLファイルの更新時刻（キャッシュ無効化用）
  indexed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE SET NULL
);

CREATE INDEX idx_sessions_repo ON sessions(repo_name, last_activity_at DESC);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_cwd ON sessions(cwd);
```

### handoff_files / pending_items

プレビューペインで先頭3件を素早く出すための補助テーブル。

```sql
CREATE TABLE handoff_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name   TEXT NOT NULL,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       TEXT NOT NULL,
  first_line  TEXT,                           -- プレビュー用に先頭100文字
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX idx_handoff_repo ON handoff_files(repo_name, mtime DESC);

CREATE TABLE pending_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name   TEXT NOT NULL,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       TEXT NOT NULL,
  first_line  TEXT,
  FOREIGN KEY (repo_name) REFERENCES repos(name) ON DELETE CASCADE
);

CREATE INDEX idx_pending_repo ON pending_items(repo_name, mtime DESC);
```

## 走査フロー

```
ccs 起動
  ├─ repos.yml 読み込み
  ├─ repos テーブルと差分比較（config_hash） → 変更分だけ UPSERT
  ├─ 全リポジトリを並列走査（Promise.all, 同時実行上限=8）
  │    各リポジトリで:
  │      - git rev-parse --is-inside-work-tree
  │      - git branch --show-current
  │      - git log -1 --format=...
  │      - git diff --shortstat
  │      - ls handoff/ pendings/ claude-room/
  │    → repo_stats に UPSERT
  ├─ ~/.claude/projects/ 走査
  │    JSONL mtime と sessions.jsonl_mtime 比較 → 変更分だけ再パース
  │    → sessions に UPSERT
  └─ fzf 起動（DB読むだけ、高速）
```

## マイグレーション戦略

```typescript
const migrations = [
  { version: 1, up: `CREATE TABLE schema_version (...); ...初期DDL...` },
  // v0.3.0 以降で version: 2, 3, ... を追加
];

function migrate(db: Database) {
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v ?? 0;
  for (const m of migrations.filter(m => m.version > current)) {
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}
```

テーブル未存在時は `schema_version` 作成 → migration version 0 扱いで全マイグレーション実行。

## キャッシュ無効化ルール

| データ | 無効化トリガ |
|---|---|
| `repos` | `repos.yml` のファイルmtime変更 |
| `repo_stats` | TTL 10秒 or ユーザー明示リフレッシュ（Ctrl-R） |
| `sessions` | JSONLファイルのmtime変更 |
| `handoff_files` / `pending_items` | ディレクトリmtime変更 |

`ccs --refresh` で全テーブル強制再走査。

## ライブラリ選定

**better-sqlite3** を採用:
- 同期API（ccsのCLI用途にマッチ）
- プリペアドステートメント・トランザクション対応
- ネイティブバインディング（高速）
- macOS/Linux 両対応

依存: `package.json` に `better-sqlite3 ^11.3.0` を追加。`install.sh --with-deps` で `npm install`（プロジェクトローカル）を実行、または `npm install` を手動で。グローバルインストール（`-g`）は推奨しない。

## 想定サイズ

- DB本体: 1〜5MB（50リポジトリ、5,000セッションで試算）
- メモリ: 走査中でも 50MB 未満
- 初回走査時間: 10リポジトリで 〜2秒、50リポジトリで 〜5秒

## セキュリティ

- `path` は `$HOME` 配下チェック（ccr v0.1.3 の既存ロジック維持）
- `first_line` にシークレットパターン検出時は `[REDACTED]` で置換
- SQL は全てプリペアドステートメント（better-sqlite3 の prepare API）
- DBファイル権限: `0600`（ユーザーのみ読み書き）
