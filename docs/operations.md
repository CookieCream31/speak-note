# 運用ガイド

[READMEへ戻る](../README.md) · [開発・テスト](development.md)

コマンドは `/home/llm/speak-note` で実行します。Docker操作はこのプロジェクトだけを対象にしてください。
録音・録画中はページ更新やサービス再起動を行わず、まず録音を終了して保存完了を確認します。

<a id="apply"></a>
## 変更の反映

Composeはソースをbind mountしますが、プロセスの再起動・依存更新・環境変数の読み直しは別です。

| 変更 | 操作 | 理由 |
| --- | --- | --- |
| README、docs | なし | アプリは変わらない |
| FrontendのTSX/CSS/JS | 通常はHMR。必要ならブラウザ再読み込み | ソースを直接マウント |
| Frontendのpackage.json / lockfile / 起動処理 | `sudo docker compose restart frontend` | 起動時に依存チェックと必要な `npm ci` |
| BackendのPython | APIはreload。Workerは `sudo docker compose restart worker realtime-ai-worker` | Workerには自動reloadがない |
| Alembic Migration | `sudo docker compose restart backend`、完了後にWorkerを再起動 | APIのreloadだけでは起動時Migrationを再実行しない |
| FrontendのDockerfile | `sudo docker compose up --build -d --no-deps frontend` | イメージを再ビルド・反映 |
| BackendのDockerfile / pyproject.toml | `sudo docker compose up --build -d backend worker realtime-ai-worker` | 3サービスでBackendイメージを使用 |
| .env / Composeの設定 | 対象サービスを `up -d --force-recreate` | `restart` だけではコンテナの環境変数は変わらない |
| Caddyfile | `sudo docker compose restart caddy` | ルーティングを再読込 |
| AI設定画面の保存 | 原則Docker操作不要 | DBへ保存。録音用設定は新しい録音で確認 |

`.env` / Compose変更例（変えた設定を使用するサービスだけ指定）:

```bash
sudo docker compose up -d --force-recreate backend worker realtime-ai-worker frontend
```

Tunnel Token変更時はcloudflaredを再作成します。`restart cloudflared` だけでは新しいTokenは入りません。

```bash
sudo docker compose --profile tunnel up -d --no-deps --force-recreate cloudflared
```

画面の変更だけで毎回 `--build --force-recreate` は不要です。
ただし別環境にソースをコピーしていない場合や、開発用Compose以外で起動している場合には、この自動反映は当てはまりません。
`docker compose up frontend` は依存サービスも対象になるため、すでに依存サービスが稼働している場合だけ `--no-deps` を使用します。

### 動画品質・Player変更の反映

今回の録画品質・動画変換・再生設定は依存追加やDB Migrationを含みません。
開発用ComposeではFrontend/APIのソースは自動反映されますが、変換担当Workerは再起動が必要です。
録画・変換中の作業が終わってから、次を実行してください。

```bash
sudo docker compose restart worker frontend
```

ブラウザも再読込します。新しい録画・新しい動画変換から品質設定が適用されます。
既存の派生動画は自動再生成されません。元動画の画質確認にはPlayerの歯車から「元動画」を選択します。
高画質録画では通信量・保存容量・変換負荷が増えるため、空き容量とWorkerのメモリを確認してください。

## 設定の管理場所

- [docker-compose.yml](../docker-compose.yml): コンテナへ渡す変数、volume、port、起動コマンド。
- [.env.example](../.env.example): 設定テンプレート。実値はローカル `.env` のみ。
- [config.py](../backend/app/core/config.py): Backendの既定値と検証。
- AI設定画面: Provider接続情報、Profile、用途、Live文字起こしエンジン、Azure認証情報。

ルートの `.env` はComposeの展開元です。変数を追記するだけで全コンテナへ渡るわけではありません。
新しい設定を追加するときは、必要な各サービスの `environment` も確認します。

### 環境変数一覧

