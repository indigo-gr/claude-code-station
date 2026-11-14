# 機械で読む口（machine interface）設計

> ccs v0.5.0 — GUI のランチャー・スクリプト・ほかの道具が、端末の画面（fzf）を通さずに ccs を呼ぶための口。読む口（`doctor`・`list`・`sessions`・`config get`）と書く口（`repo add`・`repo remove`・`config set`）と起動の口（`open`）を、同じ約束で決める。

`repos.yml` のキーと書き方の約束は `repos-yml-schema.md`（「契約」の節）が正。この資料は、その上に乗る CLI の口の形を決める。本体と食い違ったら、出す前にどちらかを直す（資料だけを黙って本体に合わせない）。

終了コード・状態の語・`doctor --json` の必須のキーは、ccs を呼ぶ側（GUI のランチャーなど）が製品をまたいで決めた Health の枠に合わせてある。枠が変わったら、この資料を直してから本体を直す。

---

## 1. 共通の約束

### 1.1 入口と名前

- 新しい口は、`ccs` の **最初の引数** が次の語の時だけ働く（今の `ccs init` と同じ形・`bin/ccs` の引数の解釈より前に分ける）

  | 語 | 口 |
  |---|---|
  | `doctor` | 自己診断 |
  | `list` | 台帳の一覧 |
  | `sessions` | 前の会話の一覧 |
  | `repo` | 台帳を足す・外す（`repo add`・`repo remove`） |
  | `config` | 設定を読む・変える（`config get`・`config set`） |
  | `open` | fzf を開かずに起こす |

- 6 語は最初の引数で分け、起動するコマンドには渡さない。`command` は `config get`・`repo add` のように 2 語目まで（`repo`・`config` の 2 語目が無い → 2 `missing_argument`・知らない 2 語目 → 2 `invalid_argument`）
- 新しい口はどれも fzf を開かない・標準入力を読まない・問いかけない（`open --here` が起こす Claude Code だけは別）。TTY が無くても動く
- 新しい口はどれも更新の確認をしない（ネットに出ない・更新のキャッシュも読まない）。更新の確認は今のとおり、一覧を開く時だけ
- 新しい口はどれも初回のひな形を作らない（`repos.yml`・`README.md`・キャッシュのフォルダ）。書く口（`repo add`）が `repos.yml` を新しく作る時だけは別（4.1）
- 環境変数は今の物をそのまま効かせる: `XDG_CONFIG_HOME`・`XDG_CACHE_HOME`（置き場）・`CCS_CMD`・`CCR_CMD`（起動コマンドの優先順）。`CCS_UI` は新しい口の出力の形を変えない（`doctor` の `settings.ui` に値として出るだけ・2.1）

### 1.2 今の動きとの違い（出す前に読む側に知らせる物）

v0.5.0 は起動の形を変えるので、`repos-yml-schema.md` の「`repos.yml` のほかに約束に入る事」に従い、tag を打つ前に読む側に知らせる。

| 違い | 前 | v0.5.0 | 回り道・移り方 |
|---|---|---|---|
| 最初の引数の 6 語 | ccs が知らない引数として起動するコマンドに渡る（`ccs doctor` は一覧を開き、選んだ項目で `claude doctor` を起こす・`ccs config` も同じ） | ccs の口になる | 起動するコマンドに渡したい時は、前にフラグを置く（`ccs --new doctor`。最初の引数でなければ今のまま渡る） |
| 一覧が止まる時の理由の語 | `invalid-package-config`（kebab-case） | `invalid_package_config`（1.3 の書き方に v0.5.0 で揃える） | 標準エラーの文は約束の外だが、語を拾っている人のために CHANGELOG に書く |
| `disabled`・`scan` の値 | 真偽に丸める（`"false"` が true になる） | 真偽値だけ。文字列などはエラー | `repos-yml-schema.md` のバリデーションルール |
| `description`・`icon` の空（YAML の null） | 文字列の `"null"` になる | 未指定として扱う（バグの直し） | 同上 |
| `repos:` が 1 行の形（`[…]`）の時の `ccs init --auto-discover` | 1 行の形のまま書き足す | 書き足さずに断る（`ccs init` は今の失敗と同じ 1・`repo add` は 6。どちらも理由の語 `flow_style_repos`・ファイルを書き換えない） | ブロックの形に書き直してから足す |

### 1.3 JSON の形

全部の口に共通の外側:

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "product_version": "0.5.0",
  "command": "list",
  "written_at": "2026-11-13T02:30:00.000Z",
  "status": "ok",
  "reasons": [{ "vocab": "ccs.cli", "code": "ok" }]
}
```

| キー | 型 | 意味 |
|---|---|---|
| `schema_version` | string | この資料の機械の口の形のバージョン（semver）。全部の口で 1 つ。足すだけの変更は minor、壊す変更は major を上げる。読む側は major だけを見る |
| `product_id` | string | いつも `ccs` |
| `product_version` | string | `ccs --version` と同じ値（読めない置き方では `0.0.0-dev`） |
| `command` | string | 口の名前（`doctor`・`list`・`sessions`・`config get`・`config set`・`repo add`・`repo remove`・`open`） |
| `written_at` | string | 出した時刻（ISO 8601 の UTC）。TS の部品が出す時はミリ秒つき（`2026-11-13T02:30:00.000Z`）、部品が答えず `bin/ccs`（bash）が組む時は秒まで（`2026-11-13T02:30:00Z`） |
| `status` | string | 状態の語（1.4 の表）。終了コードと 1 対 1 |
| `reasons` | array | `{ "vocab", "code" }` の配列。1 件以上。成功の時は `[{ "vocab": "<語彙>", "code": "ok" }]` |

- **語彙は 2 つ**: `ccs.health`（`doctor` の検査の結果の理由と検査の語・2.1）と `ccs.cli`（ほかの口の理由の語と、`doctor` の引数の誤り・中断の理由の語・1.5）。語彙の正はこの資料で、語は足すだけ（消さない・意味を変えない）
- `reasons[]` の要素には、語のほかに数だけの補い（`entry_index` など）を足すことがある（1.5）
- 機械が読む欄に自由な文を入れない。値は語（決まった一覧の中の物）・数・真偽値・バージョン・時刻・ID・利用者が `repos.yml` に書いた名前と表示名と説明（`list` のように、それを出すための口だけ）
- キーは英語の snake_case、**語の値も小文字の snake_case**（`invalid_package_config`）
- 時刻は ISO 8601 の UTC（`Z` 付き）。読めない値は `null`
- 読む側は未知のキーと未知の語を無視する（未知の `code` は `status` の意味だけで扱う）。壊す変更は `schema_version` の major を上げ、出す前に読む側に知らせる（`repos-yml-schema.md` の「契約」と同じ運び）
- 失敗の時も外側は必ず出す。口ごとの中身（`repos` など）は、失敗の時は出さない。ただし `doctor` は `failed` の時も `checks` を出す（どの検査が落ちたかが答えの中身のため）

### 1.4 終了コードと状態の語

ccs のどの口も同じ表を使う。

| 終了コード | `status` | 意味 | 呼ぶ側の共通の値 | 例 |
|:---:|---|---|---|---|
| 0 | `ok` | 成功（`doctor` は「動く」） | `ok` | 一覧を出した・書いた・端末に渡した |
| 1 | `failed` | 失敗（`doctor` は「動かない」） | `failed` | 書けない・書く間に別の手で変わった・`doctor` の前提の検査が `fail` |
| 2 | `usage` | 引数の誤り（今の `--ui=` の誤りと同じ 2） | `usage` | 知らないフラグ・引数が足りない |
| 3 | `unverifiable` | 確かめられない | `unverifiable` | 前提が読めない・権限が無い・検査が時間切れ |
| 4 | `missing_prerequisite` | 前提が足りないので実行しなかった（`doctor` 以外） | `missing_prerequisite` | `repos.yml` が無い／壊れている・macOS でない・端末のアプリが無い |
| 5 | `not_found` | 対象が無い | `failed`（理由の語で分ける） | 名前が台帳に無い・UUID がキャッシュに無い |
| 6 | `rejected` | 検査で断った | `failed`（理由の語で分ける） | `$HOME` の外・記号・名前の重なり・決まった値の外 |
| 7 | `partial` | 一部だけ済んだ（戻し方の案内が要る） | `partial` | 書いた後の検証に落ち、元に戻すのにも失敗した |
| 130 | `interrupted` | 中断した（SIGINT） | `interrupted` | Ctrl-C |

呼ぶ側の対応表（そのまま写せる形）:

```json
{ "0": "ok", "1": "failed", "2": "usage", "3": "unverifiable", "4": "missing_prerequisite", "5": "failed", "6": "failed", "7": "partial", "130": "interrupted" }
```

- **`doctor` が使うのは 0・1・2・3 だけ**（ほかは Ctrl-C で止めた時の 130）。前提が欠けて動かない時も `doctor` は 1（`failed`）で、どれが欠けたかは理由の語で分ける。4 は、`doctor` 以外の口が「前提が足りないので実行しなかった」時の値
- 読む側の決まり: `doctor` の 0・1・2 のほか（ccs が入っていない時のシェルの 127・シグナルの 128 以上を含む）は全部 `unverifiable` として読む。ほかの口で表に無い数は `failed` として読む
- `interrupted`: TS の部品は SIGINT を受けたらロックを外し、書きかけなら元に戻してから 130 で終わる（`--json` なら外側も出す）。bash の部分は `trap` で 130 にする。SIGTERM などほかのシグナルは今のまま（128 + 番号）
- 一覧を開く今の口（`ccs`・`ccs .`・`--new` など）と `ccs init` の終了コードは、この表に入れない（今のまま。`--version` の 0 と `--ui=` の誤りの 2 は変えない）
- `open --here` で Claude Code を起こした後の終了コードは、起こしたコマンドの物で、この表の外（4.6）

### 1.5 理由の語（語彙 `ccs.cli`）

`doctor` 以外の口の `reasons[].code`。`doctor` も、引数の誤り（`unknown_option`）と中断（`interrupted`）はこの語彙で出す（検査の結果は `ccs.health`・2.1）。足すだけで、消さない。

| 語 | `status` | 意味 |
|---|---|---|
| `ok` | ok | 成功 |
| `unknown_option` | usage | 知らないフラグ |
| `missing_argument` | usage | 要る引数が無い |
| `extra_argument` | usage | 余分な引数 |
| `invalid_argument` | usage | フラグの値の形が違う（`--limit` に数でない値・`--terminal` に一覧の外の値など） |
| `json_required` | usage | `--json` が要る口に付いていない（`list`・`sessions`） |
| `conflicting_options` | usage | 一緒に使えないフラグ（`--here` と `--new-window` など） |
| `config_not_readable` | unverifiable | `repos.yml` を読む権限が無い |
| `cache_not_readable` | unverifiable | `state.db` を開けない（権限・ロック） |
| `config_missing` | missing_prerequisite | `repos.yml` が無い |
| `config_invalid` | missing_prerequisite | `repos.yml` が ccs の検証に落ちる（詳しい語は `detail`） |
| `cache_missing` | missing_prerequisite | キャッシュ（`state.db`）がまだ無い |
| `no_tty` | missing_prerequisite | `open --here` に端末が無い |
| `unsupported_os` | missing_prerequisite | macOS だけの機能をほかの OS で呼んだ |
| `terminal_not_set` | missing_prerequisite | 端末のアプリが決まっていない |
| `terminal_app_missing` | missing_prerequisite | 決めた端末のアプリが入っていない |
| `unsafe_install_path` | missing_prerequisite | ccs の置き場のパスに記号が入っていて、新しいウィンドウに渡せない |
| `dependency_missing` | missing_prerequisite | Node・tsx・`claude` のどれかが無い（どれかは `detail`: `node`・`tsx`・`claude`。`open` が起こすコマンド（`CCS_CMD` などで替えた物を含む）が PATH に無い時も `claude`） |
| `repo_not_found` | not_found | その名前が `repos.yml` に無い |
| `session_not_found` | not_found | その UUID がキャッシュに無い |
| `path_outside_home` | rejected | パスが `$HOME` の外（書いた形・シンボリックリンクを解いた先のどちらか） |
| `path_not_found` | rejected | フォルダが無い |
| `path_not_directory` | rejected | フォルダでない |
| `path_taken` | rejected | 同じフォルダがもう台帳にある |
| `name_taken` | rejected | 同じ名前がもう台帳にある |
| `unsafe_characters` | rejected | シェルのメタ文字・制御文字（`SHELL_METACHARS`）が入っている |
| `needs_quoting` | rejected | YAML で引用符が要る値（1.6） |
| `invalid_value` | rejected | 値が決まった一覧の外・長すぎる・空にできない |
| `invalid_uuid` | rejected | セッションの ID が UUID の形でない |
| `key_not_settable` | rejected | `config set` で変えられないキー |
| `last_entry` | rejected | 最後の 1 件は外せない（`repos` は 1 件以上） |
| `flow_style_repos` | rejected | `repos:` が 1 行の形（`[…]`）なので書き足さない（`repo add`・`ccs init --auto-discover`） |
| `not_launchable` | rejected | 起動しない見出し（`launch: false`） |
| `repo_disabled` | rejected | `disabled: true` の項目 |
| `session_cwd_unknown` | rejected | 会話の作業フォルダが分からない・検査に落ちた |
| `command_unsafe` | rejected | 起動コマンドが記号の検査に落ちた |
| `config_changed` | failed | 読んでから書くまでに `repos.yml` が別の手で変わった（書いていない・もう一度呼べばよい） |
| `config_locked` | failed | ほかの ccs が `repos.yml` を書いている（書いていない） |
| `write_failed` | failed | 書けなかった（元のファイルのまま） |
| `validation_after_write_failed` | failed | 書いた後の検証に落ち、元に戻した（元のファイルのまま） |
| `restore_failed` | partial | 書いた後の検証に落ち、元に戻すのにも失敗した（元は `repos.yml.bak` にある） |
| `launch_failed` | failed | 端末のアプリに渡せなかった |
| `invalid_package_config` | failed | ccs より上のフォルダの `package.json` が壊れていて、Node が ccs の部品（`.ts`）を読めない（2.1 の `modules` の検査と同じ語） |
| `internal_error` | failed | 予期しない失敗 |
| `interrupted` | interrupted | SIGINT で止めた |

`config_invalid` の時は、その要素に `"detail": "<語>"` と、項目の番号が分かれば `"entry_index": <数>` を足す（名前とパスは出さない）。`detail` の語は 2.1 の `config` の検査の語と同じ一覧。

```json
"reasons": [{ "vocab": "ccs.cli", "code": "config_invalid", "detail": "duplicate_name", "entry_index": 2 }]
```

### 1.6 書く値の形（`repos.yml` を読む道具のため）

`repos.yml` は YAML のパーサを使わず行で読む道具にも読まれる（`repos-yml-schema.md` の「勧める書き方」）。ccs が書く `name`・`path` の値は、YAML で引用符なしに書ける物だけにする。

- 確かめ方: その値だけを `yaml` パッケージで書き出した結果が、元の値と同じ 1 行（引用符・ブロックの記号が付かない）。付くなら `needs_quoting` で断る（例 `2024`・`true`・`a: b`・`#x`・先頭の空白）
- `description`・`label` は引用符が付いてよい（行で読む道具は読まない）

