# 会議後要約の編集・質問

最終照合: 2026-10-16。

## 利用できる範囲

| 要約 | 原文 | 要約の全文編集 | 会議内容への質問 |
| --- | --- | --- | --- |
| 会議中のRealtime Snapshot | Live | 閲覧用 | 新規質問・再試行は無効 |
| 終了後に作成した要約 | 保存済みLive | 利用可能 | 利用可能・原文が暫定であることを表示 |
| 終了後に作成した要約 | Final | 利用可能 | 利用可能 |

録音・録画・保存中と、要約作成中は編集・質問を受け付けません。既存の会議後要約にも適用し、利用のために文字起こし・要約を作り直す必要はありません。文字起こし本文自体の修正は従来どおりFinalが必要です。Liveの話者表示名の変更は既存の停止後の操作を利用します。現在は「全文を編集」で要約全体とテンプレートの追加項目をプレーンテキストとして編集します。保存先の追加にはMigration 0032が必要です。[全文編集ガイド](summary-document.md)。

## 操作

1. 録音・録画を停止し、保存と動画変換が終わるのを待ちます。
2. 「要約を再生成」でAIとテンプレートを選び、会議後の要約を作成します。保存済みLiveを使う場合は文字起こしを再処理しません。
3. 「全文を編集」で本文全体を編集し、「保存」を押します。追記・メモはこの要約の履歴に保存され、再生成後も以前の履歴から開けます。元の項目と確認済み状態は保持します。
4. 「質問」タブで送信します。質問の原文は選択した要約の原文で固定し、その原文の版の質問履歴を表示します。別の要約も同じ原文を参照する場合は質問履歴を共有します。
5. Liveに基づく質問は原文・話者が暫定と表示します。後からFinalを作成しても、過去・実行待ちの質問はLive原文のままです。

録音時に「AIなし」でも、会議後要約で選んだProfileの現在の設定を質問に使用します。質問予約時にProvider/Profile/Modelを既存の質問行へ保存し、Workerはそのmodelを使用します。会議のAI設定や録音中のリアルタイム解析設定を勝手に変更しません。Profileが削除されている場合は会議のAI設定、Providerが無効な場合は設定画面を確認してください。外部AIから手動取り込みした要約のようにProfileがない場合も、従来の会議側のAI設定を使用します。

## 実装

会議中の解析は`RealtimeAnalysisState`から表示用の`id=realtime`へ変換し、会議後の解析は実際の`AnalysisVersion`として保存します。編集制御はこの違い、会議停止、要約完了で判定し、`transcript_kind=live`だけを理由に制限しません。テンプレートは会議後の要約で保存した「確定後」の構成を使用します。録音中・未完了の要約もBackendで編集を拒否します。

質問のPOSTには任意の`analysis_id`を追加しました。同じ会議のcompleted AnalysisVersionから原文IDとProfileを解決し、既存の`MeetingQuestion.transcript_version_id`に原文を固定します。ID省略時は従来のcompleted Finalを優先し、なければactiveの会議後要約を使用します。会議後要約がないLive原文だけでは質問を受け付けません。会議中解析の表示IDや、他会議のIDを指定してもJobを作りません。

受付・Worker実行・再試行で停止／保存完了、原文の会議一致・完了・非空を検証し、Liveの場合は同じ原文のcompleted録音Sessionも確認します。新規予約と再試行は会議の行ロック下で同時に1件までとし、質問・回答・Evidenceは通常Workerの`ask_meeting` Jobで処理します。回答の根拠は保存済み原文だけで、編集済みの要約や過去のAI回答を事実根拠にはしません。同じ原文の直前の質疑だけを文脈に使い、別の原文や会議を混ぜません。

