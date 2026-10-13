# リアルタイムSoniox・アップロード／会議後の全体処理

最終照合: **2026-10-14**。[README](../README.md) · [操作](usage.md) · [反映](operations.md#soniox-realtime-only)

## 現行の使い分け

| 用途 | エンジン・設定 | 動作 |
| --- | --- | --- |
| 録音・録画中 | Soniox固定、リアルタイム用キー・モデル | WebSocketで途中認識を表示し、確定発話を保存。暫定版 |
| ファイルアップロード | 全体処理用WhisperX／Sonioxを選択 | Job + WorkerでFinalを保存 |
| 録音・録画終了後の全体処理 | 同じ全体処理用WhisperX／Soniox | 要約の「その他」から明示してFinalを作成 |
| 要約の再生成 | AIプロファイル・テンプレート | 保存済みFinal、なければ保存済みLiveを使用。音声を再処理しない |

AI設定の「リアルタイム文字起こし」はSonioxのモデル・キー・モデル一覧・接続テストだけを表示します。「アップロード・録音終了後の文字起こし」はWhisperX／Sonioxを選び、モデル・キーを独立して保存します。WhisperXはこのプロジェクト外の既存WhisperX API Serverを利用します。Sonioxのリアルタイム用と非同期用のキーは同じものを入力しても構いませんが、用途別に保存します。

Sonioxキーが未設定なら新しい録音を開始せず、AI設定への案内を表示します。旧設定のproviderがWhisperX／Azureでも新しい録音で使用しません。新しい設定APIはSoniox以外を422で拒否し、Azureの旧入力項目も受け付けません。過去のキーを更新・削除しません。GETの旧Azureフィールドは互換性のため保持しますが、設定画面には表示しません。

途中結果の置換・確定結果の保持、精度優先の話者分離、翻訳、PCM変換、一時キーの発行、音声・映像の保存方式を維持します。公式の[リアルタイム認識](https://soniox.com/docs/stt/rt/real-time-transcription)、[非同期認識](https://soniox.com/docs/stt/async/async-transcription)、[話者分離](https://soniox.com/docs/stt/concepts/speaker-diarization)を確認しています。外部APIのリクエスト形式は今回変更していません。

会議の言語ヒント・Strictは引き続き会議ごとに指定し、開始時とJob予約時に固定します。全体処理でWhisperXを選ぶ場合の単一言語制約は維持します。翻訳はSoniox Liveの設定として使い、アップロード会議には設定しません。

## Migration・履歴

現行headは`20261014_0031`（0030の後）です。0031は`realtime_transcription_settings.provider`だけをSonioxへ変更します。キー・モデル・過去のSession・Live Transcript・翻訳・AI履歴・予約済みJob・全体処理設定を維持します。既存0030の話者表示名も保持します。downgrade時に以前のエンジンを推測して戻しません。旧ソースもSoniox設定を読めます。

旧WhisperX／Azureのクライアントと、保存済みセッション・予約済みJobを読む互換処理は残します。DB上の過去のprovider値を新しい恒久人物IDや新しいSessionへ書き換えません。

録音・録画・保存・実行中Jobを終了してから[Docker反映手順](operations.md#soniox-realtime-only)を実行し、0031とBackendのHealthyを確認してWorkerを再開します。Sonioxキー未設定だった環境では、録音開始前にキーを保存してください。既存サービスやVolumeを削除しません。

## 検証と変更ファイル

Backend: 設定モデル・schema・設定API、`services/transcription/settings.py`・`languages.py`、翻訳の設定検証、Migration 0031、設定・言語・WebSocket・共有音声・翻訳・Migrationの関連テスト。Frontend: `ai-settings-manager.tsx`と設定表示・送信の関連テスト。README・DESIGN・操作／運用ガイドも更新します。

隔離Python環境（`/tmp/speak-note-shared-audio-verify-env/bin`）とNode 22で実行しました。

```bash
# backend
pytest -q
ruff format --check app/models/transcription.py app/schemas/transcription_settings.py app/api/routes/transcription_settings.py app/services/transcription/settings.py app/services/transcription/languages.py app/services/realtime/translation.py tests/test_transcription_settings_api.py tests/test_realtime_websocket.py tests/test_meeting_transcription_languages.py tests/test_shared_audio.py tests/test_realtime_translation.py tests/test_soniox_realtime_migration.py alembic/versions/20261014_0031_soniox_realtime.py
ruff check app/models/transcription.py app/schemas/transcription_settings.py app/api/routes/transcription_settings.py app/services/transcription/settings.py app/services/transcription/languages.py app/services/realtime/translation.py tests/test_transcription_settings_api.py tests/test_realtime_websocket.py tests/test_meeting_transcription_languages.py tests/test_shared_audio.py tests/test_realtime_translation.py tests/test_soniox_realtime_migration.py alembic/versions/20261014_0031_soniox_realtime.py
mypy --follow-imports=silent --cache-dir /tmp/speak-note-soniox-only-mypy app/models/transcription.py app/schemas/transcription_settings.py app/api/routes/transcription_settings.py app/services/transcription/settings.py app/services/transcription/languages.py app/services/realtime/translation.py
alembic heads
alembic upgrade 20261013_0030:head --sql
# frontend
node node_modules/vitest/vitest.mjs run components/transcription-settings-dom.test.tsx components/ai-settings-manager.test.tsx
node node_modules/vitest/vitest.mjs run
node node_modules/eslint/bin/eslint.js .
node node_modules/eslint/bin/eslint.js components/ai-settings-manager.tsx components/transcription-settings-dom.test.tsx components/ai-settings-manager.test.tsx
node node_modules/typescript/bin/tsc --noEmit
```

Backend全335件、Frontend設定関連8件、変更箇所のformat/lint・型チェックが成功しました。Migrationの旧キー・全体処理設定・Session保持も検証し、PostgreSQL向けoffline SQLを確認しました。新しいSoniox録音ではWhisperXのLive Jobを作成せず、通信断からの再開・重複Chunk・音声保存が維持されることを確認しています。アップロード、全体文字起こし、要約、質問、旧Workerの処理も全体テストで確認しました。

実キー・実音声でのSoniox接続、運用DBへのMigration適用、実PostgreSQLの同時処理、実機Safari/iPhoneでの確認は未実施です。稼働サービスは再起動していません。既存のBackend全体lint・型エラーは別途全体確認の結果に記録します。

追加確認: Frontend全331件、Frontend全体のESLint・型チェックも成功しました。過去のAzure／WhisperXの保存済み処理を扱うテストは保持し、新規録音だけSonioxを使うことを検証しています。