### 1.7 出さない物

| 物 | 扱い |
|---|---|
| 秘密の値（キー・トークン） | どの口も出さない。会話の題は、取り込みの時に `maskSecrets` を通した物を、出す時にもう一度 `maskSecrets` に通す（2.3） |
| YAML のパーサの警告 | 既定で出さない（標準出力にも標準エラーにも。文に名前やパスが入ることがあるため） |
| 会話の中身（本文・要約） | 出さない。題（最初の依頼の 1 行）だけは `sessions --with-titles` の時だけ |
| リポのフォルダのパス | `list --with-paths`・`config get --with-paths`・`repo add --with-paths` の時だけ。`doctor` はフラグがあっても出さない |
| リポの名前 | `doctor` は出さない（数だけ）。`list`・`sessions`・書く口は、その口の目的なので出す |
| 起動するコマンドの文字列（`command`・`cwd`・`defaults.command`・`CCS_CMD`） | どの口も出さない。呼ぶ側は名前か UUID だけを渡し、ccs が起こす |
| `custom` の中身 | 出さない（ほかの道具が置いた値で、ID が入ることがある） |
| ユーザー名・ホスト名 | 出さない |

### 1.8 標準出力と標準エラー

- `--json` を付けた時、標準出力には JSON を **1 個だけ**（最後に改行 1 つ）出す。成功の時も失敗の時も出す。人向けの文は標準エラーにだけ出す
- `--json` を付けない時の出力は人向けで、約束の外（言葉も並びも変わってよい）。書く口は、`--json` が無い時は標準出力に何も出さず、標準エラーに 1 行だけ出す。`config get` は、`--json` が無い時は標準出力に `key = value` の行を出す
- `open --here` で検査を通って Claude Code を起こした時は、`--json` があっても外側の JSON を出さない（標準出力は Claude Code の物・4.6）
- 標準エラーの文は約束の外。機械は終了コードと JSON の `status`・`reasons` だけで分ける
- 標準エラーにも、既定ではリポのパスと名前・会話の中身を出さない（呼ぶ側がログに残すことがあるため）。出してよいのは理由の語・数・バージョン・設定ファイルの置き場の名前（`repos.yml`）。YAML のパーサの警告も既定で出さない

### 1.9 ネットと端末とファイル

| 口 | ネット | 端末 | 書くファイル |
|---|:---:|---|---|
| `doctor` | 出ない | 変えない | 設定とキャッシュの置き場には書かない（キャッシュも作らない・2.1 の注）。時間の上限のために `TMPDIR` に一時のフォルダを作り、終わる時に消す |
| `list --json` | 出ない | 変えない | 設定とキャッシュの置き場には書かない。`bin/ccs` が部品の標準エラーを `TMPDIR` の一時のファイルに受け、終わる時に消す |
| `sessions --json` | 出ない | 変えない | キャッシュ（`state.db`）を今の走査と同じに更新する。`--no-scan` なら書かない |
| `config get` | 出ない | 変えない | 書かない |
| `config set`・`repo add`・`repo remove` | 出ない | 変えない | `repos.yml`（と `.bak`・一時のロック）。`repo add` は `repos.yml` が無い時、設定のフォルダ（0700）と `repos.yml` を作る（検査に落ちたら両方を消す・4.1） |
| `open --here` | 出ない（起こしたコマンドは別） | 今の端末で Claude Code を起こす | 書かない |
| `open --new-window` | 出ない | 端末のアプリの新しいウィンドウを 1 つ開く | 一時の起動ファイル（開いた後に自分で消える・4.6） |

`doctor` は状態をファイルとして残さない（一時のフォルダは終わる時に消す）。呼ぶ側は `ccs doctor --json` を呼んで、その標準出力を読む。

---

## 2. 読む口

### 2.1 `ccs doctor [--json]`

前提と設定が「動くか」を、端末なし・fzf を開かずに確かめる。

**引数**: `--json` だけ。ほかは 2（`usage`・語彙 `ccs.cli` の `unknown_option`）。Ctrl-C で止めた時は 130（`interrupted`・語彙 `ccs.cli` の `interrupted`）。どちらも `bin/ccs` が答え、`--json` なら外側と `installed`・`running` だけを出す（`checks` は出さない）。

