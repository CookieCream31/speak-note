# 開発・引き継ぎガイド

[READMEへ戻る](../README.md)

## 作業前の確認

1. [AGENTS.md](../AGENTS.md) → [DESIGN.md](../DESIGN.md)の対象節 → 対象コード → 既存テストの順に読む。
2. 依頼の範囲と既存の変更を確認する。Gitがある環境では `git status --short` を確認し、他者の変更を戻さない。
3. Gitの `main` で管理する。もしGit情報がないコピーで作業する場合は履歴や差分を推測せず、変更対象と変更前の内容を把握する。
4. 通常作業は `/home/llm/speak-note` 内のみ。隣接するWhisperX / OllamaのプロジェクトやDockerリソースは変更しない。
5. 仕様とコードに差があれば報告し、意図を確認する。テストを消す・skipする・判定を弱めることで通さない。

仕様を変えるならDESIGN、操作・起動手順を変えるならREADMEと関連ガイドも同じ変更に含めます。
環境変数の追加時は `.env.example` と運用ガイドを更新してください。
変更の種類にかかわらずREADMEと実装を照合します。説明に影響する変更はREADMEと関連ガイドを同時に更新し、READMEの最終照合日も更新します。説明の変更が不要だった場合は、終了報告に照合結果と理由を記します。

## Git運用

機能単位で実装・必要なREADMEとdocsの更新・検証を完了し、他の作業を混ぜずにcommitします。開始時と終了時の `git status --short`、対象ファイルのstage、`git diff --cached --check` と差分・ファイル一覧の確認を必須とします。秘密情報、録音・録画、DB、生成物、古いバックアップはstageしません。リモート設定後は機能単位でpushし、未設定・失敗時は理由を報告します。操作例と初回リモート設定は[Git運用ガイド](git-workflow.md)を参照してください。

## 実ディレクトリ

```text
frontend/
  app/                 Next.jsのページ、Server Actions、全体CSS
  components/          画面コンポーネント、CSS Modules、画面テスト
  lib/                 APIの型・共通処理・Live状態管理・Speech SDK
  public/              再生ランタイムJS、Azure PCM AudioWorklet
  dev-entrypoint.sh    依存関係の同期と開発サーバー起動
backend/
  app/api/routes/      HTTP / WebSocketの入口
  app/models/          SQLAlchemyの永続モデル
  app/schemas/         API入出力・AI出力の検証
  app/services/        メディア、文字起こし、AI、Job処理
  app/workers/         通常Worker / Live文字起こしWorker / リアルタイムAI Worker / 回答支援Worker
  app/core/config.py   環境変数・既定値
  alembic/versions/    DB Migration
  tests/              pytest
docs/                  操作・開発・運用ガイド
storage/               会議メディア（運用データ、編集対象ではない）
```

`node_modules/`、`.next/`、`__pycache__/`、`build/` は生成物です。
残っている `*.orig` / `*.rej` を実装の正とみなさず、実際にimportされるファイルを読みます。
DESIGNの推奨ツリーにある `frontend/features/` は現状の配置ではありません。

## 変更内容からコードを探す

パスはすべてこのプロジェクト内です。関連テストは単なるスナップショットか、DOM操作・API検証を含むかも確認します。

