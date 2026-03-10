# Claude Code Recall - ccr

A fast, fzf-powered session picker for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Search, preview, and resume any past conversation from any directory.

fzfを使ったClaude Codeセッションピッカー。全プロジェクトの過去の会話を検索・プレビュー・再開できます。

## Why? / なぜ？

`claude --resume` only shows sessions from the current directory and provides no search. With dozens of projects and sessions, finding the right one is painful.

`claude --resume` はカレントディレクトリのセッションしか表示せず、検索もできません。プロジェクトやセッションが増えると、目的の会話を探すのが大変です。

**ccr** solves this: / **ccr** はこれを解決します：

- Fuzzy search across all projects by name, timestamp, or conversation content / 全プロジェクト横断のファジー検索（名前・日時・会話内容）
- Live preview of conversation history in the side pane / サイドペインで会話履歴をリアルタイムプレビュー
- Resume with a single Enter key — in the correct directory / Enterキー1つで正しいディレクトリに移動して再開
- Cross-platform clipboard support (macOS, Linux X11, Wayland) / クロスプラットフォームのクリップボード対応

## Demo

```
$ ccr
ccr> learning                          ┃ ━━━ Session Info ━━━
                                       ┃ 📁 ~/Workspace/LEARNING_SERIES
  ~/Workspace/LEARNING_SERIES  1h ago  ┃ 🌿 feature/auth
    Implement the auth module...       ┃ 📌 Claude 2.1.72
  ~/Workspace/LEARNING_SERIES  4h ago  ┃ 💬 24 messages
    Fix the client complaints...       ┃ ━━━ Conversation ━━━
  ~/Workspace/LEARNING_SERIES  1d ago  ┃
    Review the API design...           ┃ 👤 Fix the client complaints...
> ~/Workspace/LEARNING_SERIES  2d ago  ┃ 🤖 Let me check the issue...
    Set up the project structure...    ┃
```

## Install / インストール

### Prerequisites / 前提条件

- [fzf](https://github.com/junegunn/fzf) - fuzzy finder / ファジーファインダー
- [tsx](https://github.com/privatenumber/tsx) - TypeScript runner / TypeScript実行環境 (`npm install -g tsx`)
- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### Quick install / クイックインストール

```bash
git clone https://github.com/indigo-gr/claude-code-recall.git
cd claude-code-recall
bash install.sh
```

This copies the scripts to `~/.claude/scripts/` and guides you through PATH setup.

スクリプトを `~/.claude/scripts/` にコピーし、PATHの設定をガイドします。

### Manual install / 手動インストール

```bash
# Copy files / ファイルをコピー
cp bin/* ~/.claude/scripts/
chmod +x ~/.claude/scripts/ccr ~/.claude/scripts/ccr-delete.sh

# Add to PATH (in ~/.zshrc or ~/.bashrc)
# PATHに追加（~/.zshrc または ~/.bashrc に記述）
export PATH="$HOME/.claude/scripts:$PATH"
```

## Usage / 使い方

```bash
ccr                    # Search all sessions across all projects / 全セッションを検索
ccr .                  # Only sessions from current directory / カレントディレクトリのみ
ccr --model opus       # Pass options through to claude / claudeにオプションを渡す
```

### Keyboard Controls / キーボード操作

| Key / キー | Action / 動作 |
|---|---|
| Enter | Resume selected session / 選択したセッションを再開 |
| Ctrl-Y | Copy full resume command to clipboard / resumeコマンド全体をクリップボードにコピー |
| Ctrl-I | Copy session ID only / セッションIDのみコピー |
| Ctrl-D | Delete session (with confirmation) / セッションを削除（確認あり） |
| Esc / Ctrl-C | Cancel / キャンセル |

### Environment Variables / 環境変数

| Variable / 変数 | Default / デフォルト | Description / 説明 |
|---|---|---|
| `CCR_CMD` | `claude` | Command to run Claude Code. Set to your wrapper if needed. / Claude Codeの実行コマンド。ラッパーを使う場合に設定。 |

#### Example: 1Password integration / 例：1Password連携

If you use 1Password CLI to inject secrets: / 1Password CLIでシークレットを注入する場合：

```bash
# In ~/.zshrc
export CCR_CMD="opr claude"
```

> **Note / 注意**: Only set `CCR_CMD` to commands you trust. The value is split by whitespace and executed directly. / `CCR_CMD`には信頼できるコマンドのみ設定してください。値はスペースで分割されそのまま実行されます。

## How it works / 仕組み

```
ccr (shell) ──> ccr-parse.ts ──> fzf ──> claude --resume <id>
                     │                      │
                     │                      ├── ccr-preview.ts (side pane)
                     │                      └── ccr-delete.sh  (Ctrl-D)
                     │
                     └── reads ~/.claude/projects/*/*.jsonl
```

1. **ccr-parse.ts** scans `~/.claude/projects/` for session files, extracts metadata (project, timestamp, first message), and outputs fzf-compatible tab-separated lines / `~/.claude/projects/` のセッションファイルをスキャンし、メタデータを抽出してfzf用のタブ区切り行を出力
2. **fzf** provides fuzzy search, preview pane, and keyboard bindings / ファジー検索、プレビューペイン、キーバインドを提供
3. **ccr-preview.ts** renders conversation history for the selected session / 選択されたセッションの会話履歴を表示
4. On Enter, **ccr** changes to the session's working directory and runs `claude --resume` / Enterで作業ディレクトリに移動し `claude --resume` を実行

## Security / セキュリティ

- Session IDs are validated as UUID format before any shell execution / セッションIDはシェル実行前にUUID形式を検証
- Working directory paths are validated to be under `$HOME` / 作業ディレクトリは `$HOME` 配下であることを検証
- Known secret patterns (API keys, tokens) are masked in preview output / 既知のシークレットパターン（APIキー・トークン等）をプレビューでマスク
- No `eval` usage — all commands are executed directly / `eval` 不使用 — 全コマンドを直接実行
- File size limits (50MB) prevent memory exhaustion / ファイルサイズ制限（50MB）でメモリ枯渇を防止

## Platform Support / プラットフォーム対応

| Platform / 環境 | Clipboard / クリップボード | Status / 状態 |
|---|---|---|
| macOS | pbcopy | Fully supported / 完全対応 |
| Linux (X11) | xclip / xsel | Supported / 対応 |
| Linux (Wayland) | wl-copy | Supported / 対応 |
| Linux (no display) | — | Works without clipboard features / クリップボード以外は動作 |

## Inspired by / インスパイア元

- [ccresume](https://github.com/sasazame/ccresume) by @sasazame — React Ink-based session picker
- [ccraw](https://github.com/hiragram/ccraw) by @hiragram — conversation log viewer
- [ccusage](https://github.com/ryoppippi/ccusage) by @ryoppippi — usage tracker

## License / ライセンス

MIT. See [LICENSE](LICENSE).
