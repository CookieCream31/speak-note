# チャプターのサムネイル

最終照合: 2026-10-15。動画のチャプター一覧に、各開始位置の画像を自動表示します。

## 操作と動作

- 動画変換・AI解析の完了後、または手動AIのJSON取り込み後に、通常Workerへ自動予約します。
- 既存の動画会議もページを開くだけで不足分を予約します。チャプターが必要です。画像のために文字起こしや要約を再生成する必要はありません。
- 一覧に「サムネイルを作成中…」を表示し、完了した画像から反映します。生成中も動画・文字起こし・要約を閲覧できます。
- 音声のみ（マイク録音・映像OFFの画面共有・音声アップロード）は音声アイコンです。画像生成Jobは作りません。
- 失敗時は完成済みの画像と議事録を保持します。一覧の「再試行」または処理状況の失敗Jobから再試行してください。ページを開くたびに失敗Jobを自動再送しません。
- 履歴を切り替えると、選択した版のチャプターと開始位置に対応する画像を表示します。別の版のチャプターは混ぜません。

## 保存と処理

`FFmpegMediaService.create_thumbnail`が、保存された互換MP4のチャプター開始時刻から1フレームを抽出します。JPEGは320×180で、元映像の比率を保持し余白を付けます。開始時刻はDBの整数ミリ秒を使用し、FFmpeg境界で秒へ変換します。映像の原本を書き換えず、音声認識や外部AIを呼びません。

保存先は`meetings/{meeting_id}/thumbnails/{playback_media_id}/{start_ms}.jpg`です。同じ動画と開始位置ではファイルを再利用します。一時ファイルから置換するため、失敗した途中の画像で既存画像を上書きしません。会議の既存Storage削除処理に含まれます。DBの構造は変更せず、Alembicの最新headは`20261014_0031`のままです。環境変数・依存パッケージの追加もありません。

会議の行ロックを使って、待機・実行中のJobを重複予約しません。Worker再起動時は既存のJob回復処理で再開し、作成済み画像はスキップします。実行中に追加されたチャプターは、そのJob完了後の画面の取得で不足を確認し、次のJobへ予約します。失敗時と再試行時に会議の状態を「失敗」「待機」へ変更しません。

録音・録画、保存中のSession、動画変換中は予約・生成を止めます。動画の範囲外にある旧チャプターは画像を生成せず、アイコンを表示します。元のチャプター情報は変更しません。画像は内容を見て最適な場面を選ぶ方式ではなく、開始位置のフレームです。開始位置が黒画面なら黒い画像になります。

## APIと変更ファイル

| 対象 | ファイル・役割 |
| --- | --- |
| 切り出し・予約・再利用 | `backend/app/services/media/ffmpeg.py`、`thumbnails.py` |
| 状態取得・予約・JPEG配信 | `backend/app/api/routes/chapter_thumbnails.py`、`api/router.py`、`schemas/thumbnail.py` |
| Worker・完了予約・障害・再試行 | `backend/app/workers/main.py`、`services/jobs/service.py`、`api/routes/jobs.py` |
| 手動AI取り込み後の予約 | `backend/app/services/analysis/manual.py` |
| 一覧・画像・待機・エラー・再試行 | `frontend/components/chapter-list.tsx`、`meeting-workspace.tsx`、`meeting-workspace.module.css` |
| 選択履歴・Job状態・API | `frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/api.ts` |
| 回帰テスト | `backend/tests/test_chapter_thumbnails.py`、`frontend/components/chapter-list.test.tsx` |
| 文書 | `README.md`、`DESIGN.md`、`docs/chapter-thumbnails.md`、`docs/development.md`、`docs/operations.md`、`docs/redesign.md`、`docs/usage.md` |

`GET /api/v1/meetings/{meeting_id}/analyses/{analysis_id}/chapter-thumbnails`は読み取りだけです。同じURLのPOSTで不足分を予約します。通常のHTTP Request内でFFmpegを実行しません。JPEGは`GET /api/v1/meetings/{meeting_id}/chapter-thumbnails/{media_id}/{timestamp_ms}`で配信し、UUID、非負時刻、会議と再生用Mediaの所属を検証します。任意のStorage PathやFFmpegオプションは受け取りません。Frontendは2秒間隔で処理中だけ取得し、履歴を切り替えると旧リクエストを中止します。

## 検証

Backendの検証用venv、FrontendのNode 22と既存依存を使用しました。Docker・運用DB・外部サービスを操作していません。

