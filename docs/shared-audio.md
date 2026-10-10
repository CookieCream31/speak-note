# 映像を保存しない画面共有音声録音

最終照合: 2026-10-10。[README](../README.md) · [操作手順](usage.md#shared-audio) · [Dockerへの反映](operations.md#shared-audio)

取り込み方法に「画面共有の音声を録音」を追加しました。共有音声とONのマイクを混合して音声ファイルだけ保存します。従来の画面共有録画・マイクのみ・アップロードは引き続き利用できます。ブラウザの共有許可は必要ですが、映像Preview・映像Recorder・映像Chunk・動画変換は使用しません。

## 主な変更箇所

- `frontend/components/meetings-manager.tsx`とCSS: 4つの取り込み方法、音声共有の案内、音声のみの開始、2列のカード。
- `frontend/components/live-meeting-recorder.tsx`、`frontend/lib/live-capture.ts`: 音声だけの保存、共有先の変更・停止・再開、マイク切替、WhisperX/Azureへの混合音声入力。
- `frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/realtime-analysis-history.ts`: 保存済み音声の再生、Live会議ノート、変換待ちを要しない要約再生成。
- `frontend/lib/api.ts`、`format.ts`、`display-capture.ts`: source type・一覧表示と共有の対応案内。
- `backend/app/models/meeting.py`、`api/routes/transcripts.py`、`services/realtime/capture.py`: 新しい会議方式、音声のみの受付・保存・停止、明示的なFinal生成。
- `backend/alembic/versions/20261010_0025_shared_audio.py`: 0024からのenum追加。過去データを保護するためdowngradeでも値を保持。
- `backend/tests/test_shared_audio.py`と既存の会議作成・録音・再接続・要約再生成テスト、FrontendのRecorder・Mixer・会議詳細・一覧テスト。
- README・DESIGN・usage・development・operations: 操作、実装境界、Migrationと反映手順。

## 検証

バックエンドは一時venvへ`pyproject.toml`の依存・dev依存を導入しました。以前の一時環境のpytest/pipが起動できず、editable installも既存egg-infoの更新権限で失敗したため、ソースを変更せず依存のみを一時venvに導入しました。Frontendは既存node_modulesと一時配置Node 22を使用しました。検証環境の修復に運用サービス・依存定義の変更は行っていません。

通常の実行方法は[開発ガイド](development.md)を参照してください。今回は次を実行しました。

| コマンド | 結果 |
| --- | --- |
| Backend: `/tmp/speak-note-shared-audio-verify-env/bin/python -m pytest -q` | 全211件成功。外部ライブラリの非推奨警告7件 |
| Backend: `ruff check`、`ruff format --check`（変更したPython9ファイル） | lint成功、9ファイルの書式確認成功 |
| Backend: `python -m mypy --follow-imports=silent app/services/realtime/capture.py app/api/routes/transcripts.py` | 変更した処理2ファイルの型チェック成功 |
| Backend: `python -m mypy app` | 7ファイル12件のエラー。変更前HEADを一時ディレクトリへ取得して同じ環境で再現し、同じ12件を確認。今回の追加による増加なし |
| Backend: `alembic heads` | `20261010_0025 (head)`、headは1つ |
| Backend: `DATABASE_URL=postgresql+psycopg://dummy:dummy@localhost/dummy alembic upgrade 20261005_0024:head --sql` | 0024→0025のPostgreSQL用SQL生成成功。運用DBには接続しない |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/vitest/vitest.mjs run` | 全40ファイル205件成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/eslint/bin/eslint.js .` | 成功 |
| Chromium: 一時Playwrightハーネス `check_shared.py` | ライト/ダーク、320/393/560/844/1280px、作成/録音/保存後の30ケース成功。横はみ出しなし、画面作成時の`shared_audio`送信、映像要素なし、保存後の音声プレイヤー表示と要約再生成入口を確認。実音声の再生は未検証 |
| `git diff --check` | 成功 |

Python9ファイルは上記のモデル・Capture Service・Transcript Route・Migration、`test_shared_audio.py`・`test_meetings.py`・`test_realtime_phase6.py`・`test_realtime_websocket.py`・`test_summary_regeneration.py`です。Frontendにformatter専用設定はなく、既存のESLintとTypeScriptチェックを使用しました。

全体mypyの既存エラーはMeeting/Analysisのdict型引数、Azure数値変換、Realtimeテンプレート/解析、会議一覧のSQL型、テンプレートRouteの型です。テストや型検査を無効化せず、機能範囲外として報告します。追加した容量テストでは初回にMediaStorageの位置引数を取り違えて失敗し、音声/動画容量を名前付き引数に直して、元の厳密な検証内容のまま成功しました。

## 確認範囲と制約

- 音声共有なしの開始・変更を拒否し、キャンセル時に従来の共有を維持すること、マイクミュートで共有音声を止めないことを検証しました。
- 音声のみのWebSocket保存、重複Chunk再送、切断復旧、映像Media/VideoPart/変換Jobを作らないこと、音声容量の制限、録音中の全体処理禁止、Live閲覧とFinal再利用を検証しました。
- 単体/APIテストは合成データ・SQLite・モックを使用します。ブラウザ確認は実コンポーネントと合成MediaStream・モックAPI/通信を使用し、実際の会議音声や外部サービスへ送信しません。
- 実WhisperX/Azure/Ollama/Gemini接続、OSの共有音声取得、Safari・実スマートフォン、長時間録音、PostgreSQL運用DBへのMigration適用は別途確認が必要です。ブラウザ・OS・共有元による音声共有の対応はアプリ側で保証できません。