| 変数 | 既定値・用途 |
| --- | --- |
| POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD | DB名・ユーザー・パスワード。exampleの認証値は開発用ダミー |
| DATABASE_URL | SQLAlchemy接続URL。上記DB認証情報と一致させる |
| SPEAK_NOTE_UID / SPEAK_NOTE_GID | 1000 / 1000。Backend・Workerの実行ユーザー |
| FRONTEND_PORT / BACKEND_PORT | 3000 / 8001 |
| BACKEND_INTERNAL_URL | http://backend:8001。Next.jsからの内部API接続 |
| CORS_ORIGINS | http://localhost:3000。Backendの許可Origin、カンマ区切り |
| NEXT_ALLOWED_DEV_ORIGINS | Compose既定はlocalhost。開発用Originのhostname/IP、schemeなし、カンマ区切り |
| STORAGE_ROOT | /app/storage。コンテナ内保存先。変更時はvolumeのマウント先も整合させる |
| MAX_AUDIO_UPLOAD_MB / MAX_VIDEO_UPLOAD_MB | 1024 / 4096。音声・動画の受付上限 |
| UPLOAD_CHUNK_MB | 50。ファイルアップロードの分割サイズ、設定範囲1〜90MB |
| WORKER_POLL_INTERVAL_SECONDS | 2。Job取得間隔 |
| REALTIME_CHUNK_MS | 15000。録音保存用Chunk間隔 |
| REALTIME_WINDOW_MS | 30000。WhisperX Liveの音声Window |
| REALTIME_MAX_CHUNK_MB | 64。録音WebSocketのChunk受付上限 |
| REALTIME_ANALYSIS_INTERVAL_MS | 30000。Live AI解析を予約する会議時間間隔（処理完了時間の保証ではない） |
| REALTIME_ANALYSIS_DRAFT_TAIL_MS | 2000。Live AIで暫定として扱う末尾時間幅 |
| REALTIME_ANALYSIS_TIMEOUT_SECONDS | 300。Live AIのAPI timeout |
| WHISPERX_BASE_URL | http://host.docker.internal:8000 |
| WHISPERX_API_KEY | WhisperXのBearer Token。ブラウザに返さない |
| WHISPERX_MODEL / WHISPERX_LANGUAGE | large-v3 / ja |
| WHISPERX_TIMEOUT_SECONDS | 7200 |
| WHISPERX_MAX_ATTEMPTS / WHISPERX_RETRY_DELAY_SECONDS | 3 / 1。再試行上限・基準待機秒 |
| AZURE_SPEECH_TIMEOUT_SECONDS | 60。BackendのAzure HTTP Client用 |
| AZURE_SPEECH_MAX_ATTEMPTS / AZURE_SPEECH_RETRY_DELAY_SECONDS | 3 / 1。BackendのAzure HTTP Client用 |
| MASTER_ENCRYPTION_KEY | Gemini・Azure API Keyを暗号化するFernet key。復号にも同じ値が必要 |
| LLM_TIMEOUT_SECONDS | 1800。通常AI処理のAPI timeout |
| OLLAMA_NUM_CTX | 65536。Ollamaのcontext window |
| OLLAMA_ALLOWED_HOSTS | host.docker.internal,localhost,127.0.0.1。許可するPrivate接続先、scheme/portなし |
| SPEAK_NOTE_HTTPS_HOST / HTTPS_PORT | exampleは192.168.0.126 / 3443。自分のLAN環境へ変更 |
| CLOUDFLARE_TUNNEL_TOKEN | 任意のTunnel用Secret。tunnel profileを使うときに設定 |

`WATCHPACK_POLLING=true` はFrontendのCompose設定内で指定しています。
`AZURE_SPEECH_*` のtimeout/retryは、ブラウザSpeech SDKの再接続タイマーではありません。
ブラウザ側の設定・PCM供給は [azure-speech-stream.ts](../frontend/lib/azure-speech-stream.ts) を確認してください。

新しい変数や値の有効範囲を判断するときは上表だけでなくコードを確認します。
たとえばWebSocketサイズを変更する場合、Backendの `--ws-max-size` と経路の制限も別途確認が必要です。

<a id="https"></a>
## HTTPSと公開経路

現状は開発用サーバーで、アプリ内認証はありません。
インターネットからFrontend / Backendへ無認証で直接到達させないでください。
Composeの公開portは既定でホストの特定IPに限定されていないため、ファイアウォール等も確認します。

### Cloudflare Tunnel

1. remotely-managed Tunnelを作成し、Docker用Tokenを取得する。
2. Published applicationのService URLを **http://caddy:8080** にする。
3. 同じhostnameにCloudflare AccessのSelf-hosted applicationを作成し、許可する利用者を制限する。
4. `.env` の `CLOUDFLARE_TUNNEL_TOKEN` に実値、`NEXT_ALLOWED_DEV_ORIGINS` に利用hostnameを設定する。
5. 起動し、認証後の画面・API・録音WebSocketを確認する。

```bash
sudo docker compose --profile tunnel up --build -d
sudo docker compose logs --tail=100 cloudflared
```

Caddyは画面をFrontendへ、`/api/*`（WebSocketを含む）をBackendへ振り分けます。
以前の `http://frontend:3000` 経由のTunnel設定はCaddy経由に変更してください。
Backend / WhisperX / Ollamaを別の公開hostnameとして登録しません。

