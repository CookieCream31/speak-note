# 運用ガイド

[READMEへ戻る](../README.md) · [開発・テスト](development.md)

コマンドは `/home/llm/speak-note` で実行します。Docker操作はこのプロジェクトだけを対象にしてください。
録音・録画中はページ更新やサービス再起動を行わず、まず録音を終了して保存完了を確認します。
現行ソースのMigration headは`20261014_0031`です。最新変更の反映は[Sonioxへの統一を含む手順](#soniox-realtime-only)を使用してください。過去の機能の節にあるhead番号は、その機能を追加した時点のものです。

<a id="apply"></a>
## 変更の反映

Composeはソースをbind mountしますが、プロセスの再起動・依存更新・環境変数の読み直しは別です。

| 変更 | 操作 | 理由 |
| --- | --- | --- |
| README、docs | なし | アプリは変わらない |
| FrontendのTSX/CSS/JS | 通常はHMR。必要ならブラウザ再読み込み | ソースを直接マウント |
| Frontendのpackage.json / lockfile / 起動処理 | `sudo docker compose restart frontend` | 起動時に依存チェックと必要な `npm ci` |
| BackendのPython | APIはreload。Workerは `sudo docker compose restart worker live-worker realtime-ai-worker answer-worker` | Workerには自動reloadがない |
| Alembic Migration | `sudo docker compose restart backend`、完了後にWorkerを再起動 | APIのreloadだけでは起動時Migrationを再実行しない |
| FrontendのDockerfile | `sudo docker compose up --build -d --no-deps frontend` | イメージを再ビルド・反映 |
| BackendのDockerfile / pyproject.toml | `sudo docker compose up --build -d backend worker live-worker realtime-ai-worker answer-worker` | 5サービスでBackendイメージを使用 |
| .env / Composeの設定 | 対象サービスを `up -d --force-recreate` | `restart` だけではコンテナの環境変数は変わらない |
| Caddyfile | `sudo docker compose restart caddy` | ルーティングを再読込 |
| AI設定画面の保存 | 原則Docker操作不要 | DBへ保存。録音用設定は新しい録音で確認 |

`.env` / Compose変更例（変えた設定を使用するサービスだけ指定）:

```bash
sudo docker compose up -d --force-recreate backend worker live-worker realtime-ai-worker frontend
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

<a id="shared-audio"></a>
## 画面共有音声録音の反映（Migration 0025）

会議の取り込み方法に`shared_audio`を追加する変更です。Alembicの既存head `20261005_0024`から`20261010_0025`へ進みます。既存の会議・録画・音声は書き換えず、PostgreSQLの`meeting_source_type`へenum値を追加します。新しい環境変数・依存追加・Volume削除はありません。

録音・録画、保存、実行中のJobがすべて完了してから、このプロジェクトで実行します。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
```

`alembic current`が`20261010_0025 (head)`であることを確認してからWorkerを再開します。Backendの起動時にMigrationを実行します。失敗時はログを確認し、Workerを止めたまま原因を解決してください。最後にブラウザを再読み込みし、[共有音声録音の確認手順](usage.md#shared-audio)を実行します。エージェントは稼働中サービスの再起動や運用DBへの適用を行っていません。Migrationの検証はPostgreSQL向けoffline SQL生成で行っています。

2026-10-11受領のユーザー提供ログで、PostgreSQLのMigration `20261010_0025 (head)`、BackendのHealthy、`worker`・`live-worker`・`realtime-ai-worker`・`answer-worker`のStartedを確認しました。Frontendのrestart実行ログも確認しました。再起動後のFrontendの稼働状態は、必要なら`sudo docker compose ps frontend`で確認できます。実際の共有音声取得・録音・要約生成は未確認です。記録は[共有音声録音の反映状況](shared-audio.md#反映状況)を参照してください。

このMigrationのdowngradeはenum値を保持します。データを失うenum書き換えは行いません。`shared_audio`の会議を作成した後に古いアプリへ戻すと、その会議の読込に対応しないため、コードだけの巻き戻しはしないでください。

<a id="soniox"></a>
## Sonioxリアルタイム・非同期の反映（Migration 0026）

Migration 0026は0025の後にLive設定・非同期設定・Job checkpointを追加しました。現行headは、会議言語・リアルタイム翻訳・原文直下の表示用対応情報も追加した`20261012_0029`です。最新コードの反映は[リアルタイム翻訳の反映](#realtime-translation)を参照してください。新しい環境変数や依存追加はありません。録音・録画・保存・実行中Jobがすべて完了してから実行してください。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
# 現行ソースは20261014_0031 (head)を確認してからWorkerを再開
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

Migrationに失敗した場合はWorkerを止めたままBackendログを確認します。Volumeを削除しません。反映後にブラウザを再読み込みし、[Soniox設定と動作確認](soniox-transcription.md#設定と操作)を行います。エージェントは稼働中Dockerの再起動・運用DBへのMigration適用・実Sonioxへの音声送信を行っていません。録音中の設定保存は次のSessionから適用されます。

利用者の提示ログでは、運用DBが`20261012_0026 (head)`、BackendがHealthy、4つのWorkerがStartedであることを確認しています。Frontendの再起動操作も報告されています。反映後の画面・Soniox実接続は未確認です。[運用反映の記録](soniox-transcription.md#利用者の運用反映ログ)を参照してください。同じ環境で直接実装した変更を反映する場合、上記の`git pull --ff-only`は省略できます。別環境などで更新されたコードをGitHubから取得する場合に実行します。

### Sonioxモデル一覧の追加を反映する場合

以下はモデル一覧追加だけを反映した時点の手順です。現行コードにはMigration 0027もあるため、最新変更の反映には[次の会議言語の手順](#meeting-languages)を使用します。

Migration 0026適用済みの環境では追加のMigration・環境変数・依存追加はありません。モデル一覧の取得APIと設定画面の変更なので、録音・録画・保存・処理中Jobが完了してからBackendとFrontendを再起動します。Workerの処理内容は変更していません。

```bash
cd /home/llm/speak-note
sudo docker compose restart backend frontend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose ps backend frontend
```

ブラウザを再読み込みし、API Key入力 →「モデル一覧を取得」→ モデル選択 →「設定を保存」の順で確認します。保存済みキーでの取得もできます。モデル一覧でHTTP 403になる場合はModel listingのAccess権限を確認してください。[用途別の権限](soniox-transcription.md#モデル一覧とapiキーの権限)。エージェントはこの追加変更による稼働中サービスの再起動を行っていません。

追加変更の利用者の提示ログでは、Backend／Frontendの再起動後、BackendのHealthyと、`docker compose ps backend frontend`によるBackendの`Up 26 seconds (healthy)`・Frontendの`Up 36 seconds`を確認しました。4つのWorkerもRunningです。実キーによるモデル一覧取得や画面での選択・保存、音声認識は未確認です。[追加変更の反映記録](soniox-transcription.md#モデル一覧選択の追加変更2026-10-12)を参照してください。

<a id="meeting-languages"></a>
## 会議ごとの文字起こし言語の反映（Migration 0027）

会議の言語配列・StrictとLive Sessionのsnapshotを追加します。既存の会議、文字起こし、Job、認証情報は保持します。追加の環境変数・依存追加はありません。エージェントは運用DBへの0027適用やDockerの再起動を行っていません。

録音・録画・保存・実行中Jobを終了してから実行します。同じ環境で実装済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
# 現行ソースは20261012_0029 (head)を確認してからWorkerを再開
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

Backend起動時にMigrationを適用します。失敗した場合はWorkerを止めたまま`sudo docker compose logs --tail=100 backend`で確認します。Volumeを削除しません。ブラウザ再読み込み後、「新しい会議」の「会議で話す言語」、AI設定の言語欄がなくなったこと、会議ページの「文字起こし設定」を確認し、[短い録音と再生成の確認](meeting-transcription-languages.md#動作確認)を行います。

当時の利用者の提示ログで運用DBの`20261012_0027 (head)`、BackendのHealthy、4つのWorkerのStartedを確認しました。後続の言語UI変更後のログではFrontendの再起動後のUpも確認しました。[0027とFrontendの反映記録](meeting-transcription-languages.md#deployment-confirmation)。現在のソースにはリアルタイム翻訳の0028と表示用対応情報の0029も含みます。これらの運用DB反映ログは未確認のため、最新変更は次の手順で反映します。

<a id="realtime-translation"></a>
## リアルタイム翻訳の反映（Migration 0028・0029）

0028はMeetingへ翻訳設定、原文とは別の翻訳履歴を追加します。0029は翻訳履歴へnullableな`source_result_id`を追加し、原文直下の表示順を停止後も保ちます。旧翻訳はnullのままで、文字起こし枠の原文の後に表示します。既存の会議・文字起こし・翻訳・要約・Job・認証情報を保持し、新しい設定はOFFです。追加環境変数・依存追加はありません。運用DBへの適用とDocker反映はこの作業では実行していません。

録音・録画・保存・実行中Jobをすべて終えてから実行します。同じ環境でソースが更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
git pull --ff-only
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
# 20261012_0029 (head)とBackendのHealthyを確認してから再開
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

Migrationで失敗した場合はWorkerを停止したままBackendログを確認します。Volumeを削除しません。反映後にブラウザを再読み込みし、翻訳のON／OFF・翻訳先、短い英語音声→日本語、双方向を確認してください。原文の発話直下へ翻訳が届くこと、同じ枠内でスクロールすること、停止・再読み込み後も対応を保つこと、高精度版では「リアルタイム原文と翻訳」を開けること、旧翻訳を閲覧できることも確認します。[操作と検証](realtime-translation.md)。

<a id="translation-paragraphs"></a>
## 翻訳を文章で表示する修正の反映

この修正はFrontendのみで、追加のDB変更・依存・環境変数はありません。Migration 0029まで反映済みの環境では、録音・録画・保存が終了してから以下を実行します。0029以前なら、上の[Backendを含む反映手順](#realtime-translation)を使用してください。同じ環境でソース更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

反映後にブラウザを再読み込みし、同じ言語・話者の短い翻訳断片がカードを積まず一つの文章になること、原文と訳文の左端・本文幅・文字サイズが揃うこと、PCとスマートフォンで読み進められることを確認します。停止後のLive履歴と、高精度版の「リアルタイム原文と翻訳」でも同じ表示を確認します。[変更・検証記録](realtime-translation.md#translation-paragraphs)。

<a id="realtime-template-values"></a>
## リアルタイム解析の追加項目保存の修正（2026-10-14）

テンプレートに追加フィールドがある解析で`dict.model_validate`によって失敗する問題を修正しました。変更はBackendの解析処理と回帰テストです。追加Migration・依存・環境変数はなく、現在のheadは0031のままです。今回、エージェントによるDocker再起動や運用DBへの変更は行っていません。

**録音・録画・保存と実行中の解析Jobが終了してから**、更新したソースを読み込むため専用Workerを再起動します。同じ環境ですでにソースが更新されている場合は`git pull`を省略できます。現行ComposeではBackendのソースをWorkerへ共有しているため、再buildは不要です。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart realtime-ai-worker
sudo docker compose ps realtime-ai-worker
```

1. 文字起こし・過去の要約が残っていることを確認します。修正前に失敗した「リアルタイム解析」Jobは処理状況からそのJobだけを再試行します。保存済み原文を使うので文字起こしの再生成は不要です。
2. 「リアルタイム」のカードへ独自フィールドを追加したテンプレートで新しい会議を作り、AIをONにして録音します。既存会議は保存したテンプレート定義を使うため、後から編集したテンプレートを自動反映しません。
3. Sonioxの原文が確定・保存され、解析が更新された後に追加項目と根拠が表示されることを確認します。数値0やfalseは空欄と区別します。内容が不明な値はnullとして保持します。話者分離の精度優先によって原文の確定・AI更新が遅れることは、この修正とは別の動作です。
4. 次の解析で新しい項目だけでなく、根拠が残っている以前の項目も保持されることを確認します。AI接続の障害等があれば、以前の結果を表示したまま失敗したJobを再試行できます。

実LLM・Sonioxでの表示と運用環境への反映は未検証です。[修正と検証記録](function-audit-20261014.md#realtime-template-fix)を参照してください。

<a id="player-settings"></a>
## 再生設定・音声表示・チャプター表示の修正（2026-10-14）

この修正はFrontendだけです。新しいMigration・環境変数・依存追加はありません。現行Composeはソースを共有する開発構成なので、録音・録画と保存が終了してからブラウザを再読み込みします。別環境では先に`git pull --ff-only`でソースを更新してください。古い表示が残る場合だけ、停止中にFrontendを再起動します。

```bash
cd /home/llm/speak-note
sudo docker compose restart frontend
sudo docker compose ps frontend
```

1. 動画会議の歯車を開き、画質・字幕サイズ・字幕背景・字幕の話者名の各行から選択肢へ移れることを確認します。選択または戻るを押しても一覧が開いたままで、値が変わることを確認します。元動画がある場合は再生位置・速度・音量を保って切り替えられることも確認します。
2. Escape・外側クリックで閉じられ、速度メニューと歯車メニューが同時に開かないことを確認します。
3. 音声会議の時間は左側だけで、中央に「再生中／一時停止」と時間が出ないことを確認します。再生エラーは操作部の下へ表示します。
4. 音声・動画のシークバーへポインターを合わせ、チャプター名・開始時刻が縦に潰れないことを確認します。チャプターのない会議は「会議全体」、長い名前は折り返しになります。ライト・ダーク、スマートフォン幅も確認します。

再生RuntimeのURLは`20261014-1`へ更新しています。ブラウザ検証と運用環境への反映は別です。この作業ではDockerの再起動や運用DBへの操作を行っていません。以前のSoniox統一などのBackend変更をまだ反映していない環境は、別途[Migration 0031の手順](#soniox-realtime-only)を使用してください。

<a id="saved-transcript-summary"></a>
## 保存済みLiveからの要約生成・再生UI・言語初期値の反映（2026-10-13）

保存済み原文からの要約生成はBackend・Worker・Frontendの変更です。Frontendだけの再起動では新しいAPIパラメータとLive入力の解析を反映できません。この機能自体の追加Migration・依存・環境変数はありません。現在のソースには話者表示名の0030も含むため、最新変更は[0030を含む反映手順](#live-speaker-names)を使用します。既存の録音・録画、保存、実行中Jobがすべて終了してから実行してください。同じ環境でソース更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

BackendのHealthyと各Workerの稼働を確認し、ブラウザを再読み込みします。AIをOFFにして録音した会議で、保存完了後にAIを選んで要約を生成し、解析だけが作られることを確認します。暫定要約の履歴表示、モデル／テンプレート変更でも原文を再処理しないことを確認してください。高精度版は要約の「その他」から別に作成し、完成後の要約はFinalを優先します。再生ボタンの中央と丸いシークマーカー、新しい会議の未選択＝自動判定も確認します。非対応エンジンでは言語を1つ選びます。エージェントは稼働サービスの再起動や運用DBへの適用を行っていません。

<a id="soniox-realtime-only"></a>
## リアルタイム認識をSonioxに統一（Migration 0031）

0031はLiveのグローバルエンジン設定だけをSonioxへ切り替えます。Soniox・旧Azureの暗号化キー、過去のSession snapshot・録音・文字起こし・翻訳・要約・Job、非同期のエンジン・モデル・キーを保持します。新規作成のLive設定もSonioxです。新しい録音はSonioxキー未設定なら開始せず、設定を案内します。WhisperXへ自動で切り替えません。旧セッション用の互換処理は保持します。依存追加・環境変数追加はありません。

**録音・録画・保存・実行中Jobをすべて終了してから**実行します。同じ環境でソース更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
# 20261014_0031 (head)とBackendのHealthyを確認してから再開
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

Backend起動時にMigrationを適用します。失敗したらWorkerを停止したままBackendのログを確認し、Volumeを削除しないでください。ブラウザを再読み込みし、AI設定でリアルタイム用Sonioxキー・モデルを保存します。下の「アップロード・録音終了後の文字起こし」でWhisperX／Sonioxを独立して選び、片方の保存で他方が変わらないことを確認します。短い録音で途中認識・確定・保存・翻訳を確認し、停止後の要約が文字起こしJobを増やさないこと、詳細操作で全体処理を明示したときだけ選択した非同期エンジンを使うことを確認してください。[検証・制約](soniox-realtime-only.md)。エージェントは稼働サービスの再起動・運用DBへの適用を実行していません。

<a id="live-speaker-names"></a>
## 保存済みリアルタイム版の話者名・保存エラー修正（Migration 0030）

0030は`transcript_segments`へnullableの`provisional_speaker_name`（最大200文字）だけを追加します。既存の本文・時刻・元ラベル・話者FK・翻訳・要約・Job・認証情報を保持します。既存行はnullなので、編集するまで従来の話者ラベルを表示します。正式SpeakerへLiveラベルを誤送信する問題と、構造化APIエラーが`[object Object]`になる問題、名前保存後の表示更新も修正しています。追加の依存・環境変数はありません。

**録音・録画・保存・実行中Jobをすべて終了してから**実行します。同じ環境でソース更新済みなら`git pull`は省略できます。エージェントは運用DBへの適用・Docker再起動を実行していません。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
# 20261013_0030 (head)とBackendのHealthyを確認してから再開
sudo docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart frontend
sudo docker compose ps backend frontend worker live-worker realtime-ai-worker answer-worker
```

Backend起動時にMigrationを適用します。失敗した場合はWorkerを停止したままBackendのログを確認し、Volumeを削除しないでください。ブラウザ再読み込み後、[話者名の変更](usage.md#speaker-names)を試します。リアルタイム版全体の同じ話者番号が変わり、他の番号・別版・高精度版が変わらないこと、保存がTXT出力と再読込後も残ることを確認してください。高精度版では同じ正式話者の他の発言と字幕へ反映すること、名前変更で文字起こし・解析Jobが増えないことも確認します。2026-10-14の番号全体への変更は既存0030の列を使うため追加Migrationはありません。

<a id="soniox-accuracy"></a>
## Sonioxの話者分離を精度優先にする変更の反映

早期確定のOFFと暫定話者の表示番号の修正はFrontendのみです。追加のDB変更・依存・環境変数はありません。0029まで反映済みなら、録音・録画・保存が終了してから次を実行します。以前のheadなら[Backendを含む反映手順](#realtime-translation)を使用します。同じ環境でソース更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

反映後にブラウザを再読み込みし、新しく録音を開始します。Soniox接続の設定は開始・再接続時に適用されます。文字や話者の確定・保存が遅れても、認識途中の表示を確認してください。2人以上で交互に話し、表示番号が暫定認識の変化だけで増えないこと、原文と翻訳の番号が一致すること、停止後の原文・翻訳を保持することを確認します。[仕様・検証・未確認事項](soniox-transcription.md#diarization-accuracy)。

<a id="soniox-provisional-speakers"></a>
### Sonioxの途中結果を話者ごとに表示する修正（2026-10-14）

Frontendだけの変更で、追加Migration・依存・環境変数はありません。現行0031まで反映済みの環境では、録音・録画と保存が完了してから実行します。ソース更新済みなら`git pull`は省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

ブラウザを再読み込みし、新しい会議で2人以上が交互に話します。Sonioxから途中の話者変更が返ると確定前でも別ブロックになること、訂正・撤回で古い途中ブロックが残らないこと、停止後に途中表示が消えて保存済み原文・翻訳が残ることを確認します。早期確定OFFのままなのでAPI側の話者判定・確定までの遅れは残ります。[公式根拠・検証・未確認事項](soniox-transcription.md#provisional-speaker-blocks)。エージェントはDockerを再起動していません。

<a id="soniox-audio-timeline"></a>
### Soniox録音の開始時刻・PCM時刻の修正（2026-10-14）

Frontendと共有Workletだけの修正です。追加Migration・環境変数・依存はありません。録音・録画と保存を終えてから、Frontendを反映します。ソース更新済みなら`git pull`を省略できます。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

録音停止後にブラウザを再読み込みし、新しい短い会議で冒頭と終盤に発言して、保存音声の再生・文字起こしクリックの位置を確認します。マイク録音・画面共有録画・共有音声のみの3方式に適用します。過去に保存した時刻は変更されません。Sonioxモデルの認識誤差・単語時刻のない旧Liveの推定は別の制約です。[原因・検証・既存会議の注意](soniox-transcription.md#audio-timeline)。エージェントは稼働Dockerを再起動していません。

<a id="soniox-word-timings"></a>
### Soniox Liveの単語時刻保存と再生追従の反映（2026-10-14）

Backendの保存処理とFrontendの送信・Storeの変更です。既存の`TranscriptWord`を使うため、追加Migration・依存・環境変数はありません。録音・録画・保存・処理中Jobを終えてから反映します。現行Composeはソースをmountするため、Backendを先に反映してHealthyを確認し、Frontendを反映します。ソース更新済みなら`git pull`を省略します。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose restart frontend
sudo docker compose ps backend frontend
```

新しい録音で早口・ゆっくりした発話・途中の無音を混ぜ、停止・保存後に再読み込みします。再生中に各単語の位置が速度と間に合わせて動き、原文をクリックすると対応する単語の先頭へ移ることを確認します。Soniox非同期も全体処理設定で選び、新しいアップロードのFinalを同様に確認します。既存WhisperXの単語追従・速度変更・話者名変更も確認してください。旧Liveは保存済み単語時刻がないため従来の推定表示で、再処理や時刻の書換えはしません。実Soniox・iPhone実機・Docker反映は未検証です。[公式根拠と検証](soniox-transcription.md#word-timing-playback)。エージェントはDockerを再起動していません。

<a id="transcript-highlight-flicker"></a>
### 再生ハイライトのちらつき修正の反映（2026-10-14）

Frontendの再生runtimeだけの表示修正です。録音・録画と保存を終えてから反映します。ソース更新済みなら`git pull`を省略します。Backend・Workerの変更や追加Migrationはありません。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

ページを再読み込みし、単語時刻のある保存済みLive／Finalを再生します。短い単語間でハイライトが消えて点滅せず、長い無音や話者切替では解除されること、単語クリック・後ろへのシークで位置が合うことを確認してください。録音し直しや文字起こしの再処理は不要です。公開JSのURLを更新してcacheを避けます。エージェントは稼働Dockerを再起動していません。[原因・変更ファイル・検証](soniox-transcription.md#playback-flicker)。

<a id="language-picker-ui"></a>
### 言語の検索一覧・タグ・詳細設定への表示改善

この表示改善自体は追加のDB変更がありません。当時は0027適用済みの環境へFrontendだけを反映しました。現行ソースはリアルタイム翻訳の0028・0029も含むため、最新変更には[0029までの反映手順](#realtime-translation)を使います。以下は当時のFrontendだけの反映例です。録音・録画と保存を終えてから実行します。

```bash
cd /home/llm/speak-note
git pull --ff-only
# 必要な場合だけ、録音・録画と保存の終了後に実行
sudo docker compose restart frontend
sudo docker compose ps frontend
```

「新しい会議」と会議ページの「文字起こし設定」で、言語タグ・検索一覧・自動判定の制限理由・折りたたんだ詳細設定のStrict状態を確認します。詳しくは[言語選択の操作](meeting-transcription-languages.md#操作)を参照してください。

利用者の2026-10-12（日本時間）の提示ログで、Frontend再起動後の`docker compose ps frontend`が`Up 5 seconds`であることを確認しました。新UIの運用画面と実音声認識は未確認です。上記のブラウザでの確認へ進めます。

<a id="record-video-toggle"></a>
### 会議作成の3つの取り込み方法・画面共有内の録画スイッチへの表示変更

Migration 0025適用済みの環境では、この表示変更による追加のDB変更・Backend/Worker再起動はありません。現行の開発ComposeはFrontendのソースを共有しているため、録音・録画の停止・保存完了後にブラウザを再読み込みします。ホームのショートカットカードがなく、「新しい会議」を押すと3つの取り込み方法と、画面共有内の「映像を録画する」が表示されることを確認します。ソース更新の取り込みやFrontend再起動が必要な場合だけ、停止・保存完了後に実行します。

```bash
cd /home/llm/speak-note
git pull --ff-only
sudo docker compose restart frontend
sudo docker compose ps frontend
```

ブラウザを再読み込みし、録画ON（初期値）で「作成して録画開始」、OFFで「作成して録音開始」になることを確認します。既存会議は作成時の方式を維持します。

## 設定の管理場所

- [docker-compose.yml](../docker-compose.yml): コンテナへ渡す変数、volume、port、起動コマンド。
- [.env.example](../.env.example): 設定テンプレート。実値はローカル `.env` のみ。
- [config.py](../backend/app/core/config.py): Backendの既定値と検証。
- AI設定画面: Provider接続情報、Profile、用途、Soniox固定のLive設定、WhisperX／Sonioxを選ぶ全体処理設定、用途別のSonioxキー。新規Azure設定のUIは廃止済みで、既存の暗号化キーを互換処理用に保持します。

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
| REALTIME_WINDOW_MS | 30000。旧WhisperX Live Jobの音声Window。Sonioxの認識区切りには使わない |
| REALTIME_MAX_CHUNK_MB | 64。録音WebSocketのChunk受付上限 |
| REALTIME_RESUME_TIMEOUT_SECONDS | 600。切断された録音を再開待ちにしておく秒数。最後にデータを受信してからこの時間を過ぎると `live-worker` が受信済みデータで確定する。ブラウザの再接続時間（5分）より長くする |
| REALTIME_ANALYSIS_INTERVAL_MS | 30000。Live AI解析を予約する会議時間間隔（処理完了時間の保証ではない） |
| REALTIME_ANALYSIS_DRAFT_TAIL_MS | 2000。Live AIで暫定として扱う末尾時間幅 |
| REALTIME_ANALYSIS_TIMEOUT_SECONDS | 300。Live AIのAPI timeout |
| WHISPERX_BASE_URL | http://host.docker.internal:8000 |
| WHISPERX_API_KEY | WhisperXのBearer Token。ブラウザに返さない |
| WHISPERX_MODEL / WHISPERX_LANGUAGE | large-v3 / ja |
| WHISPERX_TIMEOUT_SECONDS | 7200 |
| WHISPERX_MAX_ATTEMPTS / WHISPERX_RETRY_DELAY_SECONDS | 3 / 1。再試行上限・基準待機秒 |
| AZURE_SPEECH_TIMEOUT_SECONDS | 60。旧Azure Session／JobのBackend HTTP Client用 |
| AZURE_SPEECH_MAX_ATTEMPTS / AZURE_SPEECH_RETRY_DELAY_SECONDS | 3 / 1。旧AzureのBackend HTTP Client用 |
| MASTER_ENCRYPTION_KEY | Gemini・Soniox・旧Azure API Keyを暗号化するFernet key。復号にも同じ値が必要 |
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
sudo docker compose logs --tail=100 backend worker live-worker realtime-ai-worker frontend
curl --fail http://localhost:8001/api/v1/health
```

| 症状 | 確認すること |
| --- | --- |
| UIが変わらない | ソース反映、FrontendのHMRエラー、ブラウザ再読み込み。必要ならFrontend再起動 |
| Speech SDK等のModule not found | package.jsonとlockfileの整合、Frontend起動ログのnpm ci完了。イメージ再buildだけではnode_modules Volumeが古い場合がある |
| pytestが見つからない | 開発依存がない。[一時コンテナのテスト手順](development.md#テスト)を使う |
| APIは変わったのにJobが古い動作 | worker / live-worker / realtime-ai-workerを再起動したか |
| .env変更が反映されない | 対象コンテナを再作成したか。restartだけでは反映されない |
| storage Permission denied | ホストの所有者・UID/GIDとCompose user。プロジェクト全体へ安易なchmod/chownは行わない |
| Jobがqueuedのまま | 担当Workerの起動・ログ。Live文字起こし（`transcribe_live`）は `live-worker`、Live AI要約は `realtime-ai-worker`、それ以外は `worker` |
| WhisperX / Ollamaへ接続できない | コンテナのlocalhostを指定していないか、host.docker.internalから到達できるか、許可host・認証・外部サービス状態 |
| Geminiで404等 | 選択モデルの提供状況・利用権限・モデルIDを確認。Profileのモデル取得結果と実行時エラーを確認する |
| 画面共有・マイクを開始できない | Secure Context、権限、ブラウザAPI対応、音声共有の選択。非対応時は保存済みファイルで取り込む |
| 録画停止後にFinalがない | 停止後はリアルタイム版を表示し、要約は保存済みLiveからも作れる。Finalは「その他」から全体文字起こしを明示して作成する。録画は動画変換完了を待つ |
| Live文字起こしは動くがAI要約がない | 会議のAI設定、用途の無効設定、Default、Provider有効性、realtime-ai-worker |
| すべて同じ話者 / 認識停止 | Soniox接続・会議言語・入力音声を確認。表示と認識結果を分離する。旧Azure SessionではResource設定と診断イベントも確認 |
| Live解析がテンプレート追加値で失敗 | `dict.model_validate`の問題は修正済み。[専用Workerへの反映](#realtime-template-values)後、失敗した解析Jobを再試行する。AI接続・不正な根拠等の別のエラーはメッセージを確認 |

### 旧Azure Sessionの診断（互換機能）

旧Azureの認識イベントがある場合、録音カードの「文字起こしの診断情報」→「診断情報を保存」からJSONを取得できます。新しいSoniox録音ではこのAzure診断は使いません。
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

<a id="live-worker"></a>
## Live文字起こし専用Workerの反映

現行の新しいLive認識はSonioxのブラウザWebSocketです。`live-worker`は旧`transcribe_live` Jobを担当するほか、Sonioxでも切断された録音の再開期限を確認し、受信済みデータを保存・終了処理するため必要です。通常の`worker`は旧Live Jobをclaimせず、recover対象にもしません。以下はLive専用Worker追加時の反映手順で、WhisperX・Azureの設定は旧Session／Jobの互換性用に保持します。[整理時の注意](function-audit-20261014.md)。

録音・録画を終え、実行中のLive文字起こしJobがないことを確認してから反映します。

```bash
cd /home/llm/speak-note
sudo docker compose config --quiet
sudo docker compose up -d --build live-worker
sudo docker compose restart worker
sudo docker compose ps live-worker worker
sudo docker compose logs --tail=50 live-worker
```

ログに `speak-note live transcription worker started` が出れば起動しています。2026-10-05のユーザー提供ログで、Migration `20261005_0024 (head)` の適用、`live-worker` の起動（06:49:44）、録音中の `transcribe_live` Jobの処理とWhisperXの `200 OK` を確認しました。同日、録音中に `sudo docker compose restart backend` を実行し、録音が止まらず再接続されることをユーザーが確認しました。`live-worker` を起動しないと、録音中の文字起こしJobが `queued` のまま進みません。同じ録音の区間を順番に保存するため、`live-worker` は複数台に増やさないでください。

<a id="recording-resume"></a>
## 録音の自動再接続の反映（Migration 0024）

録音WebSocketが切れても録音セッションを残し、ブラウザが再接続して再開できるようにする変更です。Backend起動時に0023から0024へMigrationし、`realtime_sessions` に最終受信時刻 `last_activity_at` と索引を追加します。既存の行にはMigration時刻が入るため、過去の障害で `recording` のまま残っていた録音セッションも、反映から `REALTIME_RESUME_TIMEOUT_SECONDS` 後に `live-worker` が受信済みデータで確定します。

先に[Live文字起こし専用Workerの反映](#live-worker)を済ませてください。録音・録画と保存を終えてから実行します。

```bash
cd /home/llm/speak-note
sudo docker compose config --quiet
sudo docker compose stop worker live-worker realtime-ai-worker answer-worker
sudo docker compose restart backend
sudo docker compose up -d --wait --no-deps backend
sudo docker compose exec -T backend alembic current
```

`20261005_0024 (head)` とBackendの正常起動を確認してからWorkerを再開し、ブラウザを再読み込みします。`.env` で `REALTIME_RESUME_TIMEOUT_SECONDS` を変更した場合は `live-worker` を再作成します。

```bash
sudo docker compose up -d --no-deps --force-recreate worker live-worker realtime-ai-worker answer-worker
sudo docker compose ps
```

動作確認は、短い録音を開始し、録音中に `sudo docker compose restart backend` を実行します。録音画面に再接続中の表示が出た後に復旧し、停止後の録音に再起動前後の音声が欠けずに入っていることを確認します。ブラウザの再読み込みは意図した終了として扱われ、その時点で確定します。