| 変更したいもの | 主な入口 | 関連テスト |
| --- | --- | --- |
| ホーム、会議作成、タグ、一括操作 | [meetings-manager.tsx](../frontend/components/meetings-manager.tsx)、[meetings.py](../backend/app/api/routes/meetings.py)、[tags.py](../backend/app/api/routes/tags.py) | `meetings-manager.test.tsx`、`test_meetings.py`、`test_meeting_updates.py`、`test_tags.py` |
| AI設定、ProfileとDefault選択 | [ai-settings-manager.tsx](../frontend/components/ai-settings-manager.tsx)、[ai-profile-list.tsx](../frontend/components/ai-profile-list.tsx)、[ai_settings.py](../backend/app/api/routes/ai_settings.py) | `ai-settings-manager.test.tsx`、`ai-profile-list.test.tsx`、`test_ai_settings_api.py` |
| 議事録テンプレートの管理・会議選択 | [meeting-template-manager.tsx](../frontend/components/meeting-template-manager.tsx)、[meetings-manager.tsx](../frontend/components/meetings-manager.tsx)、[meeting_templates.py](../backend/app/api/routes/meeting_templates.py)、[meeting_template.py](../backend/app/schemas/meeting_template.py) | `meeting-template-manager.test.tsx`、`meetings-manager.test.tsx`、`test_meeting_templates.py` |
| テンプレートの議事録表示・値検証 | [template-analysis-cards.tsx](../frontend/components/template-analysis-cards.tsx)、[analysis/templates.py](../backend/app/services/analysis/templates.py)、[analysis/realtime_templates.py](../backend/app/services/analysis/realtime_templates.py) | `template-analysis-cards.test.tsx`、`test_analysis_templates.py` |
| 会議タイトル編集 | [meeting-title-editor.tsx](../frontend/components/meeting-title-editor.tsx)、既存の `PATCH /meetings/{id}` | `meeting-title-editor.test.tsx`、`test_meeting_updates.py` |
| 会議詳細、横幅、タブ | [page.tsx](../frontend/app/meetings/[meeting_id]/page.tsx)、[meeting-workspace.tsx](../frontend/components/meeting-workspace.tsx) と各CSS Module | `meeting-workspace.test.tsx` |
| 動画・音声再生、字幕、ショートカット | [transcript-player.tsx](../frontend/components/transcript-player.tsx)、[transcript-player.js](../frontend/public/transcript-player.js)、[video-settings.tsx](../frontend/components/video-settings.tsx)、[playback-rate-control.tsx](../frontend/components/playback-rate-control.tsx) | `transcript-player-runtime.test.ts`、`video-settings.test.tsx`、`playback-rate-control.test.tsx`、`playback-chapters.test.ts` とブラウザ操作確認 |
| 動画変換・録画合成の画質 | [ffmpeg.py](../backend/app/services/media/ffmpeg.py)、[live_recording.py](../backend/app/services/media/live_recording.py) | `test_video_processor.py` |
| 分割アップロード、配信・ダウンロード | [chunked-media-uploader.tsx](../frontend/components/chunked-media-uploader.tsx)、[meetings.py](../backend/app/api/routes/meetings.py)、[media_content.py](../backend/app/api/routes/media_content.py)、[storage.py](../backend/app/services/media/storage.py) | `test_chunked_upload.py`、`test_audio_upload.py`、`test_video_upload.py`、`test_media_content.py` |
| マイク・画面共有、録音終了 | [live-meeting-recorder.tsx](../frontend/components/live-meeting-recorder.tsx)、[live-capture.ts](../frontend/lib/live-capture.ts)、[realtime.py](../backend/app/api/routes/realtime.py)、[capture.py](../backend/app/services/realtime/capture.py) | `live-capture.test.ts`、`live-meeting-recorder.test.tsx`、`test_realtime_phase6.py` |
| Azure接続、部分認識、話者、再接続 | [azure-speech-stream.ts](../frontend/lib/azure-speech-stream.ts)、[PCM Worklet](../frontend/public/azure-speech-pcm-worklet.js)、[transcription_settings.py](../backend/app/api/routes/transcription_settings.py) | `azure-speech-stream*.test.ts`、`test_transcription_settings_api.py` |
| Liveの表示・消失・重複 | [live-transcript-store.ts](../frontend/lib/live-transcript-store.ts)、[live-transcript-events.ts](../frontend/lib/live-transcript-events.ts)、[realtime-analysis-panel.tsx](../frontend/components/realtime-analysis-panel.tsx) | `live-transcript-store.test.ts`、`live-transcript-dom.test.tsx`、`realtime-analysis-panel.test.tsx` |
| 確定文字起こし・話者分離 | [transcription/processor.py](../backend/app/services/transcription/processor.py)、[client.py](../backend/app/services/transcription/client.py)、[speaker_turns.py](../backend/app/services/transcription/speaker_turns.py) | `test_transcription_processor.py`、`test_whisperx_client.py`、`test_transcript_api.py` |
| AI議事録、プロンプト、Evidence | [analysis/processor.py](../backend/app/services/analysis/processor.py)、[schemas/analysis.py](../backend/app/schemas/analysis.py)、[llm/](../backend/app/services/llm/) | `test_analysis_phase5.py`、`test_llm_providers.py` |
| Live AI要約 | [analysis/realtime.py](../backend/app/services/analysis/realtime.py)、[workers/realtime_ai.py](../backend/app/workers/realtime_ai.py) | `test_realtime_analysis.py` |
| 会議への質問、手動AI取り込み | [questions/processor.py](../backend/app/services/questions/processor.py)、[analysis/manual.py](../backend/app/services/analysis/manual.py) | `test_meeting_questions.py`、`test_manual_analysis.py` |
| 録音WebSocketの切断・再接続・再送 | [recording-connection.ts](../frontend/lib/recording-connection.ts)、[api/routes/realtime.py](../backend/app/api/routes/realtime.py)、[realtime/capture.py](../backend/app/services/realtime/capture.py)、[workers/live_transcription.py](../backend/app/workers/live_transcription.py) | `recording-connection.test.ts`、`test_realtime_websocket.py` |
| Job進行、失敗、再試行、Queueの分担 | [jobs/service.py](../backend/app/services/jobs/service.py)、[workers/main.py](../backend/app/workers/main.py)、[workers/live_transcription.py](../backend/app/workers/live_transcription.py) | `test_jobs.py`、`job-status-panel.test.ts` |

