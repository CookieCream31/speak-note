# speak-note

録音・動画・画面共有から、文字起こしと根拠付きのAI議事録を作るWebアプリです。
WhisperXを確定版の文字起こし・話者分離に、Ollama / Geminiを要約・質問回答に使用します。
録音中の文字起こしはWhisperXまたはAzure AI Speechを選べます。

最終照合: **2026-10-11**（ホームの作成入口を「新しい会議」に統一・録画・AIスイッチの右側配置統一・3つの取り込み方法と画面共有内の録画ON/OFF・ユーザー提供ログによるMigration 0025の適用・BackendとWorkerの起動確認・映像を保存しない画面共有音声録音・スマートフォンの会議設定・ヘッダー・録音操作・Liveパネルの表示修正・会議詳細のタイトル編集・設定と統一した再生速度メニュー・AI議事録の根拠ID検証失敗時の再試行・再生成失敗時の会議状態・録音接続の自動再接続とMigration 0024・Live文字起こし専用Worker `live-worker` の追加・ホーム一覧の全件取得・現行機能・Migration 0023・回答支援の根拠検証と再試行・Git管理・新規環境の起動手順・リデザイン第1〜2段階の見た目と第3段階の各画面を照合）。この文書は現在のソースコードとCompose設定を説明します。
外部APIの実接続、認識精度、すべての端末での動作を保証するものではありません。

今後の機能追加・修正では毎回、実装とこのREADMEを照合し、操作・構成・設定・制約などの説明に影響する変更を同じ作業で反映します。詳しい作業ルールは[AGENTS.md](AGENTS.md)と[開発ガイド](docs/development.md)を参照してください。

## はじめに読むもの

| 文書 | 役割 |
| --- | --- |
| [README（この文書）](README.md) | 概要、起動、現在できること、注意点 |
| [AGENTS.md](AGENTS.md) | 人間・AIエージェントの作業範囲と安全ルール |
| [CLAUDE.md](CLAUDE.md) | Claude Code向けの入口。AGENTS.mdを読み込み、リデザインの進め方を示す |
| [DESIGN.md](DESIGN.md) | 仕様の正。変更前に対象機能の設計を確認する |
| [開発ガイド](docs/development.md) | 実際のコード配置、変更箇所、テスト、引き継ぎ |
| [運用ガイド](docs/operations.md) | Dockerへの反映、環境変数、HTTPS、障害調査 |
| [操作ガイド](docs/usage.md) | 会議作成、AI設定、再生、Live / Finalの使い分け |
| [議事録テンプレートガイド](docs/meeting-templates.md) | テンプレートの管理、会議ごとのsnapshot、表示 |
| [要約再生成の実装・検証記録](docs/summary-regeneration.md) | 変更ファイル、テスト結果、未検証事項 |
| [共有音声録音の実装・検証記録](docs/shared-audio.md) | 映像を保存しない録音、テスト、Migration 0025 |
| [表示テーマガイド](docs/dark-mode.md) | ダークモード、設定の保存、全画面の対応範囲と検証 |
| [リデザイン実装ガイド](docs/redesign.md) | 画面デザイン変更の段階・配色・レイアウト（未実装の計画。モックアップは `docs/redesign/mockups/`） |

## バージョン管理

このディレクトリはGitの `main` ブランチで管理します。現在の実装を初回の基準点とし、今後は機能・修正ごとにコード、テスト、必要なREADME・docs更新をまとめてcommitします。作業前後に既存変更を確認し、対象ファイルだけを追加して差分・秘密情報・検証結果を確認します。詳しい手順は[Git運用ガイド](docs/git-workflow.md)を参照してください。

`origin` はSSHの `git@github.com:CookieCream31/speak-note.git` です。初回commitはGitHubの `origin/main` にpush済みです。このリポジトリ専用のDeploy keyを書き込み許可で登録しており、以降は機能単位のcommitをpushします。`.env`、録音・録画、DB、生成物、古い `.orig` バックアップは追跡しません。認証情報をソースに書き込まないでください。

DESIGNの「推奨ディレクトリ」「実装Phase」は設計上の説明を含みます。
実ファイルの場所は開発ガイドを参照し、仕様と実装の差を見つけても独断で仕様変更しないでください。

## 現在の機能