**2 段階で動く**: Node が ccs の部品（`.ts`）を読めない時（上のフォルダの `package.json` が壊れている・Node が無い）にも答えるため、`bin/ccs`（bash）が先に段階 1 を確かめ、段階 2（`bin/ccs-doctor.ts`）を走らせる。段階 2 が JSON を返さなかった時は、bash が段階 1 の結果と `modules` の検査だけで JSON を組んで出す（値は語と数とバージョンと時刻だけなので、bash の `printf` で組める。バージョンは `^[0-9A-Za-z.+-]{1,32}$` に合わない時 `null`。時刻は `date -u +%Y-%m-%dT%H:%M:%SZ` で秒まで）。bash が組む答えも `checks` は 11 個全部を表の順に出し、段階 2 の検査（`sqlite`・`config`・`config_layout`・`cache`・`terminal`・`groups_dir`）は `skipped`・`blocked` にする。`modules` は、段階 1 の `node`・`tsx` が `ok` でなく段階 2 を走らせなかった時は `skipped`・`blocked`、時間切れは `unknown`・`check_timeout`、Node の読み込みの失敗が分かれば `fail`（下の表の語）、ほかは `unknown`・`check_crashed`。

**時間の上限**: 段階 1 の `node --version`・`fzf --version` は各 5 秒。段階 2 は全体で 20 秒（試験のために環境変数 `CCS_DOCTOR_TIMEOUT` で 1〜999 秒に変えられる・形の外れた値は無視して 20 秒）。切れたら、その検査を `unknown`・`check_timeout` にする（段階 2 は `modules` の検査）。

**JSON の形**（外側は 1.3 と同じキーに、次を足す）:

| キー | 値 |
|---|---|
| `installed` | `installed`（`doctor` が答えた＝ccs の実体が読めた）。`not_installed`・`unknown` は ccs 自身は出さない（呼べない時に呼ぶ側が決める） |
| `running` | いつも `not_applicable`（ccs は常駐しない） |
| `reasons` | 全体を決めた検査の `code`（語彙 `ccs.health`）。`ok` の時は `[{ "vocab": "ccs.health", "code": "ok" }]`。引数の誤りと中断の時だけ語彙 `ccs.cli`（上の「引数」） |
| `checks` | `[{ "name", "status", "code" }]`（下の表の順）。検査によってバージョン・数を足す |
| `platform` | `{ "os": "darwin" \| "linux" \| …, "arch": "arm64" \| "x64" \| … }` |
| `settings` | `{ "ui", "update_check", "update_check_off_by" }`（2.1 の注） |

**検査**（`checks[]` の順。`required` の検査の結果で全体が決まる。`code` は語彙 `ccs.health`）:

| `name` | 段階 | required | 確かめる事 | `fail` の `code` | `warn` の `code` |
|---|:---:|:---:|---|---|---|
| `node` | 1 | ✅ | `node` があり、メジャーが 22 以上（下限は `bin/ccs` に持つ。コピーで入れた形には `package.json` が無いため。`package.json` の `engines.node` と同じ値に保つ） | `node_missing`・`node_too_old` | — |
| `tsx` | 1 | ✅ | パッケージの中か PATH に tsx がある | `tsx_missing` | — |
| `modules` | 1→2 | ✅ | 段階 2 が起動して JSON を返した | `invalid_package_config`（Node が `Invalid package config` を出した）・`module_load_failed` | — |
| `sqlite` | 2 | ✅ | `better-sqlite3` が読める | `sqlite_native_module_missing`・`sqlite_load_failed` | — |
| `fzf` | 1 | ✅ | `fzf` があり、0.42.0 以上（README と `install.sh` の下限） | `fzf_missing`・`fzf_too_old` | `fzf_too_old_for_headers`（0.45 未満。`ui` が `simple` でもこの語）・`fzf_too_old_for_simple`（0.45 以上 0.61 未満で、`settings.ui` が `simple`。一覧は classic で開く）。1 つの検査に語は 1 つ |
| `claude` | 1 | ✅ | `claude` が PATH にある（今の `check_deps` と同じ） | `claude_missing` | — |
| `config` | 2 | ✅ | `repos.yml` を ccs の検証に通せる | 下の語 | `config_missing`（一覧を開けば ccs が作る）・`unknown_keys`・`paths_missing`（両方ある時は表の順で `unknown_keys`） |
| `config_layout` | 2 | — | 行で読む道具にも読める書き方か（`repos-yml-schema.md` の「勧める書き方」）。`repos.yml` が無い時は `skipped`・`not_set`、`config` が `fail` の時は `skipped`・`blocked` | — | `flow_style_repos`・`name_path_not_direct` |
| `cache` | 2 | — | `state.db` を読み取り専用で開け、スキーマのバージョンが分かる | — | `cache_missing`・`cache_open_failed`・`cache_schema_newer` |
| `terminal` | 2 | — | `defaults.terminal` を決めていれば、その OS とアプリで使えるか（使えれば `ok`）。決めていなければ `skipped`・`not_set` | — | `terminal_unsupported_os`（macOS でない）・`terminal_app_missing` |
| `groups_dir` | 2 | — | `defaults.groups_dir` を決めていれば、読めるか。`defaults.groups_dir` を作る（6 章の順 9）までは、いつも `skipped`・`not_set` | — | `groups_dir_missing`・`group_files_skipped` |

`config` の `fail` の `code`（1.5 の `config_invalid` の `detail` と同じ一覧）: `config_not_readable`・`yaml_parse_error`・`not_a_mapping`・`unsupported_version`・`defaults_invalid`・`command_unsafe`・`repos_empty`・`entry_invalid`・`name_unsafe`・`duplicate_name`・`path_outside_home`・`path_unsafe`・`custom_too_large`。

**検査の状態の語**（`checks[].status`）と、その時の `code`:

| `status` | 意味 | `code` |
|---|---|---|
| `ok` | 通った | `ok` |
| `warn` | 動くが知らせる事がある | 上の表の `warn` の語 |
| `fail` | 動かない | 上の表の `fail` の語 |
| `unknown` | 調べる途中で落ちた・時間切れ | `check_timeout`・`check_crashed` |
| `skipped` | 前の検査が `fail` で調べられない・決めていない機能 | `blocked`・`not_set` |

**全体の決め方**:
1. `required` の検査に `fail` が 1 つでもあれば 1（`failed`）。`reasons` は `fail` の検査の `code` を全部（表の順）
2. そうでなく、`required` の検査に `unknown` があれば 3（`unverifiable`）。`reasons` は `unknown` の検査の `code`
3. そうでなければ 0（`ok`）。`warn` は `ok` のまま（`checks[]` で分かる）

**JSON の例**（値は架空）:

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "product_version": "0.5.0",
  "command": "doctor",
  "written_at": "2026-11-13T02:30:00.000Z",
  "status": "ok",
  "installed": "installed",
  "running": "not_applicable",
  "reasons": [{ "vocab": "ccs.health", "code": "ok" }],
  "checks": [
    { "name": "node", "status": "ok", "code": "ok", "version": "24.1.0" },
    { "name": "tsx", "status": "ok", "code": "ok" },
    { "name": "modules", "status": "ok", "code": "ok" },
    { "name": "sqlite", "status": "ok", "code": "ok" },
    { "name": "fzf", "status": "ok", "code": "ok", "version": "0.65.0" },
    { "name": "claude", "status": "ok", "code": "ok" },
    { "name": "config", "status": "warn", "code": "paths_missing", "repos": 12, "disabled": 1, "paths_missing": 2, "unknown_keys": 0 },
    { "name": "config_layout", "status": "ok", "code": "ok" },
    { "name": "cache", "status": "ok", "code": "ok", "schema": 4 },
    { "name": "terminal", "status": "skipped", "code": "not_set" },
    { "name": "groups_dir", "status": "skipped", "code": "not_set" }
  ],
  "platform": { "os": "darwin", "arch": "arm64" },
  "settings": { "ui": "simple", "update_check": "off", "update_check_off_by": "env" }
}
```

上のフォルダの `package.json` が壊れている時（段階 2 が動かない・bash が組む・終了コード 1）:

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "product_version": "0.5.0",
  "command": "doctor",
  "written_at": "2026-11-13T02:30:00Z",
  "status": "failed",
  "installed": "installed",
  "running": "not_applicable",
  "reasons": [{ "vocab": "ccs.health", "code": "invalid_package_config" }],
  "checks": [
    { "name": "node", "status": "ok", "code": "ok", "version": "24.1.0" },
    { "name": "tsx", "status": "ok", "code": "ok" },
    { "name": "modules", "status": "fail", "code": "invalid_package_config" },
    { "name": "sqlite", "status": "skipped", "code": "blocked" },
    { "name": "fzf", "status": "ok", "code": "ok", "version": "0.65.0" },
    { "name": "claude", "status": "ok", "code": "ok" },
    { "name": "config", "status": "skipped", "code": "blocked" },
    { "name": "config_layout", "status": "skipped", "code": "blocked" },
    { "name": "cache", "status": "skipped", "code": "blocked" },
    { "name": "terminal", "status": "skipped", "code": "blocked" },
    { "name": "groups_dir", "status": "skipped", "code": "blocked" }
  ],
  "platform": { "os": "darwin", "arch": "arm64" }
}
```

- `invalid_package_config` は、一覧を開く口が同じ時に止まる理由の語と同じ（本体も `invalid_package_config` に揃えた）
- `--json` が無い時は、検査ごとに 1 行の人向けの表を標準出力に出す（約束の外）。終了コードは同じ
- 書かない物: `repos.yml` のひな形・キャッシュのフォルダ・`state.db`・状態のファイル（設定とキャッシュの置き場には何も書かない）。書くのは、時間の上限のために段階 2 の出力を受ける `TMPDIR` の一時のフォルダだけで、終わる時（中断を含む）に消す。`state.db` は `readonly` と `fileMustExist` で開き、`migrate` しない（今の一覧と同じ開き方。SQLite が自分の WAL の脇のファイルに触るのはこの約束の外）
- 確かめるために起こす外の命令は `fzf --version`・`node --version` だけ。`claude` は PATH を見るだけで起こさない。時間の上限は上の「時間の上限」
- `config` の検査は数だけを足す: `repos`（項目の数）・`disabled`・`paths_missing`（`disabled` でない項目のうちフォルダが無い数）・`unknown_keys`（知らないキーの数）。どの項目かは出さない。番号が要る時は `--json` 無しで人が見る
- `settings.ui` は `CCS_UI` > `defaults.ui` > `classic` の順で決まった値（一覧が実際に使う見た目）
- `settings.update_check` は `on`・`off`。`update_check_off_by` は `env`（`CCS_NO_UPDATE_CHECK`）・`config`（`defaults.update_check: false`・4.4）・`null`。両方の時は `env`
- bash が組む答え（段階 2 が答えない時）には `settings` が無い（上の例のとおり）

