# 映像を保存しない画面共有音声録音

最終照合: 2026-10-11。[README](../README.md) · [操作手順](usage.md#shared-audio) · [Dockerへの反映](operations.md#shared-audio)

ホームの「新しい会議」からダイアログを開き、「音声・動画をアップロード」「画面共有」「マイク音声を録音」の3つから取り込み方法を選びます。ホーム上の取り込み方法のショートカットは表示しません。「画面共有」内の「映像を録画する」をOFFにすると、共有音声とONのマイクを混合して音声ファイルだけ保存します。初期値はONで従来の画面共有録画を使用します。音声のみでもブラウザの共有許可は必要ですが、映像Preview・映像Recorder・映像Chunk・動画変換は使用しません。

## 主な変更箇所

- `frontend/components/meetings-manager.tsx`とCSS: ホームは「新しい会議」から作成し、ダイアログ内で3つの取り込み方法を選択。画面共有内の録画スイッチ、音声共有の案内、音声のみの開始。方法のカードは通常3列、スマートフォンでは1列のコンパクトな表示。
- `frontend/components/live-meeting-recorder.tsx`、`frontend/lib/live-capture.ts`: 音声だけの保存、共有先の変更・停止・再開、マイク切替、WhisperX/Azureへの混合音声入力。
- `frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/realtime-analysis-history.ts`: 保存済み音声の再生、Live会議ノート、変換待ちを要しない要約再生成。
- `frontend/lib/api.ts`、`format.ts`、`display-capture.ts`: source type・一覧表示と共有の対応案内。
- `backend/app/models/meeting.py`、`api/routes/transcripts.py`、`services/realtime/capture.py`: 新しい会議方式、音声のみの受付・保存・停止、明示的なFinal生成。
- `backend/alembic/versions/20261010_0025_shared_audio.py`: 0024からのenum追加。過去データを保護するためdowngradeでも値を保持。
- `backend/tests/test_shared_audio.py`と既存の会議作成・録音・再接続・要約再生成テスト、FrontendのRecorder・Mixer・会議詳細・一覧テスト。
- README・DESIGN・usage・development・operations: 操作、実装境界、Migrationと反映手順。

## 音声のみ保存する機能の初回検証

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
- 実WhisperX/Azure/Ollama/Gemini接続、OSの共有音声取得、Safari・実スマートフォン、長時間録音は別途確認が必要です。運用DBへのMigration適用は下記のユーザー提供ログで確認しました。ブラウザ・OS・共有元による音声共有の対応はアプリ側で保証できません。

## 反映状況

2026-10-11受領のユーザー提供ログで、次を確認しました。

- 4つのWorkerを停止後、Backendを再起動し、`up -d --wait --no-deps backend`でHealthy。
- `sudo docker compose exec -T backend alembic current`でPostgreSQLの`20261010_0025 (head)`。
- `worker`・`live-worker`・`realtime-ai-worker`・`answer-worker`のStarted。
- `sudo docker compose restart frontend`の実行ログ。再起動後の`ps`やブラウザ表示はまだ提示されていません。

エージェントはこの反映作業を実行していません。ログはDB版・サービスの起動を確認するものであり、実音声取得・保存・AI生成の成功を示すものではありません。次にブラウザを再読み込みし、[操作手順](usage.md#shared-audio)に沿って共有音声とマイク音の両方が録音されること、映像が保存されないこと、停止後の「要約を再生成」を確認してください。

上記の反映状況を追記した作業では、ログに基づく文書3ファイルを更新しました。`git diff --check`と相対リンク・反映記録の整合性を確認しました。その追記時はアプリのコードを変更していないため、formatter・lint・型チェック・単体テストは再実行していません。

## 画面共有内の録画スイッチ（2026-10-11）

この作業ではホームと会議作成の取り込み方法を3つにまとめ、「画面共有」内に「映像を録画する」を追加しました。ホームのショートカットは後述の作成入口の整理で撤去しています。ONは既存の`live`、OFFは既存の`shared_audio`として作成します。切替時に共有画面とマイク状態を保持し、新しい会議ダイアログではONへ戻ります。会議作成後は方式と録画スイッチを固定します。AI設定保存の失敗後も再試行で同じ会議を使用できるよう、無効化されたradioのFormDataではなく保持した選択状態を使用します。

変更ファイルは`meetings-manager.tsx`、`meetings-manager.module.css`、`meetings-manager.test.tsx`、新規`meeting-capture-settings.test.tsx`、README・DESIGN・usage・development・operations・この記録です。Backend・Recorder・依存・環境変数・DBに追加変更はありません。反映は[Frontendのみの手順](operations.md#record-video-toggle)を参照してください。

| コマンド | 結果 |
| --- | --- |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/vitest/vitest.mjs run meeting-capture-settings meetings-manager` | 関連2ファイル8件成功。ON/OFFの送信、選択済みStream・マイクの保持、共有音声なしの拒否、作成済み会議への再試行、初期値を確認 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/vitest/vitest.mjs run` | 全41ファイル212件成功。既存Recorder・要約再生成・リアルタイム表示・回答支援・会議後質問・テーマのテストを含む |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/eslint/bin/eslint.js .` | 成功。Frontendにformatter専用設定はなく、既存のESLintで書式を確認 |
| Chromium: 一時Playwrightハーネス `check_record_video.py` | ライト/ダーク、320/393/560/844/1280px、録画ON/OFFの作成・音声録音・保存後の40ケース成功。3つの入口、通常3列/スマートフォン1列、Spaceキーでの切替、共有選択の保持、送信する方式、作成後のスイッチ固定、横はみ出しなしを確認 |
| `git diff --check` | 成功 |

再試行テストは初回に失敗し、disabledのradioがFormDataに含まれないことを確認して実装を修正しました。テスト内容を弱めずに成功しています。Backendのコードに変更はないため、Backendの検証結果は初回検証の表を参照してください。実端末・OSの音声共有・外部AI接続・実音声の保存と再生は今回の表示変更でも未検証です。運用中サービスの再起動は行っていません。

ブラウザ確認は既存の一時ハーネスを最新ソースでbundleし、実コンポーネントと合成MediaStream・モックAPIを使用しました。`PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu FONTCONFIG_FILE=/tmp/speak-note-preview/fonts.conf /tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-shared-audio-browser/check_record_video.py`を実行しました。393pxのダーク表示と1280pxのライト表示のスクリーンショットも確認しました。稼働中アプリ・会議・外部サービスへアクセスせず、一時サーバーは確認後に停止しました。

## 録画・AIスイッチの配置統一（2026-10-11）

AI設定内の一般入力欄向けCSSがスイッチの横並びを上書きし、スイッチを説明の下へ表示していました。`meetings-manager.module.css`の一般ラベル向け指定からスイッチを除外し、「映像を録画する」とAI利用の両方で共通の横並びを使用するよう修正しました。左にタイトル・説明、右にスイッチを置き、狭い画面でも説明だけを折り返します。アップロードのAI自動要約にも同じ表示を適用します。

変更ファイルは上記CSS、README、DESIGN、`docs/usage.md`、この記録の5件です。スイッチの保存内容・AI処理・録画処理は従来どおりです。

| コマンド | 結果 |
| --- | --- |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/vitest/vitest.mjs run` | 全41ファイル212件成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/eslint/bin/eslint.js .` | 成功。formatter専用設定はなく、既存のESLintで書式を確認 |
| Chromium: 上記と同じ一時環境で `/tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-shared-audio-browser/check_switch_alignment.py` | 両テーマ・320/393/560/844/1280px・3つの取り込み方法の30ケース成功。両スイッチの右端・40×24pxの寸法・縦中央配置・横はみ出しなしを確認。説明クリック・SpaceでのAI切替、OFF時の関連入力欄の無効化、録画設定の維持も確認 |
| `git diff --check` | 成功 |

393pxのダーク表示と1280pxのライト表示はスクリーンショットでも確認しました。ブラウザ検証は実コンポーネント・モックAPIを使用し、会議の作成や実録音は行っていません。実スマートフォン・Safariは未検証です。Backend・DB変更はないためBackendテストは再実行していません。稼働中Dockerは操作せず、一時ブラウザ検証サーバーを停止しました。反映は[Frontendのみの手順](operations.md#record-video-toggle)と同じで、録音・録画の停止・保存完了後にブラウザを再読み込みします。

## ホームの作成入口の整理（2026-10-11）

ホーム上の取り込み方法のショートカットカードを撤去し、「新しい会議」から作成ダイアログを開く形に統一しました。会議がまだない場合の案内も同じ入口へ更新しました。作成ダイアログ内の3方式・録画スイッチ・AI設定はそのまま利用できます。専用CSSと使われなくなったショートカットの説明データを削除し、録画ON初期値の既存テストは「新しい会議」から開く操作へ更新しています。

変更は`meetings-manager.tsx`、`meetings-manager.module.css`、`meeting-capture-settings.test.tsx`、README、DESIGN、`docs/{usage,development,operations,redesign,shared-audio}.md`の10ファイルです。初期リデザインのモックアップは参照資料として保持し、現行ホームにカードがないことをガイドに明記しました。

| コマンド | 結果 |
| --- | --- |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/vitest/vitest.mjs run` | 全41ファイル212件成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `/tmp/node-v22.16.0-linux-x64/bin/node node_modules/eslint/bin/eslint.js .` | 成功。formatter専用設定はなく、既存のESLintで書式を確認 |
| Chromium: 上記と同じ一時環境で `/tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-shared-audio-browser/check_home_entry.py` | 両テーマ・320/393/560/844/1280pxの10ケース成功。ショートカットがないこと、ホームの作成ボタンが1つであること、空の会議一覧の案内、ダイアログの3方式・スイッチ、開き直した際の録画ON、横はみ出しなしを確認 |
| `git diff --check` | 成功 |

ブラウザ検証は実コンポーネント・モックAPIを使用し、実会議は作成していません。実スマートフォン・Safariは未検証です。Backend・DB変更はなく、Backendテストは再実行していません。Dockerの再起動は行っていません。反映は録音・録画の停止・保存完了後のブラウザ再読み込みで確認します。
