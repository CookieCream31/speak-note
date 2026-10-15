# 要約再生成の実装・検証記録

最終照合: 2026-10-13（保存済みLiveからの暫定要約・原文の版固定・独立した高精度版作成）。[README](../README.md) · [操作手順](usage.md#summary-regeneration) · [Docker反映](operations.md#saved-transcript-summary)

後半のテスト件数は初回実装時点の記録です。最新の保存済み原文の再利用は[今回の実装・検証](#saved-transcript-summary)を参照してください。

## 実装した動作

共通の「要約を再生成」に入口を統合しました（リデザイン後は会議画面右上のタイトル横に配置）。AIプロファイルと議事録テンプレートを設定ダイアログで選び、今回の生成だけに適用します。初期値は会議のAI設定と保存済みテンプレートsnapshotです。テンプレートの「確定後」のカード・項目・AIへの指示を使い、従来のsummary_formatの指示を重ねません。テンプレート未使用の旧会議は従来形式を維持します。録音停止直後のRecorderに残っていた旧全体再処理ボタンも除きました。

保存済みcompleted Finalを優先し、なければ保存を完了したSessionのcompleted Liveから解析だけを予約します。Live入力の結果は暫定版として表示し、Finalへ昇格させません。AIなしで録音した会議でも、今回使うAIを明示すれば生成できます。旧API要求（reuse_saved_transcriptの省略／false）はFinal限定と初回の全体文字起こし経路を保持します。Jobへ固定した接続先・プロファイル・モデル・Temperature・テンプレート内容と版を、再試行でも引き継ぎます。生成履歴のsnapshotを指示・検証・表示に使用します。Sonioxの設定・処理IDの再利用・制約は[Sonioxガイド](soniox-transcription.md)を参照してください。

<a id="saved-transcript-summary"></a>
## 保存済み原文から要約だけを作る変更（2026-10-13）

`reuse_saved_transcript=true`は保存済みFinalを優先し、なければ同じ会議の保存済みLiveを使います。原文が空・未完了、録音／保存中の場合は409で拒否し、文字起こしJobへ切り替えません。画面は再利用できる原文が保存されるまで再生成を無効にします。モデル・テンプレートの変更、外部AI障害と再試行でも原文を再処理しません。

原文のIDとkindを既存Job JSONに固定し、AnalysisVersionの既存FKを使って生成履歴へ結び付けます。APIは関連原文から計算した`transcript_kind`を返し、Live入力はAI指示・履歴・表示で暫定と明示します。履歴選択では`GET /transcript?version_id=...`で元の版を読取り、会議一致・完了状態を検証します。後からFinalを作っても、以前の要約が参照する原文・テンプレートは変わりません。翻訳は入力に含めず、EvidenceのIDと時刻検証、ユーザー編集・確認済み情報の保護を維持します。

全体文字起こしは要約の「その他」→「全体文字起こしを作成（高精度版）」に分離しました。既存の明示APIでJobを予約し、録音／保存中・処理中・二重送信を拒否します。Jobの状態が変わると操作を更新し、失敗後も再試行できます。原文の本文編集はFinalを使います。会議後の要約編集・質問は保存済みLiveでも利用できます。[2026-10-16の変更・検証](post-meeting-notes.md)を参照してください。アップロードのFinal自動作成、録音中解析、回答支援、テンプレートの「確定後」構成は維持します。

新しいDBカラム・依存・環境変数はありません。現行Alembic headは`20261012_0029`です。Modelの変更は関係と計算property・型注釈だけで、DBの構造は変更しません。Backend・通常Worker・Frontendへの反映が必要です。[録音停止後の反映コマンド](operations.md#saved-transcript-summary)。

変更ファイルはBackendの`api/routes/{analysis,transcripts}.py`、`models/analysis.py`、`schemas/analysis.py`、`services/analysis/{regeneration,processor}.py`、`services/questions/processor.py`と`tests/test_saved_transcript_summary.py`。Frontendは会議ページと同テスト、`final-transcript-button.tsx`、`meeting-review-panel.tsx`と同テスト、`summary-regeneration.test.tsx`、`final-transcript-action.tsx`・CSS・同テスト、`lib/{api,realtime-analysis-history}.ts`です。README・DESIGNと関連する操作／開発／反映ガイドも更新しています。

| 検証コマンド | 結果 |
| --- | --- |
| Backend: `pytest -q` | 全体316件成功。既存の非推奨警告7件 |
| Backend: `pytest tests/test_saved_transcript_summary.py -q` | 新しい保存済み原文の再利用13件成功 |
| Backend: `ruff format --check`（変更8ファイル）、`ruff check`（同じファイル） | 成功 |
| Backend: `mypy --follow-imports=silent --cache-dir /tmp/speak-note-saved-summary-mypy-direct`（変更したappの7ファイル） | 成功 |
| Backend: `ruff check app` | 未変更ファイルに既存エラー8件。テンプレートRoute／Model、手動AI、Realtime解析、Azure |
| Backend: `mypy --cache-dir /tmp/speak-note-saved-summary-mypy-all app` | 未変更4ファイルに既存エラー7件。Azure、Realtime解析／テンプレート、テンプレートRoute |
| Frontend: `node node_modules/vitest/vitest.mjs run` | 全体312件・51ファイル成功 |
| Frontend: `node node_modules/eslint/bin/eslint.js .`、`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `alembic heads`／`git diff --check` | headは0029。差分チェック成功 |
| Chromium: 要約設定・履歴・高精度版の詳細操作 | 2テーマ×6幅の12条件成功。暫定表示、AI選択、エラー再試行と同じ要求ID、原文再利用の送信、履歴のLive／Final切替、独立した全体処理、横はみ出しなし |

専用Frontend formatterは未設定です。Backendの既定mypy cacheで一度内部エラーが起きましたが、別の一時cacheで再検証できました。これは型エラーと区別し、検査を無効化していません。全体に残る既存lint／型エラーは上記のとおりです。ブラウザ検証は実Component・CSSを一時bundleし、APIはmockです。実PostgreSQLの同時要求、実WhisperX／Soniox／AI接続、iPhone実機、Docker反映は未検証で、稼働サービスは再起動していません。

確認手順: AIをOFFにして録音し、停止・保存後にAIとテンプレートを選んで要約を作成します。解析Jobだけが追加され、暫定表示と原文への根拠があることを確認します。モデル・テンプレート変更でも原文を再処理せず、過去の履歴が残ることを確認してください。「その他」から高精度版を追加した後も古い暫定要約はLive原文を参照し、高精度版を明示して開けばFinal原文を表示します。

会議行ロック、処理中Jobの確認、unique request_idで重複を防ぎます。Final保存後の再開では全体文字起こしを再実行せず、後続解析も重複予約しません。録音・保存中の開始と再試行を拒否し、不正な設定・存在しないEvidence・外部API失敗時に既存結果を維持します。編集・確認済み項目を保護します。過去の要約とLive版を保持し、要約完成前の既定表示はRealtime版を維持します。明示したFinalへの切替は尊重し、処理中の履歴を選んでいた場合も完成後に表示を更新します。

Migration `20260927_0023` は確認したコード上の最新0022に続き、jobsへnullable JSONBのanalysis_requestとunique nullable UUIDのrequest_idを追加します。退避されていた/tmpのmigration案は使用していません。2026-09-27のユーザー提供ログで、運用DBが `20260927_0023 (head)` であることを確認しました。追加環境変数・依存変更はありません。

## 変更ファイル

Backend:

- `backend/app/api/routes/analysis.py`: 統一受付API。
- `backend/app/api/routes/transcripts.py`: 明示的な文字起こし再処理の詳細APIを会議ロックで保護。
- `backend/app/api/routes/jobs.py`: 録音中・別処理中・連続再試行の競合防止。
- `backend/app/models/job.py`: 固定した生成設定と冪等ID。
- `backend/app/schemas/analysis.py`: プロファイル・テンプレート・版・request_idと初回待ち応答。
- `backend/app/schemas/meeting_template.py`: 任意のカード指示（最大2,000文字）。
- `backend/app/services/analysis/regeneration.py`（新規）: Final選択、予約、設定固定、競合検知。
- `backend/app/services/analysis/processor.py`: 保存したモデル・Temperature・履歴snapshotを使用、Final限定、Evidenceと編集情報の保護。
- `backend/app/services/analysis/templates.py`: カード指示の送信と型の明確化。
- `backend/app/services/transcription/processor.py`: 固定設定で解析へ継続し、保存済みFinalと後続Jobを再利用。
- `backend/alembic/versions/20260927_0023_summary_regeneration.py`（新規）: DB Migration。
- `backend/tests/test_summary_regeneration.py`（新規）: 18件の再生成・再試行・snapshot・境界テスト。

Frontend:

- `frontend/app/meetings/[meeting_id]/page.tsx`: 入口統合、テンプレート取得、処理中の表示維持。
- `frontend/app/meetings/[meeting_id]/page.test.tsx`（新規）: ページの表示・履歴更新3件。
- `frontend/components/final-transcript-button.tsx`: SummaryRegenerationButtonとして設定ダイアログへ変更。
- `frontend/components/final-transcript-button.test.tsx`: 旧ボタンのテストを新しい動作へ更新。
- `frontend/components/summary-regeneration.module.css`（新規）: ダイアログとモバイル表示。
- `frontend/components/summary-regeneration.test.tsx`（新規）: 選択・送信・連打・処理中・エラー再送・HTTP環境6件。
- `frontend/components/meeting-review-panel.tsx`: 旧生成フォームを統合入口へ変更。
- `frontend/components/meeting-review-panel.module.css`: 暫定版の案内の表示。
- `frontend/components/meeting-review-panel.test.tsx`: 既存の履歴・編集保護テストの入力更新。
- `frontend/components/live-meeting-recorder.tsx`: 停止直後の旧入口を除去して会議ノートへ案内。
- `frontend/components/live-meeting-recorder.test.tsx`: 停止直後の単一入口を確認。
- `frontend/components/meeting-template-manager.tsx`: カード指示の編集。
- `frontend/components/meeting-template-manager.module.css`: 指示欄の表示。
- `frontend/components/meeting-template-manager.test.tsx`: 指示の保存・保存後案内を確認。
- `frontend/lib/api.ts`: 型付きの再生成APIと任意のテンプレート指示。

文書:

- `README.md`: 最終照合日、機能・操作・反映案内を更新。
- `DESIGN.md`: 旧自動処理・旧入口の記述を更新し、要約再生成の設計を追加。
- `docs/usage.md`: 設定選択、初回と2回目以降、ユーザー向け動作確認。
- `docs/meeting-templates.md`: カード指示と生成ごとのsnapshot。
- `docs/development.md`: API・Worker・テスト・詳細再処理境界。
- `docs/operations.md`: Migration0023の反映と再試行。
- `docs/summary-regeneration.md`（新規、この文書）: 変更と検証記録。

既存の変更を元に限定したunified diffを適用しました。他プロジェクト、既存サービス、.env、Docker Volumeは変更していません。この環境にはGitリポジトリがなく、Git diffによる確認は利用できませんでした。

## 実行した検証と結果

Backendは既存の `/tmp/speak-note-answer-verify-env/bin/python`、Frontendは `/tmp/node-v22.16.0-linux-x64/bin` をPATHに追加して実行しました。

| 検証 | コマンド | 結果 |
| --- | --- | --- |
| Backend全体テスト | `python -m pytest -q`（backend内） | **183 passed**。既存の非推奨警告7件 |
| Frontend全体テスト | `npm test`（frontend内） | **145 passed** |
| Frontend型 | `npm run typecheck` | 成功 |
| 変更Backend lint | `python -m ruff check` に上記変更Pythonファイル12件を指定 | 成功 |
| 変更Backend formatter | `python -m ruff format --check` に同じ12件を指定 | 成功。formatterの修正も差分で適用 |
| 変更Backend型 | `python -m mypy --follow-imports=silent` に変更appファイル10件を指定、独立cache使用 | 成功 |
| 変更Frontend lint | `eslint` に上記変更TS/TSXファイル12件を指定 | 成功 |
| Backend全体lint | `python -m ruff check app tests` | 未変更ファイルの既存問題18件 |
| Backend全体formatter | `python -m ruff format --check app tests` | 未変更ファイル31件に整形差分 |
| Backend全体型 | `python -m mypy app --cache-dir /tmp/speak-note-regeneration-mypy-cache` | 未変更7ファイルの既存問題12件。作業前コードの/tmp検証コピーでは15件で、今回触れた3件を修正 |
| Frontend全体lint | `npm run lint` | 未変更 `project-manager.tsx` のset-state-in-effect違反2件 |
| Migration head | `python -m alembic heads` | 単一 `20260927_0023 (head)` |
| Migration SQL | 下記のPostgreSQL方言でupgrade/downgradeを生成 | 両方成功。JSONB・UUID・unique制約と版更新を確認 |
| ブラウザ | Playwrightで実Componentを/tmpの隔離ページへbundleして操作 | 1280×800、768×1024、390×844、320×568、844×390の5サイズすべて成功。横はみ出し・ブラウザエラーなし。選択・送信・処理中の既存要約表示を確認 |

```bash
cd /home/llm/speak-note/backend
DATABASE_URL=postgresql+psycopg://validation@localhost/validation python -m alembic upgrade 20260927_0022:head --sql
DATABASE_URL=postgresql+psycopg://validation@localhost/validation python -m alembic downgrade 20260927_0023:20260927_0022 --sql
```

このURLはSQL生成用のダミーです。`--sql`ではDBへ接続しません。ローカルの既定SQLite方言ではunique制約のALTERが非対応で失敗したため、本番仕様のPostgreSQL方言を明示して確認しました。Frontendにはformatterの設定・実行コマンドがありません。

## 未検証・環境上の制約

- PostgreSQLでの実同時要求、実WhisperX/Ollama/Gemini接続、実録音・端末での動作は未検証です。Unit/APIテストはSQLiteとモック、ブラウザは実ComponentとモックAPIを使用しました。運用DBの版と反映状況は下記のユーザー提供ログで確認しています。
- 実装時の `docker compose ps` と `docker compose exec -T backend alembic current` はDockerソケット権限で失敗し、非対話sudoも認証が必要でした。エージェントによる再起動・Migration適用は行わず、その後ユーザーが反映を実行しました。
- 通常の実行・apply_patch・画像表示ツールはsandboxの `mountinfo path is not absolute` 起動エラーで使用できませんでした。許可された実行権限で、標準patchによる限定差分、テスト、読み取りを行いました。安全審査を回避する設定変更や既存ファイルの全面書き戻しは行っていません。
- mypyの既存cacheは内部エラーとなりましたが、新しいcacheで診断できました。Chromiumはfontconfigの環境エラーとなりましたが、既存の/tmp内設定を指定して5サイズの検証を完了しました。
- 全体lint・formatter・Backend型には上記の既存問題が残っています。テスト削除、skip追加、assertion弱体化、機能無効化はしていません。

## 反映とユーザー確認

2026-09-27のユーザー提供ログで、BackendのHealthy、PostgreSQLの `alembic current` が `20260927_0023 (head)`、`worker` / `realtime-ai-worker` / `answer-worker` のStartedを確認しました。2026-09-28の追加ログでFrontendは再起動後 `Up 43 seconds`、ホスト側3001→コンテナ側3000でした。`http://localhost:3001/` のホーム画面でテーマ切替と保存値復元も確認しました。要約再生成の実会議での選択・Job完了はまだ確認していません。

別環境へ反映する場合は[運用ガイドの反映コマンド](operations.md#summary-regeneration)を、録音・録画、保存、実行中Jobの終了後に実行してください。Workerを停止してBackendへ0023を適用し、正常起動と版を確認してWorkerを再開します。

[操作ガイド](usage.md#summary-regeneration)に従い、停止済み会議の「要約を再生成」でAIとテンプレートを選びます。初回の文字起こし後、2回目に別モデル・テンプレートで再生成し、文字起こしJobが増えないこと、過去履歴とRealtime版が残ること、テンプレート編集が旧履歴へ反映されないことを確認してください。