通常のファイルアップロードも分割送信するため、**ファイル全体のサイズだけでTunnel経由不可とはなりません**。
各リクエストのサイズ・制限・timeoutを確認し、必要なら `UPLOAD_CHUNK_MB` を小さくするかLAN/VPN経由を使います。
録音WebSocketのChunkは別経路・別サイズ設定です。

### LANのHTTPS

`.env` にLAN IPを設定します（以下は例）:

```dotenv
SPEAK_NOTE_HTTPS_HOST=192.168.0.126
HTTPS_PORT=3443
NEXT_ALLOWED_DEV_ORIGINS=localhost,192.168.0.126
```

環境変数を変更した場合は再作成します。

```bash
sudo docker compose up -d --force-recreate caddy frontend
sudo docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/speak-note-caddy-root.crt
```

Macから証明書を取得し、内容と接続先を確認した上で信頼登録します。
これはMacの信頼済み証明書設定を変更する操作です。

```bash
scp llm@192.168.0.126:/tmp/speak-note-caddy-root.crt /tmp/speak-note-caddy-root.crt
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/speak-note-caddy-root.crt
```

ブラウザを再起動し `https://192.168.0.126:3443` を開きます。
独自の証明書Storeを使用するブラウザは別途信頼設定が必要です。
このRoot CAは公開証明書ですが、CaddyのCA秘密鍵は共有しないでください。

## 永続データと保護

| 保存場所 | 内容 |
| --- | --- |
| storage/（ホストのbind mount） | 原本、録音Chunk、派生動画・音声 |
| speak-note-postgres（named volume） | 会議、文字起こし、AI結果、暗号化された設定、Job等 |
| .envとMASTER_ENCRYPTION_KEY | 接続設定・復号キー。DBバックアップとは別に安全に保管 |
| speak-note-caddy-data / speak-note-caddy-config | ローカルCA等のHTTPS関連データ |
| speak-note-node-modules / speak-note-next-cache | Frontend依存・開発キャッシュ（会議原本ではない） |

バックアップはDBとstorageの整合性を保って取得し、暗号化キーも復旧可能にします。
`MASTER_ENCRYPTION_KEY` を変えただけでは既存API Keyを復号できません。
DB Volumeが既に初期化済みの場合、`POSTGRES_PASSWORD` の書き換えだけではDB内ユーザーのパスワードは変わりません。

`docker compose down -v`、各種prune、Volume削除を通常の反映・トラブル対処として実行しないでください。
CaddyのData Volumeを失うとローカルCAも変わり、端末への信頼登録をやり直す必要があります。

<a id="troubleshooting"></a>
## 障害調査

