# 会議後要約の全文編集

最終照合: 2026-10-16。[README](../README.md) · [反映手順](operations.md#summary-document)

## 操作

1. 会議を終了し、録音・録画の保存と要約生成の完了を待ちます。既存の会議後要約も作り直さず利用できます。
2. 「要約」で本文を確認し、「全文を編集」を押します。全体を1つの入力欄で編集できます。
3. 見出し・文章・メモを追加、変更、削除して「保存」を押します。空白・改行・空の本文も保存できます。自動保存ではありません。
4. 再読み込み後も保存した本文を表示します。会議後の要約画面は本文だけに統一し、元の生成カード・根拠の参照欄は表示しません。
5. 再生成は新しい要約を作ります。以前の編集本文はその要約の履歴に残り、「履歴」で開けます。メモを新しい要約へ自動コピーしません。

保存失敗・別画面との更新競合では編集中の文章を保持します。競合時は内容をコピーしてから再読み込みし、最新の本文へ変更を反映してください。未保存の取消・履歴切替・ページの再読み込みではブラウザが変更の破棄を確認します。要約・質問・検索のタブ間では入力を保持しますが、別ページへの移動前には保存してください。

リアルタイム原文・高精度原文に関係なく会議後要約を編集できます。会議中のRealtime Snapshotは従来のカード表示で閲覧用です。文字起こし本文そのものの修正は別機能です。

## 保存と生成データ

初期本文は、各要約に保存したテンプレートの「確定後」のカード順・名称・可視性・コア項目・追加フィールドから組み立てます。数値0、真偽値false、未入力も表示します。テンプレートのない旧履歴は従来の標準項目を使い、以前に編集・確認した要約を優先します。現在のテンプレートを後から変更しても既存の本文構成に反映しません。

本文はプレーンテキスト（最大5,000,000文字）です。見出しや追加項目の値も文章として自由に変更できます。HTMLやMarkdownを装飾として解釈せず、入力文字として表示します。本文の変更は元のAI項目・担当・期限・Evidence・確認状態・テンプレート値・チャプター・原文へ書き戻しません。元の項目単位の編集APIは互換性のため保持しますが、画面の編集入口は全文編集へまとめています。

質問は選択した要約に結び付いた保存済み文字起こしを使います。追記メモや変更した本文を事実の根拠としてAIへ送信しません。本文保存はAIや文字起こしのJobを作らず、録音時のAI設定も変更しません。

Migration `20261016_0032`は`20261014_0031`に続き、`analysis_versions`へ次を追加します。既存の項目・snapshot・原文は書き換えません。

| 項目 | 用途 |
| --- | --- |
| `document_content` | nullは未編集、空文字は明示的な空欄保存 |
| `document_revision` | 初期0。保存のたびに更新競合を検出するため加算 |
| `document_updated_at` | 本文の最終保存日時 |

Analysis読取り応答の`document_text`は保存本文を優先し、未編集の場合だけ既存データから組み立てます。GETでDBを更新しません。PATCH `/api/v1/meetings/{meeting_id}/analyses/{analysis_id}/document`は`content`と`expected_revision`を受け、会議行ロック下で停止・保存・要約完了と原文の会議一致を検証します。他画面の保存後に古いrevisionで更新すると409で拒否します。未編集本文に影響する旧項目編集でもrevisionを進めます。

<a id="body-only"></a>

## 本文だけの表示への整理（2026-10-16）

「AIの生成内容・根拠を確認」の参照欄と元カードの描画を会議後要約から撤去しました。原文がLive／Finalのどちらでも、編集用本文が1つだけ表示されます。会議中のRealtime Snapshotはカード表示を維持します。生成項目・根拠・確認済み情報・原文・チャプターのAPI応答とDB保存は変更しません。追加Migration・Backend変更・環境変数・依存の変更はありません。全文編集のMigration 0032は引き続き必要です。

変更ファイルは`frontend/components/meeting-review-panel.tsx`・同CSS、`meeting-review-panel.test.tsx`、`post-meeting-notes.test.tsx`と、README・DESIGN・本ガイド・操作／テンプレート／反映ガイドです。元カードを表示する既存テストは、本文が1つだけ表示されること・元データを変更しないことの確認へ更新し、全文編集・保存・質問・Realtimeの既存テストを維持しています。

| コマンド | 今回の結果 |
| --- | --- |
| Frontend `node node_modules/vitest/vitest.mjs run` | 61ファイル・439件成功 |
| Frontend `node node_modules/eslint/bin/eslint.js .` | 成功 |
| Frontend `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `python /tmp/speak-note-summary-body-browser/check.py` | 隔離Chromiumで両テーマ × 4幅（320／393／1280／1920px）× 会議後Live／Final／会議中要約の24ケース成功 |
| `git diff --check`・変更Markdownの相対ファイルリンクと反映アンカー確認 | 成功 |

Frontendは既存のNode環境を使用しました。formatterスクリプトがないため、既存の書式に合わせてESLint・型検査・差分検査を実行しています。ブラウザでは本文の単一表示・元カードの非表示・編集保存後の再読込み・質問の入口・会議中カードの維持・横はみ出しがないことを確認しました。APIは隔離したモックを使い、Backendは変更していないため今回再実行していません。Safari・実スマートフォン・実AIへの質問は未検証です。Docker再起動・運用データの変更・外部APIへの送信は行っていません。

反映後、既存の会議後要約を開き、元の参照欄がなく本文と「全文を編集」が表示されることを確認します。追記→保存→再読込みと、履歴切替、質問、チャプター・重要区間の再生を確認してください。会議中に作成した要約へ切り替えるとカード表示で閲覧できます。[反映コマンド](operations.md#summary-document-body)。

## 変更ファイル

| ファイル | 実装 |
| --- | --- |
| `backend/app/models/analysis.py`、`backend/alembic/versions/20261016_0032_analysis_document.py` | 保存本文・更新番号・日時、既存行を保つmigration |
| `backend/app/services/analysis_document.py` | 履歴snapshot・追加値・既存編集から初期本文を作成 |
| `backend/app/schemas/analysis.py`、`backend/app/api/routes/analysis.py` | 本文の読取り・保存・競合・停止／完了検証 |
| `frontend/components/meeting-summary-document.tsx`、同CSS | 全文編集・保存・未保存表示・エラー保持・連打防止 |
| `frontend/components/meeting-review-panel.tsx`、同CSS、`frontend/lib/api.ts` | 本文のみを表示、元カードの重複表示を撤去、履歴切替時の確認 |
| `backend/tests/test_analysis_document.py` | 保存・再生成・競合・入力・原文と質問の保護・migration |
| `frontend/components/meeting-summary-document.test.tsx`、`meeting-review-panel.test.tsx`、`post-meeting-notes.test.tsx` | 全文編集・保存・エラー・取消・未保存・閲覧用の回帰確認 |
| `README.md`、`DESIGN.md`、`docs/{usage,development,operations,meeting-templates,summary-regeneration,post-meeting-notes,summary-document}.md` | 操作・仕様・反映・制約の照合 |

## 全文編集を追加した時点の検証（参照欄撤去前）

Backendは`/tmp/speak-note-shared-audio-verify-env/bin/`のvenv、Frontendは`/tmp/node-v22.16.0-linux-x64/bin/node`を使用しました。

| コマンド | 結果 |
| --- | --- |
| Backend `pytest -q` | 全448件成功（追加17件）、既存の非推奨warning 6件 |
| Frontend `node node_modules/vitest/vitest.mjs run` | 61ファイル・439件成功（追加7件） |
| Frontend `node node_modules/eslint/bin/eslint.js .`・`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| 対象Backend `ruff format --check`・`ruff check` | 6ファイル成功 |
| 対象Backend `mypy --cache-dir /tmp/speak-note-summary-document-mypy --follow-imports silent` | 実装4ファイル成功 |
| `alembic heads` | `20261016_0032 (head)` |
| `DATABASE_URL=postgresql+psycopg://unused:unused@127.0.0.1/unused alembic upgrade 20261014_0031:head --sql` | PostgreSQL向け差分SQLの生成成功。接続・適用はしない |
| 隔離Chromium操作確認 | 両テーマ × 6幅（320〜1920px）× 会議後Live／Final／会議中要約の36ケースと、409／503の2ケース成功。全文入力・保存・再読込み・根拠欄・質問・閲覧用・HTMLの非実行と横はみ出しを確認 |
| Backend全体 `ruff check --output-format concise app tests` | 対象外に既存7件の指摘 |
| Backend全体 `ruff format --check app tests` | 対象外23ファイルに既存の整形差分、143ファイルは整形済み |
| Backend全体 `mypy --cache-dir /tmp/speak-note-summary-document-mypy-all app` | 対象外に既存6件の型エラー |
| `git diff --check`・変更Markdownの相対ファイルリンクと反映手順のアンカー確認 | 成功 |

対象Backendは`app/{models/analysis,schemas/analysis,api/routes/analysis,services/analysis_document}.py`、`tests/test_analysis_document.py`、`alembic/versions/20261016_0032_analysis_document.py`です。型検査は前4ファイル。Frontendはformatterスクリプトがないため既存の書式に合わせ、ESLint・型検査・差分検査を実行しました。

ブラウザ確認は`python /tmp/speak-note-summary-document-browser/check.py`を既存の隔離Playwright環境で実行しました。Frontend全体テスト後の案内文の修正も、ESLint・型検査と関連17テストで再検証しました。全体検査の既存指摘はテンプレートAPI／モデル、手動解析、Realtime解析、旧Azure等にあり、この変更では対象外です。

Migrationのupgrade・downgradeは隔離SQLiteで既存行の保持を検証しています。運用PostgreSQLへの適用、Safari・実スマートフォン、実AIへの質問は未検証です。Docker再起動・運用会議の編集・外部APIへの送信は行っていません。各保存の変更履歴・自動保存・書式付きエディターは今回追加していません。