### 2.2 `ccs list --json [--with-paths]`

`repos.yml` を ccs の検証に通した結果の一覧。キャッシュではなく `repos.yml` を直に読む（走査を待たない・`--no-scan` の古さが無い）。

**引数**: `--json`（要る・無ければ 2・`json_required`）・`--with-paths`。`node`・`tsx` が無い時は、引数の検査より先に 4・`dependency_missing` を返す（引数を読む部品が動かないため）。

**検証**: `repos.yml` が無い → 4 `config_missing`。読めない → 3 `config_not_readable`。検証に落ちる → 4 `config_invalid`（`detail`）。ひな形は作らない。

**部品が答えない時**（`bin/ccs` が組む）: `node`・`tsx` が無い → 4 `dependency_missing`（`detail` は `node`・`tsx`）。Node が部品を読めない時（ccs より上のフォルダの `package.json` が壊れている形）→ 1 `invalid_package_config`。ほかに答えが無い時 → 1 `internal_error`。`bin/ccs` は部品の標準エラーを `TMPDIR` の一時のファイルに受け（Node の出すファイル名を標準エラーに流さないため）、終わる時に消す。

**JSON の例**（外側は 1.3 と同じなので略す）:

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "product_version": "0.5.0",
  "command": "list",
  "written_at": "2026-11-13T02:30:00.000Z",
  "status": "ok",
  "reasons": [{ "vocab": "ccs.cli", "code": "ok" }],
  "repos": [
    {
      "name": "studio",
      "label": "Studio",
      "description": "Example group",
      "icon": "📁",
      "kind": "group",
      "launch": false,
      "lead": false,
      "disabled": false,
      "parent": null,
      "tags": [],
      "exists": true
    },
    {
      "name": "studio-web",
      "label": "",
      "description": "Web front end",
      "icon": "🌐",
      "kind": "repo",
      "launch": true,
      "lead": true,
      "disabled": false,
      "parent": "studio",
      "tags": ["web"],
      "exists": true
    }
  ],
  "groups": [
    { "id": "design-review", "label": "Design review", "kind": "logical", "members": ["studio-web"], "unregistered_members": 1 }
  ]
}
```

| キー | 意味 |
|---|---|
| `repos[]` | `repos.yml` の並びのまま。`disabled: true` も入れる（`disabled` で分かる） |
| `kind` | `repo`（起動する）か `group`（`launch: false` の見出し） |
| `label` | `repos.yml` の `label`（無ければ `""`。表示名は `label` が空でなければ `label`、空なら `name`） |
| `parent` | `path` で入れ子にした時の親の `name`（一覧のツリーと同じ `findParentRepo` の決まり・`disabled` の親は飛ばす）。無ければ `null` |
| `exists` | `path` のフォルダが今あるか（パスそのものは出さない） |
| `path` | `--with-paths` の時だけ。`~` を展開した絶対パス。`path` を書いていない項目（見出しなど）は `null` |
| `groups[]` | `defaults.groups_dir` を決めている時だけ（5 章）。決めていなければ空の配列 |

出さない物: `command`・`cwd`・`custom`・`scan`。

**`--with-paths` の判断**: 既定でパスを出さず、明示のフラグでだけ出す形にする。理由: GUI のランチャーのように画面に名前を出すだけの呼ぶ側はパスが要らない（ログに残ってもパスが漏れない）。一方で、行で読む道具を `repos.yml` の自前の読み取りから寄せる時は、`--with-paths` で同じ検証を通ったパスを受けられる。

### 2.3 `ccs sessions --json [--project <name>] [--limit <n>] [--with-titles] [--no-scan]`

前の会話の一覧。プロジェクトごとに、新しい順に件数の上限つき。

**引数**:
- `--json`（要る）
- `--project <name>`: 1 つのプロジェクトだけ。名前は今の `repos.yml` で確かめる（キャッシュでなく）。`repos.yml` に無い名前 → 5 `repo_not_found`。`repos.yml` が無い → 4 `config_missing`。壊れている → 4 `config_invalid`（`detail`）
- `--limit <n>`: プロジェクトごとの件数。既定 5、1〜50。外の値・数でない値は 2 `invalid_argument`
- `--with-titles`: 題を出す（無ければ `title` を出さない）
- `--no-scan`: 走査せずにキャッシュをそのまま読む

**走査**: 既定では、出す前に一覧を開く時と同じ差分の走査（`ccs-scan --quiet`）を 1 回走らせる。`repos.yml` が無い時は走査しない（ひな形を作らないため）。その呼び出しで走査が済まなかった時（`--no-scan`・`repos.yml` が無い・ほかの走査が動いている（ロック）・走査が落ちた）は、キャッシュをそのまま読み、いつも `"stale": true` を付ける（済んだ時だけ `false`）。キャッシュも無い → 4 `cache_missing`。開けない → 3 `cache_not_readable`。

**JSON の例**（`--with-titles`・外側の一部を略す）:

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "command": "sessions",
  "status": "ok",
  "reasons": [{ "vocab": "ccs.cli", "code": "ok" }],
  "stale": false,
  "limit": 5,
  "projects": [
    {
      "name": "studio-web",
      "sessions": [
        { "uuid": "0b7c2a4e-1f3d-4c5b-9a8e-2d6f7e8a9b0c", "last_activity_at": "2026-11-12T14:03:11.000Z", "title": "ログイン画面の文言を直す" },
        { "uuid": "5e1d9c3b-7a2f-4e6d-8b0a-1c2d3e4f5a6b", "last_activity_at": "2026-11-10T09:41:02.000Z", "title": null }
      ],
      "more": 3
    }
  ],
  "unmapped": 4
}
```

| キー | 意味 |
|---|---|
| `projects[]` | 会話のあるプロジェクト。並びは一番新しい会話の時刻が新しい順 |
| `projects[].name` | `repos.yml` の `name`（表示名は `list` と合わせて呼ぶ側が引く） |
| `sessions[]` | 新しい順に `--limit` 件まで |
| `uuid` | 再開で `open --session` に渡すためだけの ID |
| `last_activity_at` | 最後に動いた時刻（キャッシュの値を `toISOString()` で揃える） |
| `title` | `--with-titles` の時だけ。最初の依頼の 1 行（下の決まり）。無ければ `null` |
| `more` | 上限で出さなかった数 |
| `stale` | この呼び出しで走査が済まなかった時 `true`（上の「走査」） |
| `unmapped` | どのプロジェクトにも当たらない会話の数（作業フォルダしか手がかりが無いので、中身は出さない）。`--project` の時も全体の数。キャッシュの UUID が UUID の形でない行は飛ばし、数えない |

- 題の決まり: 取り込みの時の `stripControlChars` と `maskSecrets` を通した `topic` を、出す時にもう一度 `stripControlChars` → `maskSecrets` → `stripControlChars` の 3 段に通し（改行・制御文字・向きを変える文字なし）、残りが空なら `null`。80 文字（コードポイント・サロゲートペアを割らない）で切って、切った時は末尾に `…`
- `disabled: true` のプロジェクトの会話は出さない（数にも入れない）。`launch: false` の見出しに当たる会話は出す（再開は作業フォルダで起こすため）
- 出さない物: 要約（`summary`）・作業フォルダ（`cwd`）・ブランチ・会話の数。`--with-titles` が無い時の題
- 題を既定で出さない理由: 題は最初の依頼の文で、会話の中身と同じ扱い。画面に出す呼ぶ側だけが明示のフラグで受ける（受けた側は保存しない・ログに出さない・ほかの機械に送らない）

### 2.4 `ccs config get [--json] [--with-paths]`

`config set` で変えられる設定の今の値。設定の画面が今の値を出すため。

```json
{
  "schema_version": "1.0.0",
  "product_id": "ccs",
  "command": "config get",
  "status": "ok",
  "reasons": [{ "vocab": "ccs.cli", "code": "ok" }],
  "settings": {
    "defaults.ui": "simple",
    "defaults.terminal": "terminal",
    "defaults.update_check": true,
    "defaults.groups_dir": { "set": false }
  },
  "allowed": {
    "defaults.ui": ["classic", "simple"],
    "defaults.terminal": ["terminal"],
    "defaults.update_check": [true, false]
  }
}
```

- `--json` が無い時は、`settings` を 1 行に 1 つ `key = value` の形で標準出力に出す（人向け・約束の外）

- 書いていないキーは既定の値（`defaults.ui` は `classic`・`defaults.terminal` は `null`・`defaults.update_check` は `true`）
- `defaults.groups_dir` はパスなので `{ "set": true|false }` だけ。`--with-paths` の時は `"path"` を足す
- `defaults.command` は出さない（1.7）。項目ごとの `label`・`description` は `list --json` で読む
- `allowed` は `config set` が受ける値の一覧（呼ぶ側が選択肢を決め打ちしないため）
- `repos.yml` が無い時は、全部を既定の値で返す（0・`ok`）。壊れている時は 4 `config_invalid`

---

## 3. 共通の書き方（書く口の土台）

`repo add`・`repo remove`・`config set` は、どれも次の手順で `repos.yml` を書く。今の `ccs init --auto-discover` の書き足し（`appendAndValidate`）をこの土台に寄せ、1 つの関数（例 `editConfig(transform)`）にする。