まず状態と必要なログを確認します。Secret・個人情報を確認し、必要な箇所だけマスクして共有します。

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 backend worker realtime-ai-worker frontend
curl --fail http://localhost:8001/api/v1/health
```

| 症状 | 確認すること |
| --- | --- |
| UIが変わらない | ソース反映、FrontendのHMRエラー、ブラウザ再読み込み。必要ならFrontend再起動 |
| Speech SDK等のModule not found | package.jsonとlockfileの整合、Frontend起動ログのnpm ci完了。イメージ再buildだけではnode_modules Volumeが古い場合がある |
| pytestが見つからない | 開発依存がない。[一時コンテナのテスト手順](development.md#テスト)を使う |
| APIは変わったのにJobが古い動作 | worker / realtime-ai-workerを再起動したか |
| .env変更が反映されない | 対象コンテナを再作成したか。restartだけでは反映されない |
| storage Permission denied | ホストの所有者・UID/GIDとCompose user。プロジェクト全体へ安易なchmod/chownは行わない |
| Jobがqueuedのまま | 担当Workerの起動・ログ。通常WorkerとLive AI Workerを取り違えていないか |
| WhisperX / Ollamaへ接続できない | コンテナのlocalhostを指定していないか、host.docker.internalから到達できるか、許可host・認証・外部サービス状態 |
| Geminiで404等 | 選択モデルの提供状況・利用権限・モデルIDを確認。Profileのモデル取得結果と実行時エラーを確認する |
| 画面共有・マイクを開始できない | Secure Context、権限、ブラウザAPI対応、音声共有の選択。非対応時は保存済みファイルで取り込む |
| 録画停止後にFinalがない | 画面共有・マイク録音はリアルタイム版を表示。「要約を再生成」の初回にFinalを作成する。画面共有は動画変換完了を待つ |
| Live文字起こしは動くがAI要約がない | 会議のAI設定、用途の無効設定、Default、Provider有効性、realtime-ai-worker |
| すべて同じ話者 / 認識停止 | Azure Resource設定、入力音声、接続、診断イベントを確認。表示の問題と認識結果を分離する |

### Azure診断

録音カードの「文字起こしの診断情報」→「診断情報を保存」からJSONを取得できます。
直近最大300件で、接続世代・時刻・Azure話者ID・表示話者番号・文字数などを含みます。
本文・音声・API Key・Tokenは含めませんが、共有前には内容を確認してください。
ブラウザ内の情報なので、再読み込み前に保存します。

再現報告には「録音か画面共有か」「認識エンジン」「停止した会議内時刻」「ブラウザ」「マイク・共有音声の選択」
「途中結果か確定結果か」「再接続前後か」を添えます。
接続テスト成功はToken発行の確認であり、音声認識・話者分離の品質検証ではありません。

本プロジェクトではリアルタイム話者分離用にStandard (S0) Resourceを使用する設計です。
Azureの話者IDは実名ではなく認識時の汎用識別子です。
実装を変更する際は[Microsoft公式のリアルタイム話者分離ガイド](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization)も確認してください。

## 回答支援用Workerの反映

会議中の回答支援には新しい `answer-worker` とMigration `20260927_0022` が必要です。既存の `worker` / `realtime-ai-worker` は回答支援を担当しません。既存サービスの再起動と専用Workerの作成、検証コマンドは[回答支援ガイド](answer-assist.md)を参照してください。新しい環境変数はなく、既存のDB・暗号化キー・LLM接続設定を利用します。


<a id="summary-regeneration"></a>
## 要約再生成の反映（Migration 0023）

録音・録画と保存、実行中のJobがすべて終わっていることを確認してから実行します。Backend起動時に0022から0023へMigrationし、jobsにanalysis_requestとrequest_idを追加します。追加環境変数・依存更新・Volume削除はありません。実装時はエージェントによる再起動・運用DBへの適用を行わず、その後のユーザー提供ログで0023の適用、BackendのHealthy、3つのWorkerのStartedを確認しました。2026-09-28の追加ログでFrontendコンテナの `Up 43 seconds` を確認し、ホーム画面のテーマ切替も別途確認しました。要約再生成そのものの運用画面での動作確認は未実施です。詳しくは[反映状況の記録](summary-regeneration.md#反映とユーザー確認)を参照してください。

```bash
cd /home/llm/speak-note
sudo docker compose stop worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
```

`20260927_0023 (head)` とBackendの正常起動を確認してからWorkerを再開します。

```bash
sudo docker compose up -d --no-deps worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps
```

ブラウザを再読み込みし、[要約再生成の操作と動作確認](usage.md#summary-regeneration)を実行します。Final作成失敗は親の文字起こしJob、要約失敗は解析Jobの「再試行」を使用します。Final保存後に予約が失敗した場合、親Jobの再試行は保存済みFinalを使い、WhisperXを再実行しません。接続先を変更した場合は現在の設定で新しい再生成を開始してください。テンプレート版の競合はダイアログを閉じてページを再読み込みし、選び直します。既存サービス・Docker Volumeは操作しません。


<a id="display-theme"></a>
## 表示テーマの反映

今回のテーマ対応はFrontendのソースだけの変更で、DB Migration、Backend／Worker再起動、環境変数・package.json・lockfileの更新は不要です。開発用Composeのbind mountとHMRで反映します。録音・録画と保存の完了後にブラウザを再読み込みし、[表示テーマの動作確認](dark-mode.md#check)を行います。

HMRで反映されない場合だけ、同じく録音・録画と保存の完了後にFrontendを再起動します。

```bash
cd /home/llm/speak-note
sudo docker compose restart frontend
sudo docker compose ps frontend
```

2026-09-28のユーザー提供ログで `speak-note-frontend-1` が再起動後に `Up 43 seconds`、ホスト側 `3001` → コンテナ側 `3000` であることを確認しました。ホストの `http://localhost:3001/` でHTTP 200、ダークへの切替、ブラウザ再読み込み後の選択保持、スマートフォン幅での横はみ出しなしを確認しています。`127.0.0.1` など別のホスト名で開く場合は `NEXT_ALLOWED_DEV_ORIGINS` の許可対象を確認してください。今回の既定設定では `localhost` が許可対象です。実会議の各画面や録音中の動作は[確認手順](dark-mode.md#check)を参照してください。

Backend・Worker・他サービス・Docker Volumeは操作しません。別環境へ配布する場合は全変更ファイルを反映し、開発用Compose以外ではその環境のFrontendビルド／配布手順を使用します。テーマ選択はブラウザに保存するため、Frontendの再起動後も残ります。