FrontendのAPI型は [lib/api.ts](../frontend/lib/api.ts)、Backendの入口一覧は [api/router.py](../backend/app/api/router.py)です。
HTTPの詳細は起動中の `/docs`、WebSocketのメッセージは `api/routes/realtime.py` と録音コンポーネントを対で確認します。

## 処理経路と守る境界

```text
ブラウザ → 同一Origin /api → Backend → DBのJob
                                        ├─ worker → FFmpeg / WhisperX / Ollama・Gemini
                                        ├─ live-worker → FFmpeg / WhisperX（録音中の区間）
                                        └─ realtime-ai-worker → Ollama・Gemini

Azure Live:
MediaStream → AudioWorklet → PCM → ブラウザのSpeech SDK → Azure
                                   ├─ 部分認識 → Live状態ストア → 画面
                                   └─ 確定発話 → 録音WebSocket → Backend保存
録音データ: MediaRecorder → 録音WebSocket → storage（上記と並行）
```

- DB上の会議内時刻は整数ミリ秒。Playerや外部APIとの境界でのみ秒へ変換する。
- LiveとFinal、AI生成とユーザー編集済みを区別し、VersionとEvidenceの参照整合性を保つ。
- 外部サービスのClientはService層に置き、テストでmockできるようにする。
- 長時間の文字起こし・AI・FFmpeg処理はJob + Workerで扱う。
- 原本は変更しない。保存パスは生成IDから作り、拡張子・MIME・容量・Path Traversalを検証する。
- Gemini / AzureのAPI Keyは暗号化保存し、読み出しAPIには実値を返さない。Azureブラウザ認識には限定用途の短期Tokenを発行する。

### Azureの改修で特に注意すること

現在はConversationTranscriberによる連続認識です。15秒ごとの録音保存と、認識中の文字表示を混同しないでください。

- アプリ側の発話IDを途中結果から確定結果まで維持する。SDKのresultIdをそのままDB発話の一意キーにしない。
- 部分認識のspeakerIdでは話者を確定しない。確定結果を認識セッション単位で採番し、再接続後の同じAzure IDを同一人物と決めつけない。
- 履歴と途中結果は単一Snapshotとして購読する。表示は発話IDの平坦なDOM一覧を保ち、同一話者の連続箇所は見出し・罫線だけ省略する。
- 遅延ACK、古い取得結果、前の発話の遅延確定で、現在の途中結果を消さない。
- 無音は異常停止とは限らない。終了時はSDKの最終結果を受け取ってから未確定結果の救済・音声解放を行う。
- テストはSDKイベントの模擬であり、実サービスの認識精度・ネットワーク・長時間録音を保証しない。

## テスト

コマンドはリポジトリルートで実行します。通常のDockerイメージにBackendの開発依存は入りません。
`pytest: executable file not found` は「テスト不合格」ではなく、pytest未インストールです。

### Frontend（起動済みCompose）

```bash
sudo docker compose exec frontend npm test
sudo docker compose exec frontend npm run typecheck
sudo docker compose exec frontend npm run lint
```

絞り込み例:

```bash
sudo docker compose exec frontend npm test -- ai-profile-list ai-settings-manager meeting-template-manager template-analysis-cards
sudo docker compose exec frontend npm test -- azure-speech-stream live-transcript realtime-analysis-panel
```