1. ロックを取る: `<config の置き場>/repos.yml.lock` を `O_EXCL` で作る（走査のロックと同じ形・10 秒より古い物は乗っ取る）。取れない → 1 `config_locked`
2. 元の文字列を読み、検証に通す（`loadConfig` の読み取り専用の形）。読めない → 3 `config_not_readable`。落ちる → 4 `config_invalid`（書かない）
3. 入力を検証する（口ごとの決まり）。落ちる → 2／5／6
4. `parseDocument` で読んだ文書を直し、`toString({ lineWidth: 0, flowCollectionPadding: false })` で書き出す（コメントと並びと書き方を残す・`ccs init` と同じ）。例外は 1 つ: `yaml` パッケージは、行の終わりのコメント（`key: value   # …`）の前の空白を 1 つに揃える（`ccs init` も前から同じ）
5. 書く直前にもう一度読み、2 の文字列と違えば 1 `config_changed`（書かない）
6. 元の文字列を `repos.yml.bak` に 0600 で書く（1 世代だけ・`ccs init` と同じ）
7. `repos.yml` に **その場で** 0600 で書く（一時のファイルから名前を替えない。`repos.yml` をシンボリックリンクにしている人のリンクを壊さないため。今の `ccs init` と同じ）。書けない → 1 `write_failed`
8. もう一度検証に通す。落ちたら元の文字列を書き戻し、1 `validation_after_write_failed`。書き戻しにも失敗したら 7 `restore_failed`（`.bak` に元がある・標準エラーに戻し方を 1 行）。`repo add` が `repos.yml` を新しく作った時は、書き戻す代わりに新しいファイルを消す（消せなければ 7 `restore_failed`・手で消すよう標準エラーに 1 行）
9. ロックを外す。SIGINT はここまでのどこで来ても、書いた後なら元に戻してから 130 で終わる

- 試験のため: 環境変数 `CCS_TEST_EDIT_PAUSE_MS`（0〜10000 ミリ秒・外の値は無視して 0）で、上の段階ごとに待つ（途中に SIGINT を送るため）。書いた後の検証と書き戻しの失敗は、部品の差し替え（試験から関数を差し替える）で試す。利用者の約束の外
- 書く時の形は `repos-yml-schema.md` の「勧める書き方」: 足す項目はブロックの形で、`name:` → `path:` → `description:` の順
- `repos:` が 1 行の形（`repos: [ … ]`）の時、項目を足す口（`repo add`・`ccs init --auto-discover`）は書かずに断る → `repo add` は 6・`ccs init` は 1（init はこの表の外・1.4）。理由の語はどちらも `flow_style_repos`（ファイルを書き換えない）。外す口と `config set` は 1 行の形のままで直せるので断らない
- `ccs init --auto-discover` の書き足しも、この土台で書く（ロックと書く前の検証を含む）。書き足しは、ほかの検査より先に 1 行の形を断る（`repos: []` も `flow_style_repos`）。探す段階（`$HOME` を走査する前）は先に `repos.yml` を読むので、`repos: []` はそこで `repos` が空のエラーで止まる
- 書く口は走査を走らせない（次に一覧を開く時の走査が拾う）

---

## 4. 書く口と起動の口

### 4.1 `ccs repo add <path> [--name <name>] [--description <text>] [--with-paths] [--json]`

**引数**: `<path>` は絶対パス・`~/…`・今のフォルダからの相対パス（`resolve` する）。

**検証**（この順・最初に落ちた物を返す）:

| 検査 | 落ちた時 |
|---|---|
| `<path>` がある | 2 `missing_argument` |
| ロックを取る（3 章の 1。`repos.yml` の検査より先） | 1 `config_locked` |
| `repos.yml` が検証に通る（無い時は下の注） | 4 `config_invalid` |
| `repos:` がブロックの形 | 6 `flow_style_repos` |
| 解決したパスに `..` の区切りが無く、`$HOME` の下（書いた形とシンボリックリンクを解いた先の両方・今の `isUnderHome`） | 6 `path_outside_home` |
| フォルダがある | 6 `path_not_found` |
| フォルダである | 6 `path_not_directory` |
| 解決したパスに `SHELL_METACHARS` が無い | 6 `unsafe_characters` |
| `~/…` にした形が引用符なしで書ける（1.6） | 6 `needs_quoting` |
| 同じフォルダ（解決した絶対パス）が台帳に無い（`disabled` の項目を含む） | 6 `path_taken` |
| 名前: `--name` が無ければフォルダの名前（`$HOME` そのものは `home`）。空でない・100 字まで（コードポイントで数える） | 6 `invalid_value` |
| 名前に `SHELL_METACHARS` が無い | 6 `unsafe_characters` |
| 名前が引用符なしで書ける（1.6） | 6 `needs_quoting` |
| `--name` を渡した名前が台帳に無い | 6 `name_taken` |
| `--name` が無い時の名前が重なれば、`-2`・`-3` … を付ける（`ccs init` の候補と同じ） | — |
| `--description`: 制御文字なし・200 字まで（コードポイント）。`""` は受けて、`description` を書かない | 6 `invalid_value` |

**書く物**: 項目を 1 つ、`repos:` の最後に足す。`path` は `~/…` の形（`$HOME` そのものは `~/`。`~` だけだと YAML の null になり、引用符なしで書けないため）。

```yaml
  - name: studio-web
    path: ~/projects/studio/web
    description: Web front end
```

- `repos.yml` が無い時は、置き場のフォルダを 0700 で作り、次の最小の形で 0600 で作る（`defaults.command` は書かない。書くと `CCS_CMD` より強くなり、今まで `CCS_CMD` で決めていた人の起動が変わるため）

  ```yaml
  # Claude Code Station — Repository Definitions
  version: 1
  repos:
    - name: studio-web
      path: ~/projects/studio/web
  ```

- `repos.yml` を作る最初の `repo add` が検査に落ちた時は、何も書かず、作った設定のフォルダも消して元に戻す。書いた後の検証に落ちた時は、作った `repos.yml` を消す（3 章の 8）

**JSON の例**（外側の一部を略す）:

```json
{ "schema_version": "1.0.0", "product_id": "ccs", "command": "repo add", "status": "ok", "reasons": [{ "vocab": "ccs.cli", "code": "ok" }], "repo": { "name": "studio-web", "created_config": false } }
```

`--with-paths` の時だけ `repo.path` を足す。フォルダの中身には触らない。

### 4.2 `ccs repo remove <name> [--json]`

**検証**: `<name>` が無い → 2 `missing_argument`。`repos.yml` が無い → 4 `config_missing`。壊れている → 4 `config_invalid`。その名前（大文字と小文字を区別・完全一致）が無い → 5 `repo_not_found`。最後の 1 件 → 6 `last_entry`。

**書く物**: 台帳からその項目だけを消す（3 章の手順）。

- フォルダ・会話の記録・キャッシュには触らない。その項目に当たっていた会話は、次の走査で「どのプロジェクトにも当たらない会話」になる
- `launch: false` の見出しも外せる。中にあった項目は残り、一つ上の階に並ぶ
- その項目に付いていたコメントは一緒に消える（`yaml` パッケージの扱い。`.bak` に残る）

```json
{ "schema_version": "1.0.0", "product_id": "ccs", "command": "repo remove", "status": "ok", "reasons": [{ "vocab": "ccs.cli", "code": "ok" }], "repo": { "name": "studio-web" } }
```

### 4.3 `ccs config set [--repo <name>] <key> <value> [--json]`

決まった値から選ぶ物と、項目の表示名と説明だけを変える。

| キー | `--repo` | 受ける値 | 書く物 |
|---|:---:|---|---|
| `defaults.ui` | — | `classic`・`simple` | `defaults.ui` |
| `defaults.terminal` | — | `terminal`・`""`（消す） | `defaults.terminal`（新しいキー・4.5） |
| `defaults.update_check` | — | `true`・`false` | `defaults.update_check`（新しいキー・4.4） |
| `label` | 要る | 制御文字なし・80 字まで（コードポイント）・`""`（消す＝`name` を出す） | `repos[].label` |
| `description` | 要る | 制御文字なし・200 字まで（コードポイント）・`""`（消す） | `repos[].description` |

- 受けないキー（`defaults.command`・`command`・`cwd`・`path`・`custom`・`launch`・`lead`・`disabled`・`tags`・`icon`・`scan`・`name`・`defaults.groups_dir` ほか）→ 6 `key_not_settable`。自由なコマンドの文字列とパスは、呼ぶ側の画面からは変えない（変える人はファイルを直す）
- 検査の順（最初に落ちた物を返す）:
  1. 引数の数（キーと値の 2 つ）: 足りない → 2 `missing_argument`・多い → 2 `extra_argument`
  2. キー: 上の表に無い → 6 `key_not_settable`
  3. `--repo` の有無: 要るキーに無い → 2 `missing_argument`・要らないキーにある → 2 `extra_argument`
  4. `repos.yml`（無い時のほかは、先にロックを取る・取れない → 1 `config_locked`）: 無い → 4 `config_missing`（`config set` は作らない）・読めない → 3 `config_not_readable`・壊れている → 4 `config_invalid`
  5. 項目: `--repo` の名前が無い → 5 `repo_not_found`
  6. 値: 一覧の外・長すぎる・制御文字 → 6 `invalid_value`
- `defaults` が無い時は `repos:` の前に足す（行で読む道具が `repos:` の下だけを見るため）
- `"changed": false` は、書いてある値と同じ時だけ（0・`ok`・ファイルは書かない）。キーが書いていない時は、既定と同じ値（`defaults.update_check true` など）でも書く（`"changed": true`）。`""` で消すキーがもう無い時も `"changed": false`
- `defaults.*` のキーは `version: 1` の「足すだけ」に入る。前のバージョンの ccs は `defaults` の未知のキーを黙って無視するので、壊れない