| コマンド・確認 | 結果 |
| --- | --- |
| Backend `pytest -q` | 384件成功（追加20件）、既存の非推奨warning 6件 |
| Frontend `node node_modules/vitest/vitest.mjs run`（Node 22） | 58ファイル・411件成功（追加9件） |
| Frontend `node node_modules/eslint/bin/eslint.js .`・`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Backendの追加・対象9ファイル `ruff check`・`ruff format --check` | 成功。既存エラーのある`manual.py`は2行の追加に限定 |
| Backendの対象8ファイル `mypy --follow-imports silent --cache-dir /tmp/speak-note-chapter-thumbnails-mypy` | 成功。import先の既存エラーを分けて検査 |
| Backend全体 `ruff check app tests` | 既存7件。変更前`d4cd27a`でも同じ7件を確認 |
| Backend全体 `ruff format --check app tests` | 既存24ファイルが未整形。変更前でも同じ24ファイル |
| Backend全体 `mypy app`（検証用cache-dir指定） | 既存6件。変更前でも同じ6件を確認 |
| `alembic heads` | `20261014_0031 (head)`。新Migrationは不要 |
| 実FFmpeg・合成動画 | 1.5／4／7秒の異なるフレーム、320×180 JPEG、縦動画の余白、元動画の保持を確認 |
| Chromium・合成動画とAPI模擬 | ライト／ダーク、幅320／393／620／844／1280／1920px、動画／音声／生成中／失敗の48ケース成功。画像読込、チャプター再生、音声アイコン、横はみ出しなしを確認 |

テストはGETの読み取りのみ、初回予約、待機・実行中の重複防止、画像再利用、手動AI取り込み、Worker分岐・再起動回復、録音／保存／変換中の拒否、履歴・開始位置一致、実行後追加の追予約、障害時の結果保持と再試行を確認します。Frontendは画像、待機・停止、通信失敗と再試行、画像取得失敗、旧履歴の遅れた応答の破棄、処理状況からの再試行後の更新を確認します。

最初のmypy実行は既存cache DBの書込権限エラーで停止しました。コードのエラーではなく、`/tmp`の専用cache-dirを指定して再実行できています。

Backendの実行には`/tmp/speak-note-shared-audio-verify-env/bin/`の`pytest`・`ruff`・`mypy`・`alembic`、Frontendには`/tmp/node-v22.16.0-linux-x64/bin/node`を使用しました。対象ファイルを限定した検査コマンドは次のとおりです（Backend内で実行）。

```bash
ruff check app/services/media/thumbnails.py app/services/media/ffmpeg.py app/services/jobs/service.py app/api/routes/chapter_thumbnails.py app/api/routes/jobs.py app/api/router.py app/schemas/thumbnail.py app/workers/main.py tests/test_chapter_thumbnails.py
ruff format --check app/services/media/thumbnails.py app/services/media/ffmpeg.py app/services/jobs/service.py app/api/routes/chapter_thumbnails.py app/api/routes/jobs.py app/api/router.py app/schemas/thumbnail.py app/workers/main.py tests/test_chapter_thumbnails.py
mypy --cache-dir /tmp/speak-note-chapter-thumbnails-mypy --follow-imports silent app/services/media/thumbnails.py app/api/routes/chapter_thumbnails.py app/workers/main.py app/services/jobs/service.py app/api/routes/jobs.py app/schemas/thumbnail.py app/services/media/ffmpeg.py app/api/router.py
```

実会議、運用PostgreSQLでの同時予約、Safari／実スマートフォンでの画像取得は未検証です。画像作成時間は動画とチャプター数によります。通常Workerの既存Jobより後に待機する場合があります。運用環境への反映手順は[運用ガイド](operations.md#chapter-thumbnails)を参照してください。

## 動作確認手順

1. 録音・録画・保存と実行中Jobが終了してから反映します。
2. 保存済み動画でチャプターのある会議を開きます。一覧の「作成中」と、処理状況の「サムネイル生成」を確認します。
3. 完了後、チャプター開始位置の画像と長さが表示されることを確認します。画像を押して、その位置から再生できることも確認します。
4. 再読み込みして画像が維持され、新しいサムネイルJobが増えないことを確認します。要約履歴を切り替え、各版の画像と時刻が一致することを確認します。
5. 音声のみの会議では音声アイコンになり、サムネイルJobが作られないことを確認します。スマートフォンと両テーマでも確認します。