| 分野 | 実装されている内容 |
| --- | --- |
| 取り込み | ホームの「新しい会議」から3つの方法（音声・動画をアップロード、画面共有、マイク音声を録音）を選択。画面共有内で映像の録画をON/OFFでき、OFFでは共有音声とONにしたマイク音だけを保存 |
| 会議管理 | 一覧・詳細からのタイトル変更、検索、並べ替え、お気に入り、タグ、複数選択の一括操作、親子2階層のプロジェクトと会議の紐付け |
| 文字起こし | WhisperXの確定版、Live文字起こし、話者名・本文の編集、テキスト出力 |
| 再生 | 音声・動画ダウンロード、文字単位の追従、シーク、画質・字幕設定、設定と同じ形式の速度選択メニュー、全画面。動画設定は半透明の一覧メニューから画質・字幕を個別に変更でき、選択画面は内容に合わせて滑らかにサイズが変わります |
| 表示 | ライト／ダーク／システムに合わせる。端末ごとに選択を保存し、ホーム・会議詳細・AI設定・プロジェクト・404／エラー画面へ適用 |
| AI | Ollama / Gemini接続、プロファイル一覧・デフォルト選択、構造化議事録、生成履歴、会議テンプレート。AIが存在しない根拠IDや文字起こし範囲外の時刻を返した場合は一度だけ修正を求めて再生成し、再び不正なら失敗にします（その場合AI利用料・処理時間は最大2回分） |
| 見返し | 根拠から再生、会議への質問、全文検索、Bookmark、チャプター、重要区間の連続再生 |
| 手動AI連携 | 外部AI用プロンプト出力、回答JSONの検証・取り込み（自動送信はしない） |
| プロジェクト情報 | 共通プロフィール、プロジェクトの背景、テキスト・Markdown資料の保存・参照対象の切替 |
| 回答支援 | 会議中の発言案、独立したAI選択、手動/任意の自動質問検出、詳細・根拠・生成履歴 |

会議開始時のマイクは初期ミュートです。開始前のボタンでONにするか、会議中にミュート解除できます。画面共有でミュート開始した場合は、解除時にマイク権限を要求して既存の録音へ音を追加します。共有音声はマイクのミュートに影響されません。マイクのみの録音でも解除まで無音です。

会議作成の「映像を録画する」と「AIを使う」は、タイトル・説明が左、スイッチが右の共通UIです。アップロードの「文字起こし後にAI要約を自動作成する」も同じ配置です。スマートフォンでは説明を折り返し、スイッチを右側に保ちます。