```json
{ "schema_version": "1.0.0", "product_id": "ccs", "command": "config set", "status": "ok", "reasons": [{ "vocab": "ccs.cli", "code": "ok" }], "key": "defaults.ui", "changed": true }
```

### 4.4 更新の知らせを止める設定 `defaults.update_check`

- `defaults.update_check: false` で、`CCS_NO_UPDATE_CHECK` と同じに止める（ネットに出ない・更新のキャッシュを読まない・知らせを出さない）
- 優先順: `CCS_NO_UPDATE_CHECK` が空でない → 止める。そうでなく `defaults.update_check: false` → 止める。どちらも無い → 今のとおり 1 日 1 回確かめる。設定の `true` は環境変数の「止める」に勝たない
- 読み方: `bin/ccs` は `defaults.ui` を前の走査の標準出力（`ui=<mode>`）で受けている。走査は `--print-settings` で `ui=<mode>` と `update_check=on` か `off` の 2 行を出し（`--print-ui` は `ui=` だけで今のまま）、`meta` に `defaults_update_check`（`on`・`off`）を書く（`defaults_ui` と同じ）。走査をしない時（`--no-scan`）や走査が落ちた時は、`ccs-list --print-settings` で `meta` から同じ 2 行を読む（読めなければ `classic`・`on`）。`check_for_update` はこの値を見てから動く（今も走査の後に呼んでいるので、順番は変えなくてよい）
- 真偽値だけ受ける（`"false"` の文字列は検証のエラー・`launch` と同じ厳しさ）
- 用途: 管理された入れ方（ほかの道具が更新を受け持つ）で、「npm で上げる」の案内と食い違わないようにする

### 4.5 端末のアプリ `defaults.terminal`

| 値 | アプリ | 開き方（macOS） |
|---|---|---|
| `terminal` | macOS の「ターミナル」 | `open -a Terminal <起動ファイル>.command` |

- v0.5.0 の一覧は `terminal` だけ。iTerm2 は `.command` を走らせるのを確かめられなかったので、確かめてから足す。一覧は足すだけ（ほかの端末のアプリも、開き方を確かめてから足す・8 章）
- 書いていない時は、`open --new-window` は 4 `terminal_not_set`。ccs はアプリを勝手に選ばない
- アプリがあるかは、決まった置き場の `.app`（`terminal` は `/System/Applications/Utilities/Terminal.app` と `/Applications/Utilities/Terminal.app` の 2 つ）を見るだけで確かめる（Finder を動かさない）
- 文字列の検証: 一覧の語だけ。ほかの値は読む時に検証のエラー（`defaults.ui` と同じ）

### 4.6 `ccs open (--repo <name> | --session <uuid>) [--here | --new-window] [--terminal <app>] [--json] [-- <args>…]`

fzf を開かずに、今の一覧の起動の決まりを通して Claude Code を起こす。呼ぶ側が渡すのは名前か UUID だけ。

**引数**:
- `--repo` と `--session` のどちらか 1 つ（両方 → 2 `conflicting_options`・どちらも無い → 2 `missing_argument`）
- `--here`（既定）: 今の端末で起こす。`--new-window`: 端末のアプリの新しいウィンドウで起こし、待たずに返る。両方 → 2 `conflicting_options`
- `--terminal <app>`: この 1 回だけ `defaults.terminal` の代わり（値は 4.5 の一覧・外れた値 → 2 `invalid_argument`）。`--new-window` の時だけ使える（ほかと一緒 → 2 `conflicting_options`）
- `-- <args>…`: 起こすコマンドに渡す（`--here` の時だけ。今の一覧の「知らないフラグを渡す」と同じ）。`--new-window` と一緒 → 2 `conflicting_options`

**解決と検査**（一覧で選んだ後の今の決まりと同じ物を、1 つの関数にして一覧と `open` で使う）:

| 検査 | `--repo` | `--session` | 落ちた時 |
|---|---|---|---|
| ID の形 | — | UUID の正規表現（今の `UUID_RE`） | 6 `invalid_uuid` |
| 設定とキャッシュ | `repos.yml` が無い → 4 `config_missing`・壊れている → 4 `config_invalid`・読めない → 3 `config_not_readable` | `state.db` が無い → 4 `cache_missing`・開けない → 3 `cache_not_readable` | 左の語 |
| 対象を引く | `repos.yml` を直に読む（キャッシュでなく今の値） | キャッシュの `sessions` を UUID で引く（走査はしない） | 5 `repo_not_found`／`session_not_found` |
| 起動できる項目 | `launch: false` でない・`disabled: true` でない | — | 6 `not_launchable`／`repo_disabled` |
| 作業フォルダ | `cwd`（無ければ `path`） | 会話の `cwd`（`unknown` は不可） | 6 `session_cwd_unknown` |
| `$HOME` の下・`..` なし | ✅ | ✅ | 6 `path_outside_home` |
| フォルダがある | ✅ | ✅ | 6 `path_not_found` |
| 起動コマンド | 優先順 `repos[].command` > `defaults.command` > `CCS_CMD` > `CCR_CMD` > `claude` | 今の `repos.yml` を読み、会話の項目が `repos.yml` にあればその `command`、無ければ `defaults.command` から後の優先順。`repos.yml` が壊れている → 4 `config_invalid` | — |
| コマンドの記号の検査 | 今の `bin/ccs` の 2 重目の検査（メタ文字・制御文字） | 同じ | 6 `command_unsafe` |
| 前提 | `node`・`tsx`（`bin/ccs` が引数の検査より先に見る）・起こすコマンド（fzf は要らない） | 同じ | 4 `dependency_missing`（起こすコマンドが PATH に無い時は `detail: claude`） |

検査の順（最初に落ちた物を返す）: 引数（2）→（`--new-window` の時は）OS（4 `unsupported_os`）→（`--terminal` が無ければ）`repos.yml`（4 `config_invalid`）→ 端末のアプリ（4 `terminal_not_set`・`terminal_app_missing`）→ 上の表の対象・項目・作業フォルダ・コマンド（5／6）→ 起こすコマンドが PATH にあるか（4 `dependency_missing`・`detail: claude`）→（`--here` の時は）TTY（4 `no_tty`）。`node`・`tsx` が無い時だけは、引数より先に 4 `dependency_missing`（`detail` は `node`・`tsx`）。

- 一覧との違い: 一覧は作業フォルダが `$HOME` の外か無い時に「今いるフォルダで開く」に落ちるが、`open` は落ちずに断る（呼ぶ側が別のフォルダで起きたと気づけないため）
- `--repo` の名前の一致は大文字と小文字を区別・完全一致

**`--here`**:
- 標準入力と標準出力が端末でない → 4 `no_tty`（Claude Code は端末の中で動くため）。TTY は、上の表の検査を全部通った後に見る
- 検査を通ったら、一覧と同じに `cd` して、コマンドを直に起こす（`exec` でなく直に呼ぶ・`set -f` で語に分ける・会話は `--resume <uuid>` を付ける）
- 起こした後の終了コードは起こしたコマンドの物（1.4 の表の外）。検査で止まった時だけ表の値で終わり、`--json` があれば JSON を出す。起こせた時（成功の時）は、`--json` があっても外側の JSON を出さない（標準出力は Claude Code の物）
- 中の作り: 検査は部品（`ccs-open.ts`）がし、起こすのは `bin/ccs`。部品は検査を通った起動の中身を `bin/ccs` が渡す一時のファイルに書き、`bin/ccs` がもう一度検査してから起こす。その受け渡しの環境変数 `CCS_OPEN_PLAN`・`CCS_OPEN_TTY` は `bin/ccs` と部品の間の内部の物で、利用者の約束の外

**`--new-window`**（macOS だけ）:
1. macOS でない → 4 `unsupported_os`
2. 端末のアプリ: `--terminal` か `defaults.terminal`。`--terminal` が無く `repos.yml` が壊れている → 4 `config_invalid`（読めない → 3 `config_not_readable`）。どちらも無い → 4 `terminal_not_set`。アプリが無い → 4 `terminal_app_missing`
3. 上の検査を全部ここで通す（`--here` の検査のうち TTY のほか全部）。落ちた時はウィンドウを開かずに返る
4. `mktemp -d` で 0700 の一時のフォルダを作り、起動ファイル `ccs-open.command`（0700）を書く:

   ```sh
   #!/bin/sh
   rm -f -- "$0"; rmdir -- "$(dirname -- "$0")" 2>/dev/null
   exec '<ccs の絶対パス>' open --here --repo '<name>'
   ```

   名前は `SHELL_METACHARS`（`'` を含む）を通った物なので、`'…'` で包めば記号として読まれない。UUID は正規表現を通った物。`<ccs の絶対パス>` は `bin/ccs` を解決した実体で、記号が入っていれば 4 `unsafe_install_path`
5. `open -a <アプリ> <起動ファイル>` を走らせる。0 以外 → 一時のフォルダを消して 1 `launch_failed`
6. 0（`ok`）で返る。新しいウィンドウの中の `ccs open --here` が、同じ検査をもう一度通してから起こす

```json
{ "schema_version": "1.0.0", "product_id": "ccs", "command": "open", "status": "ok", "reasons": [{ "vocab": "ccs.cli", "code": "ok" }], "mode": "new_window", "terminal": "terminal" }
```

- `ok` の意味は「検査を通り、端末のアプリに渡せた」。Claude Code が起きたかは見ない（待たない）
- この開き方は、AppleScript（Apple Events）でアプリを操作しない（ファイルを開くだけ）。macOS の実機で Terminal.app を確かめた: オートメーションの許可を求めない・`.command` に隔離の属性（quarantine）が付かない・新しいウィンドウのログインシェルの PATH で `node` が見つかる。GUI のアプリから呼んだ時に quarantine が付くかは確かめていない（8 章）

---

## 5. 外のグループの定義を読む `defaults.groups_dir`

フォルダがばらばらのプロジェクトを、外の定義ファイルに従って 1 つの見出しの下に並べる。既定は off。

