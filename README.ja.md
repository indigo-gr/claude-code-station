# Claude Code Station — ccs

[English](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24.12+](https://img.shields.io/badge/node-%3E%3D24.12-brightgreen.svg)](https://nodejs.org/)

複数のプロジェクトをまたいで使う、[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 用の fzf の起動＆セッション再開ランチャー。プロジェクトを選んで新しく起動するのも、過去のセッションを再開するのも、手元のすべてのリポを並べた 1 つのあいまい検索（fzf）から一発で。

---

## v0.2.0 の新機能

- **混在表示のランチャー** — 新規起動の行（NEW）と過去のセッションの再開の行（RESUME）を同じ fzf の一覧に並べる
- **リポジトリの状態をひと目で** — git の状態・handoff/・pendings/・連携先を右の欄のカードに出す
- **SQLite の状態キャッシュ** — `~/.cache/ccs/state.db` で、たくさんのリポの一覧もすぐ開く
- **リポジトリごとの連携情報** — Plane・Attio・Notion・Linear・Slack・GitHub・Figma（ほか任意のカスタムキー）
- **改名**: `claude-code-recall`（ccr）→ `claude-code-station`（ccs）。移行は下の[移行の節](#ccr-v01x-からの移行)を参照。

---

## なぜ？

`claude --resume` はカレントディレクトリのセッションしか出さず、検索もできない。プロジェクトが増えると、`cd` で動き回らずに正しいリポで**新しく起動**したい時もあり、「新規起動したいリポ」も「続きをやりたいセッション」も、探すのが手間になる。

**ccs** が両方まとめて解決する:

- 全プロジェクトのあいまい検索（リポ名・セッションの題・日時・中身）
- 混在の一覧: 新規起動の行（`NEW`）と再開の行（`RESUME`）を同じ一覧に並べる
- ライブプレビュー — git の状態・handoff/pendings のまとめ・連携先・会話の冒頭
- Enter 1 回で、正しい cwd・正しいコマンドで起動

---

## インストール

初めての人はこの節だけで、前提を確かめる → npm で入れる → プロジェクトを登録する → `ccs` を開く、まで進める。

### 1. 前提を確かめる

| 道具 | 確かめ方 | 要る物 |
|---|---|---|
| [Node.js](https://nodejs.org/) | `node -v` | **24.12 以上**（24.12.0 かそれより新しい物） |
| [fzf](https://github.com/junegunn/fzf) | `fzf --version` | **0.61.0 以上** |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) の CLI | `claude --version` | 入っていればよい |

- **fzf のバージョン** — 0.61.0 が下限（一覧が `--style`・枠のラベル・`--ghost` を使うため）。古い fzf では一覧を開かずに 1 行で知らせる。`ccs doctor` では `fzf_too_old` と出る。
- **TypeScript を動かす道具は要らない** — npm の物は作り済みの JavaScript で動く。checkout とコピーインストールは、Node が `.ts` のソースをそのまま動かす（型の除去・Node 24.12 以上）。

OS ごと:

- **macOS**（Apple silicon・Intel）— `brew install node fzf`。Node は [nodejs.org](https://nodejs.org/) やバージョン管理の道具（nvm・fnm・Volta）から入れてもよい。
- **Linux**（x64・arm64。glibc のディストリビューションと、Alpine など musl の物）— Node は [nodejs.org](https://nodejs.org/)・ディストリビューション・バージョン管理の道具から入れる。`apt` などのパッケージ管理の fzf は 0.61 より古いことが多い（`fzf --version` で見る）。古ければ fzf のリポジトリから入れる: `git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf && ~/.fzf/install`。
- **Windows** — **WSL**（WSL の中の Ubuntu かほかの Linux）を使い、その中で Linux の手順に従う。ccs は bash のスクリプトで、データベースの部品（`better-sqlite3`）も配布済みのファイルで動くと分かっているのは macOS と Linux だけ。Claude Code も WSL の中で使う（セッションのパスが合うように）。

`better-sqlite3` は macOS と Linux（glibc・musl）の x64 と arm64 向けに作り済みの部品を配っている。それ以外の環境では npm がソースから作る（Python・make・C++ のコンパイラが要る・未確認）。

### 2. 入れる

```bash
npm install -g @indigo-gr/claude-code-station
ccs --version        # ccs v0.x.y
ccs doctor           # first line: "ccs doctor: ccs works (ok)"
```

[npm レジストリ](https://www.npmjs.com/package/@indigo-gr/claude-code-station)から入れる。実行に要る依存（`better-sqlite3`・`yaml`）は全部入っていて、`ccs` は npm のグローバルの bin を通って PATH に乗る。`ccs doctor` は Node・fzf・`claude`・`repos.yml`・キャッシュを確かめ、足りない物を名指しする。入れた直後は 3 の前なので、`config` と `cache` が `warn`（`config_missing`・`cache_missing`）になる。それでよい。

### 3. プロジェクトを登録して開く

```bash
ccs init --auto-discover          # pick repos with TAB, add them with Enter
ccs repo remove "Example Project" # drop the template entry
ccs                               # the picker opens
```

1. `ccs init --auto-discover` は `~/.config/ccs/repos.yml` を作り、`$HOME` の下（深さ 5。`--depth N` で変えられる）からまだ登録していない git のリポを探して fzf を開く。**TAB** で選び、**Enter** で選んだ物を足し、**Esc** でやめる。
2. 新しいファイルには見本の項目 `Example Project` が入っている。そのフォルダは無いので、`path not found` の警告が出る。自分の項目を足したら外す。
3. `ccs` で一覧が開く。プロジェクトの上で Enter を押すとそこで Claude Code を新しく起動し、前のセッションの上で Enter を押すと再開する。キーとフラグは[使い方](#使い方)を参照。

後からプロジェクトを足す時は、`ccs repo add ~/path/to/folder`・`ccs init --auto-discover` をもう一度・`repos.yml` を直に書く（[設定](#設定)）、のどれか。

### 4. Claude Code の skill（任意）

パッケージに Claude Code の skill `ccs` が入っている。入れると、Claude Code が ccs の使い方を答え、`repos.yml` へのプロジェクトの登録や連携の欄の書き足しを代わりにしてくれる（「~/projects/my-app を ccs に足して」「my-app に GitHub のリポを書いて」など）。`~/.claude` には自動で入らないので、自分でコピーする:

```bash
mkdir -p ~/.claude/skills
cp -R "$(npm root -g)/@indigo-gr/claude-code-station/docs/skills/ccs" ~/.claude/skills/
```

- コピーの後に Claude Code のセッションを新しく開く（skill を読み込ませるため）。
- **ccs を上げたら、同じ `cp` をもう一度打つ** — コピーはパッケージに付いてこない。
- 消す時: `rm -r ~/.claude/skills/ccs`
- 1 つのプロジェクトだけで使う時は、代わりにそのプロジェクトの `.claude/skills/` にコピーする。

### スコープなしの旧パッケージからの入れ替え

0.3.1 までは、スコープなしの `claude-code-station` で出していた（今は deprecate 済み）。`npm ls -g claude-code-station` に出たら一度だけ入れ替える。`ccs` のコマンド・`~/.config/ccs/repos.yml`・キャッシュはそのまま残る。

```bash
npm uninstall -g claude-code-station
npm install -g @indigo-gr/claude-code-station
```

### 上げ方

```bash
npm install -g @indigo-gr/claude-code-station@latest
ccs --version
```

（`npm update -g @indigo-gr/claude-code-station` でもよい。）新しいバージョンが出ると ccs が知らせる（[更新の確認](#更新の確認)）。`repos.yml` とキャッシュはそのまま。skill をコピーしていたら、もう一度コピーする（4）。Node のメジャーバージョンを上げたら、ccs を入れ直す（`better-sqlite3` を新しい Node に合わせるため）。

### 消し方

```bash
npm uninstall -g @indigo-gr/claude-code-station
rm -r ~/.claude/skills/ccs     # if you copied the skill
rm -r ~/.cache/ccs             # the cache (rebuilt if you install again)
rm -r ~/.config/ccs            # your project list — only if you no longer want it
```

`XDG_CACHE_HOME`・`XDG_CONFIG_HOME` を設定していれば、下の 2 つのフォルダはその下にある。Claude Code のセッション（`~/.claude/projects/`）は ccs の物ではないので残る。

### よくある詰まり

| 症状 | 対処 |
|---|---|
| `ccs: command not found` | npm のグローバルの bin が `PATH` に無い。`export PATH="$(npm prefix -g)/bin:$PATH"` を `~/.zshrc` か `~/.bashrc` に足して、端末を開き直す。 |
| `npm install -g` で `EACCES`・permission denied | npm のグローバルの置き場が root の物になっている。`sudo` を使わず、バージョン管理の道具（nvm・fnm・Volta）か Homebrew で Node を入れる。 |
| 入れる時に `EEXIST` … `ccs` | スコープなしの旧パッケージがまだ `ccs` を持っている。[スコープなしの旧パッケージからの入れ替え](#スコープなしの旧パッケージからの入れ替え)を参照。 |
| `ccs doctor` で `fzf_too_old`、または見出しの上で Enter を押すと ccs が閉じる | fzf が ccs の要る物より古い。新しい物を入れる（1）。 |
| `node_too_old`・`EBADENGINE`・`better-sqlite3` のエラー | Node が 24.12.0 より古いか、ccs を入れた後に Node を上げた。Node を 24.12.0 以上にして、`npm install -g @indigo-gr/claude-code-station` をもう一度打つ。 |
| `better-sqlite3` がコンパイルを始める（`gyp`・`make`） | この環境向けの作り済みの部品が無い（Windows で直に入れた時など）。macOS・Linux・WSL を使う。 |
| 一覧が空、または `Example Project` だけ | まだプロジェクトを登録していない。`ccs init --auto-discover` を打つ（3）。 |
| `path not found` の警告 | 項目のフォルダが動いたか消えた。`repos.yml` の `path` を直すか、`ccs repo remove NAME` で外すか、`disabled: true` を付ける。 |
| `repos.yml` についての文を出して ccs が止まる | 文が直すキーと項目を名指しする。そこを直す。ccs のコマンドが書いた直後なら、`repos.yml.bak` を戻してもよい。`ccs doctor` も同じ点検をする。 |

スクリプト向けには、`ccs doctor --json` が同じ点検を語で返す（[下](#スクリプトや道具から呼ぶ)）。

### ほかの入れ方

**勧める入れ方は npm**（上の 2）。GitHub のリポに載るのは npm と同じ出したバージョンだけ（未リリースの物は無い）なので、GitHub から入れても新しい物は入らず、入れるのが遅くなるだけ。

#### GitHub から

```bash
npm install -g --allow-git=root github:indigo-gr/claude-code-station
```

npm と同じ出したバージョンが入る。上げる時は npm のコマンド（`npm install -g @indigo-gr/claude-code-station`）で入れ直す（置き換わる）。

#### コピーインストール（checkout）

```bash
git clone https://github.com/indigo-gr/claude-code-station.git
cd claude-code-station
npm install
./install.sh
```

`install.sh --with-deps` で `npm install` も install.sh に任せられる。`install.sh` は実行に要る依存を解決するため、checkout の `node_modules` をインストール先に symlink する（checkout は残しておくこと）。コピーした `.ts` は Node がそのまま動かす（24.12.0 以上）。`tsx` は要らない。

#### 手動インストール

```bash
npm install
cp bin/ccs bin/ccs-*.ts bin/ccs-*.sh bin/ccs-lang-*.txt ~/.claude/scripts/
chmod +x ~/.claude/scripts/ccs ~/.claude/scripts/ccs-delete.sh

# Add to ~/.zshrc or ~/.bashrc
export PATH="$PATH:$HOME/.claude/scripts"
```

---

## クイックスタート

[入れた](#インストール)後:

1. `ccs init --auto-discover` — 登録するリポを fzf で選ぶ（TAB で選ぶ・外す、Enter で足す）。
2. または `~/.config/ccs/repos.yml` を手で書く（`ccs init` でひな形を作る。[設定](#設定)を参照）。`ccs repo add PATH` でも足せる。
3. `ccs` を打つ — 登録したリポと過去のセッションを並べた fzf が開く。

```
──────── プロジェクト ────────
📁 ClaudeCode      Claude Code設定
📁 My Project      Main development repository
──────── 前の会話のつづき ────────
💬 2 時間前    My Project  Fix the billing webhook…
💬 きのう      My Project  Plane work item sync…
```

一覧の枠には 4 つのラベル（Claude Code をはじめる / さがす / えらぶ / 中身）が付き、右の欄のカードが選んでいる行を説明する（[一覧の見た目](#一覧の見た目)を参照）。画面の言葉は日本語と英語で切り替わる（[言語](#言語)）。

---

## 設定

スキーマの全体: [`docs/design/repos-yml-schema.md`](docs/design/repos-yml-schema.md)

### 最小構成

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

### 連携情報付き

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

知っているキー: `plane_project_id`・`plane_url`・`attio_workspace`・`notion_db`・`linear_team`・`slack_channel`・`github_repo`・`figma_file`。知らないキーは "Other Integrations" の下にそのまま出す。

### 特殊コマンド（CMS の開発サーバー）

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

優先の順: `repos[].command` > `defaults.command` > `$CCS_CMD` > `"claude"`。

### グループ見出しと表示名

中の子をまとめるだけで、自分は起動しない親フォルダには `launch: false` を付ける。子は `path` で自動的にその下に並ぶ（追加のキーは要らない）。`label` で、どの項目にも `name` と別の表示名を付けられる。

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `launch` | bool | `true` | `false` で表示だけの**グループ見出し**になる。子をその下に並べるが、Enter で起動しない（`command`/`cwd` は使われない）。`path` は必須（どのリポがこの見出しの下に並ぶかを決める）。本物の真偽値で書く（引用符付きの `"false"` はエラー）。 |
| `lead` | bool | `false` | `true` でグループの統括（director・取りまとめ役）。名前の順でなく**兄弟の中で一番上**に並び、👑 付きで出る。本物の真偽値で書く。 |
| `label` | string | `""`（`name` を出す） | リポの行とプレビューの見出しに、`name` の代わりに出す名前。一意のキーは `name` のまま（過去のセッションの行も `name` で出る）なので、同じ `label` を複数の項目に付けてもよい。表示専用で、制御文字は取り除かれる。 |

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
──────── グループ ────────
🎬 Studio          Production team         ← header: Enter does nothing
   📱 App team     Mobile app/  （Studio）
   🎬 Studio       Coordination hq/
   🌐 Web team     Website web/  （Studio）
```

### ほかの道具のグループ定義（`groups_dir`）

フォルダがばらばらのプロジェクトを、ほかの道具が持つグループの定義ファイルに従って、1 つの見出しの下に並べる。書かなければ使わない。

```yaml
defaults:
  groups_dir: ~/tools/groups   # a folder of *.json files; must be under $HOME
```

そのフォルダの直下の `*.json`（名前の順・200 個まで・1 つ 256 KB まで）から 5 つのキーだけを読む。ccs はこのフォルダに何も書かない:

```json
{ "version": 1, "id": "team-x", "label": "Team X", "kind": "logical",
  "members": [{ "path": "~/x/beta" }, { "path": "~/w/alpha" }] }
```

- 使うのは `version: 1` と `kind: "logical"` だけ。`physical` のグループは読まない（そのプロジェクトはもう `path` の入れ子＝`launch: false` の見出しで並ぶため）。
- `members[].path`（`~` は展開する）を `repos.yml` の項目の `path` と比べ、当たった項目をファイルの順に見出しの下に並べる（名前とアイコンは `repos.yml` の物）。`repos.yml` に無いメンバーは出さない。1 つのプロジェクトが、自分の場所と見出しの下の両方に出ることがある。
- これらの見出しは `launch: false` の見出しの後に並ぶ。見出しの上で Enter を押しても何もしない。
- 壊れたファイルや知らない形のファイルは飛ばす（一覧は止めない）。`ccs doctor` がその数を出し（`groups_dir`: `group_files_skipped`）、`ccs list --json` は `groups[]` でグループを返す。フォルダは走査の時に読むので、変更は次の走査（`ccs --refresh` か `Ctrl-R`）の後に出る。

### 一覧の見た目

全画面・角の丸い枠・使う言語（日本語か英語。[言語](#言語)を参照）のやさしい言葉の見た目で開く。端末に慣れていない人にも使えるように作ってある。v0.6.0 からはこの見た目だけ（前の `classic` の見た目・`--ui=`・`CCS_UI` はなくなった）。`repos.yml` の `defaults.ui: simple` はそのまま読む（何も変わらない）。`defaults.ui: classic` は 1 行の警告を出して、この見た目で開く。

- **並び** — グループ（`launch: false` の見出しと、その中の全部）→ ほかのプロジェクト → 前の会話の順で、それぞれ見出しの行の下に並ぶ。入れ子の項目は字下げし、グループの中の行の末尾にはグループの名前が薄く出る。だから**グループの名前を打つと、そのグループとそのプロジェクト、その会話だけに絞れる**。打っている間も、この並びは変わらない。
- **統括が先** — `lead: true` の項目（グループの統括・取りまとめ役）は、グループの中の一番上に 👑 付きで出る。
- **行** — 名前と説明だけ。ブランチ・まだ commit していない変更・申し送り・連携先は右の欄の「カード」に出る。時刻は話し言葉のように出る（たった今・3 時間前・きのう・3 日前・10月25日）。
- **案内** — 案内の行には Enter / ↑↓ / Esc だけを出す（`^Y` `^I` `^R` `^D` もそのまま使える）。見出し・グループ見出し・空の結果の上で Enter を押すと、開かなかった理由が出る。Esc の後は戻り方を出す。開く物が何も無い時は、空の一覧の代わりにプロジェクトの足し方を出す。`repos.yml` が壊れている時は枠でそれを知らせ、一覧を閉じた後に中身を説明する。
- **狭い端末** — 横がおよそ 100 桁より狭いと、右の欄が一覧の下に回る（80x24 でも一覧の行は 8 行残る）。

画面の一覧の部分（まわりの枠に Claude Code をはじめる / さがす / えらぶ / 中身 のラベルが付き、右の欄のカードが選んでいる行を説明する）:

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

### 言語

ccs が自分で出す文は、日本語か英語で出る。一覧・プレビュー・お知らせ・警告・エラー・`--help`・`ccs init`・`ccs doctor` の表が対象。`repos.yml` に自分で書いた値（`label`・`description`・`custom`）は書いたまま出し、訳さない。`--json` の出力・終了コード・語（`status`・`reasons[].code`）は、どちらの言語でも同じ。だからスクリプトは言語を気にしなくてよい。

言語は次の順に見て、最初に決まった物を使う:

1. **コマンドの `--lang=ja` か `--lang=en`**。ほかの値は引数の誤り（終了コード 2）。
2. **環境変数 `CCS_LANG`**（`ja` か `en`）。ほかの値は 1 行の警告を出して、次へ進む。
3. **`repos.yml` の `defaults.language`**（`auto`・`ja`・`en`）。`auto` と空は「決めていない」の意味。ほかの値は 1 行の警告を出して次へ進む（一覧は止めない）。`ccs config set defaults.language ja` で書ける。
4. **OS の locale**: `LC_ALL`・`LC_MESSAGES`・`LANG` のうち、最初の空でない物。`ja` で始まる値（`ja_JP.UTF-8` など）なら日本語、それ以外（`C`・`POSIX`・`en_US.UTF-8` など）なら英語。
5. 上のどれも決めない時は**英語**。

macOS では、日本語で使っていても locale が `en_US.UTF-8` のことが多く、GUI から開いた端末では locale が無いこともある。その時 ccs は英語で開く。いつも日本語にしたい時は、`repos.yml` の `defaults:` の下に `language: ja` を書く（または `ccs config set defaults.language ja` を打つ）:

```yaml
defaults:
  language: ja
```

### 右の欄のカードの例

```
  ✨ My Project で、新しく Claude Code を始めます

  Main development repository

  📂 フォルダ
     ~/projects/my-project
  🕒 最後に開いた
     きのう 18:20
  📝 変更
     まだ保存（commit）していない変更が 2 ファイルあります
  📌 申し送り
     2 件あります（前の作業からのメモ）
  🔗 つながっているサービス
     Plane・Slack・GitHub

  Enter を押すと、このフォルダで Claude Code が開きます
```

---

## 使い方

### フラグ

| フラグ | 動き |
|---|---|
| （なし） | 混在の一覧: 新規起動の行と再開の行 |
| `.` | cwd がカレントディレクトリの下にあるセッションだけ |
| `--new` | 新規起動の行だけ |
| `--resume` | 過去のセッションだけ |
| `--refresh` | 走査で DB を作り直してから一覧を出す |
| `--no-scan` | 起動前の走査を飛ばす（古い DB のまま使う） |
| `--lang=ja\|en` | この起動の言語。`CCS_LANG` と `defaults.language` より強い（[言語](#言語)を参照） |
| `--help` / `-h` | ヘルプ |
| `--version` / `-v` | バージョン |
| 最初の引数の `doctor` / `list` / `sessions` / `repo` / `config` / `open` | スクリプトや道具向けのコマンド。[下](#スクリプトや道具から呼ぶ)を参照 |
| _それ以外_ | 起動するコマンドにそのまま渡す |

### キーボード

| キー | 動き |
|---|---|
| Enter | 起動（NEW）か再開（RESUME）。グループ見出しの上では何もしない |
| Ctrl-Y | `cd … && cmd [--resume …]` をクリップボードにコピーする。fzf は開いたままで、ヘッダーに「📋 Copied」と出る（グループ見出しではコピーする物が無い） |
| Ctrl-I | セッションの UUID かリポのパスをコピーする（グループ見出しはパス）。fzf は開いたまま |
| Ctrl-R | DB を走査し直して一覧を読み直す |
| Ctrl-D | セッションを消す（RESUME の行だけ）。リポを外す時は `~/.config/ccs/repos.yml` を直に書き換える |
| Esc / Ctrl-C | やめる |

**見た目の手がかり:**
- グループ・ほかのプロジェクト・前の会話は、それぞれ見出しの行（グループ / プロジェクト / 前の会話のつづき）の下に並ぶ。見出しの上で Enter を押しても何もしない。
- 前の会話の行には、そのプロジェクトの名前（`label` があればそれ）が出る。`repos.yml` に無いフォルダの会話は、代わりにフォルダの場所が出る（その場で 1 回だけ使ったか、まだ登録していないリポ）。
- `path` が別の登録済みのリポの `path` の中にあるリポは、そのリポのすぐ下に字下げして並び、行の末尾に親の名前が薄く出る。設定は要らない（入れ子は `path` から決まる）。検索で親の行が隠れても薄い名前で関係が分かり、親の名前で検索すると子も一緒に出る。`launch: false` の親は[グループ見出し](#グループ見出しと表示名)になる。

### よくある使い方

**1. プロジェクトを新しく起動する**

```bash
ccs --new
# pick repo → Enter → claude starts in repo cwd
```

**2. きのうの続き**

```bash
ccs --resume
# fuzzy search by content → Enter → cd + claude --resume <id>
```

**3. カレントディレクトリで再開する**

```bash
cd ~/projects/my-project
ccs .
```

---

## スクリプトや道具から呼ぶ

GUI のランチャー・スクリプト・ほかの道具から呼ぶためのコマンド。fzf を開かず、標準入力を読まず、何も問いかけないので、端末が無くても動く（`ccs open --here` だけは、走らせた端末で Claude Code を起こす）。ネットワークに出ず（更新の確認もしない）、`repos.yml` のひな形も作らない。読むコマンド（`doctor`・`list`・`config get`）は ccs の設定とキャッシュの置き場に何も書かない（`TMPDIR` に一時のファイルを作ることがあり、終わる前に消す）。`sessions` は一覧を開く時と同じようにキャッシュを更新し、`repo add`・`repo remove`・`config set` は `repos.yml` を書く。約束の全体は [`docs/design/machine-interface.md`](docs/design/machine-interface.md)。

| コマンド | すること |
|---|---|
| `ccs doctor [--json]` | ccs がここで動くか。Node・ccs 自身の部品・better-sqlite3・fzf・`claude`・`repos.yml`・キャッシュ・`open --new-window` で使う端末のアプリを確かめる。終了コードは 0 動く・1 動かない・2 引数の誤り・3 確かめられない。 |
| `ccs list --json [--with-paths]` | ccs の検証を通した `repos.yml` の項目を、ファイルの順に返す: 名前・label・説明・アイコン・種類（`repo` / `group`）・launch・lead・disabled・親・タグ・フォルダがあるか。パスは `--with-paths` の時だけ。 |
| `ccs sessions --json [--project NAME] [--limit N] [--with-titles] [--no-scan]` | プロジェクトごとの過去の会話を、新しい順に `N` 件まで（既定 5 件・50 件まで）返す: セッションの UUID・最後に使った時刻と、`more`（出さなかった件数）。題（最初の依頼・1 行・80 文字まで）は `--with-titles` の時だけ。要約・フォルダ・会話の中身は出さない。 |
| `ccs repo add PATH [--name NAME] [--description TEXT] [--with-paths] [--json]` | `$HOME` の下のフォルダを `repos.yml` に足す（末尾に、ブロックの形で、パスは `~/…` の形で書く）。名前の既定はフォルダの名前（使われていれば `-2`・`-3`…）。`repos.yml` が無ければ最小の物を作る。 |
| `ccs repo remove NAME [--json]` | 項目を `repos.yml` から外す。フォルダ・その会話・キャッシュには触らない。最後の 1 項目は外せない。 |
| `ccs config get [--with-paths] [--json]` | `config set` で変えられる設定の、今の値と受ける値。 |
| `ccs config set [--repo NAME] KEY VALUE [--json]` | 設定を 1 つ変える: `defaults.ui`（v0.6.0 からは `simple` だけ）・`defaults.language`（`auto` / `ja` / `en`）・`defaults.terminal`（`terminal`。`""` で外す）・`defaults.update_check`（`true` / `false`）、または `--repo` を付けて項目の `label` / `description`（`""` で消す）。起動コマンド・パス・ほかのキーはここでは変えられない（ファイルを直に書く）。 |
| `ccs open (--repo NAME \| --session UUID) [--here \| --new-window] [--terminal APP] [--json] [-- ARGS…]` | 一覧を開かずに Claude Code を起こす。選んだ行と同じ点検（`$HOME` の下のフォルダか・コマンドの文字・セッション ID の形）を通る。`--here`（既定）はこの端末で動かし、`--new-window`（macOS）は `defaults.terminal` の新しいウィンドウを開いてすぐ戻る。一覧と違い、`open` はカレントフォルダで代わりに起こすことはせず、断る。 |

- **これらの語は最初の引数の時だけコマンドになる**: `doctor`・`list`・`sessions`・`repo`・`config`・`open`。0.4.x までは起動するコマンドに渡していた（`ccs doctor` は一覧を開いて `claude doctor` を起こした）。起動するコマンドに渡したい時は、前にフラグを置く: `ccs --new doctor`。
- **`--json` の時**は、失敗の時も、標準出力に JSON を 1 つだけ出す。中には `schema_version`・`product_version`・`command`・`status`・`reasons`（`[{ "vocab", "code" }]`）がある。機械は終了コードとこれらの語で分ける。標準エラーの文は人向けで、変わることがある。文字列の中の DEL・C1 の文字・向きを変える文字は `\uXXXX` の形で書く（読んだ後の値は同じ）。`--json` なしの時、`repo` と `config set` は標準出力に何も出さず、標準エラーに 1 行出す。
- **出さない物**: 秘密・リポを起動するコマンド・`custom`・ユーザー名とホスト名。`doctor` はリポの名前もパスも一切出さない（語・件数・バージョンだけ）。パスは `--with-paths`、会話の題は `--with-titles` の時だけ。
- **`repos.yml` の書き方** — 書くのは一度に 1 つだけ（`repos.yml.lock`）。前の中身を `repos.yml.bak` に残し、ファイルをその場で書き（symlink の `repos.yml` は symlink のまま）、もう一度点検し、落ちたら元に戻す。1 行の `repos:` の一覧（`repos: [ … ]`）には足さない（`flow_style_repos`）。名前とパスは、YAML の引用符が要らない時だけ書く（要る時は `needs_quoting`）。DEL・C1 の文字・向きを変える文字の入った名前は、説明と同じに断る（`invalid_value`）。コメントとキーの順は残す。行末のコメントの前の空白は 1 つに減ることがある。
- **`ccs open --new-window`** は `TMPDIR` に 1 回きりの起動用のファイルを書き（起動すると自分で消える）、`open -a` で端末のアプリに渡す。AppleScript を使わないので、オートメーションの許可は求めない。新しいウィンドウでは、同じ点検をする `ccs open --here` が動く。アプリは先に決める: `ccs config set defaults.terminal terminal`（macOS のターミナル。ほかのアプリは、開き方を試してから足す）。Claude Code を起こした後の `--here` の終了コードは Claude Code の物なので、スクリプトは `--new-window` を使う。
- **GUI のアプリから呼ぶ**と、`PATH` が短く、`node` や `claude` が見つからないことがある（`dependency_missing`）。利用者のシェルの `PATH` を ccs に渡す。

| 終了コード | `status` | 意味 |
|:---:|---|---|
| 0 | `ok` | できた（`doctor`: ccs が動く） |
| 1 | `failed` | 失敗した（`doctor`: ccs が動かない）。`config_locked`・`config_changed` もここ — やり直す |
| 2 | `usage` | 引数の誤り（`--json` なしの `list` / `sessions` も） |
| 3 | `unverifiable` | 確かめられない（権限が無い・点検が時間切れ） |
| 4 | `missing_prerequisite` | 動かさなかった: 要る物が無い（`repos.yml` が無い・壊れている・キャッシュが無い・端末が無い・Node が無い）— `doctor` は使わない |
| 5 | `not_found` | その項目やセッションが無い |
| 6 | `rejected` | 点検で断った（`$HOME` の外・使われている名前・受けない値 など） |
| 7 | `partial` | 書いたが点検に落ち、元に戻せなかった: 前の中身は `repos.yml.bak` にある |
| 130 | `interrupted` | Ctrl-C で止めた（書いている途中の物は元に戻す） |

```bash
ccs doctor --json | jq -r '.status, (.checks[] | select(.status != "ok") | "\(.name): \(.code)")'
ccs list --json | jq -r '.repos[] | select(.kind == "repo" and (.disabled | not)) | .name'
ccs sessions --json --project studio-web --limit 3 | jq -r '.projects[].sessions[].uuid'
ccs repo add ~/projects/studio/web --json | jq -r '.status'
ccs open --repo studio-web --new-window
```

---

## 状態キャッシュ

ccs は `~/.cache/ccs/state.db`（または `$XDG_CACHE_HOME/ccs/state.db`）に SQLite のキャッシュを持ち、リポジトリの情報・git の状態・セッションの要約・handoff/pending のファイルの一覧を入れている。

- `ccs` を起動するたびに自動で走査する（軽い — リポジトリごとに 10 秒の TTL）
- 手で強制する: `ccs --refresh` か、fzf の中で `Ctrl-R`
- リセット: `rm ~/.cache/ccs/state.db` — 次の `ccs` で作り直す（設定の `repos.yml` には触らない）

スキーマの詳細: [`docs/design/sqlite-schema.md`](docs/design/sqlite-schema.md)。

---

## 更新の確認

npm に新しいバージョンがあると、ccs が知らせる。一覧の枠に知らせを出し、一覧を閉じた後に上げ方のコマンドを出す。

- **上げ方は入れ方に合わせる** — npm で入れた時（`github:…` から入れた時も。npm のパッケージで置き換わる）は `npm install -g @indigo-gr/claude-code-station`、clone の `bin/ccs` を使う時は `cd <your clone> && git pull && npm install`。
- **要る時は Node を先に** — 新しいバージョンが今より新しい Node を要る時（その `engines.node`）は、要る Node と、ccs より先に Node を上げることを知らせる。端末の幅が足りれば、枠に「先に Node を上げる」も足す。

- **何をどこに送るか** — 1 日に 1 回まで（失敗の後は 1 時間後）、HTTPS の `GET https://registry.npmjs.org/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags` を 1 回。そこにリリースの名前があれば、そのリリースの公開の情報（`GET https://registry.npmjs.org/%40indigo-gr%2Fclaude-code-station/<latest>`。要る Node を読むため）をもう 1 回。どちらにも ccs のバージョン・リポジトリ・セッション・マシンの情報は入らない（2 つ目の URL のバージョンは npm の latest そのもの）。レジストリに届くのは、リクエストそのもの・IP アドレス・Node の既定の User-Agent だけ。
- **じゃまをしない** — 確認は裏で 3 秒の時間制限つきで行い、その答えは次の起動で使う。起動の時は `~/.cache/ccs/update-check`（または `$XDG_CACHE_HOME/ccs/update-check`）を読むだけ。オフラインの時や答えが使えない時は、今までどおりに動く。HTTP のプロキシの設定は使わないので、プロキシの内側では確認が静かに失敗するだけ。
- **知らせない時** — 最新かそれより新しいバージョンを使っている時・npm の latest がプレリリースの時・手元のバージョンがプレリリースかコピーインストール（`0.0.0-dev`）の時。確認の失敗だけでは知らせないが、前の確認で見つけたバージョンは知らせる。
- **止める** — `CCS_NO_UPDATE_CHECK=1`（空でない値なら何でも）を設定するか、`repos.yml` の `defaults:` の下に `update_check: false` を書く（`ccs config set defaults.update_check false`）。通信せず、キャッシュも読まない。環境変数がファイルより強い（`update_check: true` でも、設定した環境変数は戻らない）。ccs の更新をほかの道具で管理している時に使う。
- **ほかのレジストリ** — `CCS_UPDATE_REGISTRY=https://registry.example.com` で、代わりにそのサーバーに問い合わせる。

---

## ccr v0.1.x からの移行

今までのセッションは `~/.claude/projects/*/*.jsonl` にあり、最初の走査で ccs が自動で見つける。**手で移す物は無い**。

### コマンド・環境変数の名前の変更

| 前（ccr v0.1.x） | 後（ccs v0.2.0） |
|---|---|
| `ccr` | `ccs` |
| 環境変数 `CCR_CMD` | 環境変数 `CCS_CMD` |
| GitHub: `indigo-gr/claude-code-recall` | `indigo-gr/claude-code-station` |

`CCR_CMD` は当面読む（標準エラーに deprecation の警告を出す）。シェルの設定ファイルで、なるべく早めに `CCS_CMD` に名前を変える。

### 旧 ccr を消す

```bash
rm -f ~/.claude/scripts/ccr ~/.claude/scripts/ccr-*.ts ~/.claude/scripts/ccr-*.sh
# Remove any `export CCR_CMD=...` from ~/.zshrc or ~/.bashrc
```

---

## 設計

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

設計の資料: [`docs/design/`](docs/design/)。

---

## セキュリティ

- セッション ID は、シェルで使う前に UUID の形かを検証する
- すべての `cwd` が `$HOME` の下にあるかを検証する
- プレビューの中の既知の秘密の形（API キー・トークン）は伏せる
- SQLite の DB は `0600` の権限で作る。設定とキャッシュのディレクトリは `0700`
- `eval` は使わない。どの呼び出しも直接
- SQLite は prepared statement だけ。外部キーを有効にする
- JSONL のセッションを読む時は、1 ファイル 50MB まで

> **注意**: `repos.yml` の `command:` は、読み込む時にシェルのメタ文字を検証する。安全な、検証済みのコマンドだけを実行する。

---

## コントリビュート

Issue と PR を歓迎する。レビューの基準は [`REVIEW.md`](REVIEW.md)、リリースの履歴は [`CHANGELOG.ja.md`](CHANGELOG.ja.md)（英語は [`CHANGELOG.md`](CHANGELOG.md)）を参照。

---

## ライセンス

MIT。Copyright © INDIGO GROUP LLC.（著作権者は INDIGO GROUP LLC.）。[LICENSE](LICENSE) を参照。

画面のバージョンから、そのリリースの中身をたどれる:

- **ソース** — [indigo-gr/claude-code-station](https://github.com/indigo-gr/claude-code-station/tags) の git の tag `vX.Y.Z`
- **変更点** — [CHANGELOG.ja.md](CHANGELOG.ja.md)（英語は [CHANGELOG.md](CHANGELOG.md)）の `[X.Y.Z]` の節
- **配布の条件** — その tag の [LICENSE](LICENSE)