起動していない場合は、依存関係が用意された環境で `exec` の代わりに `run --rm --no-deps --user root` を使えます。
ただしコマンドを上書きする `run frontend npm test` は `dev-entrypoint.sh` を通らないため、依存更新直後は先に通常起動で `npm ci` を完了させます。

### Backend（一時コンテナ）

既にビルド済みのBackendイメージで実行します。開発依存はその一時コンテナへインストールされ、コンテナ終了時に消えます。パッケージ取得のネットワーク接続が必要です。

```bash
sudo docker compose run --rm --no-deps --user root backend sh -c '
  pip install ".[dev]" &&
  python -m ruff check app tests &&
  python -m ruff format --check app tests &&
  python -m mypy app &&
  python -m pytest -q
'
```

テンプレート関連だけを検証する場合:

```bash
sudo docker compose run --rm --no-deps --user root backend sh -c '
  pip install ".[dev]" &&
  python -m pytest tests/test_meeting_templates.py tests/test_analysis_templates.py -q
'
```

Live周辺だけの検証例:

```bash
sudo docker compose run --rm --no-deps --user root backend sh -c '
  pip install ".[dev]" &&
  python -m pytest tests/test_realtime_phase6.py tests/test_realtime_transcript_quality.py tests/test_transcription_settings_api.py -q
'
```

[conftest.py](../backend/tests/conftest.py)はDB依存をSQLiteメモリDBへ差し替えます。
通常の単体テストに本番DBのMigrationや外部API Keyは不要です。
一方、PostgreSQL固有のMigrationと実際の外部API接続は別途検証が必要です。
コンテナ内のroot実行でホスト側に生成物ができる場合があるため、ソース全体の権限変更で対処しないでください。

### ホストで検証する場合

Docker構成に合わせてNode.js 22、Python 3.12以降を用意します。テスト以外でローカル環境を使う場合は接続URLや保存先を別途設定します。

```bash
cd frontend
npm ci
npm test
npm run typecheck
npm run lint
```

```bash
cd backend
python3.12 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
ruff check app tests
ruff format --check app tests
mypy app
pytest -q
```

Frontendに独立したformatterコマンドは現在ありません。既存スタイルに合わせ、ESLintと型チェックを行います。
`npm run build` は追加の本番ビルド検証ですが、起動中の開発コンテナと同じ `.next` を共有して実行しないでください。
Migrationの検証は、バックアップまたは検証用DBを準備してから実施します。

## 実機での受け入れ確認

変更範囲に応じて、以下を確認して結果を記録します。外部送信がある検証では、共有を許可された音源を使います。

- AI設定: デフォルトは1つ、選択保存失敗時に元のまま、編集中の値保持、追加・編集・削除の反映。
- 議事録テンプレート: AI設定でのカード・フィールド編集とrevision更新、会議作成時の選択、旧会議と過去Versionのsnapshot表示。
- 録音: マイクのみ／共有音声＋マイクの録画／映像を保存しない共有音声＋マイク、共有先変更、ミュート、停止後の保存、Final生成。
- Azure: 2人以上の交互発話、途中結果→確定、長い無音、再接続、10分を超えるToken更新、タブ切り替え。
- タイトル編集: 詳細画面の鉛筆から保存・Enter送信・キャンセル・Escape、空白のみの拒否、通信失敗時の入力保持と再試行、送信中の重複防止。保存で見出し・パンくずが更新され、再生位置・再生中の状態を維持すること。
- 再生: 文字クリック後もSpace再生、速度・字幕・全画面・音量、長文内の行追従と手動スクロール後の再開。画質切替で再生位置・速度・音量を維持し、非対応の元動画で互換MP4に戻ること。速度・歯車メニューを外側クリック/Escapeで閉じられ、同時に開かないこと。速度メニューのチェック・キーボード操作・ショートカットとの同期を確認すること。スマホ縦横と4K画面で、動画・設定パネルがはみ出さないこと。
- 会議詳細のスマートフォン表示: 320/375/393/430/560pxと境界の561px、横向き844pxを両テーマで確認。長いタイトル・プロジェクト名・AI名、保存結果、失敗Jobを入れ、ページの横スクロールやラベルの途中折り返しがないこと。話者数の設定、録音・録画の各アイコンの中央配置、Live文字起こしの補足、解析／回答支援タブも確認する。録音・通信を模擬したブラウザ検証と、実端末での録音・API保存の確認は分けて記録する。
- 動画品質: `live-capture.test.ts`の4K制約・解像度別ビットレートと、`test_video_processor.py`のH.264コピー・CRF18変換・縦横比を保つ録画合成を確認。原本を書き換えないこと。
- DB/API: 正常系だけでなく無効ID・不正入力・外部API失敗・再試行・Version参照。