**設定**: `defaults.groups_dir: <フォルダのパス>`（`repos.yml` に人が書く・`config set` では受けない）。`~` を展開し、`$HOME` の下・`SHELL_METACHARS` なし。外れる値は検証のエラー（`path` と同じ）。ccs はこのフォルダに書かない。

**読む物**: フォルダの直下の `*.json`（下の階は読まない・名前の順・200 個まで・1 個 256 KB まで）。各ファイルから次の 5 つだけを読み、ほかのキーは無視する。

| キー | 読み方 |
|---|---|
| `version` | 整数の `1` の物だけ使う。ほかは飛ばす |
| `id` | 空でない文字列・`SHELL_METACHARS` なし・64 文字まで。重なれば名前の順で先の物 |
| `label` | 見出しに出す文字列（制御文字を除く・無ければ `id`） |
| `kind` | `logical` の物だけ使う。`physical` などは飛ばす（フォルダの入れ子は今の `path` の入れ子で並ぶ） |
| `members[].path` | `~` を展開して `repos.yml` の `path` と比べる（`realpath` が取れれば両方を解いて比べる）。当たった項目を `members[]` の順に並べる。当たらない物は出さない |

- 壊れた JSON・形の外れた物は飛ばし、`doctor` の `groups_dir` に `group_files_skipped`（数）で出す。一覧は開く（飛ばした事で一覧を止めない）
- 読むのは走査の時（`ccs-scan`）。結果を `meta` に `logical_groups` として JSON で置き（`[{ "id", "label", "members": ["<name>", …] }]`）、一覧（`ccs-list`）はそれを読む。`state.db` のスキーマは変えない
- 一覧の出し方: 起動しない見出し（行の種類 `group:`・キーは `@<id>` で `repos.yml` の名前と分ける）の下に、当たった項目の行を並べる。`ui: simple` は `launch: false` の見出しの後、`classic` は全部のプロジェクトの行の後で会話の区切りの前。同じプロジェクトが、自分の場所と見出しの下の両方に出てよい
- `list --json` の `groups[]`（2.2）・`doctor` の `groups_dir`（2.1）に出す。`unregistered_members` は当たらなかった数

---

## 6. 作る順の案（engineer）

| 順 | 作る物 | ファイル |
|---|---|---|
| 1 | 土台: 外側の JSON・終了コード・2 つの語彙・フラグの解釈を 1 か所に。`ConfigError` に `code`（1.5 の `detail` の語）を足す。`loadConfig` を「ひな形を作らない・警告を集める」読み取り専用の形と、今の形に分ける。`bin/ccs` の最初の引数で 6 語を分ける（`check_deps` と更新の確認より前）。SIGINT で 130 | `bin/ccs`・`bin/ccs-config.ts`・新 `bin/ccs-machine.ts` |
| 2 | `repos.yml` の検証の直し: `disabled`・`scan` は真偽値だけ（文字列はエラー）・`description`・`icon` の YAML の null は未指定・`custom` の上限のエラー文を `64,000 characters` に。一覧が止まる理由の語を `invalid_package_config` に揃える | `bin/ccs-config.ts`・`bin/ccs` |
| 3 | `doctor`（段階 1 の bash と段階 2） | `bin/ccs`・新 `bin/ccs-doctor.ts` |
| 4 | `list --json` | 新 `bin/ccs-list-json.ts` か `bin/ccs-list.ts` に口を足す |
| 5 | `sessions --json` | 同上 |
| 6 | 書く土台（3 章）と、`ccs init` の書き足しをそれに寄せる（1 行の形の `repos:` は断る）。`repo add`・`repo remove` | `bin/ccs-init.ts`・新 `bin/ccs-repo.ts` |
| 7 | `config get`・`config set`、`defaults.update_check`（走査の出力と `meta`）、`defaults.terminal` の検証 | `bin/ccs-config.ts`・`bin/ccs-scan.ts`・`bin/ccs`・`bin/ccs-repo.ts` |
| 8 | `open --here`（一覧の選んだ後の検査と起動を bash の関数にして共有）→ `open --new-window` | `bin/ccs`・新 `bin/ccs-open.ts` |
| 9 | `defaults.groups_dir`（走査 → `meta` → 一覧の行・`list --json`・`doctor`） | `bin/ccs-scan.ts`・`bin/ccs-list.ts` |
| 10 | `--help`・README の節（機械の口・終了コードの表）・CHANGELOG（1.2 の違いを全部） | `bin/ccs`・`README.md`・`CHANGELOG.md` |

- 新しい部品は `ccs-*.ts` の名前にする（コピーで入れる手順は `ccs-*.ts` と `ccs-*.sh` だけを写す）
- パッケージは足さない（`yaml`・`better-sqlite3`・`tsx` と Node の標準だけで作れる）
- `--new-window` は macOS の実機で Terminal.app を確かめた（8 章の 2・3）ので、v0.5.0 に `--here` と一緒に出す。iTerm2 は後で足す

## 7. 試験で確かめる事（checker）

どれも TTY なし・標準入力 `/dev/null`・`XDG_CONFIG_HOME`・`XDG_CACHE_HOME`・`HOME` を一時のフォルダにして走らせる。値は架空。

**共通**

| 入力 | 期待 |
|---|---|
| 新しい口を `--json` で全部（成功と失敗の両方） | 標準出力は JSON 1 個で `JSON.parse` が通る。`schema_version`・`product_id`・`product_version`・`command`・`written_at`・`status`・`reasons` がある。終了コードと `status` が 1.4 の表どおり。`reasons[].vocab` は `doctor` の検査の結果が `ccs.health`、`doctor` の引数の誤りと中断が `ccs.cli`、ほかの口が `ccs.cli` |
| 同じ | 語の値（`status`・`code`・`kind` など）がどれも `^[a-z][a-z0-9_]*$` |
| 同じ（標準出力と標準エラー） | `HOME` の下のパスの文字列（`--with-paths` の時の他）・`command` の値・会話の本文（`--with-titles` の時の題の他）が出ない。`doctor` には `repos.yml` の `name` も出ない |
| 同じ・ネットを切った・`CCS_UPDATE_REGISTRY` を止まるサーバーにした | 時間がかからず、更新のキャッシュのファイルが作られない・変わらない |
| `ccs doctor`・`ccs list --json` を `repos.yml` も置き場も無い所で | 置き場のフォルダ・`repos.yml`・`README.md`・`state.db` が作られない。`TMPDIR` に ccs 自身の一時の物が残らない（tsx の変換のキャッシュ `tsx-<uid>/` は残ることがある） |
| `ccs repo --json`・`ccs config bogus --json` | 2・`usage`・`missing_argument`／`invalid_argument`。起動するコマンドが起きない |
| `ccs --new doctor` | 今のとおり一覧の口（`doctor` は起動するコマンドに渡る） |
| 知らないフラグ `ccs list --json --bogus` | 2・`usage`・`unknown_option` |
| 書く口の途中で SIGINT（`CCS_TEST_EDIT_PAUSE_MS` で段階ごとに待たせる） | 130・`interrupted`・`repos.yml` が元のまま・ロックが残らない |

**doctor**

| 入力 | 期待 |
|---|---|
| 全部そろう | 0・`ok`・`installed: installed`・`running: not_applicable`・`checks[]` が 2.1 の順 |
| PATH から `fzf`／`claude`／`node` を抜く | 1・`failed`・その検査が `fail`・`fzf_missing`／`claude_missing`／`node_missing`（`node` が無い時は bash が組んだ JSON） |
| `fzf --version` が `0.41.0` の偽の命令 | 1・`fzf_too_old`。`0.44.0` なら 0 で `fzf_too_old_for_headers`（`warn`・`ui: simple` でも同じ語）。`0.55.0` で `ui: simple` なら 0 で `fzf_too_old_for_simple`（`warn`） |
| `better-sqlite3` を読めなくする | 1・`sqlite` が `fail`・`sqlite_native_module_missing` |
| `repos.yml` が YAML として壊れている・`version: 2`・名前が重なる・`$HOME` の外の `path` | 1・`config` が `fail`・それぞれ `yaml_parse_error`・`unsupported_version`・`duplicate_name`・`path_outside_home` |
| `bin/` の上の `package.json` が壊れている（コピーで入れた形） | 1・`modules` が `fail`・`invalid_package_config` |
| 段階 2 を時間切れにする（`CCS_DOCTOR_TIMEOUT` を短くする）・落とす（試験用の差し替え） | 3・`unverifiable`・`modules` が `check_timeout`／`check_crashed`。`checks[]` は 11 個で、段階 2 の検査は `skipped`・`blocked` |
| `repos.yml` が無い | 0・`config` が `warn`・`config_missing`・`config_layout` が `skipped`・`not_set` |
| 知らないキーと無いフォルダの両方がある `repos.yml` | 0・`config` が `warn`・`unknown_keys`・`unknown_keys` と `paths_missing` の数 |
| `defaults.terminal` なし／`terminal` を macOS で／macOS 以外で／アプリが無い | `terminal` が `skipped`・`not_set`／`ok`／`warn`・`terminal_unsupported_os`／`warn`・`terminal_app_missing`。`groups_dir` は `skipped`・`not_set` |
| `state.db` が無い | 0・`cache` が `warn`・`cache_missing`。走らせた後も `state.db` が無い |
| `repos: [{name: a, path: ~/a}]` の 1 行の形 | `config_layout` が `warn`・`flow_style_repos` |
| 終了コード | 0・1・2・3 のどれか（4〜7 を使わない）。Ctrl-C で止めた時だけ 130・`ccs.cli` の `interrupted` |
| `ccs doctor --bogus --json` | 2・`usage`・`ccs.cli` の `unknown_option` |
| 走らせる前と後 | 置き場のファイルの中身と更新の時刻が同じ |

**list・sessions・config get**

