# 変更履歴

[English](CHANGELOG.md)

このプロジェクトの目立つ変更は、すべてこのファイルに書く。
形は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) にならい、バージョンの付け方は [Semantic Versioning](https://semver.org/lang/ja/spec/v2.0.0.html) に従う。

## [Unreleased]

## [0.6.0] — 2026-11-18

### 追加
- **日本語と英語。** ccs が自分で出す文（一覧・プレビュー・お知らせ・警告・エラー・`--help`・`ccs init`・`doctor` の表）の言語を、`--lang=ja|en` → `CCS_LANG` → `repos.yml` の `defaults.language`（`auto` / `ja` / `en`）→ OS の locale（`LC_ALL`・`LC_MESSAGES`・`LANG`。`ja…` なら日本語、それ以外は英語）の順で決める。`ccs config get` と `ccs doctor --json` の設定に `language` を足した。`ccs config set defaults.language` は `auto`・`ja`・`en` を受ける。`--json`・終了コード・語は言語で変わらない。README とこの変更履歴を、英語（`README.md`・`CHANGELOG.md`）と日本語（`README.ja.md`・`CHANGELOG.ja.md`）に分けた。

### 互換性のない変更
- **locale（か設定）が日本語でなければ、ccs の文は英語になる。** 0.5.x までは一覧の見た目はいつも日本語だった。locale が英語か空の時（macOS でよくある）は、英語で開くようになった。日本語のままにしたい時は、`repos.yml` の `defaults:` の下に `language: ja` を書く。
- **ccs は Node 24.12.0 以上が要る**（前は 22）。`engines.node` は `>=24.12.0` になり、`ccs doctor` は古い Node を `node_too_old` と出し（マイナーバージョンも比べるようになった）、`install.sh` も 24.12.0 を求める。Node 22 や 24 の初めのほうを使っている時は、先に Node を上げてから ccs を入れ直す。24.12.0 は Node 自身の TypeScript の型の除去が安定になったバージョンで、ccs は tsx の代わりにこれを使う。
- **見た目は 1 つだけ: `classic` の見た目はなくなり、fzf 0.61.0 以上が要る**（前は 0.42.0）。一覧はいつも、全画面でやさしい日本語の言葉の見た目（前の `ui: simple` で選んでいた物）で開く。古い fzf では一覧を開かずに 1 行で知らせる。`ccs doctor` は `fzf_too_old` と出し、`fzf_too_old_for_headers` と `fzf_too_old_for_simple` はもう出さない。`install.sh` は 0.61.0 を求める。
- **`--ui=` は引数の誤り（終了コード 2）になり、`CCS_UI` は読まなくなった。** エイリアスとスクリプトから外す。
- **`repos.yml` の `defaults.ui`**: `simple`（か空）は今までどおり読み、何も変えない。`classic` は 1 行の警告を出して、いつもどおり一覧を開く。ほかの値は今までどおりエラー。`ccs config set defaults.ui` は `simple` だけを受ける（`classic` は `invalid_value`・終了コード 6）。`ccs config get` と `ccs doctor --json` は `defaults.ui`・`settings.ui` のキーを残し、値はいつも `"simple"`。

### 変更
- **新しいバージョンが新しい Node を要る時は、更新のお知らせがそう言う。** 1 日 1 回の確認で、npm の latest のバージョンの公開の情報（manifest）も読んで `engines.node` を見る（GET が 1 回増える。ccs のバージョンやマシンの情報は今までどおり送らない）。手元の Node が古い時は、お知らせが要る Node を名指しして先に Node を上げるよう言い、端末の幅が足りれば枠に「先に Node を上げる」を足す。下限が `>=X[.Y[.Z]]` 以外の形で書かれている時は推し量らず、お知らせは今までどおりになる。
- **お知らせの上げ方のコマンドを、ccs の入れ方に合わせた**: npm（か `github:`）で入れた時は `npm install -g @indigo-gr/claude-code-station`、clone の `bin/ccs` を使う時は `cd <clone> && git pull && npm install`。コピーインストール（`install.sh`）には今までどおりお知らせを出さない。
- **README は npm を勧め、GitHub から入れる物を「最新の未リリース版」と呼ぶのをやめた**: GitHub のリポに載るのは npm と同じ出したバージョンだけ。
- **ccs は自分の部品を tsx でなく Node 自身で動かす。** npm のパッケージには、リリースの時に TypeScript のソースから作った JavaScript が入る（Node は `node_modules` の下では型を除かないため）。checkout とコピーインストール（`install.sh`）は `.ts` のソースを Node でそのまま動かす。起動・一覧・プレビュー・`--json` のコマンドは、どれも今までどおり動く。パッケージは `tsx` に依存しなくなったので、`npm i -g` は `tsx` を入れない。
- **`ccs doctor` の `tsx` の点検はいつも `ok`。** JSON を読む側が壊れないよう、名前と `checks[]` の中の位置は残す。`tsx_missing` と、`dependency_missing` の detail の `tsx` はもう出さない。グローバルの `tsx` が無くても、`ccs`・`ccs init`・`--json` のコマンドは止まらない。
- **直接の依存を、`^` の範囲でなく正確なバージョンで固定した**（`better-sqlite3` 13.0.3・`yaml` 2.8.3）。`npm i -g` が、入れた日の範囲の中の一番新しい物でなく、試験したのと同じバージョンを入れる。バージョンそのものは変わらない。
- **`ccs init --auto-discover` は、パスの中のどれかのフォルダ** — 自分の名前だけでなく — **に DEL・C1 の文字・向きを変える文字があるリポを勧めなくなった**。代わりに `[ccs-init] skipped … in the path` の 1 行を出す。今まではそういう親フォルダがそのまま選ぶ画面に届いていた。

### 修正
- **`ccs init --auto-discover` が、飛ばしたパスや形の崩れた選んだ行を、DEL・C1・向きを変える文字のまま標準エラーに出していた。** これらの文字は、もう 1 つの `[ccs-init] skipped` の行と同じく `\uXXXX` の形で書くようにした。

## [0.5.1] — 2026-11-16

### 追加
- **Claude Code の skill `ccs` をパッケージに入れた**（`docs/skills/ccs/SKILL.md`）。入れると、Claude Code が ccs の入れ方と使い方を説明し、ccs の点検に従って、`repos.yml` へのプロジェクトの登録・label と説明の設定・項目のグループ分け・`custom` の下の連携の欄の書き足しをする（`ccs repo add` / `ccs config set` を優先し、結果を `ccs list --json` で確かめる）。`~/.claude` には自動で入らない: `cp -R "$(npm root -g)/@indigo-gr/claude-code-station/docs/skills/ccs" ~/.claude/skills/` でコピーし、ccs を上げたらもう一度コピーする。README のインストールの節に手順と消し方がある。

### 変更
- **README のインストールの節を、npm から入れる人向けの 1 本の手順にした**: macOS・Linux・Windows（WSL）での前提（Node 22 以上・fzf 0.42 以上・`claude`）の確かめ方、`npm install -g`、`ccs doctor`、`ccs init --auto-discover` と見本の項目を外すこと、`ccs` を開くこと、任意の skill、スコープなしのパッケージからの入れ替え、上げ方、消し方、よくある詰まり。checkout と手動のインストールは「ほかの入れ方」の下に移した。
- **`ccs repo add --name` は、DEL・C1 の文字・向きを変える文字**（U+061C・U+200E–U+200F・U+202A–U+202E・U+2066–U+2069）**の入った名前を断る**（`invalid_value`・終了コード 6）。`--description` と `label` と同じ。今までは向きを変える文字は `repos.yml` に書かれ、DEL と C1 は `needs_quoting` で断られていた。C0 の文字は今までどおり `unsafe_characters`。手で書いた、そういう文字の入った名前は今までどおり読む。
- **`ccs init --auto-discover` は、名前にそれらの文字があるフォルダを勧めなくなった**。代わりに `[ccs-init] skipped …` の 1 行を出す。
- **JSON の出力は、DEL・C1・向きを変える文字・U+2028–U+2029 を `\uXXXX` の形で書く**（`--json` の `list`・`sessions`・`repo`・`config`・`open`・`doctor`）。読んだ後の値は同じで、変わるのは端末に出るバイトだけ。出力を表示しても、端末の並びが変わったり端末を操ったりしなくなった。

### 修正
- **向きを変える文字の入った名前やグループの `id` で、一覧とプレビューの表示の並びが変わっていた。** 一覧の行・セッションの行・プレビューは、名前や `id` の制御文字と向きを変える文字を空白に替えて出す（続く空白は 1 つにし、両端は切る。何も残らなければ `?`）。`repos.yml` の中・キャッシュの中・`--repo` の後の名前は変わらない。
- **`label` の無いグループの定義**は、`id` をそのまま label にしていた。書いた `label` と同じく、制御文字と向きを変える文字を空白に替えるようにした（`ccs list --json` の `groups[].label`）。`groups[].id` は変わらない。
- **DEL・C1 の文字・向きを変える文字の入ったパスを、そのまま出していた。** プレビュー（題の下の行・グループの項目・simple のカードとセッションのカードのフォルダ・セッションのプレビュー）・プロジェクトの無いセッションの行・`ccs config get` の `defaults.groups_dir` の行は、パスを名前と同じように出す（何も残らなければ `?`）。起動に使うパス・キャッシュの中・`--json` の出力のパスは変わらない。キャッシュができる前や、キャッシュに無い項目のプレビューの題も、名前を同じように出すようにした。

## [0.5.0] — 2026-11-14

### 追加
- **repos.yml を資料に書いた約束にした** — [`docs/design/repos-yml-schema.md`](docs/design/repos-yml-schema.md) に、ほかの道具がどのキーに頼ってよいか、`version: 1` の下でそれぞれが何を意味するか、形がどう変わりうるかを書いた: `version: 1` の間はキーを足すだけ（消さない・意味を変えない）で、読む側は知らないキーを無視する。互換性のない変更は、移る期間を置いて `version: 2` に進める。ほかの道具は自分の値を `repos[].custom` の下に持つ。勧める形は、各項目のすぐ下に `name:` と `path:` を置いたブロックの一覧で、行ごとに読む道具でも読める。ccs はいつもこの形で書く。
- **`ccs doctor [--json]`** — スクリプトや GUI のランチャーに、端末なしで、ccs がここで動くかを答える: Node（22 以上）・tsx・ccs 自身の部品・better-sqlite3・fzf（0.42.0 以上）・`PATH` の上の `claude`・ccs の点検を通した `repos.yml`・行ごとに読む道具が要る形・キャッシュとそのスキーマのバージョン。終了コードは 0 動く・1 動かない・2 引数の誤り・3 確かめられない。`--json` の時は、`schema_version`・`status`・`reasons` と、全部の点検の `name`・`status`・`code` を持つ JSON を 1 つ出す。リポの名前もパスも出さず、ネットワークに出ない。ccs の設定とキャッシュの置き場には何も書かない — `repos.yml` のひな形やキャッシュが無い時も作らない — 。`TMPDIR` に使う一時のフォルダ（時間制限と tsx のため）は、終わる前に消す。Node が ccs の部品を読み込めない時（コピーインストールの上に壊れた `package.json` がある時: 終了コード 1・`invalid_package_config`）も答える。
- **`ccs list --json [--with-paths]`** — ファイルを自分で読もうとする道具のために、ccs の点検を通した `repos.yml` の項目をファイルの順に返す: 名前・label・説明・アイコン・種類（`repo` か `group`）・launch・lead・disabled・親（一覧が見せる入れ子）・タグ・フォルダがあるか。パスは `--with-paths` の時だけ。起動コマンドと `custom` は出さない。`repos.yml` が無い時は終了コード 4（`config_missing`）、壊れている時も 4（`config_invalid`。点検の語を `detail` に入れる）。
- **`ccs sessions --json [--project NAME] [--limit N] [--with-titles] [--no-scan]`** — プロジェクトごとの過去の会話を、新しい順に `N` 件まで（既定 5 件・50 件まで）返す: UUID・最後に使った時刻・出さなかった件数。最初の依頼の行（1 行・80 文字まで・秘密は伏せる）は `--with-titles` の時だけ。要約・フォルダ・会話の中身は出さない。一覧を開く時と同じようにキャッシュを更新する（`--no-scan` の時と、`repos.yml` が無い時はしない）。
- **`ccs repo add PATH [--name NAME] [--description TEXT]` と `ccs repo remove NAME`** — ファイルを書き換えずに、`$HOME` の下のフォルダを `repos.yml` に足す・項目を外す。`add` はフォルダを点検し（symlink をたどった後も `$HOME` の下か・あるか・フォルダか・シェルのメタ文字が無いか・まだ登録していないか）、`--name` が無ければフォルダの名前を付け（使われていれば `-2`・`-3`…）、末尾にブロックの形で、パスを `~/…` の形にして書く。`repos.yml` が無ければ最小の物を作る。`remove` はフォルダ・その会話・キャッシュには触らず、項目を少なくとも 1 つ残す。
- **`ccs config get` と `ccs config set [--repo NAME] KEY VALUE`** — 画面から変えられる設定を読み書きする: `defaults.ui`・`defaults.terminal`・`defaults.update_check` と、項目の `label` と `description`。起動コマンドとパスはここでは変えられない。
- **`ccs open (--repo NAME | --session UUID) [--here | --new-window]`** — 一覧を開かずに、選んだ行と同じ点検を通して Claude Code を起こす。`--here`（既定）はこの端末で動かし、`--` の後の引数を渡す。`--new-window`（macOS）は、1 回きりの起動用のファイルを `defaults.terminal` で決めた端末のアプリ（今は `terminal` = macOS のターミナル）に渡し、すぐ戻る。一覧と違い、`open` は `$HOME` の外のフォルダや無くなったフォルダの時、カレントフォルダで起こさずに断る。
- **`repos.yml` の `defaults.update_check: false`** は、`CCS_NO_UPDATE_CHECK` と同じく更新の確認を止める（環境変数が強い）。ほかの道具が更新を管理している時のため。
- **`repos.yml` の `defaults.terminal`**: `ccs open --new-window` が開く端末のアプリ。今は `terminal` だけを受ける。ほかのアプリは開き方を試してから足す。`ccs doctor` が点検する。
- **`defaults.groups_dir`**（書かなければ使わない）: ほかの道具が持つ、グループの定義ファイルのフォルダ。ccs はその中の各 `*.json` から 5 つのキー（`version`・`id`・`label`・`kind`・`members[].path`）を読み、`version: 1` と `kind: "logical"` だけを使って、`path` が当たった `repos.yml` の項目を表示だけの見出しの下に並べる — classic の見た目では全プロジェクトの後、simple の見た目では `launch: false` の見出しの後。ccs はそこに書かない。壊れたファイルは飛ばして `ccs doctor` が数え（`groups_dir`）、`ccs list --json` は `groups[]` でグループを返す。
- **`repos.yml` を書く経路を 1 つにした**（`repo add`・`repo remove`・`config set`・`ccs init --auto-discover`）: 書くのは一度に 1 つだけ（`repos.yml.lock`）、書く前と後にファイルを点検し、前の中身を `repos.yml.bak` に残し、その場で書き（symlink は symlink のまま）、書いたファイルが ccs の点検に落ちたら元に戻す。書いている途中の Ctrl-C は前の中身を戻す（終了コード 130）。
- これらのコマンドの JSON の形・終了コード・理由の語は [`docs/design/machine-interface.md`](docs/design/machine-interface.md) に書き、`schema_version`（今は `1.0.0`）でバージョンを付ける。終了コード: 0 ok・1 失敗・2 引数の誤り・3 確かめられない・4 要る物が無い・5 見つからない・6 点検で断った・7 一部だけできた・130 中断。

### 変更
- **`doctor`・`list`・`sessions`・`repo`・`config`・`open` は、最初に来た時に ccs のコマンドになる。** 今までは `ccs doctor` が一覧を開き、選んだプロジェクトで `claude doctor` を起こしていた（ほかの語も同じ）。これらの語を起動するコマンドに渡したい時は、前にフラグを置く: `ccs --new doctor`。見るのは最初の引数だけで、ほかは今までどおり渡す。
- **`disabled` と `scan` は、`launch` と `lead` と同じく `true` か `false` だけを受ける。** ほかの値は、引用符付きの文字列も含めて、キーを名指しするエラーになる。**repos.yml を確かめてほしい**: 今までは引用符付きの `disabled: "false"` や `scan: "false"` を *true* と読んでいたので、その項目は隠れるか走査されていなかった。今は、引用符を外すまで ccs が文を出して止まる。空の値（`disabled:` の後に何も無い）もエラー。
- **`ccs init --auto-discover` は、`repos.yml` に足す前にロックを取って点検する**（`ccs repo add` と同じ書く経路）: もう ccs の点検に落ちるファイルには足さない（今までは足してから戻していた）。
- **壊れた `package.json` の下での `ccs list --json`**（Node が読めない物の下のコピーインストール）は、`doctor` と一覧と同じ理由の語 `invalid_package_config` で終了コード 1 を返す（前は `internal_error`）。`sessions`・`repo`・`config`・`open` も同じ。
- **`ccs init --auto-discover` は、1 行の `repos:` の一覧**（YAML の flow style。例 `repos: [{name: a, path: ~/a}]`）**を走査の前に断り**、終了コード 1 で終わってファイルを変えない。いつもの `🔍 Scanning $HOME for git repositories...` の行の後に、`[ccs-init] flow_style_repos:` で始まる 1 行を出す。一覧をブロックの形に書き直して、もう一度打つ。

### 修正
- **名前に空白のあるフォルダの下に入れた ccs**（アプリの `Application Support` など）が何もしなかった: 一覧が行の無いまま開き、終了コード 0 で終わっていた。各部品が自分の URL とパスを比べていて、URL では空白が `%20` と書かれるためだった。一覧・プレビュー・走査・`ccs init`・新しいコマンドが、そういうフォルダからも動くようにした。
- **YAML のパーサー自身の警告**（値に付いた `!made-up` のような知らないタグ）が、`repos.yml` のその行を標準エラーに出していた。スクリプトや道具向けのコマンドはもう出さない（一覧は今までどおり出す）。
- **使える `TMPDIR` が無い時**（無い・書けない）: スクリプトや道具向けのコマンドは代わりに `/tmp` を使い、いつもの JSON で答える（前は標準出力が空・終了コード 1・パスの入った `mktemp` の文）。
- **`ccs doctor` の点検が時間切れになった時**（答えない `fzf --version`）、bash 自身の `Terminated` の行をインストール先のパス付きで出していた。もう出さない。
- **壊れた `package.json` の下のフォルダで動かした ccs** が、ccs 自身に問題が無くても `invalid_package_config` で止まっていた（Node が tsx の preload のためにそのファイルを読んでいた）。ccs の部品は ccs 自身のフォルダから起動するようにしたので、一覧はどこでも開く。止まるのは、ccs 自身のファイルの上に壊れた `package.json` がある時だけ。そのファイルを名指しする行は、パスに制御文字や向きを変える文字がある時はパスを省く。
- **自分自身を指す値**（`disabled: &x [*x]` のように、自分の中で使った YAML のアンカー）で TypeError で落ちていた。ほかの間違った値と同じく、項目を名指しするエラー（`entry_invalid`）にした。
- **空の `description:` や `icon:`**（YAML の null）で `null` という語が出ていた。書いていないのと同じに扱う（説明なし・既定のアイコン）ようにした。
- **`custom` の大きさのエラー**が、何を測っているかを言うようにした: 上限は JSON の形での 64,000 文字で、64KB のバイトではない。
- **ccs の上にある壊れた `package.json`** — Node が ccs の部品の読み込みを断り、ccs は空の一覧を開いて（または役に立たない `ccs --refresh` を勧めて）終了コード 0 で終わっていた。パッケージに自分の `bin/package.json` を入れたので、上の `package.json` は読まない。コピーインストール（`install.sh`）はまだそういうファイルの下に置けるので、その時は、どちらの見た目でも、ファイルを名指しする 1 行と理由の語 `invalid_package_config` を出して終了コード 1 で止まる。

### セキュリティ
- **リリースの tag に署名する** — このバージョンから、このリポの各 `vX.Y.Z` の tag に SSH の署名を付ける。作る元の tag が決まった署名のキーで署名されていなければ、リリースを出さない。

## [0.4.1] — 2026-11-08

0.4.0 は作業用のリポで tag を打ったが、出していない。その変更は 0.4.1 に入っている。

### 追加
- **画面にバージョンと著作権** — どちらの見た目でも、枠の上の辺に `ccs v<version>` と `Copyright © INDIGO GROUP LLC.` を出す（fzf の枠のラベル: simple の見た目では題の後、classic の見た目では新しく出る）。ラベルは一覧の行を使わず、`change-header` の後も残る。狭い端末では、枠の角をはみ出す代わりにラベルを短くする: まず題を（simple）、次に `Copyright` の語を外し（`© INDIGO GROUP LLC.`）、バージョンは残す。`ccs --help` も著作権を出す。
- **更新のお知らせ** — npm の latest が動いているバージョンより新しい時、classic の見た目は選ぶ画面の上に上げ方のコマンドを 1 行出す。simple の見た目は一覧の枠でそう知らせ、選ぶ画面を閉じた後にコマンドを出す。どちらかがプレリリースの時や、latest のバージョンが何も分からない時は知らせない。
  - **ネットワークに出る物**: 1 日に 1 回まで（失敗の後は 1 時間後）、裏のプロセスが `https://registry.npmjs.org/-/package/%40indigo-gr%2Fclaude-code-station/dist-tags` に HTTPS の GET を 1 回送る。ccs のバージョン・リポ・セッション・マシンの情報は入らない。README の「更新の確認」を参照。
  - **ccs を遅らせたり止めたりしない**: ランチャーは `~/.cache/ccs/update-check` から前の答えを読むだけで、リクエスト（3 秒の時間制限つき）を待たない。オフラインでも今までどおり動く。
  - **止める**には `CCS_NO_UPDATE_CHECK=1`（通信せず、キャッシュも読まない）。`CCS_UPDATE_REGISTRY` で確認の先をほかのレジストリにできる。
- `package.json` に `author`。

### 変更
- 著作権者を INDIGO GROUP LLC. にした（`LICENSE`・`package.json`・README・画面）。ライセンスは MIT のまま。
- `tput` は要らなくなった。
- **npm 12 でそのまま動き、Node 22 が要る** — npm 12 は、グローバルに入れる時も含めて、依存のインストールのスクリプトを既定で止める。そのため `better-sqlite3` 11 では、ただの `npm install -g` が成功と言いながら起動できない `ccs` を残していた（前のバージョンの ccs に当てはまる）。`better-sqlite3` 13 は作り済みのネイティブの部品を配るので、スクリプトは要らない。これは Node 22 以上を要るので、ccs も今は Node 22 以上が要る（`engines`・`install.sh`・README）。作り済みの部品の無い環境では、`ccs` がそう言う。今の `state.db` はそのまま使う。

### 修正
- **端末の幅** — `$()` の中の `tput cols 2>/dev/null` がどの幅でも 80 と答えていたので、狭い端末向けの classic の見た目の短い案内の行が出なかった。今は `stty size` で端末に聞く（export した `COLUMNS` が強い）ので、80 桁より狭い端末で短い案内の行が出る。
- **コピーインストール** — `bin/` の横に `package.json` が無い時（`install.sh`・README の手動インストール）、`ccs` が何もせず文も出さずに終了コード 2 で終わっていた。今は `ccs v0.0.0-dev` として動き、コピーインストールでは更新の確認もお知らせもしない。
- **ほかのパッケージのバージョン** — `ccs` は `bin/` の上にある `package.json` からバージョンを取っていたので、コピーインストールがほかのプロジェクトのバージョンを出すことがあった。今はそのファイルの `name` がこのパッケージの時だけ読み、そうでない時や読めない・解釈できない時は `ccs v0.0.0-dev` として動く。
- **simple の見た目**: 当たる物が無い時の文が、案内の行に上書きされて時々しか残らなかった。今は検索がまた当たるまで残る。
- キャッシュを開く所で失敗した走査が、ロックを残さなくなった（後の走査が 5 分の間「別の走査が動いている」と言い、本当のエラーを隠していた）。
- インストールの手順で、`~/.claude/scripts` を `PATH` の末尾に足すようにした。システムのコマンドを隠さないため。前の手順に従った人は、シェルの設定ファイルのその行を変えるとよい。

### セキュリティ
- **repos.yml の欄がコマンドを選べなくなった** — `icon` の中のタブ・改行・ユニットセパレーターが行の列をずらし、そのリポ（かそのセッション）を選ぶと、リポのコマンドの代わりにその欄が名指しした物を動かしていた。アイコンはどこで出す時も掃除し、`ccs-list` は形の違う行を落とし、`bin/ccs` はシェルのメタ文字や制御文字のあるコマンドを断る。
- **`command` の中のワイルドカード**は書いたまま渡す（`claude *` は引数 `*` を受ける）。語への分け方は変わらない。
- **セッションの cwd** に `..` の区切りがある時は、セッションのファイルから取らない。`$HOME` の外で開くことも、`^Y` でクリップボードに届くこともない。
- **プレビューは、文を切る前に秘密を伏せる**。切る所にまたがったキーの先頭が見えなくなった（メッセージ・`cwd`・`gitBranch`・`version`）。
- **走査はリポの中に留まる**: `handoff/` や `pendings/` の中のファイル、またはそのフォルダ自身が、リポの外への symlink の時は読まない。リポの中に留まる symlink は今までどおり使える。
- **走査はリポが設定した物を何も動かさない**: git は `core.fsmonitor` を切り、hook なしで動き、走査がリポの index を書き換えなくなった。
- **表示の文**から C1 の制御文字と向きを変える文字も取り除く。classic のプレビューでも `description`・`tags`・`icon` を掃除するようにした。絵文字と日本語の文は変わらない。

## [0.3.3] — 2026-11-06

### 変更
- npm のパッケージの公開の連絡先を更新するために出し直した。動きの変更は無い。

### セキュリティ
- ロックファイル: `tsx` 4.23.15。これで `esbuild` 0.28.2 が入る（[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)。Windows での esbuild の開発サーバーのパストラバーサル）。ccs はそのサーバーを動かさない — tsx は esbuild をコードの変換にだけ使う — ので、ccs は影響を受けていなかった。新しく `npm install -g` すれば新しい tsx がもう入っていた。これはリポから入れる時（`install.sh --with-deps`）に使うロックファイルを更新する物。

## [0.3.2] — 2026-11-05

### 変更
- **npm のパッケージを `@indigo-gr/claude-code-station` に改名した** — `npm install -g @indigo-gr/claude-code-station` で入れる。スコープなしの `claude-code-station`（0.3.1 まで）は deprecate し、新しいバージョンは出さない。`npm uninstall -g claude-code-station && npm install -g @indigo-gr/claude-code-station` で一度だけ入れ替える。`ccs` のコマンド・`~/.config/ccs/repos.yml`・キャッシュは変わらない。コードの変更は無い。

## [0.3.1] — 2026-11-04

### 追加
- **`lead: true`** — グループの統括（director や取りまとめ役）の項目に付ける。名前の順でなく兄弟の中で一番上に並び — どちらの見た目でも、一覧でもグループのプレビューでも —、simple の見た目では 👑 付きで出る（そのカードは「👑 このグループの統括です」と言い、グループのカードには（統括）と付く）。本物の真偽値で書く。キャッシュには `repos.lead` として入る（**スキーマ v4**。ただの `ADD COLUMN ... DEFAULT 0`。読むだけの側は v3 のキャッシュでは既定の値を補い、0.3.0 も v4 のキャッシュで動き続ける）。`lead` が無ければ、どの並びも変わらない。

### 修正
- **simple の見た目: 絵文字の幅** — 名前の列の詰め物が、絵文字の表示を持たない絵文字（🛰・✍️・🛠️・✴️。VS16 付きも）を 2 桁と数えていたが、fzf と wcwidth は 1 桁と数えるので、その行の説明が 1 桁左から始まり、絵文字が名前にかぶっていた。幅は wcwidth に合わせ（2 は CJK と `Emoji_Presentation` だけ）、アイコンの欄はいつも 2 桁に詰める。

## [0.3.0] — 2026-11-04

### 追加
- **やさしい見た目（`ui: simple`）** — repos.yml の `defaults.ui: simple`（か `ccs --ui=simple`、か `CCS_UI=simple`。フラグ > 環境変数 > repos.yml）で、ccs が全画面で開く: 角の丸い枠・4 つのラベル（Claude Code をはじめる / さがす / えらぶ / 中身）・Enter / ↑↓ / Esc だけを出す日本語の案内の行・空の検索欄の薄いヒント・目立つカーソルの行。fzf 0.61 以上（`--ghost`）が要る。古い fzf では、理由を言う 1 行を出して classic の見た目で開く。既定は classic の見た目で、1 バイトも変わらない（一覧の行・プレビューの文・fzf の引数・ランチャーの出力を 0.2.4 と比べた）。
  - **グループが先** — 一覧はグループ（`launch: false` の見出しとその中の全部）→ ほかのプロジェクト → 過去の会話の順で、それぞれ見出しの行の下に並ぶ（空の区分には見出しを出さない）。入れ子の項目はツリーで描く代わりに字下げし、グループの中の行の末尾にグループの名前を薄く出すので、グループの名前を打つと、そのグループ・そのプロジェクト・その会話だけに絞れる。絞り込みの間も並びを保ち（`--no-sort`）、検索を直すたびにカーソルを一番上の当たりに戻し（`change:first`）、カーソルは見出しの行に止まらず、右端で当たっても行が横に流れて名前が隠れなくなった（`--no-hscroll`）。
  - **バッジの代わりにカード** — 行は名前と説明だけ。プレビューは行ごとにカードを出す: Enter で何が起きるか・フォルダ（`~/…`）・最後に使った時・保存していない変更 / 申し送り / 保留の物 / つながっているサービスをやさしい言葉で・最近の話題・過去の会話ならツールの置き換えの無い会話そのもの。フォルダが無い時ははっきりそう言い、代わりに Enter がどこで開くかを言う。時刻は話し言葉で出す（たった今 / N 分前 / N 時間前 / きのう / N 日前 / 10月25日）。暦に合わせる。
  - **行き止まりで案内する** — 見出し・グループ見出し・空の結果の上で Enter を押すと、何もしない代わりに案内の行に 1 行の理由を出す。Esc の後は戻り方を出す。開く物が何も無い時は、空の選ぶ画面の代わりにプロジェクトの足し方を出す（`.` / `--resume` の時は、まだ会話が無いこと）。走査が読めない `repos.yml` は枠でそれを知らせ、選ぶ画面を閉じた後にエラーを出す。狭い端末（およそ 100 桁より狭い）では、プレビューを一覧の下に出す。
- `ccs-scan --print-ui` は `ui=<mode>` を出す（ランチャーはもう走らせている事前の走査から `defaults.ui` を知るので、既定の起動でプロセスは増えない）。値は `ccs --no-scan` のためにキャッシュの meta の表（`defaults_ui`）にも入り、`ccs-list --print-ui` で読み返す。
- `test/tty/ccs_tty.py` — 標準ライブラリだけの擬似端末の試験の道具（小さな VT100 の画面の模型。fzf のカーソル位置の問い合わせに答える）と `test/ccs-tty.test.ts`。本物の fzf で simple の見た目を 120x36 と 80x24 で動かす。python3 か fzf 0.61 以上が無い時は飛ばす。

### 変更
- 最初の起動で作る `repos.yml` のひな形に `# ui: simple`（コメントアウト）を書いた。
- `defaults.ui` は `simple` か `classic` でなければならない。ほかの値は設定のエラー（黙って既定に戻さない）。

## [0.2.4] — 2026-10-21

### 追加
- **グループ見出し（`launch: false`）** — `launch: false` の付いた repos.yml の項目は、起動してはいけない親フォルダのための、表示だけの見出しの行（`KIND=group:<name>`）として並ぶ。その `path` の中のリポは、今までの「一番深いパス」の決まりでその下に入れ子になる。見出しの上の Enter（とダブルクリック）では選ぶ画面が開いたまま（fzf 0.45 以上の `transform` のバインド。`fzf --version` で見分ける。古い fzf は区切りの行と同じく、行を受けて ccs が静かに終わる）。`^I` は見出しのパスをコピーし、`^Y` は何もコピーせず、`^D` はリポの行と同じ「repos.yml を書き換える」の注意を出す。プレビューは見出しのパス・説明・起動できないことの注意・その項目（表示名と相対のフォルダ）を出す。見出しにはバッジが付かず、リポの走査でも飛ばす。見出しには `path` が必須で、`launch` は本物の真偽値で書く（引用符付きの `"false"` は `true` に読み替えずに断る）。
- **表示名（`label`）** — 任意の `label` を、リポの行・`‹parent›` のヒント・プレビューの題に `name` の代わりに出す（題では後ろに `name` を薄く出す）。ほかのどこでも一意のキーは `name` のまま。過去のセッションの行は `name` を出し続ける。`description` と同じく表示専用: シェルのメタ文字は使ってよく、制御文字は出す時に取り除く。

### 変更
- **入れ子のリポをツリーで描く** — 子は、前の兄弟には `├ `、最後の物には `└ ` を使い、深い入れ子では祖先にまだ後の兄弟がある間 `│ ` の縦の罫線を引く（前はどの子も `└ ` だった）。薄い `‹parent›` のヒントは親の表示名を使い、行自身の表示名と同じ時は省く。
- **スキーマ v3** — `repos.launch INTEGER NOT NULL DEFAULT 1` と `repos.label TEXT NOT NULL DEFAULT ''`（ただの `ADD COLUMN`）。ccs-list / ccs-preview（読むだけ・移行しない）は、まだ移行していない v2 のキャッシュでは既定の値を補う。0.2.3 も v3 のキャッシュで動き続ける: その repos の文は列を名指しするので、新しい列は入れる時に既定の値を取り、読まれない。

### 修正
- **空の列で、選んだ行がずれなくなった** — `bin/ccs` は選んだ行を `IFS=$'\t' read` で分けていて、TAB は IFS の空白なので、空の列がつぶれていた: `description` の無いリポを起動できなかった（KIND:KEY に cwd が入って `Unknown row kind`）。今は読む前にタブを `\x1f` に替えるので、空の欄が残る。
- `path` の無い repos.yml の項目が、一覧の入れ子でほかの全リポの親と数えられなくなった（空のパスが、どの絶対パスにも先頭で当たっていた）。

## [0.2.3] — 2026-10-14

### 追加
- **入れ子のリポを一覧でまとめる** — `path` がほかの一覧のリポの `path` の中にあるリポは、名前の順の場所でなく、そのリポのすぐ後に字下げして並ぶ（`  └ 📁 child  ‹parent›`）。一番近い外側のパスが勝ち（セッションをリポに結ぶのと同じ「一番深いパス」の決まり）、深い入れ子ほど深く字下げし、兄弟は名前の順のまま。薄い `‹parent›` の後ろ書きで、fzf の検索が親の行を隠しても関係が読め、親の名前の検索で子も当たる。一覧を作る時に `path` から決める — `repos.yml` のキーもキャッシュの移行も無い。無効にした親は一覧に出ないので、その子は一番上の階層に残る。

## [0.2.2] — 2026-06-21

### 修正
- **バージョンのずれ** — `bin/ccs` はバージョンの文字列を書き込まなくなった。スクリプトの横の `package.json` から `version` を読むので、`ccs --version` がいつもパッケージのバージョンと合う。0.2.1 の公開では、bash の定数を `package.json` と一緒に上げていなかったので `VERSION="0.2.0"` のまま出ていた。コピーインストールの置き方（install.sh は `bin/ccs` を `package.json` なしで `~/.claude/scripts/` に置く）では `0.0.0-dev` になる。

## [0.2.1] — 2026-06-21

### 追加（v0.2.1 の機能）
- **`ccs init --auto-discover [--depth N]`** — `$HOME`（既定の深さ 5）から git の checkout のルートを探し、雑音のフォルダ（`node_modules`・`Library`・隠しフォルダ…）を外し、リポのルートで止まり、symlink を飛ばし、もう `repos.yml` にあるリポを除き、残りを fzf の複数選択で出す。選んだ物はコメントと書式を保って（yaml の `parseDocument`）`repos.yml` に足し、`.bak` のバックアップと、全体の検証に落ちた時の巻き戻しを持ち、すぐに索引を作る。ただの `ccs init` は設定のひな形を作る。
- **アカウントなしで npm から入れる** — `npm install -g github:indigo-gr/claude-code-station` が最後まで動くようになった: `bin/ccs` は npm のグローバルの bin の symlink を通して `$0` をたどり、横の部品を見つける。`tsx` は実行の依存として入り、`PATH` の物よりパッケージの中の物を優先する（グローバルの tsx が要るのは、ただの checkout で使う時だけ）。`files` の欄で tarball を小さく保つ。`npm pack` と、別の prefix の中でのグローバルのインストールで確かめた。

### 修正（レビュー 2026-06-12 — 4 つの観点の守りのレビューの片付け）
- **C-2（High）** — `ccs-delete.sh` が、`rm` の失敗で `set -e` のもと黙って死ななくなった: 失敗を知らせ、「Press Enter」の問いも出し、終了コード 1 で終わる。`du` の失敗（途中でファイルが消えた）では、スクリプトを止めずに `?` にする。
- **C-1（High）** — `git log` の解釈で、タブでなく NUL（`%x00`）の区切りを使う。commit の題に生のタブがあっても分け方がずれず、題のかけらが `last_commit_at` に入らなくなった。題にタブのある commit で戻りを確かめる試験を足した。
- **C-4** — 50MB の上限を超えて育ったセッションの JSONL は、（古いが再開できる）行を残し、新しい大きさと mtime を書き、走査のたびに読み直さなくなった。前は行がずっと古いままで、しかも永遠に読み直しを試みていた。
- **C-5** — `ccs-list` の最初の起動のやさしいヒントが死んだコードだった: `isMissing` の形が `openDb()` の実際の「state.db not found」の文に当たらなかった。形を足し、戻りを確かめる試験はやさしい分かれを名指しで確かめる（前の試験は生の致命的な経路で通っていた）。
- **C-3** — Twilio の Account SID を伏せる形が、大文字の 16 進を受ける（`AC[a-fA-F0-9]{32}`）。
- **DA-3** — `buildRepoResolver` は各リポのルートを realpath でも登録するので、symlink のパスで登録したリポ（や macOS の `/var` の別名）も自分のセッションを取る。
- **A-8** — どのリポにも結ばれないセッションは、決まった順（`defaults.command` > `CCS_CMD` > `"claude"`）で起動する（新しい `meta.defaults_command` の値を通す）。前は `"claude"` を書き込んでいた。
- **A-10** — `--current-only` を SQL で絞る（`cwd = ? OR (cwd >= ? AND cwd < ?)`）ので `idx_sessions_cwd` が効く。cwd を文字列の先頭に持つ兄弟のフォルダは、作りの上で外れる。
- **A-6** — 決まった `defaults.command`（`CCS_CMD`/`CCR_CMD` から来た物を含む）は、それを受け継ぐリポが無くても `loadConfig()` で SHELL_METACHARS を検証する。
- **K-4** — `command` / `custom` の ConfigError の文に、ほかの検証エラーと同じく `repos.yml: repos[i].field` の前置きを付ける（Phase 6 の「at index」の言い方はやめた）。
- **K-9** — `npm test` は `node --import tsx --test` で動く（資料に書いた Node 20 以上で動く。Node 23.6 以上の型の除去だけではない）。`MODULE_TYPELESS_PACKAGE_JSON` を黙らせるため `"type": "module"` を足した。
- **K-10** — `install.sh` は入れたファイルを `ls | grep` でなく `find -maxdepth 1` で並べる（SC2010）。

### 変更（レビュー 2026-06-12 — 作り）
- **A-4** — セッションの索引作りを `ccs-scan.ts`（999 行）から `bin/ccs-scan-sessions.ts` に出した。`parseSessionJsonl` / `buildRepoResolver` / `scanSessions` を export し、単体で試験できる。
- **A-1 / A-2 / A-3 / K-8** — 新しい `bin/ccs-utils.ts` が、`truncate`・`timeBucket` / `formatRelativeTime` / `formatDateTime`・`extractText`（ツールのブロックはオプションで明示した時だけ）・`UUID_RE`・`MAX_JSONL_SIZE` の唯一の元になる。一覧とプレビューのコピー（空白の扱いと日本語/英語の後ろ書きで、もうずれていた）は無くした。相対の時刻は英語でそろえて出す（「5m ago」）。一覧のセッションのバッジは、解釈できない時刻では DB の生の文字列でなく `-` を出す。
- **スキーマ v2** — 新しい `meta(key, value)` の表（何度流しても同じ移行。読むだけの側が v2 より前のキャッシュを読む時、`getMeta` は null に落ちる）。

### 試験（レビュー 2026-06-12）
- 新しい `test/ccs-utils.test.ts` で、まとめたヘルパーの意味を固める（しきい値・制御文字の除去・ツールのブロックの取り出し・UUID の点検）。
- 戻りを確かめる新しい試験: commit の題のタブ（C-1）・疎な `ftruncate` での大きすぎる JSONL の残す/触る/飛ばす（C-4）・symlink のリポのセッションの結び付け（DA-3）・最初の起動のやさしいヒント（C-5）・結ばれないセッションのコマンドの代わりの順（v2 より前のキャッシュでの落ち方を含む）（A-8）・`--current-only` の完全一致/下のフォルダ/兄弟の先頭一致（A-10）・`defaults.command`/`CCS_CMD` から来た物の検証（A-6）・大文字の Twilio SID（C-3）・meta の読み書きの往復と v1→v2 の上げ。
- 設定の試験の `freshImport()` のコメントが、本当の事を言うようにした: ESM のキャッシュは捨てていない。部品の状態のリセットは export した hook を通す（C-6）。
- 110 の試験が、全部通る。

### 資料（レビュー 2026-06-12）
- 戻りの点検表の #4（秘密の形: 26 にまとめた）と #18（危ないコマンドの警告は Phase 6 S2 で外した）を直した。古い `isUnderHome` の残りの項目を閉じた（監査 M-4 で直った）。README の作りの図に bin/ の 14 の部品を全部載せた。`REVIEW.md` にメタ文字を固く断る今の動きを書いた。`sqlite-schema.md` にスキーマ v2 とセッションを先にする走査の順を書いた。`repos-yml-schema.md` に NEW-3 の名前の決まり・まとめたエラーの形・結ばれないセッションの代わりの順を書いた。

### 修正（レビュー 2026-06-12 — 続きのまとめ）
- **トランザクションの中の COUNT(*)** — `scanOneRepo` はセッションの集計を書くトランザクションの中で読むので、別のプロセスがセッションの変更を commit しても、読む時と `repo_stats` の upsert の間に割り込めなくなった。
- **走査の勧告ロック** — `<cacheDir>/scan.lock`（O_EXCL で作る・5 分で古いと見て引き継ぐ）: 同時に動く 2 つ目の走査は、セッションの片付けと競わずに、標準エラーに一言書いて飛ばす（元の CR2 H3）。`ScanResult.lockSkipped` で飛ばしたことが分かる。
- **PRAGMA の調整** — 書く経路の接続は `cache_size = -8000`・`temp_store = MEMORY`・`mmap_size = 64MB` を設定する（読むだけのプレビューの経路はそのまま）。
- **install.sh の実行の依存** — リポの checkout の `node_modules` をインストール先に symlink するので、入れたスクリプトが `better-sqlite3`/`yaml` を見つける（残りの項目の HIGH の当座を閉じる。npm のパッケージで配るのが長い目での計画のまま）。
- **パイプの標準入力での問いの表示** — `ccs-delete.sh` と `install.sh` は、標準入力が TTY の時しか bash が出さない `read -p` に頼らず、問いを明示して標準エラーに出す（`prompt_read` のヘルパー）。TTY での動きは変わらない（`read -p` も標準エラーに書く）。スクリプトやパイプで使っても問いが消えなくなり、シェルの試験で問いを確かめる。

### 試験（レビュー 2026-06-12 — 続きのまとめ）
- 新しい `test/ccs-shell.test.ts`: 今まで試験の無かった bash の部分 — `bin/ccs --version/--help` と `ccs-delete.sh` の全部の組み合わせ（UUID でない物の拒否・見つからない・確かめての削除（サブエージェントのフォルダの削除を含む）・断った削除・C-2 の rm の失敗の分かれ）— を、HOME/XDG を別にした node:test と spawnSync で動かす。bats には頼らない。
- 勧告ロックの試験: 新しいロック → 飛ばす。古いロック → 引き継いで放す。
- 118 の試験が、全部通る。

### セキュリティ（監査 2026-06-12 の強化）
- **H-1 / NEW-1 — セッションの取り込みの掃除**: セッションの `.jsonl` の `cwd` が、点検なしに Ctrl-Y のクリップボードのコマンドに届かなくなった。セッションの `cwd`/`topic`/`summary`/`branch` とワークスペースの `first_line` は、共通の `bin/ccs-sanitize.ts` で走査の時に点検する: シェルのメタ文字のある `cwd` は `"unknown"` の目印に替え（貼り付けた時の後からのコマンドの注入を防ぐ）、ESC を含む制御文字は取り除く（`--ansi` の fzf の一覧とプレビューでの ANSI・端末のエスケープの偽装を防ぐ）。
- Ctrl-Y のクリップボードの行は `cwd`/`uuid` を `%q` で引用する（H-1 の重ねの守り）。一覧とプレビューの描く側でも制御文字を取り除く（NEW-1 の重ねの守り）。
- **NEW-3** — `repos.yml` の `name` は `SHELL_METACHARS` を全部断る（前は `\t \n \\` だけ）。`path`/`cwd`/`command` の決まりとそろえた。
- **NEW-2** — `bin/ccs` の `new:` の行の検証は、シェルのメタ文字に加えて制御文字（ESC を含む）も断る。
- **M-1** — 秘密の形を 19 → 26 に広げた: GitLab の PAT・GitHub の fine-grained PAT・Google の OAuth の secret・SendGrid・npm のトークン・Slack の webhook の URL・一般の `KEY=value` の形・どのスキームでも `user:pass@` の URL の資格情報。
- **M-2** — セッションの `cwd` も `maskSecrets` に通す。プレビューの欄の上の項目（`cwd`/`branch`/`version`）も伏せる。
- **M-3** — `ccs-delete.sh` のキャッシュの片付けは、文字列をつないだ SQL でなく、パラメーターを結んだ削除（`bin/ccs-delete-session.ts`）を使う。
- **M-4** — `isUnderHome` は symlink を解く（`realpathSync`）ので、`~/escape -> /` で HOME を抜けられなくなった。
- **L-1** — `bin/ccs` の HOME の点検は、`$HOME` そのものか `$HOME/` の下の物を求める（`/Users/xEVIL` のような隣のフォルダは断る）。
- **L-2** — サブエージェントのフォルダの `rm -rf` を、最後の形 `<projects>/<dir>/<uuid>` の点検で守る。

### 修正（監査 2026-06-12 の論理）
- **C-1（critical）** — `scan()` はリポの走査の前にセッションの走査を流すので、`--refresh` 1 回の後で `repo_stats.session_count_total` / `session_last_at` が正しい（前は 1 回分遅れ、新しい DB ではどのリポも `💤 未使用` と出ていた）。
- **論理 H-1** — `--no-sessions` の走査は、セッションの集計を 0 に戻さずに前の値を残す。
- **H-2 / M-1（時刻）** — 一覧とプレビューは DB の時刻を共通の `bin/ccs-time.ts` で解釈し、SQLite の素の `datetime('now')` の値を UTC として扱う（JST のずれが無くなった）。`sessions.indexed_at` は ISO 8601 で書き、DB の中の時刻の形を 1 つにした。
- **H-3** — プレビューの「Recent」のセッションは、「Total」の件数と同じ `WHERE repo_name = ?` の集まりを使う（Total と Recent が食い違わなくなった）。
- **H-4** — `message_count` は `user`/`assistant` の行だけを数え、プレビューと合わせた。
- **M-4（論理）** — リポの下のフォルダで始めたセッションは、一番長い先頭一致でそのリポに結ぶ。
- **M-3（論理）** — 結ばれないまま残ったセッション（セッションの後にリポを足した）は、後の走査で結び直す。
- **M-2（論理）** — `scan: false` のリポには `[scan off]` のバッジを出し、止まった数字を今の物と読まないようにした。
- **M-5** — `extractUserText` はすべての文のブロックをつなぐ（プレビューと合わせた）ので、話題が最初のブロックで切れない。
- **M-6** — `started_at` / `last_activity_at` は、行の最初と最後でなく、時刻の最小と最大を使う。
- **L-1（論理）** — `parseInt` の結果は、DB に書く前に `Number.isFinite` で守る。
- **L-3 / L-4（速さ・丈夫さ）** — ワークスペースのフォルダのプレビューは並行に `stat` し、各ファイルの最初の 4 KB だけを読む。キャッシュ（と WAL の横のファイル）の chmod の失敗は、黙って失敗せずに警告する。
- **NEW-4** — DB の接続に `busy_timeout = 3000` を設定したので、同時の `--force` の走査が `SQLITE_BUSY` で失敗しない。
- `ccs-preview-session.ts` の古い `ccr-preview.ts` の先頭のコメントを直した。

## [0.2.0] — 2026-04-26

### 変更
- `claude-code-recall`（ccr）から `claude-code-station`（ccs）に**改名**した。実行ファイル・リポ・設定のパスはどれも新しい名前に従う。
- 環境変数 `CCR_CMD` → `CCS_CMD`。`CCS_CMD` が無い時は、今も `CCR_CMD` を読む（標準エラーに deprecation の警告を出す）。
- Node.js の下限を **20** に上げた。

### 追加
- **混在表示のランチャー**: 1 つの fzf の一覧に、`NEW` のリポの行（新しく起動）と `RESUME` のセッションの行（過去を再開）を両方出す。
- プレビューの欄の**リポジトリの状態のバッジ**: git の状態・handoff/ のファイルの数・pendings/ のファイルの数・連携のリンク。
- **SQLite の状態キャッシュ**（`~/.cache/ccs/state.db`。または `$XDG_CACHE_HOME/ccs/state.db`）。WAL モード・外部キーを有効・prepared statement だけ・権限 `0600`。
- **設定ファイル** `~/.config/ccs/repos.yml` とスキーマの検証。最初の起動でひな形を自動で作る。スキーマの全体: `docs/design/repos-yml-schema.md`。
- **リポジトリごとのカスタムの連携の欄**（`custom:` の map）: Plane・Attio・Notion・Linear・Slack・GitHub・Figma の決まったキー。知らないキーは "Other Integrations" の下にそのまま出す。
- **新しいフラグ**: `--new`・`--resume`・`--refresh`・`--no-scan` と、知らないフラグをそのまま渡すこと。
- **新しいキーのバインド**: fzf の中から `Ctrl-R` で DB を強制的に更新する。
- **依存**: `better-sqlite3 ^11.3.0`・`yaml ^2.6.0`。
- `install.sh --with-deps`: インストールの一部として `npm install` を流す、選んだ時だけのフラグ。

### セキュリティ
- SQLite へのアクセスはすべて prepared statement を使う。外部キーを有効にする。
- 設定とキャッシュのディレクトリはモード `0700`、DB は `0600` で作る。
- `custom:` の値は、信頼する利用者の設定として資料に書いた。README で API キーを入れないよう注意している。

### セキュリティ（Phase 6 の強化）
- `command:` の設定の欄でシェルのメタ文字を断る（S1/S2 — 悪意のある repos.yml からの注入を防ぐ）
- ローカルの DoS を防ぐため、`custom` の欄の JSON の大きさを 64KB までにする
- `sessions.topic` と `sessions.summary` の列にも `maskSecrets` を当てる（前は handoff/pending の first_line だけだった）
- 秘密の形を 13 → 19 に広げた: AWS STS（ASIA）・Stripe の live/test・Twilio・JWT・データベースの URL

### 修正（Phase 6 の品質）
- `ccs-list.ts` は、SQLite を読むだけのモードで、移行を飛ばして開く（前の M4 の修正の戻り）
- `ccs-scan.ts` の CLI の起動は、同期の throw で正しく 0 でない終了コードで終わる
- `ccs-preview-session.ts` を同期の fs から非同期の fs/promises に替えた。CLI は `undefined` のセッション ID を防ぐ
- `deleteReposNotIn` は `json_each` を使い、SQLite の変数 999 個の上限を避ける（500 以上のリポを扱える）
- 引用符の無い `cut -f` の結果を、`IFS` で読む形に替え、空白があっても行を正しく分ける
- fs/path の import をすべて `node:` の前置きにそろえた
- 古い `ccr-delete.sh` の先頭のコメントを `ccs-delete.sh` に直した
- `sqlite-schema.md` の依存の注意を直した（誤解を招く `npm install -g` を外した）
- `ccs-list.ts` は、チルダの置き換えに `process.env.HOME || ""` でなく `homedir()` を使う

### 追加（Phase 8 — 使い心地の仕上げ）
- `ccs-list.ts` は、NEW のリポと RESUME のセッションが両方ある時、その間に薄い `── Past Sessions ──` の区切りを出す。区切りを選んでも何もしない。
- 登録したリポに結ばれない RESUME のセッションは `❓` を出し、「その場で 1 回だけ使ったか、まだ登録していないリポ」と見て分かるようにした。結ばれたセッションはリポのアイコン（既定は `📁`）を出す。
- `Ctrl-Y` / `Ctrl-I` はコピーの後に fzf を閉じなくなった — `📋 Copied…` のヘッダーを一瞬出し、選ぶ画面を開いたままにするので、`ccs` を打ち直さずに起動やコピーをもう一度できる。
- 名前の列に、リポやセッションの名前と説明の間の薄い `│` の区切りを足した。説明が空でも見て分かる。

### 修正（Phase 8 — CR4 の対応）
- `bin/ccs`: 区切りの行での Enter で `❌ Could not parse selection` が出なくなった — 空の `ROW_CMD` の守りを、動かせる行だけに絞った。
- `bin/ccs`: 狭い端末で安全に — ヘッダーの 2 行目を 81 → 63 文字に縮め、80 桁の端末で折り返さないようにした。
- `bin/ccs`: 新規の行の Ctrl-D の知らせの `read -r -n1 _` は、どのキーでも受ける（「press any key」と言いながら Enter を待っていた）。
- `bin/ccs-list.ts`: `sessionToRow` の要らない非 null アサーションを外し、TS の型の絞り込みのために `s.repo_display` を直に見る。
- `bin/ccs-list.ts`: 区分の区切りを出す条件は、遠回しの `lines.length > 0` でなく明示の `wantRepos` のフラグを使う。後から前置きの行を足しても、誤って区切りが出ない。
- `install.sh`: `fzf >= 0.42.0` を確かめる（コピーの知らせで使う `change-header` のバインドに要る）。
- `README.md`: `fzf ≥ 0.42.0` を明記し、`^Y`/`^I` のコピーの後も開いたままの動き・結ばれないセッションの `❓` のアイコン・区分の区切りを書いた。

### 修正（Phase 7 — CR3 の対応）
- `ccs-list.ts`: 最初の起動のエラー（state.db がまだ無い）で、生のスタックトレースの代わりにやさしいヒントを出す
- `ccs-scan.ts`: DB に書く前と標準エラーに出す前に、`last_commit_subject` と `scan_error` に `maskSecrets` を当てる
- `ccs-db.ts`: `DbHandle.close()` が `wal_checkpoint(PASSIVE)` を行い、WAL のファイルがたまらないようにする
- `ccs-preview-session.ts`: 残っていた素の `"path"` / `"os"` の import を `node:` の前置きに替えた
- `docs/design/repos-yml-schema.md`: スキーマの表に、`command` のシェルのメタ文字の検証の行を足した

### 移行
- `~/.claude/projects/*/*.jsonl` の下の今までの JSONL のセッションは、最初の走査で自動で見つかる — 手で移す物は無い。
- 古い実行ファイルを消す: `rm ~/.claude/scripts/ccr*`。
- シェルの設定ファイルで `CCR_CMD` → `CCS_CMD` に名前を変える。

## [0.1.3] — 2026-03-11

### 修正
- 再開と削除に、中の `sessionId` でなく JSONL のファイル名の UUID を使う。中の id がファイル名と違うサイドチェーンのセッションで、プレビューと削除が「Session file not found」のエラーになっていた。
- セッションの要約を作る時、`[Request interrupted by user]` のメッセージを飛ばす。

## [0.1.2] — 2026-03-11

### 追加
- 狭い端末向けに、幅に合わせて変わる 2 行の fzf のヘッダー（80 桁より狭い → 短いラベル、80 桁以上 → 全部のラベル）。

## [0.1.1] — 2026-03-11

### 修正
- `exec` をやめて直に呼ぶようにしたので、`CCR_CMD` に外のコマンドだけでなくシェルの関数（例 `opr`）も使える。

## [0.1.0] — 2026-03-11

### 追加
- `claude-code-recall`（ccr）として最初のリリース。
- `~/.claude/projects/*/*.jsonl` の全部をまたぐ、fzf のセッションの選ぶ画面。
- 会話の履歴を出すライブプレビューの欄。
- `Ctrl-Y`（再開のコマンドをコピー）・`Ctrl-I`（セッション ID をコピー）・`Ctrl-D`（セッションを消す）のキーのバインド。
- OS をまたぐクリップボード: `pbcopy`（macOS）・`xclip` / `xsel`（X11）・`wl-copy`（Wayland）。
- 自分の claude のラッパーのコマンドのための環境変数 `CCR_CMD`。
- UUID の検証・`$HOME` の下のパスの検証・プレビューの秘密を伏せること・JSONL の 50MB の大きさの上限。
- MIT ライセンス。