Liveの暫定性をAIへの指示とUIで明示し、保存した暫定話者名も使用します。Evidenceのaliasを実IDへ戻し、質問に保存した原文のSegment IDに存在するか検証します。外部API・不正Evidenceの失敗で既存の要約・原文・履歴・ユーザー編集を失いません。質問のAPI応答の`transcript_kind`は既存の原文FKから計算し、DB列は増やしません。質問対応自体のMigration・環境変数・依存の追加はありません。後続の全文編集はMigration 0032を使用します。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `backend/app/services/questions/processor.py` | 選択要約からの原文・AI解決、保存済みLive検証、暫定性の指示、予約モデルの使用 |
| `backend/app/api/routes/questions.py`、`backend/app/schemas/question.py` | analysis_id受付、原文kindの応答 |
| `backend/app/models/question.py` | 既存FKのrelationshipと原文kindの算出（DDL変更なし） |
| `backend/app/api/routes/jobs.py`、`backend/app/api/routes/analysis.py` | 再試行・要約編集時の停止／保存／完了確認 |
| `frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/api.ts` | 選択原文・要約・Profileによる質問の有効化とAPI型 |
| `frontend/components/meeting-review-panel.tsx`、`meeting-question-panel.tsx` | 閲覧用との区別、案内文、質問送信・原文ごとの履歴・再試行 |
| `backend/tests/test_post_meeting_notes.py` | 保存済みLiveでの編集・確認・再生成保護・質問・参照版維持・障害 |
| `backend/tests/test_meeting_status.py` | 質問再試行fixtureへ実際の失敗済み質問と非空原文を追加し、元の会議状態維持のassertionを保持 |
| `frontend/components/post-meeting-notes.test.tsx`、`meeting-review-panel.test.tsx`、`meeting-question-panel.test.tsx`、`frontend/app/meetings/[meeting_id]/page.test.tsx` | 編集・送信・待機・エラー・閲覧用・AIなし録音・Final追加後の原文選択 |
| `README.md`、`DESIGN.md`、`docs/usage.md`、`docs/development.md`、`docs/summary-regeneration.md`、`docs/operations.md`、`docs/function-audit-20261014.md`、`docs/post-meeting-notes.md` | 仕様・操作・反映と制約の照合 |

## 質問対応を追加した時点の検証（全文編集前）

Backendは`/tmp/speak-note-shared-audio-verify-env/bin/`の検証用venv、Frontendは`/tmp/node-v22.16.0-linux-x64/bin/node`を使用しました。

| コマンド | 結果 |
| --- | --- |
| Backend `pytest -q` | 全431件成功（追加14件）、既存の非推奨warning 6件 |
| Frontend `node node_modules/vitest/vitest.mjs run` | 60ファイル・432件成功（追加11件） |
| Frontend `node node_modules/eslint/bin/eslint.js .`、`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| 対象Backend `ruff check`・`ruff format --check` | 8ファイル成功 |
| 対象Backend `mypy --cache-dir /tmp/speak-note-post-meeting-notes-mypy --follow-imports silent` | 実装6ファイル成功 |
| Backend全体 `ruff check --output-format concise app tests` | 変更前からの7件が残る |
| Backend全体 `ruff format --check app tests` | 対象外23ファイルに既存の整形差分、141ファイルは整形済み |
| Backend全体 `mypy --cache-dir /tmp/speak-note-post-meeting-notes-mypy-all app` | 変更前からの6件が残る |
| `alembic heads` | `20261014_0031 (head)`、今回のDDL変更なし |
| 隔離Chromium操作確認 | ライト・ダーク × 幅320/393/620/844/1280/1920 × 会議後Live・Final・会議中要約＝36ケース成功。編集・確認・質問・会議中閲覧用と横はみ出しを確認 |
| `git diff --check`・変更Markdownの相対ファイルリンク確認 | 成功 |

対象Backendは`app/schemas/question.py`、`app/models/question.py`、`app/api/routes/questions.py`、`app/api/routes/analysis.py`、`app/api/routes/jobs.py`、`app/services/questions/processor.py`、`tests/test_meeting_status.py`、`tests/test_post_meeting_notes.py`です。型検査は前6ファイルを対象に実行しました。Frontendにはformatterコマンドが未設定のため、既存の書式に合わせてESLint・型検査・差分検査を行っています。

実会議への質問の送信、実AIの回答精度、Safari・実スマートフォンは未検証です。運用会議の本文・要約・質問履歴を書き換える検証や、録音・録画中のDocker再起動は行っていません。[反映手順](operations.md#post-meeting-notes)を実行後、上の操作手順で既存のLive原文からの会議後要約を確認してください。