## 現状の制約を確認する入口

- 質問候補 / チャプターの用途別設定は保存可能だが、[確定議事録処理](../backend/app/services/analysis/processor.py)はそれぞれの設定を解決していない。機能追加時はUIだけでなく生成Jobと出力Schemaも確認する。
- [質問回答](../backend/app/services/questions/processor.py)は `resolve_analysis_profile` を使用。「質問候補」設定は質問回答用の独立設定ではない。
- [JobType](../backend/app/models/job.py)の `generate_thumbnails` に対して [通常Worker](../backend/app/workers/main.py)の処理分岐はない。
- 認証・利用者ごとの権限分離はアプリ内にない。Caddy / Tunnelだけで認証を実装したことにはならない。
- `frontend/public/transcript-player.js` とAudioWorkletはTypeScriptの型チェック対象外。JSの変更はブラウザ確認を省略しない。
- `frontend/public/transcript-player.js` を変更した場合は、[TranscriptRuntime](../frontend/components/transcript-player.tsx)のScript URLに付く版番号も更新し、ブラウザが旧版を再利用しないようにする。確認時はページを完全に再読み込みする。

## 作業終了時の報告

変更ファイル、実装内容、実行コマンド、成功・失敗した検証、未確認事項、反映手順を残してください。
「実装済み」「テスト済み」「実サービスで確認済み」を区別し、テスト件数を恒久的な仕様としてREADMEへ固定しません。

## プロジェクト情報（2026-09-25）

`backend/app/models/knowledge.py` に共通プロフィール、親子プロジェクト、テキスト資料を置き、`backend/app/services/knowledge/context.py` が会議に紐付く親・子の情報だけをsnapshot化します。APIは `backend/app/api/routes/knowledge.py`、DB変更は `backend/alembic/versions/20260925_0021_project_answer_assist.py` です。会議への紐付けは `meetings.project_id` で、既存会議はnullのままです。UIは `frontend/components/project-manager.tsx` と会議作成・詳細画面にあります。

回答支援は `app/models/answer_assist.py`、`app/api/routes/answer_assist.py`、`app/services/knowledge/answer_assist.py`、`app/workers/answer_assist.py` と `frontend/components/answer-assist-panel.tsx` に分離しています。既存の `build_llm_provider` を利用し、Ollama / Geminiをプロファイルで選択できます。Migrationは `20260927_0022`。汎用Workerは `answer_live` をclaim/recoverしません。既存の会議後質問APIは変更していません。

送信許可、固定snapshot、送信先変更拒否、request_idの冪等性、新旧Jobの取り下げ、根拠検証、会議状態への影響を `tests/test_answer_assist.py` で検証します。会話AI判定は `app/services/knowledge/answer_monitor.py`、ON／OFFは `PATCH /meetings/{meeting_id}/answer-assist/session/{assist_id}/automatic` に分離しています。状態・カーソル・revisionは既存のconfiguration JSONに保持し、新しいDB列やJob enumは追加していません。専用Workerが監視・判定・回答を実行します。`tests/test_answer_monitor.py` で非質問・重複・対象話者・OFF後の送信防止を検証します。AI通信はモックで、実接続・回答品質は別の実機検証が必要です。操作・制約・反映手順は[回答支援ガイド](answer-assist.md)を参照してください。

### プロジェクト機能の反映と検証

DB migration 20260925_0021を追加しているため、コードの自動reloadだけでは反映が完了しません。Backendを再起動して起動時migrationを適用します。未適用ではmeetings.project_idなどが存在せず会議APIが500になります。

```bash
sudo docker compose restart backend frontend
sudo docker compose logs --tail=80 backend
sudo docker compose exec frontend npm run typecheck
sudo docker compose exec frontend npm test -- meetings-manager
sudo docker compose run --rm --no-deps --user root backend sh -c '
  pip install ".[dev]" &&
  python -m pytest tests/test_knowledge.py tests/test_meetings.py -q
'
```

