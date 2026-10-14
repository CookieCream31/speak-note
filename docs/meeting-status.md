# 処理完了後に残る会議の失敗状態

最終照合: 2026-10-15。

## 原因と修正

会議タイトル下の状態は`Meeting.status`、処理状況の「すべて完了」はJob履歴の現在の実行から表示していました。対象の会議ではサムネイルの2回目の試行が成功し、動画変換・要約も完了していましたが、会議の`failed`が残っていました。サムネイルの成功時に既存の失敗状態を復旧する経路がなかったためです。

今回、Workerの補助Job成功時と、会議詳細で「失敗・現在のJobがすべて完了」を検出した場合に、保存状態を照合する処理を追加しました。会議のstatusだけを完了へ戻し、ヘッダーを更新します。一覧も次の取得で完了になります。処理状況の「更新」も、Job一覧に加えてページ情報を更新します。

補助Jobはサムネイル、Live文字起こし、リアルタイム解析、会議後質問、回答支援です。失敗・再試行で会議全体を失敗・待機へ変更しません。リアルタイム解析の失敗が会議全体を失敗にする経路、リアルタイム解析・回答支援の再試行が会議を待機にする経路も同じ扱いに揃えました。失敗Jobとそれぞれの結果状態、エラー表示は残します。

## 完了へ戻す条件

行ロック下で最新の状態を確認し、次の条件を満たす場合だけ`failed`から`completed`へ変更します。

- 録音・録画／保存中のSessionがなく、最新のSessionが失敗していない。
- 動画変換・全体文字起こし・要約の待機／実行中Jobがなく、各種類の最新Jobが失敗していない。後続の成功で解決済みの古い失敗は履歴に保持する。
- 同じ会議の保存済みcompleted Transcript（Finalまたは終了済みLive）、またはcompleted Analysisとそのcompleted Transcriptが存在する。
- 同じ会議の再生用動画または原音声のファイルが実際に存在し、空でない。元動画だけしか残っている場合は完了にしない。

AIなし・Finalなしでも保存済みLiveとメディアが揃う会議は復旧できます。条件を満たさない会議は変更しません。ユーザー編集・確認済み情報・テンプレートsnapshot・選択中の版・文字起こし・要約・サムネイル・Job履歴を変更せず、新しいJobや外部API呼び出しも作りません。

`POST /api/v1/meetings/{meeting_id}/reconcile-status`で照合し、現在のMeetingを返します。会議詳細は必要な場合だけ自動で呼び、復旧できたときに`router.refresh()`で表示を更新します。通信失敗時は処理状況にエラーを表示し、「更新」で再試行できます。GETにはDB更新を追加していません。DB構造・環境変数・依存の変更はなく、Alembic headは`20261014_0031`のままです。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `backend/app/services/jobs/meeting_status.py` | 保存結果と本処理の照合、補助Jobの分類 |
| `backend/app/services/jobs/service.py` | 成功時の復旧、補助Job失敗時の会議状態維持 |
| `backend/app/api/routes/jobs.py` | 補助Job再試行時の会議状態維持 |
| `backend/app/api/routes/meetings.py` | 状態照合POST |
| `frontend/app/meetings/[meeting_id]/job-status-panel.tsx` | 自動照合、手動更新時のヘッダー再取得 |
| `frontend/app/meetings/[meeting_id]/page.tsx` | 会議状態をJobパネルに渡す |
| `backend/tests/test_meeting_status.py` | 残留失敗の復旧、進行中・本当の失敗・保存欠損の保護、履歴保持 |
| `frontend/app/meetings/[meeting_id]/job-status-panel-dom.test.tsx` | 自動照合、通信失敗・更新・録音中・本当の失敗の表示 |
| `README.md`、`DESIGN.md`、`docs/meeting-status.md`、`docs/operations.md`、`docs/usage.md` | 動作・検証・反映と操作手順 |

## 検証

Backendは検証用venv `/tmp/speak-note-shared-audio-verify-env/bin/`、FrontendはNode 22 `/tmp/node-v22.16.0-linux-x64/bin/node`で検査しました。

| コマンド | 結果 |
| --- | --- |
| Backend `pytest -q` | 全417件成功（追加33件）、既存の非推奨warning 6件 |
| Frontend `node node_modules/vitest/vitest.mjs run` | 59ファイル・421件成功（追加10件） |
| Frontend `node node_modules/eslint/bin/eslint.js .`、`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| 対象Backend `ruff check`・`ruff format --check` | 5ファイル成功 |
| 対象Backend `mypy --cache-dir /tmp/speak-note-meeting-status-mypy --follow-imports silent` | 4ファイル成功 |
| Backend全体 `ruff check --output-format concise app tests` | 変更前からの7件が残る |
| Backend全体 `ruff format --check app tests` | 変更前からの24ファイルが未整形 |
| Backend全体 `mypy --cache-dir /tmp/speak-note-meeting-status-mypy-all app` | 変更前からの6件が残る |
| `alembic heads` | `20261014_0031 (head)` |
| 対象会議の実APIで状態照合 | `failed`から`completed`への復旧を確認。前後のJob・Transcript・Analysis・Mediaレスポンスの比較はすべて一致し、既存結果と履歴を保持 |
| 実Frontendの会議ページ取得 | HTTP 200、ヘッダーの`data-status="completed"`と表示名「完了」を確認 |

対象Backendのformatter/lintは`app/services/jobs/meeting_status.py`、`app/services/jobs/service.py`、`app/api/routes/jobs.py`、`app/api/routes/meetings.py`、`tests/test_meeting_status.py`です。型検査は同じ4つの実装ファイルに行いました。既存の全体検査エラーの詳細は[サムネイル機能の検査記録](chapter-thumbnails.md#検証)も参照してください。

対象会議の修復はテスト後に上記の照合POSTで実施しました。他会議を一括更新する処理や、条件を省略したstatusの強制変更は行っていません。

未確認: Safari／実スマートフォンでの更新、録音中の実端末操作。Docker・録音・録画・外部サービスの再起動やデータ削除は行っていません。反映と確認は[運用ガイド](operations.md#meeting-status)を使用します。
