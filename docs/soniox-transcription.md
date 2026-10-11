# Soniox文字起こし

最終照合: 2026-10-12。[README](../README.md) · [操作ガイド](usage.md) · [Docker反映](operations.md#soniox)

## 公式仕様と実装の境界

Soniox公式ドキュメントを読み、リアルタイムと非同期を独立して実装しました。

| 用途 | API／モデル | 処理場所 |
| --- | --- | --- |
| 録音・画面共有中のLive | WebSocket、`stt-rt-v5` | ブラウザの混合音声をPCMで直接送信。確定発話をBackendへ保存 |
| アップロード／録音停止後のFinal | Files + Transcriptions REST、`stt-async-v5` | 既存の通常Workerが保存音声を送信・状態確認・結果保存 |

確認した公式ページ: [モデル](https://soniox.com/docs/stt/models)、[リアルタイム仕様](https://soniox.com/docs/stt/rt/real-time-transcription)、[WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)、[WebSocket認証](https://soniox.com/docs/guides/websocket-authentication)、[一時キー](https://soniox.com/docs/api-reference/auth/create_temporary_api_key)、[非同期処理](https://soniox.com/docs/stt/async/async-transcription)、[ファイル送信](https://soniox.com/docs/api-reference/stt/files/upload_file)、[処理予約](https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription)、[結果取得](https://soniox.com/docs/api-reference/stt/transcriptions/get_transcription_transcript)、[ファイル削除](https://soniox.com/docs/api-reference/stt/files/delete_file)。モデル名やAPIの提供状況が変わった場合は公式ページと接続テストで再確認してください。

## 設定と操作

1. Migration 0026を反映します。録音・録画・処理中Jobが終わってから[反映手順](operations.md#soniox)を実行します。
2. `MASTER_ENCRYPTION_KEY`を設定済みであることを確認します。SonioxのAPI Keyは`.env`へ追加せず、画面からDBへ暗号化保存します。既存のGemini／Azureと同じ暗号化基盤です。
3. AI設定 →「リアルタイム文字起こし」でSonioxを選び、API Keyを入力します。「モデル一覧を取得」を押してモデル（既定`stt-rt-v5`）を選び、言語ヒント`ja`を確認し、「設定を保存」を押します。「接続テスト」はモデル取得と一時キー発行を確認し、音声を送信しません。必要な権限は下の表を参照してください。
4. 確定版もSonioxにする場合は「非同期・確定版の文字起こし」でSonioxを選び、API Keyを入力してモデル一覧を取得します。モデル（既定`stt-async-v5`）と`ja`、API Keyを別途保存し、接続テストします。同じキーを両方へ入力しても構いません。片方の保存はもう片方の選択やAzureキーを変更しません。
5. 新しい会議から録音・画面共有を開始します。途中認識の表示と発話確定後の保存を確認します。共有音声とマイクは従来どおり混合され、映像の保存ON/OFFは文字起こし設定と独立です。
6. 停止・保存完了後、「要約を再生成」でAIとテンプレートを選びます。Finalがなければ初回だけ非同期処理を行います。既存Finalがある場合はその版を再利用し、Sonioxへ音声を再送しません。エンジン設定変更でも既存Final・生成履歴を自動更新しません。
7. 音声・動画アップロードでも、アップロード時に選んだ非同期設定でFinalが自動生成されることを確認します。AIを使う会議では、その後の解析Jobと根拠・会議後質問も確認します。

設定をWhisperXへ戻すと新しいSession／JobからWhisperXを使用します。Soniox恒久キーの削除はPUTの`clear_soniox_api_key`（WhisperXへ切り替える同じ要求で指定）に対応します。画面にはキーの全文を表示せず、マスクだけ返します。リアルタイム用と非同期用のキーは別々に管理します。

## モデル一覧とAPIキーの権限

モデル一覧は保存前の入力キーで取得できます。キーの入力欄が空なら、その用途の保存済みキーを使用します。取得APIは`POST /api/v1/transcription/soniox-models`で、Backendが公式`GET /v1/models`へ問い合わせ、`transcription_mode`でリアルタイム／非同期を分けます。入力キーをURLへ含めず、モデルIDと名前だけを返し、設定やキーをDBへ保存しません。[公式モデル一覧API](https://soniox.com/docs/api-reference/stt/get_models)。

取得中は再取得と保存を無効にします。失敗・空一覧の場合は現在の選択を保持してエラーを表示します。取得した一覧に現在のモデルがなければ、自動的に別のモデルへ変更せず、モデルの選び直しを求めます。「設定を保存」を押すまで会議・録音・予約済みJobへ影響しません。

Full accessをOFFにし、用途別に以下を指定します。WriteはReadの一覧・取得に加えて作成・削除も許可します。短期キーの発行には、そのサービスの権限とTemporary API keysの両方が必要です。[公式のAPIキー権限](https://soniox.com/docs/guides/api-key-permissions)。

| Consoleの権限 | リアルタイム用キー | 非同期用キー |
| --- | --- | --- |
| Full access | OFF | OFF |
| Speech-to-text, real-time | Access | No Access |
| Speech-to-text, async | No Access | Write |
| Files | No Access | Write |
| Model listing | Access | Access |
| Temporary API keys | Access | No Access |
| Text-to-speech, real-time | No Access | No Access |
| Cloned voices | No Access | No Access |
| Usage and limits | No Access | No Access |
| Legacy API | No Access | No Access |

同じキーを両用途で使う場合は、上表の必要な権限を合わせ、Speech-to-text, real-time／Model listing／Temporary API keysをAccess、Speech-to-text, async／FilesをWriteにします。その他はNo Accessです。HTTP 401はキーの不正・削除、403は権限不足を確認します。権限変更の反映には数分かかる場合があり、開始済みストリーム・発行済み短期キーには反映されません。

## 保存・障害・再試行

- Liveは16kHz・16bit・monoの`pcm_s16le`を送信します。恒久キーはBackendに残し、録音中のSoniox Sessionに限って60秒・一回限り・最大5時間の一時キーを発行します。接続期限は開始済みのストリームを60秒で切る意味ではありません。再接続ごとに新しいキーを取得します。[一時キーの期限](https://soniox.com/docs/guides/temporary-api-keys)。
- 非確定tokenは表示用だけです。Sonioxが確定したtokenを連結し、話者変更・発話区切り・10秒区間で保存します。空白とsubwordを保持し、翻訳tokenと制御markerを本文へ含めません。接続ごとの話者番号は暫定IDです。停止時にPCM末尾をflushし、空text frameを送り、最終応答を待ちます。
- Soniox通信断は最大3回自動再接続します。認証・残高・権限エラーでは再接続を繰り返しません。録音保存用のMediaRecorder／Backend接続は独立して継続します。Soniox切断中の音声はLiveへ遡って再送せず、保存音声から非同期Finalで処理します。録音中にブラウザを更新しないでください。
- 非同期はJobの`transcription_request`に予約時のprovider／model／language、file／transcription ID、送信状態を保存します。設定変更は予約済みJobに影響しません。保存内容にAPI Keyは含めません。動画の変換Jobから後続文字起こしJobにも設定を引き継ぎます。旧Jobのnull設定はWhisperXです。
- pollがタイムアウトした場合や取得APIが失敗した場合は、そのJobの「再試行」で同じSoniox処理IDへ戻ります。POSTを無条件に再送しません。送信成功が不明な場合は`client_reference_id`で一覧を照合し、一致が一つだけなら再開します。これはSoniox側のunique制約ではありません。照合不能・重複時は「二重送信を防ぐため再送を停止」として失敗します。Consoleで該当Job UUIDの処理を確認してください。
- Sonioxが`error`になった処理や、復旧不能な送信では保存音声・Live・既存Final・要約を保持します。Soniox側のFile／Transcriptionは調査・再試行用に残ります。不要になったものはConsoleで、処理がcompleted／errorであることを確認してから削除します。processing中のFileを先に削除しないでください。
- 正常時はFinalをDBへcommitしてからSoniox側のTranscriptionとFileを削除します。削除に失敗してもFinalは保持し、Job checkpointの`cleanup_pending`に残します。Consoleで後から削除できます。speak-note内の元音声やDocker volumeは削除しません。
- Sonioxは最小／最大話者数指定を提供していないため、この指定はWhisperX利用時だけ適用します。Sonioxの話者分離自体は有効です。新しい環境変数・SDK依存は追加していません。

## 実装と検証

主要な変更はBackendの`services/transcription/soniox.py`・設定API／モデル／schema・Job／Worker・Liveの結果保存と一時キー発行、Frontendの`soniox-speech-stream.ts`・`pcm-audio-input.ts`・録音UI・独立した設定フォームです。Migrationは`20261012_0026`（0025の後）です。既存Azure PCM Workletを共有し、停止時の末尾flushを追加しました。恒久キーや音声をGitへ含めません。

テストはmock HTTP／WebSocketとSQLiteのAPIテストで、設定の独立・暗号化、Sonioxのtoken連結／時刻／話者、失敗時保護、初回FinalからのAI／テンプレート引継ぎ、処理ID再利用、曖昧な送信の再送停止、重複発話の防止、停止処理、UIの保存・処理中・エラーを確認します。PostgreSQL Migrationは運用DBへ接続せずoffline SQLで検証します。

実Sonioxアカウント・課金API・Safari／実スマートフォン・長時間録音は未検証です。運用PostgreSQLへのMigration適用は、下記の利用者の反映ログで確認しました。接続テストだけでは音声認識品質、残高、同時接続枠、ファイル容量制限まで保証しないため、短い実録音と小さいアップロードで両用途を確認してください。LiveはHTTPS／localhost、WebSocketとAudioWorkletに対応したブラウザが必要です。

### 利用者の運用反映ログ

記録日: 2026-10-12（日本時間）。利用者が実行したコマンドの提示ログに基づく記録です。エージェントは稼働中Dockerや運用DBを操作していません。

- `docker compose stop worker live-worker realtime-ai-worker answer-worker`で4つのWorkerが停止。
- Backendの再起動後、`docker compose up -d --wait --no-deps backend`でHealthy。
- `docker compose exec -T backend alembic current`が`20261012_0026 (head)`。
- 4つのWorkerの再開がすべてStarted。
- Frontendの再起動操作が報告されています。再起動後の状態・ブラウザ表示・Soniox接続テスト・実音声認識は未確認です。

次はブラウザを再読み込みし、上記「設定と操作」の手順でリアルタイムと非同期をそれぞれ確認します。

### 変更したファイル

| 役割 | ファイル（同じディレクトリの項目はまとめて記載） |
| --- | --- |
| DB | `backend/alembic/versions/20261012_0026_soniox_transcription.py`、`backend/app/models/{__init__,job,transcription}.py` |
| Backendの設定・接続・全体処理 | `backend/app/schemas/transcription_settings.py`、`backend/app/api/routes/transcription_settings.py`、`backend/app/services/transcription/{soniox,settings,base,processor,azure}.py` |
| Backendの予約・再利用・Live保存 | `backend/app/api/routes/{meetings,realtime,transcripts}.py`、`backend/app/services/analysis/regeneration.py`、`backend/app/services/media/processor.py`、`backend/app/services/realtime/capture.py`、`backend/app/workers/main.py` |
| Frontendの設定・再生成説明 | `frontend/app/settings/ai/page.tsx`、`frontend/components/{ai-settings-manager,async-transcription-settings,final-transcript-button}.tsx`、`frontend/components/ai-settings-manager.module.css`、`frontend/lib/api.ts` |
| FrontendのLive認識・保存 | `frontend/components/live-meeting-recorder.tsx`、`frontend/lib/{soniox-speech-stream,pcm-audio-input,live-transcript-events,live-transcript-store,recording-connection}.ts`、`frontend/public/azure-speech-pcm-worklet.js` |
| 新規テスト | `backend/tests/test_soniox_transcription.py`、`frontend/lib/{soniox-speech-stream,pcm-audio-input}.test.ts`、`frontend/components/transcription-settings-dom.test.tsx` |
| 既存テストの拡張・表示更新 | `frontend/components/{ai-profile-list,ai-settings-manager,final-transcript-button,summary-regeneration}.test.tsx`、`frontend/lib/{live-transcript-store,recording-connection}.test.ts` |
| 文書 | `README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,operations,development,summary-regeneration}.md` |

### 検証コマンドと結果

Ubuntu上の一時検証環境で実行しました。Frontendの専用formatter設定はなく、既存ESLintを使用します。

| コマンド | 結果 |
| --- | --- |
| Backend: `pytest -q` | 全体テスト230件成功 |
| Backend: `ruff format --check`（変更したPythonファイル） | 成功（既存Azureファイルの追加はmodel属性1行だけで、全体formatter対象から除外） |
| Backend: `ruff check`（Soniox・設定・予約・保存・Migration・新規テスト） | 成功 |
| Backend: `mypy --follow-imports=silent app/services/transcription/soniox.py app/services/transcription/settings.py app/api/routes/transcription_settings.py app/services/transcription/processor.py app/api/routes/realtime.py` | 5ファイル成功 |
| Backend: `ruff check app tests` / `mypy app` | 既存lint 13件／型エラー12件が残る。変更前Git版の15件／12件と比較し、新しいエラーなし |
| Frontend: `node node_modules/vitest/vitest.mjs run` | 全体テスト225件成功 |
| Frontend: `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `node node_modules/eslint/bin/eslint.js .` | 成功 |
| Backend: `alembic heads` | `20261012_0026 (head)`、headは一つ |
| Backend: `DATABASE_URL=postgresql+psycopg://dummy:dummy@localhost/dummy alembic upgrade 20261010_0025:head --sql` | 0025→0026のPostgreSQL用SQL生成成功。DB接続なし |
| Playwright Chromium（mock API＋実Component） | light／dark × 320、393、560、844、1280pxの10条件で横overflowなし・設定選択／送信成功 |

初回の`npm run typecheck`は一時Node環境の`node-gyp/bin/node-gyp.js`不足で実行できず、npm scriptと同じTypeScript／ESLint／VitestをNodeから直接実行しました。mypyの既存cacheではinternal errorが出たため、`--cache-dir=/tmp/speak-note-soniox-mypy-cache`で再検証しました。いずれも環境問題として扱い、ソースやテストを無効化していません。

全体lintの残件はテンプレートRoute・Analysisモデル／手動取り込み／Realtime解析・Meeting schema・Azureの既存行長です。全体mypyの残件はMeeting／Analysisのdict型、Azureの数値変換、Realtimeテンプレート／解析、会議一覧SQL型、テンプレートRouteです。今回はSonioxの変更に範囲を限定しています。

### モデル一覧選択の追加変更（2026-10-12）

変更ファイルはBackendの`app/schemas/transcription_settings.py`、`app/api/routes/transcription_settings.py`、`app/services/transcription/soniox.py`、新規`tests/test_soniox_models.py`、Frontendの`components/{async-transcription-settings,ai-settings-manager,transcription-settings-dom.test}.tsx`、`components/ai-settings-manager.module.css`、文書の`README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,operations,development}.md`です。追加Migrationはなく、headは0026のままです。

- `pytest -q`: 全体244件成功。新規14件で用途による絞込・保存前キー・用途別保存済みキー・設定非更新・キー非返却・401／403／503・不正応答を確認。
- `node node_modules/vitest/vitest.mjs run`: 全体229件成功。設定画面で取得・モデル選択・保存、処理中の重複防止、失敗復旧、空一覧、用途の独立を確認。
- `ruff format --check`、`ruff check`（変更した4つのPythonファイル）: 成功。
- `mypy --cache-dir=/tmp/speak-note-soniox-models-mypy-cache --follow-imports=silent app/schemas/transcription_settings.py app/services/transcription/soniox.py app/api/routes/transcription_settings.py`: 3ファイル成功。
- `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/eslint/bin/eslint.js .`: 成功。
- Playwright Chromium: light／dark × 320、393、560、844、1280pxの10条件で、一覧取得・選択したモデルの送信・横overflowなし・ページエラーなし。

モデル取得もmock APIで検証しています。実Sonioxアカウントによるキーの権限・取得モデル一覧、実端末は未検証です。稼働中Dockerの再起動は行っていません。反映は[運用ガイド](operations.md#sonioxモデル一覧の追加を反映する場合)を参照してください。

追加変更の運用反映も、利用者の提示ログで確認しました（記録日: 2026-10-12、日本時間）。`docker compose restart backend frontend`後、`docker compose up -d --wait --no-deps backend`でBackendがHealthy、4つのWorkerがRunningです。`docker compose ps backend frontend`ではBackendが`Up 26 seconds (healthy)`、Frontendが`Up 36 seconds`で、ホスト側8001／3001からコンテナ側8001／3000への公開を確認しました。エージェントはDockerを操作していません。反映後のブラウザ表示・実キーでの一覧取得・選択・保存・音声認識は未確認のままです。