テストは2階層制限・会議の紐付け解除・兄弟資料の非混在・資料の除外・共通プロフィールの上書き・snapshotの版保持を確認します。手動では親とA社/B社を作り、A社への会議作成・既存会議の移動・除外資料の編集後も除外のままかを確認してください。

2026-09-27の作業環境ではPython compileallとesbuildによる構文検証を実行しました。Node・Backendの開発依存・Docker権限がないため、typecheck・lint・単体テストおよびmigration実行は未確認です。プロフィールや資料は現状のアプリのアクセス権限に従うため、外部公開する際はアクセス制限を確認し、APIキーなどのSecretは資料へ保存しないでください。


開始時のマイク切替は `frontend/components/microphone-start-toggle.tsx`、途中のマイク追加は `LiveCaptureMixer.attachMicrophone()` です。ミュート開始設定は画面共有Streamの引継ぎ、またはマイク録音の `microphone_muted` queryで渡します。新規npm依存はありません。

## 停止後のLive版の閲覧

`GET /meetings/{id}/transcript?kind=live|final` と download の同じパラメータで版を指定できます。未指定はactive（高精度版）を優先し、なければ最新停止済みRealtimeSessionのcompleted Transcriptへフォールバックします。録音中Sessionはこのフォールバックで返しません。Live版をactive Finalへ昇格しないため既存の解析・会議後質問APIの境界を維持します。

停止済みSessionは共通会議ノートへ移行し、Snapshotを既存の読み取り専用履歴カードに変換します。全体処理の入口は以下の要約再生成へ統合しました。マイク録音・共有音声のみの録音停止のfinalized.job_idはnullで、自動TRANSCRIBE Jobは発行しません。画面共有録画のメディア変換とアップロード会議の従来処理は維持します。停止後表示だけの変更はDB変更なしでしたが、要約再生成は0023、共有音声録音は0025の適用が必要です。

共有音声録音は`MeetingSourceType.SHARED_AUDIO`とRecorderの`captureMode="shared_audio"`で区別します。作成画面の入口はUpload・画面共有・マイク録音の3つです。`meetings-manager.tsx`の画面共有内にある`record_video`スイッチ（初期ON）から、ONは`live`、OFFは`shared_audio`を保存します。切替で共有Streamやマイク選択を破棄せず、Meeting作成後は方式とスイッチを固定します。再試行時は無効化されたradioのFormDataではなく保持した選択状態から方式を判断します。`meeting-capture-settings.test.tsx`で送信方式・共有の保持・音声なしの開始拒否・AI設定失敗後の同じ会議への再試行・初期値を確認します。

`LiveCaptureMixer`へpreview=nullを渡して映像再生を省き、共通のAudio Destinationを録音・Azure認識に使用します。音声Streamに映像Trackを混ぜず、分離録画メッセージを作成しません。Backendは音声MIMEだけ受け付け、`original_audio`で保存・音声容量制限を適用・停止時の変換Jobを省略します。切断復旧は既存RealtimeSessionとChunk再送を使用します。`test_shared_audio.py`、`shared-audio-recorder.test.tsx`、`live-capture.test.ts`で新しい経路を確認し、`test_summary_regeneration.py`でFinalの初回作成・再利用を確認します。[検証記録](shared-audio.md)も参照してください。

確認: `pytest tests/test_stopped_live_notes.py tests/test_realtime_phase6.py -q`、frontendの`npm test -- realtime-analysis-history meeting-review-panel final-transcript-button`、`npm run typecheck`。実機で停止直後の表示、変換後の再生、AI解析OFF、要約再生成、版切替、録音のみを確認してください。


<a id="summary-regeneration"></a>
## 要約再生成の実装と検証

`POST /meetings/{id}/analyses` は `profile_id`、`template_id`、`template_revision`、`request_id` を受けます。nullのテンプレートIDは会議に保存済みのsnapshotを使います。明示したIDは現在のテンプレートをコピーし、指定revisionが更新されていれば409です。初回のFinal待ちは `analysis: null` と文字起こしJob IDを202で返し、Finalがあれば解析VersionとJob IDを返します。未知の入力フィールドは422です。