| 入力 | 期待 |
|---|---|
| `list --json`（見出し・入れ子・`lead`・`disabled` を含む見本） | `repos[]` が `repos.yml` の並び・`kind`・`parent`・`exists` が合う。`path`・`command`・`cwd`・`custom` が無い |
| `list --json --with-paths` | `path` が展開した絶対パス |
| `list`（`--json` なし） | 2・`json_required` |
| `list --json` で `repos.yml` が無い・壊れている | 4・`config_missing`／`config_invalid`（`detail` あり） |
| `list --json` で `bin/` の上の `package.json` が壊れている（コピーで入れた形） | 1・`failed`・`invalid_package_config` |
| `list --json` を PATH に `node`／`tsx` の無い所で | 4・`dependency_missing`・`detail` が `node`／`tsx` |
| `sessions --json` に 1 つのプロジェクトで 7 件 | 5 件・新しい順・`more: 2`・`title` のキーが無い |
| `sessions --json --with-titles` で、題に改行・ESC・向きを変える文字・偽の API キー・120 文字 | 1 行・制御文字なし・キーが伏せてある・80 文字＋`…` |
| `sessions --json --project nosuch` | 5・`repo_not_found` |
| `sessions --json --project web` を `repos.yml` 無しで・壊れた `repos.yml` で | 4・`config_missing`／`config_invalid` |
| `sessions --json --no-scan`・`repos.yml` 無し・走査のロックを先に置く | `stale: true` |
| `sessions --json --project web`（ほかのプロジェクトと、どれにも当たらない会話がある） | `unmapped` は全体の数 |
| `sessions --json --limit 0`・`--limit x` | 2・`invalid_argument` |
| `sessions --json --no-scan` で `state.db` が無い | 4・`cache_missing` |
| `config get --json` を `repos.yml` 無しで | 0・既定の値 |

**repo add・repo remove・config set**

| 入力 | 期待 |
|---|---|
| `repo add ~/p/web`（コメントと 1 行の `tags: [x]` のある見本に） | 0・最後にブロックの形で `name: web`・`path: ~/p/web`。ほかの行は 1 文字も変わらない（例外: 行の終わりのコメントの前の空白は 1 つに揃う・3 章の 4）。`.bak` が元と同じ |
| `repo add ~`（`$HOME` そのもの） | 0・`name: home`・`path: ~/` |
| `repo add` と `ccs init --auto-discover` の書き足しを、`repos: [{name: a, path: ~/a}]` の見本に | `repo add` は 6・`ccs init` は 1。どちらも `flow_style_repos`・ファイルが変わらない |
| `ccs init --auto-discover` の書き足しを `repos: []` の見本に | 1・`flow_style_repos`（ほかの検査より先）・ファイルが変わらない |
| `repos.yml` が無い所で、検査に落ちる `repo add` | 書かない・設定のフォルダも残らない |
| `repo add /etc`・`repo add ~/../x`・`~/link`（`/` へのリンク） | 6・`path_outside_home`・ファイルが変わらない |
| `repo add ~/nosuch`・`repo add ~/file.txt` | 6・`path_not_found`／`path_not_directory` |
| `repo add ~/p/a';b` | 6・`unsafe_characters` |
| `repo add ~/p/2024`（フォルダの名前が数） | 6・`needs_quoting` |
| `repo add ~/p/web --name web`（`web` がある） | 6・`name_taken` |
| `repo add ~/q/web`（`--name` なし・`web` がある） | 0・名前は `web-2` |
| 同じフォルダを 2 度 | 2 度目は 6・`path_taken` |
| `repos.yml` が無い所で `repo add` | 0・最小の形・`defaults.command` が無い・ファイルは 0600・`created_config: true` |
| `repos.yml` がシンボリックリンク | 書いた後もリンクのまま・リンク先が変わる |
| 書いた後の検証を落とす（試験用の差し替え） | 1・`validation_after_write_failed`・元のまま。書き戻しも落とすと 7・`partial`・`restore_failed`・`.bak` が元と同じ |
| `repo remove web` | 0・その項目だけが消える。フォルダは残る |
| `repo remove nosuch`・最後の 1 件を `repo remove` | 5・`repo_not_found`／6・`last_entry` |
| ロックのファイルを先に置く（新しい） | 1・`config_locked`・ファイルが変わらない |
| `config set defaults.ui fancy`・`config set defaults.command x`・`config set --repo web path ~/x` | 6・`invalid_value`／`key_not_settable`／`key_not_settable` |
| `config set defaults.ui simple`（`defaults` が無い見本） | `defaults:` が `repos:` の前に入る |
| `config set --repo web label ""` | `label` のキーが消える |
| `config set defaults.update_check false` の後で一覧を開く（偽のレジストリ） | 問い合わせが来ない・知らせが出ない。`--no-scan` でも同じ |
| `config set defaults.update_check true`（キーが無い見本）を 2 度 | 1 度目は書く（`changed: true`）・2 度目は `changed: false` |
| `config set defaults.ui simple` を `repos.yml` 無しで | 4・`config_missing`・ファイルを作らない |
| `config set bogus x`（`repos.yml` 無し）・`config set label x`（`--repo` なし） | 6・`key_not_settable`／2・`missing_argument`（`repos.yml` より先に見る） |

**repos.yml の検証の直し**

| 入力 | 期待 |
|---|---|
| `disabled: "false"`・`scan: "no"` | 検証のエラー（一覧は前の物で開き、`doctor` は `entry_invalid`） |
| `description:`・`icon:`（値なし） | エラーでなく、説明は空・アイコンは既定 |
| `custom` が JSON にして 64,001 文字 | エラーの文に `64,000 characters` |

**open**

| 入力 | 期待 |
|---|---|
| `open --repo web`（TTY なし） | 4・`no_tty`・何も起きない |
| `open --repo web` を擬似端末で（`CCS_CMD` を引数を書き出す偽の命令に） | `cwd` で、優先順どおりの命令が起きる |
| `open --session <UUID>` を擬似端末で | 会話の `cwd` で `--resume <UUID>` が付く |
| `open --repo nosuch`・`open --session <無い UUID>`・`open --session not-a-uuid` | 5・5・6（`invalid_uuid`） |
| `launch: false` の項目・`disabled: true` の項目・`$HOME` の外を指す項目・フォルダが無い項目 | 6・それぞれの語。今いるフォルダで起きない |
| `open --repo web --terminal terminal`（`--new-window` なし）・`open --repo web --new-window --terminal iterm` | 2・`conflicting_options`／2・`invalid_argument` |
| `open --repo web`（TTY なし・`CCS_CMD` を PATH に無い命令に） | 4・`dependency_missing`・`detail: claude`（TTY より先） |
| `open --session <UUID>` で、会話の項目が `repos.yml` に無い・`repos.yml` が壊れている | `defaults.command` から後の優先順で起こす／4・`config_invalid` |
| `open --repo web --here --json` を擬似端末で、成功 | 標準出力に外側の JSON が無い |
| `open --repo web --new-window` を macOS 以外で | 4・`unsupported_os` |
| macOS で `defaults.terminal` なし | 4・`terminal_not_set` |
| macOS で `open` を偽の命令にした（呼ばれた引数を書き出す） | 0・`-a Terminal` と `.command` のファイル。ファイルの中に `command` の文字列が無く、名前が `'…'` で包まれている |
| 記号の入った名前（`R (old)`） | 起動ファイルの中で 1 つの引数として渡る |

## 8. 未決の点と勧め

| # | 点 | 勧め |
|---|---|---|
| 1 | `schema_version` を semver の文字列にした事（呼ぶ側の Health の枠の例と同じ形）。枠のバージョンと ccs の口の形のバージョンを同じ欄で持つ | ccs の口の形のバージョンとして持ち、足すだけは minor・壊す時は major。枠が別の意味を決めたら合わせる |
| 2 | `open --new-window` が、呼んだ GUI のアプリにオートメーションの許可を求めないか・隔離の属性（quarantine）で `.command` が止められないか・新しいウィンドウのシェルの PATH で `node` が見つかるか | 確かめた（Terminal.app）: 本物で動き、オートメーションの許可を求めず、`.command` に quarantine が付かず、ログインシェルの PATH で `node` が見つかった。v0.5.0 に `--new-window` を出す。残り: GUI のアプリから呼んだ時に quarantine が付くかは確かめていない。iTerm2 は後で |
| 3 | iTerm2 が `.command` を新しいウィンドウで走らせるか。ほかの端末のアプリ（Ghostty・WezTerm・kitty など）の開き方 | 確かめた（Terminal.app は走る）。iTerm2 は確かめられなかったので、v0.5.0 の一覧は `terminal` だけ。iTerm2 とほかのアプリは確かめてから足す（「足すだけ」の変更） |
| 4 | GUI のアプリから呼ぶと PATH が短く、`node` が見つからない（`dependency_missing`） | 呼ぶ側が利用者のシェルの PATH を渡す前提を README に書く。ccs は PATH を推し量らない |
| 5 | 名前（`name`）の付け替え。表示名は `label` で変えられるが、`name` は会話の結び付きと、行で読む道具のキー | v0.5.0 では作らない。要るなら `repo rename` を別に設計する |
| 6 | `sessions` の題を `--with-titles`、`list` のパスを `--with-paths` の明示のフラグにした事 | この形を勧める（2.2・2.3 の理由） |
| 7 | `open --here` の起こした後の終了コードが、表の値（1〜7）とぶつかる | 機械は `--new-window` を使う。`--here` の終了コードは約束の外と README に書く |
| 8 | 一覧を開く今の口（`ccs`）は `fzf` の下限を確かめず、有るかだけを見る（README と `install.sh` は 0.42.0 以上） | `doctor` は 0.42.0 を `fail` にする。一覧の口の `check_deps` に下限を入れるかは別に決める |
| 9 | `doctor` が `state.db` を読み取り専用で開く時、SQLite が WAL の脇のファイルを作ることがある | 今の一覧と同じ開き方なので約束の外とし、試験は `state.db` 本体の中身と更新の時刻で見る |