映像が不要な場合は「画面共有」を選び、その中の「映像を録画する」をOFFにして、共有ダイアログで音声共有を有効にします。録画スイッチの初期値はONで、新しい会議を開くたびにONへ戻ります。切替時も選択済みの共有画面とマイク設定を保持します。作成後は方式を固定し、録音中に映像保存へ切り替えません。OFFでは映像を保存・送信せず、共有音声とONにしたマイク音声を1つの音声として保存し、Live文字起こし・解析・回答支援に使用します。停止後の「要約を再生成」で、初回だけFinal文字起こしを作成します。ブラウザ・OS・共有元によって音声共有の対応が異なり、音声を取得できない場合は開始しません。ブラウザ上は画面共有の許可が必要です。詳しい[操作手順](docs/usage.md#shared-audio)と[Migration 0025の反映手順](docs/operations.md#shared-audio)を確認してください。会議作成の取り込み方法の選択・録画スイッチ・ホームの作成入口の整理はFrontendの変更で、追加のMigrationはありません。

2026-10-11受領のユーザー提供ログで、運用DBの`20261010_0025 (head)`、BackendのHealthy、4つのWorkerのStartedを確認しました。Frontendの再起動実行ログも確認しましたが、再起動後の稼働状態と実録音・要約生成は未確認です。[反映状況の記録](docs/shared-audio.md#反映状況)を参照してください。

画面共有録画は最大4K・解像度別ビットレートで取得し、対応H.264動画の再圧縮を避けます。
実際の画質は共有元・ブラウザ・端末性能に依存し、過去の低画質録画は自動復元されません。
画質選択（元動画 / 互換MP4）と字幕設定の詳細は[操作ガイド](docs/usage.md)を参照してください。

会議詳細のタイトル横の鉛筆から、作成後もタイトルを変更できます（前後の空白を除いて1〜200文字）。保存後は見出し・パンくず・一覧へ反映し、再生や録音を続けられます。通信失敗時は入力を保持して再試行できます。一覧の「…」からも編集できます。

動画・音声の「1×」などの速度表示を押すと、設定と同じ形式のメニューから0.5〜2倍を選べます。現在の選択にはチェックを表示し、外側クリック・Escapeで閉じます。ライト／ダークと狭い画面に対応します。この変更はFrontendのみで、DB変更や新しい環境変数はありません。現行の開発Composeではソースを共有しているため、録音・録画停止後のブラウザ再読み込みで反映を確認でき、Docker再起動は不要です。

プレイヤー内の操作ボタンをクリックした後はフォーカスを解除し、Spaceを再生・一時停止に使えます。Tab・Enterによるボタン操作ではフォーカスを維持します。
全画面切替後にボタンへフォーカスが戻ってもSpaceは再生・一時停止を優先します。設定メニュー内は選択操作を優先します。

Phase 1〜6の機能に加え、マイク録音、Azureストリーミング、モバイル向け表示などが追加されています。
「Phase 6実装済み」だけを根拠に、設計書のすべてが実装・実機検証済みとは判断しないでください。

### プロジェクトと共通プロフィール

ホームの「プロジェクト」から親プロジェクトと子プロジェクト（2階層まで）を作成し、各階層に背景情報と資料を保存できます。共通プロフィールはAIモデルの「プロファイル」と別物で、子プロジェクトは親の情報を引き継ぎます。兄弟プロジェクト間では資料を共有しません。資料は現時点で100KB以下の .txt / .md または貼り付けたテキストに対応します。保存後も本文の編集と参照対象からの除外ができます。

会議作成時にプロジェクトを選ぶか、既存会議の詳細画面から紐付け先を変更できます。会議作成画面の「＋ 新規作成」から親・子プロジェクトを作成し、そのまま会議の所属先として自動選択できます。プロジェクト・議事録テンプレートの選択欄は他の入力と統一したデザインです。未分類の会議もそのまま残ります。会議中の「回答支援」では、AI設定に登録したOllama / Geminiのプロファイルを要約とは独立して選択できます。送信確認後に開始し、質問の手入力・現在の発言・任意の自動質問検出から、短い回答案・詳細・根拠・履歴を表示します。開始時の資料・設定を固定し、AI切替時は停止と再確認を行います。現在の「会議への質問」は従来どおり確定文字起こしを対象とし、保存したプロジェクト資料を自動送信しません。詳しくは[操作ガイド](docs/usage.md)を参照してください。

回答支援の導入にはMigration `20260927_0022` と新しい `answer-worker` が必要です。[回答支援ガイド](docs/answer-assist.md)に反映コマンド・使い方・検証手順・制約を記載しています。自動回答は初期OFFで、会議中にON／OFFできます。ONの間は専用Workerが新しい発話と直近の会話をAIで判断し、完成した質問に回答案を生成します。判定にもAI利用料・処理時間がかかります。混合音声の話者番号から自分と相手を完全には区別できません。任意のAIサービス全般への対応ではなく、現在のOllama / Gemini接続境界を共通利用します。回答AIが存在しない根拠IDを返した場合は一度だけ修正を求め、再び不正ならその回答Jobだけを失敗にします。過去の回答と録音は保持します。

### LiveとFinalの違い

| 取り込み方 | 録音・録画中 | 停止・アップロード完了後 |
| --- | --- | --- |
| 音声ファイル | なし | WhisperXでFinalを自動作成 |
| 動画ファイル | なし | FFmpeg変換 → WhisperXでFinalを自動作成 |
| マイク録音 | 選択したLive認識エンジン | リアルタイム版を保存・表示。「要約を再生成」で初回のみFinalを作成 |
| 画面共有録画 | 選択したLive認識エンジン | 停止後は動画変換とリアルタイム版の表示。「要約を再生成」で初回のみFinalを作成 |

会議のAI利用の有無・プロファイル・要約形式・背景は、取り込み方法によらず会議作成画面で選べます（画面共有・マイク録音ではリアルタイム解析と「要約を再生成」の初期値に使用）。Final完了後、会議のAIが有効で利用可能なプロファイルがあればAI解析Jobを作成します。
Liveの発話確定は、会議全体のFinal作成とは別です。Liveの話者番号を永久的な人物IDとみなしません。
会議テンプレートはAI Profileとは別に管理します。会議と解析Versionは選択時の定義をsnapshotとして保持するため、後日のテンプレート編集は過去の表示を変えません。[テンプレートの仕様と操作](docs/meeting-templates.md)。

## 構成

現在のComposeは**開発用**です。FrontendはNext.js開発サーバー、BackendはUvicornのreloadで動きます。
Dockerfileだけで判断せず、[docker-compose.yml](docker-compose.yml)のcommandとvolumeを確認してください。

| サービス | 役割 | ホスト側ポート（既定） |
| --- | --- | --- |
| frontend | Next.js / React / TypeScript | 3000 |
| backend | FastAPI / SQLAlchemy、API・WebSocket、起動時Migration | 8001 |
| worker | 動画変換、WhisperX、確定議事録、質問回答 | 公開なし |
| live-worker | 録音中のLive文字起こし（WhisperX / Azure短時間音声）専用。1台で動かす | 公開なし |
| realtime-ai-worker | Live文字起こしを使うAI解析 | 公開なし |
| answer-worker | 会議中の回答支援専用の生成Job | 公開なし |
| postgres | PostgreSQL 17、Jobと会議データ | 公開なし |
| caddy | HTTPS、通常画面と /api の振り分け | 3443 |
| cloudflared | 任意のCloudflare Tunnel（tunnel profile） | 公開なし |

WhisperX（ホスト8000）とOllama（ホスト11434）は既存の別サービスです。このComposeでは起動・変更しません。
コンテナからは `host.docker.internal` を使います。

<a id="fresh-install"></a>
## 新しいUbuntu環境でGitから起動

アプリはUbuntu Server上で実行します。以下はユーザー `llm`、配置先 `/home/llm/speak-note` の例です。別のユーザーならホームディレクトリと `.env` のUID/GIDを読み替えてください。Mac等はブラウザ・Remote SSHの操作端末です。

### 1. 前提とSSHでclone

- UbuntuにGit、Python 3、curl、OpenSSH client、[Docker Engine](https://docs.docker.com/engine/install/ubuntu/)と[Docker Composeプラグイン](https://docs.docker.com/compose/install/linux/)を用意します。Dockerはリンク先の公式手順で導入してください。
- 確定文字起こしには、このリポジトリに含まれないWhisperX API ServerとAPI Keyが必要です。既定の接続先はホストの8000番です。AI解析には別途Ollama（既定はホストの11434番）かGemini API Keyを用意します。Azure Liveを使う場合はSpeech Resource、リージョン、API Keyも必要です。外部サービスの導入・設定はそれぞれの手順に従ってください。
- GitHubの `CookieCream31/speak-note` へのSSH読み取り権限が必要です。新しいホストでは新しい鍵を作り、**公開鍵だけ**をリポジトリの **Settings → Deploy keys** に登録します。cloneだけなら読み取り権限、以後このホストからpushするなら **Allow write access** を有効にします。既存の鍵を上書きせず、必要ならファイル名を変えてください。[GitHubのDeploy key手順](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)。

```bash
sudo apt update
sudo apt install -y git python3 curl openssh-client
git --version
python3 --version
sudo docker compose version
```

```bash
install -d -m 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -C "speak-note on new host" -f "$HOME/.ssh/speak-note_ed25519"
cat "$HOME/.ssh/speak-note_ed25519.pub"
```

公開鍵の登録後にcloneします。初回接続時は表示されたGitHubのホスト鍵指紋を[GitHub公式一覧](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)と照合してから承認してください。秘密鍵をGitHubやこのリポジトリに登録しないでください。

```bash
cd "$HOME"
git -c core.sshCommand="ssh -i $HOME/.ssh/speak-note_ed25519 -o IdentitiesOnly=yes" clone git@github.com:CookieCream31/speak-note.git
cd speak-note
git config --local core.sshCommand "ssh -i $HOME/.ssh/speak-note_ed25519 -o IdentitiesOnly=yes"
git status --short --branch
```

このホストから変更をpushする場合は、Deploy keyの書き込み権限に加え、リポジトリ内で `git config --local user.name "cookie"` と `git config --local user.email "74705675+CookieCream31@users.noreply.github.com"` を設定します。鍵やGit設定はcloneに含まれません。[Git運用ガイド](docs/git-workflow.md)も参照してください。

### 2. ローカル設定

`.env` はGitに含まれません。既にある場合は上書きしないでください。

```bash
cd "$HOME/speak-note"
test -e .env || cp .env.example .env
mkdir -p storage
id -u
id -g
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```

[.env.example](.env.example)を参考に `.env` を編集します。最後のコマンドの出力は `MASTER_ENCRYPTION_KEY` に設定し、安全に保管します。

- `POSTGRES_PASSWORD` をダミー値から変更し、`DATABASE_URL` 内の認証情報と一致させる。
- `SPEAK_NOTE_UID` / `SPEAK_NOTE_GID` を上記のホストユーザーに合わせ、`storage/` を書き込み可能にする。
- `WHISPERX_API_KEY` のダミー値を実値へ変更し、必要なら `WHISPERX_BASE_URL` を接続先に合わせる。
- `MASTER_ENCRYPTION_KEY` を設定する。Gemini / Azure等の暗号化された設定を別環境へ移す場合は、元環境と**同じ鍵**が必要です。
- 利用するホスト名・ポートに合わせて `FRONTEND_PORT`、`BACKEND_PORT`、`SPEAK_NOTE_HTTPS_HOST`、`NEXT_ALLOWED_DEV_ORIGINS`、必要なら `CORS_ORIGINS` を確認する。Cloudflare Tunnelを使わない初回起動では `tunnel` profileを指定しません。

### 3. 起動と確認

```bash
cd "$HOME/speak-note"
sudo docker compose config --quiet
sudo docker compose up --build -d
sudo docker compose ps
curl --fail http://localhost:8001/api/v1/health
sudo docker compose exec -T backend alembic current
```

`config --quiet` は構文確認のみです。値を展開する `docker compose config` の出力にはSecretが含まれ得るため、共有しないでください。Backendは起動時にAlembic Migrationを実行します。現行ソースのheadは `20261005_0024` です。Frontendは起動時にlockfileを確認し、必要なら `npm ci` を実行します。初回ビルド中はヘルスチェックが通るまで待ってから確認してください。エラー時は[障害調査](docs/operations.md#troubleshooting)を参照してください。

- 画面（Compose既定）: [http://localhost:3000](http://localhost:3000)。`FRONTEND_PORT` を変えた場合はそのホスト側ポートを使用します。2026-09-28のユーザー提供ログでは3001→コンテナ3000です。
- APIドキュメント: [http://localhost:8001/docs](http://localhost:8001/docs)
- ヘルスチェック: [http://localhost:8001/api/v1/health](http://localhost:8001/api/v1/health)

上の `localhost` はUbuntuホスト自身からの接続です。`FRONTEND_PORT` / `BACKEND_PORT` を変更した場合はURLと `curl` コマンドのポートも読み替えます。Macなど別端末のブラウザからは[LAN HTTPS設定](docs/operations.md#https)後にUbuntuホストのIPアドレスでアクセスしてください。

画面が開いたら[操作ガイド](docs/usage.md)に従ってAI設定・Profileを登録し、短いファイルをアップロードして会議・Job・Final文字起こしを確認します。WhisperXへ接続できない場合は上記の外部サービスとAPI Keyを確認してください。録音・画面共有にはHTTPSまたはlocalhostのSecure Contextが必要です。別端末からの録音や長時間録画は、WebSocketをBackendへ直接振り分けるCaddy経由を使います。[LAN HTTPS / Cloudflareの手順](docs/operations.md#https)。

### 既存環境の会議データを移す場合

Gitからcloneしただけでは**空の新規環境**です。`.env`、PostgreSQL volume内の会議・文字起こし・AI設定、`storage/` の原本、CaddyのローカルCAはGitに入りません。移行時はDBと `storage/` の整合するバックアップ、元の `MASTER_ENCRYPTION_KEY` を含む設定を用意し、新環境で復旧してから起動してください。鍵を変えると保存済みのAPI Keyは復号できません。[永続データと保護](docs/operations.md#永続データと保護)。volumeや既存サービスを削除して初期化しないでください。

### 表示テーマ（ダークモード）

画面上部の「表示テーマ」の3択アイコンでライト・ダーク・システムに合わせるを選べます。初期値はシステム設定です。選択はブラウザに保存し、OS設定への追従・別タブとの同期に対応します。切替は再読み込みやAPI通信を行わず、入力・録音・再生を続けたまま適用します。フォーム、議事録履歴、リアルタイム解析、回答支援、ダイアログ、状態・エラー表示にも共通配色を使用します。配色は白・黒・グレーにエメラルドの差し色1色です（[リデザイン](docs/redesign.md)第1段階）。文字はGeist・Noto Sans JP、時刻などの数字はGeist Monoで、最小11pxです。画面の見出しは日本語だけで、英字の大文字ラベルと番号付き見出しは表示しません。アイコンは `lucide-react` の線のアイコンです。角丸はボタン・入力8px、カード12px、ダイアログ16pxにそろえ、影はダイアログ・メニュー・プレイヤー操作部だけです。状態表示は完了＝グレー、処理中＝差し色の点、失敗＝赤、録画・録音中＝赤い点です（第2段階まで。第3段階の画面レイアウト（ホーム・会議詳細・新しい会議・録画中・プロジェクト・AI設定・ダイアログ・スマートフォン表示）を反映。議事録テンプレートは専用画面 `/settings/templates` で編集）。フォントは `next/font/google` がFrontendの起動・ビルド時に取得してアプリから配信するため、ブラウザからGoogleへは接続しません。Frontendコンテナがインターネットへ出られない場合は代替フォントで表示されます。映像・画像の内容は変更せず、映像上の字幕・操作部には読める固定配色を使います。保存領域を利用できない場合も、その画面で切替できます。操作と検証範囲は[表示テーマガイド](docs/dark-mode.md)を参照してください。

DB・環境変数の変更はありません。リデザイン第2段階でFrontendの依存に `lucide-react` を追加したため、この変更を取り込んだ後は一度 `sudo docker compose restart frontend` を実行します（起動時に `npm ci` されます）。それ以外は開発用ComposeのHMRで反映し、録音・録画と保存の完了後にブラウザを再読み込みします。2026-09-28のユーザー提供ログでFrontendの再起動後 `Up 43 seconds` を確認しました。ホストの `http://localhost:3001/` はHTTP 200を返し、実配信のホーム画面でテーマ切替と保存値の復元を確認しています。その他の実会議画面・録音中の操作は引き続き未確認です。[確認範囲と手順](docs/dark-mode.md)を参照してください。

## 変更を反映するには

| 変更内容 | 通常必要な操作 |
| --- | --- |
| README・文書だけ | Docker操作不要 |
| FrontendのTSX / CSS | bind mountとHMRで反映。ブラウザを再読み込み |
| Frontendの依存関係 / 起動スクリプト | `sudo docker compose restart frontend` |
| BackendのPython | APIはreload。Workerにも関係するなら `sudo docker compose restart worker live-worker realtime-ai-worker` |
| DB Migration追加 | 録音を終えてBackendを再起動し、Migration結果を確認 |
| .env / Compose / Dockerfile / Python依存関係 | 再起動だけでは不十分な場合あり。[反映手順](docs/operations.md#apply)を参照 |

スマートフォンの会議詳細では、プロジェクト・AI・話者数・処理状況を幅の揃った行に表示します。長い設定名は選択欄の中へ収め、ラベルの途中折り返しを防ぎます。上部は会議一覧へのリンク・テーマ切替・AI設定を44px以上の高さで操作でき、録音・録画の丸いボタンではアイコンを中央に表示します。Live文字起こしと解析タブの補足は狭い画面で行を分けます。今回の変更はCSSのみで、DB・環境変数・依存パッケージの変更はありません。

録音中の再読み込み・再起動は避け、保存完了を確認してから操作してください。
新しい録音処理のコードを試すときは、更新後のページで新しい録音を開始します。

### Live文字起こし専用Worker

録音中のLive文字起こしは `live-worker` が担当し、通常の `worker` は担当しません。これにより、別の会議のFinal文字起こしやAI要約が長時間かかっても、会議中の文字起こしが止まりません。各区間の音声は録音ファイル全体をコピーせずに切り出すため、長い会議でも1区間あたりの処理時間が増えません。

この変更を取り込んだ既存環境では、録音・録画を終えてから `sudo docker compose up -d --build live-worker` と `sudo docker compose restart worker` を実行します。`live-worker` を起動しないと、Live文字起こしのJobが `queued` のまま進みません。DB Migration・環境変数の追加はありません。[反映手順](docs/operations.md#live-worker)。

### 録音中の接続切れと自動再接続

録音・画面共有の途中で通信が切れたりBackendが再起動したりしても、ブラウザは録音を続け、最大5分間自動で再接続します。再接続すると同じ録音セッションへ戻り、切断中に録った分を含めて未送信のデータを順番どおり送ります（Backendは重複を無視します）。再接続中は録音画面に「再接続しています…」と表示されます。

ブラウザの再読み込み・タブを閉じる・録音画面から移動する操作は意図した終了として扱い、従来どおり受信済みのデータですぐ確定します。5分以内に再接続できなかった場合や、ブラウザ自体が終了した場合は、最後にデータが届いてから `REALTIME_RESUME_TIMEOUT_SECONDS`（既定600秒）後に `live-worker` が受信済みデータで確定します。送信待ちのデータはブラウザのメモリに保持するため、タブが閉じると未送信分は失われます。

この変更にはMigration `20261005_0024`（録音セッションの最終受信時刻）と `live-worker` が必要です。新しい環境変数 `REALTIME_RESUME_TIMEOUT_SECONDS` は省略できます（既定600秒）。[反映手順](docs/operations.md#recording-resume)。

## 既知の制約・引き継ぎ時の注意

- アプリ内のログイン・利用者ごとの権限分離は未実装です。インターネットへ無認証で公開しないでください。Cloudflare利用時もAccess設定と、迂回できる公開ポートがないことを確認します。
- iOS / iPadOSを含む画面共有は、実行時のブラウザAPI対応判定に依存します。非対応時は端末の画面収録ファイルをアップロードする案内です。ネイティブ画面共有の実装はありません。
- Azureの認識精度・話者分離は音源・接続・リソース設定の影響を受けます。モックテストの成功だけで実録音の品質を保証しません。
- 「質問候補」「チャプター」の用途別Profileは保存UI/APIがありますが、現在の一括議事録生成では個別には参照されません。確定議事録と同じProfileで生成します。会議への質問回答も確定議事録側のProfile解決を使用します。
- `generate_thumbnails` はJob種別にありますが、Workerの処理分岐は未実装です。
- 運用データは `storage/`、PostgreSQL Volume、暗号化キーを含む設定に分かれます。Volume削除は初期化ではなくデータ消失です。
- 旧会議とテンプレートsnapshotのない解析Versionは、従来の議事録表示を使います。テンプレート値に関する詳細は[議事録テンプレートガイド](docs/meeting-templates.md)を参照してください。

根拠ファイル・テスト・改修時の確認項目は[開発ガイド](docs/development.md)、障害時の切り分けは[運用ガイド](docs/operations.md#troubleshooting)を参照してください。

### 停止後のリアルタイム版と要約再生成

画面共有・マイク録音の停止後は、録画操作とLive専用パネルに代わり、共通の会議ノートで保存済みのリアルタイム文字起こしと解析を表示します。動画・音声再生、文字ハイライト、話者表示、要約カード、テキスト出力を利用できます。リアルタイム版は暫定データで、正式な話者ID・単語時刻の精度を保証せず、編集や会議後の質問は高精度版が必要です。解析をOFFにしていた場合は要約がなくても文字起こしを見られます。

会議画面右上の「要約を再生成」から、今回だけ使うAIプロファイルと議事録テンプレートを選びます。初期値は会議のAI設定と保存済みテンプレートです。テンプレートの「確定後」のカード・項目・AIへの指示を使い、会議やリアルタイム解析の設定は変更しません。テンプレート選択時は従来の要約形式を重ねて指定しません。AIなしの会議でも今回使うプロファイルを明示すると生成できます。

保存済みの全体文字起こし（Final）があれば要約だけを生成します。Finalがない場合だけ初回にWhisperXで全体文字起こしを保存し、選択設定を引き継いで要約生成へ進みます。以降はモデル・テンプレートを変更しても文字起こしをやり直しません。過去の要約とリアルタイム版を保持し、処理中も閲覧・版切替ができます。連打や処理中の要求は重複Jobを作らず、失敗時は既存結果を保持します。以前の要約またはリアルタイム版が残っている会議は、再生成に失敗しても一覧で「失敗」にならず「完了」のままです。失敗は会議画面の処理状況に再試行ボタン付きで表示されます。アップロード会議の自動処理は維持しています。

Migration `20260927_0023` が必要です。追加環境変数はありません。録音・録画と保存、実行中Jobの終了を確認してから[要約再生成の反映手順](docs/operations.md#summary-regeneration)を実行してください。操作・動作確認は[操作ガイド](docs/usage.md#summary-regeneration)、実装と検証は[開発ガイド](docs/development.md#summary-regeneration)に記載しています。