`services/analysis/regeneration.py` は会議行ロック、録音・保存状態、処理中Job、冪等ID、設定snapshotを扱います。`jobs.analysis_request` にはprofile/provider ID、モデル、Temperature、接続先種別・URL、テンプレート定義と版を保持します。Secretは保存しません。`processor.py` はcompleted Finalだけを選び、生成履歴のsnapshotで指示・検証・カード行の対応付けを行います。過去の編集・確認済み項目を引き継ぎ、失敗時にactive解析を置換しません。

文字起こしWorkerはFinalを保存してから、固定設定で解析Jobを予約します。後続Job IDを親の設定JSONへ同じTransactionで保存し、再開時は保存済みFinalと後続IDを使います。AI Jobは履歴のモデル・Temperatureを使い、予約後にProvider接続先が変更された場合は送信せず失敗します。retry APIも会議をロックし、録音・保存中や別の全体処理が実行中なら拒否します。

Frontendの `final-transcript-button.tsx` は名前を残して `SummaryRegenerationButton` を実装し、会議画面のタイトル横（`page.tsx`）に一度だけ配置します（`MeetingReviewPanel` の `regeneration` は省略可能で、現在は渡していません）。ネイティブdialogでフォーカス・Escapeを扱い、幅・高さを画面内に制限します。選択は生成APIにだけ送信し、通信失敗時は選択とrequest_idを維持します。Job状態の変化で再生成UIを更新し、既存の履歴とLive表示を維持します。録音停止直後のRecorderにあった旧再処理ボタンも除き、会議ノートへの案内を表示します。古いPOST transcriptは明示的な文字起こし再処理の詳細APIとして残し、再生成UIからは呼びません。

Migration: `20260927_0023_summary_regeneration.py`。既存Jobはnullableの追加カラムで互換性を維持します。退避していた/tmpの案は適用していません。

```bash
cd /home/llm/speak-note/backend
python -m pytest tests/test_summary_regeneration.py tests/test_analysis_phase5.py tests/test_stopped_live_notes.py tests/test_transcription_processor.py tests/test_meeting_questions.py -q
python -m pytest -q
python -m ruff check app tests
python -m ruff format --check app tests
python -m mypy app
python -m alembic heads
DATABASE_URL=postgresql+psycopg://validation@localhost/validation python -m alembic upgrade 20260927_0022:head --sql
cd /home/llm/speak-note/frontend
npm test
npm run lint
npm run typecheck
```

テストではFinalがない初回、Finalの再利用、モデル・テンプレート編集後の固定設定、snapshotによる指示・検証、Liveの拒否、連打・処理中・録音中の拒否、API失敗、Final保存後の再開、編集済み項目の保護を確認します。UIは選択・送信・キャンセル・連打・処理中・エラー再送を確認します。本番DBへのMigration、PostgreSQLでの同時要求、実WhisperX/AI接続、端末表示は別途実機確認が必要です。


<a id="display-theme"></a>
## 表示テーマの実装と変更時の確認

全配色は `frontend/app/theme.css` に集約します。通常のページ・Component CSSでは意味別変数を参照し、色の直接指定やページ内のテーマ変数上書きを追加しません。`--blue` は文字・リンク用、`--primary-bg` と `--on-primary` は塗りつぶしたボタン用です。映像上に固定する配色は `--media-*` を使用します。

`frontend/lib/theme.ts` が保存値、OS追従、別タブ同期、初回描画前のScriptを担当し、`ThemeSelector` はuseSyncExternalStoreで選択を共有します。保存不可・matchMediaなしにも対応し、SSR Snapshotはsystemで一定にします。Root LayoutとGlobal Errorの初回Script、通常Error／404、会議取得失敗の表示も共通テーマを使います。

`theme-styles.test.ts` は全ページ・Component CSSの色指定と変数、インライン・publicのRuntime内の直接色指定、両テーマのコントラストを検査します。`theme.test.ts` と `theme-selector.test.tsx` は保存・追従・初回表示・Hydration・入力／音声要素の保持を検証します。新しい表示を追加したら両テーマ・狭い画面・エラー表示も確認し、READMEの最終照合日と関連ガイドを同じ作業で更新してください。

変更ファイル、実行コマンド、結果、未検証事項は[表示テーマガイド](dark-mode.md)に記載しています。
