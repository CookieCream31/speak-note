# speak-note 設計書

## 1. 概要

`speak-note` は、会議の録音・録画・画面共有を取り込み、既存の WhisperX API Server で日本語文字起こしと話者分離を行い、Ollama または Gemini API を利用して議事録を生成する Web アプリケーションである。

中心コンセプト:

```text
Capture
会議を取り込む
   ↓
Understand
文字起こし・話者分離・AI整理
   ↓
Verify
元発言・元映像で確認
   ↓
Act
決定事項・TODO・次回アクションへ
```

特に以下を重要要件とする。

- AIが生成した決定事項・TODO・要約等から根拠となるTranscriptへ戻れる
- Transcriptをクリックすると対応する動画位置から再生できる
- 動画再生位置に合わせてTranscriptが追従する
- WhisperXとLLMはアプリ本体から独立した外部サービスとして扱う
- MacのVS CodeからRemote SSHでUbuntu Serverへ接続し、サーバー上で直接開発する

---

## 2. 開発・実行環境

### 開発端末

```text
Mac
├─ VS Code
├─ Remote - SSH
├─ Codex
└─ Browser
```

Mac側にはDocker・PostgreSQL・FFmpeg等の開発環境を構築しない。

### 開発サーバー

```text
Ubuntu Server

/home/llm/
├─ speak-note/              ← 本プロジェクト
├─ whisperx-api-server/     ← 既存・変更禁止
└─ llm-server/              ← 既存・変更禁止
```

`speak-note` は Ubuntu Server 上で Docker Compose を使って動作させる。

### 既存サービス

WhisperX:

```text
http://localhost:8000
```

Ollama:

```text
http://localhost:11434
```

これらは外部サービスとして利用し、既存プロジェクト自体は変更しない。

---

## 3. 技術構成

### Frontend

```text
Next.js
TypeScript
App Router
```

### Backend

```text
FastAPI
Python
SQLAlchemy
Alembic
Pydantic
```

### Database

```text
PostgreSQL
```

### Background Worker

FastAPI Backendとは別プロセスで動作させる。

用途:

```text
FFmpeg処理
WhisperX文字起こし
AI議事録生成
Thumbnail生成
```

録音中のLive文字起こし（`transcribe_live` Job）は専用の `live-worker` で処理し、長時間のFinal文字起こし・AI解析・動画変換のQueueと分離する。
同じ録音の区間を順番に保存するため、`live-worker` は1台で動かす。各Workerは自分の担当Job種別だけをclaim・再起動時のrecoverの対象にする。

### Media

```text
FFmpeg
ffprobe
```

### Realtime

```text
WebSocket
MediaRecorder
navigator.mediaDevices.getDisplayMedia()
```

### AI

```text
Ollama
Gemini API
```

### Infrastructure

```text
Docker Compose
```

---

## 4. Docker構成

`speak-note` 用に以下を用意する。

```text
frontend
backend
worker
postgres
```

WhisperXとOllamaはこのComposeへ含めない。

想定ポート:

```text
Frontend    3000
Backend     8001
WhisperX    8000
Ollama      11434
PostgreSQL  5432（原則Container内利用）
```

Macからの開発確認はVS Code Remote SSHのPort Forwardを使う。

---

## 5. 推奨ディレクトリ構成

```text
speak-note/
├─ frontend/
│  ├─ app/
│  ├─ components/
│  ├─ features/
│  │  ├─ meetings/
│  │  ├─ transcript/
│  │  ├─ player/
│  │  ├─ live/
│  │  └─ settings/
│  └─ lib/
│
├─ backend/
│  ├─ app/
│  │  ├─ api/
│  │  ├─ core/
│  │  ├─ db/
│  │  ├─ models/
│  │  ├─ schemas/
│  │  ├─ services/
│  │  │  ├─ media/
│  │  │  ├─ transcription/
│  │  │  ├─ analysis/
│  │  │  ├─ llm/
│  │  │  └─ jobs/
│  │  └─ workers/
│  ├─ alembic/
│  └─ tests/
│
├─ storage/
├─ docker-compose.yml
├─ .env.example
├─ .gitignore
├─ DESIGN.md
├─ AGENTS.md
└─ README.md
```

---

## 6. 入力方法

画面共有（録画または音声のみ）、マイク録音、ファイルアップロードへ対応する。

### 6.1 画面共有・準リアルタイム

ブラウザから画面共有を開始し、MediaRecorderで記録する。

画面共有には「画面共有を録画」（`source_type=live`）と「画面共有の音声を録音」（`source_type=shared_audio`）を提供する。音声のみの場合もBrowserの`getDisplayMedia({video:true,audio:true})`による許可を取得するが、映像Trackは共有の継続・終了確認にだけ使用し、映像Preview・映像MediaRecorder・映像Chunk送信・Video Part保存を行わない。共有音声とONのマイクを既存のAudioContext Destinationへ混合し、音声だけのMediaRecorderから`capture_mode=audio`・`chunk`を送信する。Backendは`original_audio`のみ保存し、音声の容量制限を適用する。動画変換Jobは作成しない。

`shared_audio`はMeetingに保存し、再読み込みや録音接続の復旧後も録画方式へ切り替えない。共有音声が取得できない場合は開始前に案内し、Backendも共有音声なし・動画MIME・分離録画を拒否する。共有先の変更時は同じAudio DestinationとRecorderを維持し、音声なし・選択キャンセルの場合は以前の共有を維持する。共有または共有音声Trackが終了した場合、マイク・Timeline・録音は継続し、共有音声停止の案内と共有再選択を表示する。マイクの初期ミュート・途中追加・回り込み防止は従来方式と共通。Browser・OS・共有元による音声共有の制約を説明し、非対応端末では既存のマイク録音やUploadを使用する。

停止後はマイク録音と同様にリアルタイム版を共通会議ノートへ表示し、「要約を再生成」の初回だけWhisperX全体処理とFinal保存を行う。保存済みFinalを再利用する既存の再生成、Evidence検証、編集保護を維持する。DB変更はAlembic `20261010_0025`（0024の後）で`meeting_source_type`へ値を追加する。downgradeで既存会議や音声を失わないようenum値は保持する。

```text
保存: getDisplayMedia -> MediaRecorder -> Media Chunk -> WebSocket -> Backend

WhisperX: Media Chunk -> Worker -> WhisperX -> Live Transcript

Azure: MediaStream -> AudioWorklet状態保持変換 -> 16kHz・16bit・mono Raw PCM -> PushAudioInputStream -> Azure Speech SDK ConversationTranscriber（リアルタイム話者分離） -> WebSocket -> Live Transcript
```

WhisperX選択時は数十秒程度遅れる準リアルタイムとする。ブラウザ負荷やBackground化によって
Chunkの到着が遅れ、1つのChunkが設定Windowより長くなった場合は、Backend Workerで複数の
Overlap Windowへ再分割し、新規区間をすべて文字起こしする。

Azure AI Speech選択時は、MediaRecorderの15秒Chunkを待たず、公式Speech SDKのConversationTranscriberを使用し、
リアルタイム話者分離にはAzure Standard (S0) リソースを使用する。Free (F0) はMicrosoftの制限表でリアルタイム話者分離の対象外である。
途中結果は`SpeechServiceResponse_StablePartialResultThreshold=3`で安定化し、単語が一時的に消えて再表示されるちらつきを抑える。
同じMediaStreamをAudioWorkletで状態を保持しながら16kHz・16bit・mono Raw PCMへ変換し、公式SDKのPushAudioInputStreamへ100ms単位で継続送信する。発話中の部分認識結果はBrowser内でLive Transcriptへ即時反映し、
同じ表示行を更新する。確定した発話だけをWebSocket経由でBackendへ保存する。
Speech SDKの`SpeechRecognitionResult.resultId`は連続認識セッション内で共通のRequest IDであるため、
発話の識別子には使用しない。Browser側で発話ごとの一意なIDを生成し、同じ発話の部分認識から
確定結果までだけ同じIDを引き継ぐ。
ConversationTranscriberの確定結果の`speakerId`を認識Session内で`SPEAKER_00`形式の暫定Labelへ割り当てる。
部分認識のspeakerIdは変動するため採番には使用せず、`SPEAKER_UNKNOWN`として表示する。Session再接続後の話者IDは同一人物と断定せず、新しい暫定Labelを割り当てる。
Live Transcriptの表示は連続する同一話者の発話を1つのTurnへまとめ、話者Labelが変わった時点で次のTurnへ分ける。
Azureが話者を未判定の`SPEAKER_UNKNOWN`同士は同一人物と断定せず、別Turnとして表示する。
Azureが途中結果の後に`NoMatch`または空の確定結果で発話区切りを通知した場合は、最後の空でない途中結果を保持して確定扱いにし、次の発話へ同じClient Result IDを再利用しない。部分認識のOffsetは同一発話内でも補正され得るため、発話区切りの判定には使用しない。空の途中結果だけを無視し、短く修正された結果を含む最新の非空仮説を表示する。確定済みの発話は遅延した途中結果で未確定状態へ戻さない。部分認識のUI通知は80ms間隔で最新結果へ集約し、確定結果は即時通知する。Live TranscriptはTurn単位で描画をメモ化し、内容が変化したTurnだけ再描画する。
部分認識中は話者LabelをTurnの結合条件に使用せず、末尾に「認識中」と表示する。履歴と途中結果は単一のSnapshotとして同じComponentで購読し、確定への遷移を一度に描画する。発話ごとのDOM要素は発話IDをkeyとする平坦な一覧に保持し、同じ確定話者が続く場合は後続要素の話者見出しと区切り線だけを省略する。これにより同一話者の結合時も発話本文のDOM要素を移動・削除しない。途中結果の更新では履歴のソート・話者Groupingを再計算せず、本文Componentをメモ化する。保存ACKや古いPolling結果を待たずに確定文を表示し、タブ切替・Panel再MountでBrowser内の認識結果を失わない。
文字が増える途中結果は80ms間隔で通知する。短縮・書き換えは最大250msだけ保留し、一時的な撤回と復活を描画しない。保留中に新しい修正が届いてもタイマーは延長しない。最新の訂正は必ず反映し、確定結果は待たずに即時反映する。既に次の発話が認識中の場合、時間範囲がその発話より前に終了する遅延確定結果で、現在の発話IDや保留中の途中表示を解除しない。
録音UIに診断情報のJSON保存を設ける。直近300件を上限として接続世代・音声時刻・Azureの話者ID・表示話者番号・文字数を保持し、連続する途中イベントは最新1件へ集約する。発言本文・音声・API Key・Tokenは診断情報へ含めない。
Live Transcript内だけで最新の発話を自動追従する。過去の発話へScrollした場合は追従を停止し、「最新の発話へ」から再開できる。録画Sessionが継続している間は、直前の1発話の確定だけで「文字起こし済み」と表示しない。
Backendは録画中のAzure Sessionに対して有効期限10分の短期Tokenだけを発行し、API Keyは
Frontendへ返さない。Frontendは期限前にTokenを更新する。MediaRecorderのChunk送信は
認識Sessionが予期せず停止またはキャンセルされた場合は同じMediaStreamへ自動再接続し、再接続時点の
録画経過時間を基準としてAzureの相対時刻を会議全体のTimelineへ補正する。
発話区切りはAzure Speech標準の連続認識に任せる。`Time`方式の固定最大時間は設定しない。無音中に認識結果が届かないことは正常なので再接続条件にしない。空の途中結果もAzureからの応答として扱う。Raw PCMの供給自体が5秒止まった場合、または有音PCMが継続しているのに部分認識・確定認識が15秒止まった場合だけ認識Sessionを再生成する。録画停止時はstopTranscribingAsyncの完了まで確定結果と話者IDを受け付け、確定結果が届かなかった場合だけ最新途中結果を保存する。
本文がundefinedのNoMatchも発話区切りとして処理し、再接続開始時に旧RecognizerのCallbackを無効化する。
Recognizerの終了・再接続時は公式APIの`stopTranscribingAsync()`完了後に`close()`し、接続解放後750ms以上待って再接続する。これによりFree（F0）の同時接続上限1を超える重複接続を避ける。最後にAudioWorkletとPushAudioInputStreamを解放し、並行するMediaRecorderの録画用Trackは停止しない。
原本保存用として並行継続し、Azure用の15秒文字起こしJobは作成しない。

表示中の「AI要約」「文字起こし」タブにかかわらず、録画、Chunk送信、文字起こしを継続する。

### 6.2 マイク録音・準リアルタイム

画面共有を行わず、ブラウザの`getUserMedia`で取得したマイク音声だけをMediaRecorderで録音する。
録音データは`original_audio`として保存し、画面共有と同じChunk保存と選択中Providerの
Live Transcript処理を使用する。マイクをミュートしても録音SessionとTimelineは継続する。

赤い停止ボタンを押した時点で音声とLive Transcriptを確定して保存し、共通会議ノートで表示する。
停止時に全体文字起こしJobを自動作成しない。「要約を再生成」からAIとテンプレートを選び、
保存済みFinalがない初回だけWhisperX全体処理を行う。保存済み音声は通常のAudio Playerで再生・Downloadできる。

### 6.3 ファイルアップロード

会議作成画面では音声と動画を分けず、「音声・動画をアップロード」という1つの入口にする。
選択されたファイルの拡張子とMIME TypeをBackendで検証し、動画なら`video_upload`、
音声なら`audio_upload`へ確定して、それぞれの既存処理へ渡す。

#### 動画ファイル

対応例:

```text
mp4
mov
webm
```

通常の動画ファイルは単一Requestでは送信しない。BrowserがBackendから指定された
`UPLOAD_CHUNK_MB`（既定50MB、設定上限90MB）単位へ分割し、各Chunkを個別Requestで送る。
BackendはUpload Sessionと受信済みChunk番号を保持し、同一画面内の再試行では未受信分だけを
再送する。全Chunkのサイズと個数を確認して原本へ結合した後にのみ、Mediaと
`preprocess_media` Jobを同一Transactionで作成する。元ファイル名はStorage Pathへ使用しない。

#### 音声ファイル

対応例:

```text
m4a
mp3
wav
flac
```

録音ファイルも動画と同じUpload Session APIを使用する。全Chunkの結合完了後にのみ、
Mediaと`transcribe` Jobを作成する。途中失敗時に不完全なMediaやJobを作らず、受信済みChunkは
再試行のために保持する。新しいUpload Sessionを開始した場合は、同じ会議の古い未完了Chunkを
削除する。

### 6.4 Home Dashboard

トップ画面は紹介用Landing Pageではなく、日常的に会議を開始・検索・再開するWorkspaceとする。

```text
┌──────────────┬────────────────────────────────────────────┐
│ speak-note   │ Home                         会議を検索    │
│              ├────────────────────────────────────────────┤
│ Home         │ 音声・動画Upload     画面共有録画        │
│ All Meetings │                                            │
│ AI Settings  │ 会議数  処理中  完了  エラー              │
│              │                                            │
│ Local        │ 最近の会議一覧                             │
│ Workspace    │ タイトル  作成日時  長さ  状態  操作       │
└──────────────┴────────────────────────────────────────────┘
```

- ファイルアップロード、マイク録音、画面共有録画、画面共有音声録音をQuick Actionとして最上部へ表示する。
- 会議作成Modal内でタイトルと取り込み方法に加え、Uploadでは対象ファイルを、画面共有では共有する画面・Windowとマイク利用有無を、マイク録音ではマイク利用有無を選択する。4つの取り込み方法すべてで、AI利用の有無・使うAI Profile・要約形式・会議の背景を選択する。方式のカードは2列で狭い画面に対応する。
- 選択したAI利用の有無とAI Profileは、取り込み方法によらず作成時に会議へ保存する。
- Uploadでは「文字起こし後にAI要約を自動作成」として表示する。無効時は文字起こしのみを行い、有効時はFinal Transcript完成後に解析Jobを自動作成する。
- 画面共有・マイク録音では停止時にFinal Transcriptを自動作成しないため、「AIを使う（リアルタイム解析・要約）」として表示する。無効時は録画・録音中のリアルタイム解析を行わない。要約は停止後の「要約を再生成」でAIを選んで作成できる。
- Uploadは会議作成後もModal内で分割送信と進捗表示を継続し、完了後に対象Meetingへ移動する。失敗時は作成済みMeetingとUpload Sessionを再利用して途中から再試行する。
- 画面共有は選択済みMediaStreamを一時的に保持し、Meeting作成後に対象Meetingへ移動してからRecorderへ引き継いで録画を開始する。引き継ぎが失敗または期限切れの場合はMeeting画面で共有画面を再選択する。
- 会議一覧は検索と作成日時・タイトル順の並べ替えに対応する。
- 会議をお気に入りとして保存し、お気に入りだけを一覧表示できる。
- 任意のタグを作成・削除でき、1つの会議へ複数のタグを付けられる。
- 会議タイトルだけでなくタグ名も検索対象とし、特定のタグで一覧を絞り込める。
- 会議一覧で複数件を選択し、お気に入り追加・解除、タグ追加・解除、削除を一括実行できる。
- 一括操作は対象をすべて検証してから実行し、存在しない会議が含まれる場合は部分実行しない。
- 会議一覧のタイトル変更と削除は各行の操作Menuへ格納し、通常時はRecord情報の閲覧を優先する。
- 会議詳細ではタイトル横の鉛筆からインライン編集し、保存またはキャンセルできる。Escapeもキャンセルとして扱う。前後の空白を除いた1〜200文字を既存のMeeting PATCH APIへtitleだけ送信し、保存後は見出し・パンくず・一覧へ反映する。二重送信を防止し、失敗時は入力を保持する。画面全体を再読み込みせず、再生・録音を維持する。
- 各行の操作Menuは同時に1件だけ開き、Menu外のクリックまたはEscapeキーで閉じる。Menu内の入力・タグ操作では閉じない。
- 処理中、完了、失敗の件数をDashboardへ表示する。
- MobileではSidebarを上部Navigationへ変更し、会議一覧を2行形式へ再配置する。

---

## 7. WhisperX連携

既存 WhisperX API Server を利用する。

環境変数:

```text
WHISPERX_BASE_URL=http://localhost:8000
WHISPERX_API_KEY=...
```

FrontendへAPI Keyを渡さない。

基本Request:

```text
POST /v1/audio/transcriptions
```

multipart:

```text
model=large-v3
language=ja
align=true
diarize=true
response_format=verbose_json
```

必要な場合のみ:

```text
min_speakers
max_speakers
```

会議ごとに最小話者数と最大話者数を任意設定できるようにする。どちらも1以上の整数とし、
両方を指定する場合は`min_speakers <= max_speakers`とする。両方が未入力ならWhisperXへ送らず
自動推定とする。同じ値を指定した場合は、実質的に話者数を固定する。設定はFinal Transcriptと
Live Transcriptの両方へ適用し、文字起こし処理中はUIから変更できないようにする。

WhisperX固有処理は `transcription` Service層へ隔離する。

---

## 8. 共通タイムライン

本アプリの最重要設計。

動画・音声・Transcript・AI情報など、すべて「会議開始からの経過時間」で統一する。

DBでは整数ミリ秒を使う。

```text
start_ms
end_ms
timestamp_ms
```

例:

```json
{
  "start_ms": 1478240,
  "end_ms": 1484620
}
```

FrontendでVideoへ渡す時だけ秒へ変換する。

```ts
video.currentTime = startMs / 1000;
```

---

## 9. Media設計

元ファイルは変更しない。

```text
storage/meetings/{meeting_id}/
├─ original/
│  └─ original.*
├─ derived/
│  ├─ playback.mp4
│  └─ transcription.wav
└─ thumbnails/
```

### original

ユーザーがアップロードした原本。

### playback

ブラウザ再生用。

推奨:

```text
MP4
H.264
AAC
faststart
```

### transcription

WhisperX処理向け音声。

FFmpeg処理はBackend/Worker内で行う。

---

## 10. DB設計

### Meeting

```text
Meeting
- id: UUID
- title
- source_type
- status
- created_at
- started_at nullable
- duration_ms nullable
- active_transcript_version_id nullable
- active_analysis_version_id nullable
- summary_format: standard | concise | detailed | bullet
- meeting_context nullable（最大4000文字）
- min_speakers nullable
- max_speakers nullable
- is_favorite
- tags: MeetingTag[]
```

`source_type`:

```text
live
audio_recording
shared_audio（画面共有音声とマイクの音声のみ保存）
media_upload（ファイル選択前の一時的な種別）
video_upload
audio_upload
```

`status`:

```text
created
uploading
preprocessing
queued
transcribing
analyzing
completed
failed
```

### MeetingTag

```text
MeetingTag
- id: UUID
- name: unique, 1..50 chars
- created_at
- updated_at

MeetingTagAssignment
- meeting_id
- tag_id
- primary key: meeting_id + tag_id
```

- MeetingとMeetingTagは多対多とし、1会議へ複数タグ、1タグへ複数会議を関連付けられる。
- タグ削除時は関連付けのみをCascade Deleteし、会議本体は削除しない。
- お気に入りはタグとは独立した素早い表示切替として維持する。

### Media

```text
Media
- id
- meeting_id
- kind
- storage_path
- mime_type
- size_bytes
- duration_ms
- created_at
```

kind:

```text
original_video
original_audio
playback_video
transcription_audio
```

### TranscriptVersion

```text
TranscriptVersion
- id
- meeting_id
- version
- kind
- status
- language
- model
- diarization_enabled
- raw_response JSONB nullable
- created_at
```

kind:

```text
live
final
```

### TranscriptSegment

```text
TranscriptSegment
- id
- transcript_version_id
- start_ms
- end_ms
- speaker_id
- text
- confidence nullable
- sequence
```

### TranscriptWord

必要になった場合:

```text
TranscriptWord
- id
- segment_id
- start_ms
- end_ms
- text
- confidence nullable
- speaker_id
```

### Speaker

```text
Speaker
- id
- meeting_id
- internal_name
- display_name nullable
```

例:

```text
SPEAKER_00 → 田中
```

Speaker名変更時にTranscript本文を書き換えない。

---

## 11. Transcript Version

リアルタイムと確定Transcriptを分離する。

```text
live-v1
final-v1
final-v2
```

会議終了後に保存済み全メディアをWhisperXで再処理し、`final` Versionを生成する。

Realtime結果を正式版としてそのまま確定しない。

---

## 12. Job設計

長時間処理をHTTP Request内で待たない。

最初はKafka等を使わず、PostgreSQL Job + Workerで実装する。

```text
Job
- id
- meeting_id
- realtime_chunk_id nullable
- realtime_window_start_ms nullable
- realtime_window_end_ms nullable
- realtime_commit_start_ms nullable
- type
- status
- attempts
- progress nullable
- error_message nullable
- created_at
- started_at
- finished_at
```

type:

```text
preprocess_media
transcribe
transcribe_live
analyze_realtime
analyze
ask_meeting
generate_thumbnails
```

status:

```text
queued
running
completed
failed
```

WhisperXが同時処理1の場合、transcribe Jobも同時実行1を基本とする。

Workerは単一Processで動かす。Worker再起動時は、前回のProcessが残した`running` Jobを
`queued`へ戻し、`attempts`を維持したまま再実行できるようにする。

WhisperXの接続系エラーは短いBackoffを挟んで最大3回試行する。
HTTP 429、一時的な5xx、および録画中の不完全なContainer境界により一時的に発生し得る
音声Decode系のHTTP 422も短いBackoffを挟んで最大3回試行する。それ以外の4xxは再試行せず、
WhisperXの安全なエラー詳細をJobへ記録する。

---

## 13. 動画とTranscript同期

### Transcript → Video

発言をクリック:

```text
TranscriptSegment.start_ms
↓
video.currentTime
↓
該当位置から再生
```

### Video → Transcript

```text
start_ms <= current_ms < end_ms
```

となるSegmentをactive表示する。

現在発言をハイライトし、自動スクロールする。同一話者の長い文章でも、現在の文字のDOM Rangeを使って表示行を追従する。
話者Blockの切り替わりだけを追従条件にせず、文字が表示領域の外側へ近づいた場合にスクロールする。
単語間の無音でも直前の文字位置を維持し、Block先頭へ戻らない。

再生中にユーザーがTranscriptを手動スクロールした場合は自動スクロールだけを一時停止し、
固定表示する再開ボタンを押すと現在の再生箇所へ戻って自動追従を再開する。

長時間Transcriptで毎回全Segmentを線形探索せず、Binary Search等を使用する。

動画配信はHTTP Rangeへ対応し、任意位置へseek可能にする。
Player右側の字幕・全画面操作の間に設定ボタンを置く。画質は互換MP4と元動画（再圧縮なし）を選択でき、
存在しない解像度の選択肢は表示しない。切り替え時は再生位置・再生/停止・速度・音量を維持する。
元動画をBrowserが再生できない場合は互換MP4に戻す。
字幕設定は文字サイズ（小/標準/大）、背景（半透明/黒/なし）、話者名の表示を切り替える。
設定アイコンは操作群の他アイコンと視覚的な大きさを揃える。歯車メニューは操作群と同じ半透明の暗色面にする。
画質・字幕サイズ・字幕背景・話者名を現在値と右矢印付きの行で表示し、行を押すと選択肢の画面へ移る。
選択中の項目にはチェック印を付け、選択後は一覧へ戻る。選択肢画面から戻る操作も用意する。
選択肢画面の幅は項目の内容に応じて一覧より狭くし、画面切り替え時にはパネルの幅と高さを滑らかに遷移させる。動きの軽減設定ではアニメーションを無効にする。
設定はPlayerを開いている間に適用し、ページを再読込すると既定値に戻る。
設定パネルは外側クリックまたはEscapeで閉じる。
1280px以上のTranscript表示では画面の高さからPlayerの最大高さを求め、固定720px上限は設けない。
映像の縦横比を維持し、操作UIも映像のStage内に収める。狭い画面は上下配置と高さ制限を維持する。
狭い画面で設定メニューを開いている間はStageを一時的に広げ、項目をスクロール可能にする。

---

## 14. Transcript編集

文字起こし結果は手動修正可能。

通常変更するもの:

```text
text
```

通常維持するもの:

```text
start_ms
end_ms
speaker_id
```

修正後にAI議事録を再生成できる。

---

## 15. AI Provider設計

AI処理は特定Providerへ依存させない。

```text
AnalysisService
      ↓
LLMProvider
  ┌────┴────┐
  ↓         ↓
Ollama    Gemini
```

Providerの永続設定は接続に必要な値だけを保持する。モデルとTemperatureはAI Profileへ集約し、
解析実行時にProfileからProvider Clientへ明示的に渡す。接続テストとモデル一覧取得はProfileなしで実行できる。

```text
AIProviderConfig = provider_type + name + URL/API Key + enabled
AIProfile        = name + provider_id + model + temperature + is_default
AnalysisVersion  = 実行時のprovider_id + profile_id + model + temperatureのsnapshot
```

共通Interfaceイメージ:

```python
class LLMProvider(Protocol):
    async def generate_structured(
        self,
        system_prompt: str,
        prompt: str,
        schema: type[BaseModel],
    ) -> BaseModel:
        ...
```

---

## 16. AI設定画面

```text
Settings
└─ AI
   ├─ Providers（接続情報）
   │  ├─ Ollama
   │  └─ Gemini
   ├─ Profiles（生成設定）
   │  ├─ Provider
   │  ├─ model
   │  └─ temperature
   ├─ Templates（概要と /settings/templates への入口）
   ├─ Usage
   │  ├─ realtime_analysis
   │  ├─ final_minutes
   │  ├─ suggested_questions
   │  └─ chapters
   └─ Realtime Speech-to-Text
```

AI設定は `/settings/ai`、議事録テンプレートの編集は `/settings/templates` とする。

### Ollama

接続設定:

```text
name
base_url
enabled
```

機能:

```text
接続テスト
利用可能モデル取得
```

Model List取得に失敗した場合は手入力できるようにする。

### 表示設計

ライトテーマのAI設定は他の管理画面と同じ淡いグレーのページ背景と白いカードを用いる。ダークテーマでは43節の共通配色を使い、全カード・フォーム・状態表示を切り替える。接続先、AIプロファイル、用途別設定を独立したカードとして上から順に配置し、入力欄・状態表示・操作ボタンは青を主アクセントとする。黒背景の設定セクションや過度に大きな見出しは使用せず、狭い画面ではフォームとカードを1列にする。

プロファイルは一覧表示とし、名前・接続先・モデルを確認できる。ラジオボタンでデフォルトを1つ選択し、保存成功後に選択状態を更新する。行をクリックするとその場で編集フォームを開き、保存・キャンセル・削除できる。生成設定の編集とデフォルトの選択は独立させ、未保存の変更がある場合は切り替え時に破棄確認する。追加もフォームを開いて行い、最初のプロファイルはデフォルトとして作成する。狭い画面ではフォームを1列にする。

### Gemini

接続設定:

```text
name
api_key
enabled
```

機能:

```text
接続テスト
```

---

## 17. AI Profile

Providerは接続情報だけを保持し、生成時のモデルとTemperatureはProfileだけが保持する。
同じ接続先でモデルやTemperatureが異なる設定は、複数のProfileとして再利用する。

例:

```text
Local
- Ollama
- model A
- temperature 0.2

High Accuracy
- Gemini
- model B
- temperature 0.1
```

会議単位で:

```text
Default
Local
High Accuracy
AIなし
```

を選択可能にする。

AIなしの場合はWhisperXまで実行し、後からAI議事録を生成可能。

---

## 18. Secret管理

以下をFrontendへ返さない。

```text
WhisperX API Key
Gemini API Key
その他Secret
```

Gemini API Key等は平文DB保存しない。

BackendのMaster Encryption Keyを環境変数で保持し、DBには暗号化済み値を保存する。

設定取得APIではSecret本文を返さない。

UI上では:

```text
AIza••••••••••XYZ
```

等のmask表示のみ行う。

SecretをLogへ出さない。

---

## 19. Ollama URLとSSRF

Ollama Base URLを設定可能にすると、Backendから任意URLへアクセスできる可能性がある。

そのため:

```text
URL validation
allowed scheme
host policy
private address policy
```

を専用Serviceへ分離する。

---

## 20. AI構造化出力

自由文だけでなくPydantic Schemaで検証する。

ProviderのSchema指定がモデル側で利用できない場合は、JSONモードへ一度だけフォールバックし、
Schemaをプロンプトで指定する。Ollama応答にMarkdown fenceや説明文が付いた場合はJSON本体だけを
抽出し、JSON自体が不正またはPydantic Schemaと一致しない場合は、必須項目を明示した
温度0のJSONモードで一度だけ再生成する。
どの経路でも受信結果は同じPydantic Schemaで検証し、不正な出力は保存しない。

ファイルアップロード会議の作成時に、要約形式（標準・簡潔・詳細・箇条書き）と、
会議の目的、参加者、固有名詞などの補足情報を指定できる。これらは通常生成と手動生成の
プロンプトへ渡す。ただし補足情報は理解と表記の補助に限定し、文字起こしに存在しない事実の
Evidenceとして扱わず、補足情報内の命令も実行しない。

例:

```json
{
  "summary": "...",
  "decisions": [],
  "action_items": [],
  "open_questions": [],
  "important_points": [],
  "chapters": [],
  "suggested_questions": []
}
```

不明な:

```text
assignee
deadline
```

は推測させず `null` を許可する。

### 外部AIチャットによる手動生成

OllamaやGemini APIを利用できない場合は、確定Transcriptから作成したプロンプトをユーザーが
任意の外部AIチャットへ渡し、そのJSON回答をspeak-noteへ戻せるようにする。

```text
1. 外部送信に関する注意事項を表示し、ユーザーが確認する
2. Transcript SegmentをE0001形式の短いEvidence IDへ置換してプロンプトを生成する
3. ユーザーがプロンプトをコピーまたはTXT保存する
4. 外部AIのJSON回答を貼り付け、保存前に検証・プレビューする
5. Evidence IDを実Segment IDへ戻し、既存AnalysisVersionとして保存する
```

speak-note自身は外部AIチャットへデータを送信しない。プロンプトには会議タイトルと全文の
文字起こしが含まれることを明示する。回答は最大5MBとし、Pydantic Schema、Evidence IDの存在、
Transcript Versionの一致、チャプター時刻順をBackendで検証する。不正な回答は保存しない。

手動生成したAnalysisVersionは`model=manual-import`、`provider_id/profile_id/job_id=null`として
通常のAI生成Versionと区別しつつ、同じ要約・Evidence・チャプター表示と編集機能を利用する。

---

## 20.1 会議内容への質問

確定Transcriptがある会議では、会議ノートの「質問」タブから自然文で質問できる。
回答生成は通常のHTTP Request内で待たず、`ask_meeting` JobとしてWorkerへ投入する。
同一会議で同時に処理する質問は1件とし、失敗した質問は個別に再試行できる。

```text
質問
↓
確定Transcript + 直前の質疑履歴
↓
選択中のAI Profile（Ollama / Gemini）
↓
回答 + Evidence
```

回答の事実根拠は質問時点の確定Transcriptだけに限定する。直前の質疑履歴は代名詞などの
文脈理解にだけ使い、事実根拠にはしない。回答可能な場合は最大20件のEvidence Segmentを必須とし、
Backendで同じTranscript Versionに存在するIDか検証する。文字起こしから答えられない場合は推測せず、
`insufficient_information=true`として不足内容を説明する。Evidenceは検証と監査のためBackendへ保存するが、
質問画面には表示せず、質問と回答だけを会話形式で表示する。

質問、回答、使用したTranscript Version、Provider/Profile/Model、Job、Evidence、状態、Errorを保存する。
質問Jobの失敗だけでは会議全体を`failed`へ変更しない。会議がAIなし、確定Transcriptなし、または
利用可能なAI Profileなしの場合は質問入力を無効にする。
質問入力はEnterで送信し、Shift+Enterで改行する。日本語IMEの変換確定中は送信しない。
質問を送信したとき、および最新質問の処理状態・回答が更新されたときは、質問履歴を末尾まで
自動スクロールして最新の質問と回答を表示する。内容に変化がないポーリングではスクロールしない。

---

## 21. AnalysisVersion

AI結果もVersion管理する。

```text
AnalysisVersion
- id
- meeting_id
- transcript_version_id
- provider_id
- model
- prompt_version
- status
- created_at
```

Ollamaで生成後、Geminiで再生成しても前の結果を削除しない。

---

## 22. Evidence

AI生成情報には根拠となるTranscript Segmentを持たせる。

例:

```text
Decision
「JWT認証を採用」

Evidence
- segment 325
- segment 326
```

AI入力:

```text
[segment_id=UUID start=24:31 speaker=佐藤]
JWTを使うのが良いと思います。
```

AIには入力に存在する `segment_id` のみ返すよう要求する。

Backendでも:

```text
Segmentが存在する
同じTranscriptVersionに属する
```

ことを検証する。

確定議事録の生成でEvidence IDの検証、またはChapter・Highlightの時刻範囲の検証に失敗した場合は、
失敗理由と、入力のevidence_idだけを使う指示を添えて一度だけ再生成を求める。
再生成の結果も不正ならAnalysisを失敗にし、未知のEvidence IDは保存しない。

```text
AI情報
↓
Evidence
↓
Transcript
↓
Video
```

を必ず辿れるようにする。

---

## 23. AI議事録項目

最低限:

```text
Summary
Decision
ActionItem
OpenQuestion
ImportantPoint
Chapter
SuggestedQuestion
```

AI生成情報のstate:

```text
generated
confirmed
edited
```

ユーザーが `confirmed` / `edited` にした情報をAI再生成時に勝手に上書きしない。

---

## 24. AIチャプター

例:

```text
00:00 挨拶
04:21 前回進捗
12:32 API設計
24:10 認証方式
31:05 DB設計
```

動画ではチャプター境界をプレイヤー内のシークバー自体に区間として表示する。
再生済み部分は区間ごとに進捗表示し、チャプター区間のクリック位置へ動画seekする。
現在のチャプター名はプレイヤー操作部へ表示する。
シークバーは履歴欄で選択中の解析Versionに含まれるChapter情報だけを使用する。
確定版・リアルタイム解析・別の確定版を切り替えた場合はシークバーも同じVersionへ切り替え、
選択中のVersionにChapterがなければ他VersionのChapterを流用せず、全体を1区間で表示する。
動画のシークバーと再生操作は、マウス操作可能な端末ではポインター操作時に表示し、
動画上で2.5秒間ポインター操作がなければ、操作部とマウスカーソルを非表示にする。
ポインターを再び動かしたときは、操作部とマウスカーソルを再表示する。
キーボードのフォーカス表示中と、ホバーできないタッチ端末では常時表示する。
操作部の表示時も映像全体へ暗いグラデーションを重ねず、個々の操作を枠線なしの半透明な丸い背景で判別できるようにする。
音量バーと再生速度はポインター操作後にフォーカス枠を残さない。
Player内のボタンはポインターで押した後にフォーカスを解除し、続けて押す`Space`がボタンを再実行せず再生・一時停止になるようにする。`Tab`・`Enter`によるボタン操作時はフォーカスを維持する。
全画面切替などでブラウザが操作ボタンへフォーカスを戻した場合も、設定メニューを除くPlayer操作ボタン上の`Space`は再生・一時停止を優先し、ボタンの再実行を防ぐ。ボタン自体は`Enter`で操作できる。
音量操作は再生ボタンの右側に配置し、クリックでミュートを切り替え、ホバーまたはキーボードフォーカス時に音量スライダーを表示する。
音量操作中は操作部を自動で非表示にしない。
フォーム入力中とダイアログ表示中を除き、`F`で動画の全画面表示、`M`でミュート、
`Space`または`K`で再生・一時停止、`J`で10秒戻る、`L`で10秒進む、
`←`で5秒戻る、`→`で5秒進む、`Shift + >`で再生速度を一段階上げ、
`Shift + <`で一段階下げる。全画面表示以外のショートカットは音声でも利用できる。
動画と音声の操作部では、`2`、`1.75`、`1.5`、`1.25`、`1`、`0.75`、`0.5`倍の降順リストから再生速度を選択できる。
速度表示のボタンから、画質・字幕設定と同じ角丸・項目・チェック表示のメニューを開く。動画は設定と同じ半透明配色、音声は表示テーマの配色を使う。外側クリック・フォーカス移動・Escapeで閉じ、↑/↓/Home/Endで選択肢へ移動できる。画質・字幕設定と同時に開かない。狭い画面や横画面では画面内へ収めてスクロールできるようにする。速度変更は再生位置と再生／停止を保持し、既存ショートカットや画質変更にも表示を同期する。
動画の速度表示は選択中の値を高さ中央へ配置し、下矢印を表示せず、字幕・全画面をまとめた操作群とは独立したボタンとして表示する。
字幕ON時の選択背景はクリック領域より小さい角丸四角とし、外側の操作群との間に均等な余白を設ける。
チャプター上で`Space`を押しても再度Seekせず、現在位置で再生・一時停止する。
チャプターへSeekした後は操作方法にかかわらずチャプターボタンのフォーカスを解除し、選択枠を残さない。
文字起こしの時刻または本文へSeekした後もボタンのフォーカスを解除し、`Space`ではSeekを再実行せず現在位置で再生・一時停止する。
確定文字起こしがある動画では、話者名と発言内容を独自字幕として映像上に重ねて初期表示する。
字幕は最大34文字・最大6秒を目安に分割し、単語時刻がない長い発言は発言区間内で表示時刻を補間する。
プレイヤー内の`CC`ボタンまたは`C`キーで字幕の表示・非表示を切り替える。`C`は動画でのみ有効とする。
音声では画面下部の固定Player内にチャプター付きシークと再生操作を表示する。
音声のシークバーも動画と同じChapter情報で区間分割し、区切りと現在区間を常時判別できる表示にする。
開いている会議の動画はPlayer見出し、音声は固定Playerの操作部からダウンロードできるようにする。
再生用のinline配信とは別のattachment APIを使用し、会議タイトルと実際の拡張子を保存ファイル名にする。
動画・音声の再生開始時とSeek後は現在の発言へ追従し、別タブで再生中に文字起こしタブへ戻った場合も
現在の再生位置に対応する発言を中央へ表示する。ユーザーが手動Scrollした場合のみ自動追従を一時停止する。

Ollamaによる議事録生成で`chapters`が空の場合だけ、同じTranscriptを使ってチャプター専用の
小さいSchemaで追加生成する。最初からチャプターがある場合とGemini利用時は追加生成しない。
追加生成したEvidence IDと時間範囲もBackendで検証してから保存する。
Ollamaが1項目へ20件を超える既知のEvidence IDを返した場合は、時系列全体から最大20件を
均等に選んで保存する。未知のEvidence IDが含まれる場合は縮約せず、検証失敗にする。

---

## 25. 検索

MVP:

```text
Transcript全文検索
Speakerフィルター
```

検索結果:

```text
24:31 佐藤
JWTを使うのが良いと思います。
[▶ 再生]
```

クリックで動画へseek。

---

## 26. Bookmark

```text
Bookmark
- id
- meeting_id
- timestamp_ms
- title
- note
- created_at
```

会議中と見返し中の両方で追加可能。

---

## 27. Timeline Marker

動画Timelineへ以下を表示できる構造にする。

```text
Chapter
Decision
ActionItem
Bookmark
ImportantPoint
```

---

## 28. Highlight Review

AIが重要区間を選び、重要箇所だけ連続再生できる。

例:

```text
24:20-25:10 認証方式決定
31:10-32:30 DB構成決定
42:00-43:15 スケジュール決定
```

UI:

```text
[全編を見る]
[重要箇所だけ見る]
```

---

## 29. Realtime

Frontend:

```text
getDisplayMedia
MediaRecorder
WebSocket
```

基本処理:

```text
画面共有
↓
MediaRecorder
↓
Media Chunk
↓
WebSocket
↓
Backend保存
↓
一定Windowごとの独立Job作成
↓
WhisperX
↓
live TranscriptVersion
```

System Audioが取得できないブラウザ・OSがあることを前提とする。

取得できない場合を可能な範囲でUIへ明示する。

録音WebSocketが通信断やBackend再起動で切れても、ブラウザは録音を止めず、未確認のメッセージとChunkを保持する。
再接続後は最初のメッセージを`resume`（録音セッションID）にして同じセッションへ戻り、確認応答のないメッセージを順番どおり再送する。
Backendは送信済みのChunk・映像Part・映像Chunkの再送を書き込まずに確認応答し、録音ファイルを二重にしない。
ブラウザが意図して閉じた場合（Close Code 1000 / 1001 / 1005）と、Backendが録音データを拒否した場合だけ、受信済みデータをすぐ確定する。
それ以外の切断では録音セッションを`recording`のまま残し、最後にデータを受信してから`REALTIME_RESUME_TIMEOUT_SECONDS`（既定600秒）再開されなければ`live-worker`が受信済みデータで確定する。
ブラウザの再接続は5分で打ち切り、送信待ちのデータが512MBを超えた場合も録音を終了する。

MediaRecorderがBackground化等で長いChunkをまとめて送信した場合は、Backend受付時に30秒の
Overlap Windowへ分割し、各Windowを独立した`transcribe_live` Jobとして保存する。あるWindowが
失敗しても後続Windowの処理を継続し、失敗した時間範囲だけを処理状況から再試行できるようにする。
WhisperXがWindowを空音声（音声Streamなし、または長さ0）と判定した場合は発言なしの正常結果として扱い、
既存Transcriptを消さず、後続WindowとRealtime解析を停止させない。
Migration前に作成済みのChunk単位JobはWorker側で従来どおり分割して再試行可能とする。

録画中に共有対象を変更できるようにする。長時間録画でBrowserの描画Loopが遅延するのを避けるため、
Canvasや`captureStream()`で映像を再描画せず、共有元の映像Trackを映像専用MediaRecorderへ直接渡す。
音声はAudioContext出力を音声専用MediaRecorderへ渡し、会議開始から終了まで連続して録音する。
映像は共有対象の変更・停止・再開ごとにPartを閉じ、新しい共有元の映像Trackで次のPartを開始する。
各Partには会議Timeline上の`start_ms`と`end_ms`を保存する。WebSocketと音声Recorderは切り替えず、
Chunk送信は`bufferedAmount`に上限を設け、長時間録画時の未送信Dataの無制限な増加を防ぐ。
共有元の映像Trackが`ended`になった場合も録画全体を自動確定せず、音声、WebSocket、
会議Timelineを維持したまま共有停止中として表示する。ユーザーは共有変更ボタンから新しい画面を
選択して同じ録画を再開でき、録画全体の終了・確定は赤い停止ボタンを押した場合にのみ行う。
共有停止中の映像が存在しない区間は、録画停止後のWorkerが黒画面として補完する。
共有元Trackは最大3840x2160・30fpsを指定し、録画ビットレートは解像度に応じて5〜24Mbps
（1920x1080では約8.3Mbps）を目標とする。映像の送信Chunk間隔は最大5秒とし、音声の間隔は変えない。
Browserが要求どおりに取得・符号化できる保証はない。
Workerは最大画素数の映像Partの縦横比を基準とし、3840x2160以内・偶数サイズのCanvasへ合成する。
小さい映像を一律1080pへ拡大せず、共有対象の縦横比が変わる場合のみ余白を追加する。
30fps、H.264 CRF18・AAC 192kbpsのMP4を連続音声とMuxしてから通常の派生ファイル生成へ渡す。
互換H.264（yuv420p / yuvj420p）は再圧縮せず映像をコピーする。
それ以外は元の解像度を保ち、必要な偶数サイズ補正のみ加えてCRF18へ変換する。
AAC音声はコピーし、他形式はAAC 192kbpsへ変換する。原本は変更しない。
既存派生動画を自動再生成する処理は行わず、既存の低画質録画で失われた情報は復元できない。
会議作成画面で共有対象を選ぶユーザー操作中にAudioContextを開始し、MediaStreamと一緒に
会議詳細へ引き継ぐ。Recorderは共有映像の最初のFrameとAudioContextのrunning状態を確認してから
MediaRecorderを開始する。最初のFrame確認に`requestVideoFrameCallback`を利用できるが、録画中の
映像生成はBrowserの描画Callbackへ依存しない。

開始時のマイク設定はチェックボックスではなくミュート切替ボタンとし、初期ミュートにする。開始前・録音中に解除できる。画面共有でマイク未取得のまま開始した場合、解除操作で権限を要求してマイクStreamを既存のAudioDestinationへ接続する。取得済みTrackは`enabled`でミュートする。既存の録音Stream・MediaRecorder・共有音声を作り直さない。マイクのみの録音は開始時に権限を要求するが、解除までTrackを無効にする。共有音声もマイクもない場合は無音状態を明示する。
マイクをミュートしても共有元のSystem Audio、録画、Chunk送信、文字起こしは継続する。
録画中の共有変更、マイク操作、録画終了はアイコンのツールバーとして横並びにし、
録画プレビューの中央へ均等な間隔で表示する。
録画中および停止後の保存中は、録画プレビュー上に録画開始からの経過時間を表示する。
共有変更ボタンと通常時のマイクボタンは常時青の単色とする。マイクのミュート中は
斜線入りマイクアイコンを白で表示し、ボタン背景を赤にして状態を常時判別できるようにする。

会議詳細上段は通常の会議情報と録画操作の2カラムを維持し、録画操作だけを過度に拡大しない。
Live TranscriptとRealtime AI解析は下段の1つの会議ノート領域へまとめ、「AI要約」「文字起こし」の
タブで切り替える。初期表示はAI要約とする。文字起こしはFinal Transcriptと同様に、時刻・話者と
読みやすい本文を発言単位で表示し、狭い画面では縦積みにする。AI要約のEvidence時刻から文字起こし
タブへ切り替え、該当するLive Segmentへ移動できるようにする。
「これまでの要約」ではEvidence時刻を表示せず、決定事項、Action Item、確認ポイント、重要情報では
根拠となる発言へ移動するため、複数のEvidenceを開始から終了までの1つの時間範囲として表示する。
時間範囲を選択した場合は先頭の根拠発言へ移動する。Evidence情報自体はBackendに保持する。

---

## 30. Realtime Timestamp

WhisperXから返るChunk内相対時刻をそのままDBへ保存しない。

```text
global_ms =
window_start_ms + whisper_relative_ms
```

として共通Timelineへ変換する。

Overlap Windowを利用する場合はTranscript重複除去を行う。
Windowの保存・再試行では、そのWindowが担当する`commit_start_ms <= start_ms < end_ms`のSegment
だけを置換する。過去Windowの再試行で後続WindowのSegmentを削除せず、必要な場合は全Segmentの
`sequence`を時刻順に再採番する。

---

## 31. Realtime Speaker

Chunkごとの:

```text
SPEAKER_00
SPEAKER_01
```

を永久的な人物IDとして扱わない。

Live Speakerは暫定。

会議終了後の全体diarization結果を最終版として優先する。

---

## 31.1 Realtime AI Analysis

Live Transcriptの更新完了直後に、`realtime_analysis`用途のAI Profileを使って暫定解析を実行する。
基本更新間隔は約30秒とする。録画終了時に新しいRealtime解析は予約せず、すでに受け付けた
Live Chunkの処理だけを完了させる。AI処理は文字起こしを
待たせない専用Workerで実行し、実行中に次のTranscriptが届いた場合は古いJobを積み上げず、
最新Revisionを直後に処理する。

表示項目:

```text
これまでの要約
決定事項
Action Item
確認ポイント（未解決、情報不足、矛盾の可能性、リスク）
重要情報
```

Realtime画面は同じ領域内で「AI要約」「文字起こし」を切り替え、AI要約を初期表示とする。
Live Transcriptは録画操作カードと分離し、Final Transcriptに近い会議ノート形式で表示する。

質問文や質問候補、現在の話題は生成しない。確認ポイントには、分かっている情報、不足している
情報、確認理由を表示する。情報不足は、会話内で必要性が明示された情報が実際に不足している場合だけ生成し、一般論から水増ししない。

WhisperXには境界精度のためOverlap Window全体を渡すが、LLMには前回Snapshot、新規・修正Segment、
削除されたEvidence ID、直前2発言のContextだけを送る。各発言には時刻と本文から決定的に作る
Realtime Evidence IDを付け、DB上のSegment UUIDがOverlap再処理で変わっても同じ発言を重複送信しない。
Overlap Window前半のContextは認識だけに使い、保存時は単語時刻を使って新規Commit範囲の本文と単語だけを
残す。単語時刻がない境界跨ぎの発言は、前半Contextの本文が再混入しないよう保存しない。
また、短い同一語句が5回以上連続し、正規化本文の65%以上を占める明らかな反復誤認識は
Live Transcriptへ保存しない。WhisperXのRaw Responseは診断用に変更せず保持する。
録画中は末尾2秒以内と最新の発言を`draft`、それ以前を`confirmed`として扱う。draftは要約の参考にできるが、
決定事項やAction Itemの確定根拠にしない。録画終了時に最新発言も`confirmed`へ更新する。

AIは差分ではなく現時点の完全なSnapshotをStructured Outputで返す。BackendはPydantic Schema、
入力Revision、Evidenceの存在を検証し、古い応答や存在しないEvidenceを保存しない。失敗時は前回の
Snapshotを維持して更新Errorを表示し、録音・文字起こしは継続する。Realtime結果を正式版として
確定しない。録画終了後の正式なAI議事録は「要約を再生成」から生成する。
Final Transcriptがなければ初回だけ全体文字起こしを作成し、以後の要約生成は保存済みFinalを使う。

GeminiのHTTP 429および一時的な5xx、通信失敗は指数バックオフで最大5回再試行する。
決定事項、Action Item、確認ポイント、重要情報は前回Snapshotを履歴として維持する。
新しい情報は末尾へ追加し、新しい発言によって誤り、変更、撤回、解決、完了が確認できた項目だけ、
AIが`superseded`で前回位置と変更を示すconfirmed Evidenceを明示して置換または削除する。
根拠のない`superseded`指示はその指示だけを破棄し、ほかの有効な更新を失敗させない。
「これまでの要約」は履歴一覧ではなく、過去と最新の重要点を統合した最大6文・800文字の
ローリング要約として更新する。BackendでもEvidenceの存在と新規性を検証してからこの規則を適用し、
AIの省略や言い換えによって過去の結果が消えたり書き換わったりすることを防ぐ。
Overlap文字起こしの補正でEvidence IDが変わった場合は、前回と現在の発言時間が十分重なるSegmentへ
SnapshotのEvidenceを付け替えてからAIへ渡し、古いEvidence IDの再利用による更新失敗を防ぐ。

## 32. 会議終了後の再処理

```text
画面共有停止
↓
最終Chunk保存
↓
会議メディア確定
↓
MediaRecorder形式にDuration metadataがない場合はDBの録画duration_msを使用
↓
Playback MP4・文字起こし用WAV生成
↓
保存済みLive版を共通会議ノートで閲覧（高精度処理は任意）
↓ ユーザーが「要約を再生成」でAIプロファイル・議事録テンプレートを選択
選択した接続先・モデル・Temperature・テンプレート定義と版をJobへ固定
↓ 保存済みFinalがない初回だけ
Final Transcription Job → WhisperX全体処理 → final TranscriptVersionを保存
↓ 保存済みFinalがあれば直接ここへ
Final AI Analysis Job（固定した選択設定を使用）
↓
新しいAnalysisVersionを保存（過去の要約・Live版は保持）
```

---

## 33. Meeting画面イメージ

会議詳細は要約を中心とする作業画面とし、画面幅にかかわらず上部Tabで表示内容を切り替える。

```text
┌─────────────────────────────────────────────────────────────────┐
│ ← 会議一覧   会議タイトル              状態  Download  AI設定   │
├─────────────────────────────────────────────────────────────────┤
│ Video / Audio Player（Tabにかかわらず常時表示）                 │
├─────────────────────────────────────────────────────────────────┤
│ [要約]  [質問]  [文字起こし]  [検索・設定]                      │
├─────────────────────────────────────────────────────────────────┤
│ AI議事録（初期表示）                                             │
│ 要約 / 決定事項 / Action Item / チャプター / Evidence           │
│                                                                 │
│ 質問Tab: 会議への質問 / 回答                                    │
│ 文字起こしTab: Transcript / Download / 修正                     │
│ 検索・設定Tab: 検索 / Bookmark / 話者名 / Timeline              │
└─────────────────────────────────────────────────────────────────┘
```

- 会議を開いた直後は「要約」を表示し、Transcriptを常時表示しない。
- Video / Audio Playerは選択中のTabにかかわらず常に表示し、録画・音声を確認しながら要約や検索を閲覧できるようにする。動画の現在時間と再生・一時停止状態は下部の操作部だけに表示し、見出し直下へ重複表示しない。
- Header、Meeting Detail、処理状況、Realtime解析と、要約・質問・検索設定を表示中の会議ノートは、ホーム画面のDashboardと同じ横幅へ統一する。ホームの最大1420pxラッパーは左右28pxの内側余白を含むため、表示コンテンツの左右端は最大1364pxを基準とする。Meeting Detailと処理状況は最大1420pxのラッパー、Realtime解析・会議ノート見出し・通常の会議ノート本体は最大1364pxとする。動画Player見出しは「MEETING VIDEO」だけを表示し、「映像を確認する」のような重複説明は表示しない。
- 1280px以上で動画の「文字起こし」を表示している間は、動画を左側へSticky表示し、右側のTranscriptをスクロールしても再生画面を見失わない構成とする。左右分割では会議ノートの最大幅制限を解除して画面左右の余白を28pxに抑え、動画側を最低640px・約56%、Transcript側を最低520px・約44%とする。
- 1280px未満では動画を上部へSticky表示する。固定中は見出しを省略し、動画高をViewportの42%以下へ制限してTranscriptの閲覧領域を確保する。
- 動画・音声はSpaceキーで再生／一時停止を切り替える。Form入力、編集可能要素、Button、Link、Modal操作中はShortcutを発火させない。
- 音声ファイルのPlayerは画面下部へ固定し、Transcriptや要約をスクロールしても、Chapter Seek、再生時間、再生／一時停止、10秒移動、再生速度、音量を常時操作できるようにする。
- 「要約」はリアルタイム解析と同様に、要約・決定事項・Action Item・確認ポイント・重要情報を
  一画面のCard一覧で表示する。チャプター・質問候補は存在する場合に同じ一覧へ追加する。
  要約Cardは横幅全体、その他は2列、狭い画面では1列で表示する。
  通常は文章として表示し、編集時だけ入力欄へ切り替える。
- 「質問」は確定Transcriptを根拠にした質疑履歴と入力欄を表示する。Evidenceは画面に表示しない。
- 「文字起こし」はTranscript、Download、Transcript修正をまとめて表示する。話者名をクリックするとその場で編集できる。
  保存した表示名は文字起こし本文、検索・設定の話者一覧、動画字幕へ即時反映する。
  PlayerとChapter SeekはTabの外で常時利用できる。
- 「検索・設定」は検索、Bookmark、話者名、Timelineを内部Tabで切り替える。
- 処理状況は完了後に折りたたみ、Transcriptまでの縦移動を短くする。
- 外部AI取り込みは狭いペイン内へ展開せず、4段階のModalでプロンプト作成、回答貼り付け、検証、保存を行う。
- Desktop、Tablet、Mobileのすべてで同じTab順序と初期表示を使用する。
- 配色、Card、Header、ButtonはHome Dashboardと同じ表示テーマ（ライト・ダーク）へ統一する。43節を参照する。
- 画面共有・マイク録音のSessionが停止済みなら、Final TranscriptやAI議事録の有無によらず録画操作CardとRealtime専用Panelを表示しない。保存したLive TranscriptとRealtime Snapshotを通常の会議ノートへ表示する。暫定版と明示し、編集・会議後質問は高精度版に限定する。「要約を再生成」に入口を統合し、Finalがない初回だけ全体WhisperX処理を開始する。完成後もLive版を保持し、版切替で文字起こしと要約を対応させる。マイク録音停止時は全体処理Jobを自動予約しない。
- 完了後のAI議事録の「履歴」では「リアルタイム解析」と各確定版Versionを選択できる。Realtime SnapshotもAI議事録と同じCard一覧UIへ変換して表示するが、暫定結果の履歴なので編集・確認済み操作は提供しない。
- Realtime履歴の「これまでの要約」には時刻を表示しない。決定事項、Action Item、確認ポイント、重要情報はEvidence全体の開始〜終了時刻を1つの範囲として表示する。

---

## 34. 処理進捗

工程ベースで表示する。

```text
✓ Upload
✓ Media preprocessing
● Transcription
○ AI analysis
○ Completed
```

WhisperXから正確な%が取れない場合、偽の進捗率は表示しない。

- 処理状況の主表示はJob種別ごとの最新実行だけとし、過去の再試行は折りたたみ式の実行履歴へ分離する。
- Headerのエラー件数は最新実行だけを対象とし、後続の成功で解消済みの過去エラーを現在の異常として数えない。
- 失敗は利用者向けの短い説明を先に表示し、Backendの`error_message`は「エラー詳細」に折りたたむ。
- 再試行操作は最新の失敗Jobだけに表示する。

---

## 35. エラー処理

最低限:

```text
Upload失敗
FFmpeg失敗
WhisperX接続失敗
WhisperX処理失敗
Ollama接続失敗
Gemini API失敗
LLM Schema Validation失敗
Storage不足
```

Jobへerror_messageを保存し、再実行可能にする。

---

## 36. Security

最低限以下を守る。

```text
WhisperX API KeyをFrontendへ渡さない
Gemini API KeyをFrontendへ渡さない
Secretをログへ出さない
Upload filenameをStorage Pathへ直接使用しない
Path Traversalを防止
MIMEと拡張子を検証
Upload Size上限を設定可能にする
任意FFmpeg引数をユーザー入力から作らない
```

### Cloudflare TunnelによるRemote Access

- Public HostnameはCaddyだけへRouteし、Backend、WhisperX、Ollamaを直接公開しない。
- Caddyは通常画面をFrontendへ、`/api`をBackendへ振り分ける。同一Originを維持しつつ、長時間接続する録画WebSocketはNext.js Rewriteを経由させない。
- Tunnelはremotely-managed Tokenを`.env`から受け取り、通常起動へ影響しないCompose profileとして動かす。
- Public HostnameはCloudflare Accessで認証し、許可した利用者だけが到達できるようにする。
- CloudflareのRequest Size上限を超えるMediaはLAN/VPN経由でUploadし、画面共有はSize上限以下のChunkとして送信する。

---

## 37. 削除

Meeting削除時は関連する:

```text
Media
Transcript
Analysis
Bookmark
Thumbnail
Clip
Job
```

も整合性を保って削除する。

将来的に:

```text
録画のみ30日後削除
Transcriptは保持
```

等へ拡張できる構造とする。

---

## 38. 実装Phase

### Phase 1: 基盤

```text
Next.js
FastAPI
PostgreSQL
Docker Compose
Meeting CRUD
Job基盤
```

### Phase 2: 音声文字起こし

```text
Audio Upload
WhisperX Client
Transcription Job
Transcript
Speaker
```

### Phase 3: 動画

```text
Video Upload
FFmpeg
Video Player
Transcript ↔ Video同期
```

### Phase 4: AI設定

```text
LLM Provider Interface
Ollama
Gemini
AI設定画面
Secret管理
AI Profile
```

### Phase 5: AI議事録・見返し

```text
Structured Minutes
Evidence
Decision
ActionItem
Chapter
検索
Bookmark
Timeline Marker
Highlight Review
```

### Phase 6: Realtime

```text
画面共有
MediaRecorder
WebSocket
Live Transcript
Final再処理
```

---

## 39. 実装原則

1. `DESIGN.md` を仕様の正とする。
2. 全データを共通Timelineで管理する。
3. DB時刻は整数msを基本とする。
4. TranscriptをVersion管理する。
5. AI AnalysisもVersion管理する。
6. AI生成情報にはEvidenceを持たせる。
7. 元Mediaを変更しない。
8. 長時間処理をHTTP Request内で待たない。
9. Provider固有処理をAnalysis Serviceへ漏らさない。
10. WhisperX固有処理をTranscription Serviceへ隔離する。
11. FFmpeg固有処理をMedia Serviceへ隔離する。
12. SecretをFrontendへ返さない。
13. AIに不明情報を推測させない。
14. AI生成情報とユーザー確定情報を区別する。
15. Realtime結果は暫定、終了後にユーザーが開始する全体処理を確定版とする。
16. 外部API Clientはテスト時にmock可能にする。
17. OS固有の絶対パスをSource Codeへハードコードしない。
18. `speak-note` 以外の既存プロジェクトを変更しない。

## 40. モバイル表示と画面共有

### レスポンシブ表示

- 320px以上の表示幅でページ全体の横スクロールを発生させない。
- 760px以下ではホームのサイドバーを上部ナビゲーションへ切り替える。
- 520px以下では会議作成、会議詳細、AI設定、質問、要約、検索・設定、手動AI取り込みを1カラム表示にする。
- モバイルの主要操作は44px以上のタップ領域を確保する。
- 560px以下の会議詳細では、プロジェクト・AI・話者数・処理状況を幅の揃った1列の設定行にする。ラベルを途中で折り返さず、選択欄は長い値でもページを広げない。保存結果やエラーは行内に収める。上部ヘッダーは会議一覧へのリンクを保持し、本文にある会議名と重複するパンくずの会議名は省略する。ダウンロード・要約再生成の操作は各行に分けて44px以上の高さにする。
- 話者数の設定はスマートフォン・タブレットで画面内に収める。録音・録画の丸い操作ボタンはアイコンを水平・垂直とも中央へ配置する。Live文字起こしと解析タブの補足・状態表示は、狭い画面で見出しや操作と行を分けて欠けないようにする。
- モーダルと固定音声プレイヤーは `100dvh` とSafe Areaを考慮する。
- 文字起こし表示中の動画は画面上部へ固定しつつ、表示高を端末画面の36%以下に抑える。

### モバイル画面共有

- 画面共有はHTTPSのSecure Contextでのみ開始する。
- ブラウザ実行時に `navigator.mediaDevices.getDisplayMedia` と `MediaRecorder` の有無を判定する。
- 対応端末ではユーザーのタップ操作から共有選択画面を開き、選択済みStreamを会議ページへ引き継いで録画を開始する。
- 非対応端末では録画開始を無効化し、端末標準の画面収録で保存したファイルを「音声・動画をアップロード」から取り込むよう案内する。
- ブラウザがシステム音声を提供しない場合もあるため、マイク音声の選択と無音警告を維持する。

## 議事録テンプレート

議事録テンプレートはAI Profileとは独立して管理し、会議作成時に選択する。テンプレートはrevisionを持ち、会議と各AnalysisVersionは作成時点の定義をJSON snapshotとして保持する。既存会議と旧AnalysisVersionは従来形式で表示できること。

テンプレートは「リアルタイム」と「確定後」の2構成を持つ。各構成は順序を持つカードの配列で、カードとフィールドは不変IDを持つ。カードは表示/非表示、並べ替え、名称変更ができ、独自カードにもフィールドを追加できる。初期フィールド型は`short_text`、`long_text`、`number`、`date`、`boolean`（値はtrue/false/null）、`single_select`とする。単一選択肢はテンプレート定義で列挙する。

AI値は根拠となるTranscript Segment IDを持ち、Segmentの存在をBackendで検証する。不明値はnullとし、発言にない値を推測しない。AI出力は固定形式の汎用envelopeで受け、テンプレート定義に照らしてID、型、選択肢を検証する。コアの要約・決定事項・タスク・章等はテンプレートで非表示でも内部データとして保持する。Realtimeはセッション開始時のsnapshotを使い続け、旧Realtime形式も読み込める。進行中の解析では既存値と安定IDを維持し、音声文字起こしを停止させない。

テンプレート編集はAI設定配下の専用画面（`/settings/templates`）に配置し、AI設定には件数・既定テンプレートの概要と編集画面への入口だけを表示する。テンプレートは会議作成・要約再生成で選択する。カードには任意のAIへの指示（最大2,000文字）を保存できる。Realtime結果・確定議事録・履歴は保存されたsnapshotのカード順で表示する。既存の4種類のsummary_formatは後方互換のため維持する。


## 41. プロジェクト単位の情報と会議中の回答支援

ユーザーの基本情報はAIモデル設定とは別の共通プロフィールとして保存する。会議は任意のプロジェクトに所属し、プロジェクトは親・子の2階層までとする。既存の未分類会議は維持する。会議作成フォームでは既存の所属先を選ぶほか、親・子プロジェクトをその場で作成して自動選択できる。プロジェクト作成と会議作成は別操作で、会議をキャンセルしても作成済みプロジェクトは残る。子は親の背景・資料・プロフィールを継承できるが、兄弟の資料は参照しない。会議の紐付け変更は過去の生成結果の根拠を遡及変更しない。

初期の資料入力はテキスト・Markdownまたは本文貼り付け。資料ごとに参照の有無と版を持つ。会議中の回答支援では、選択プロジェクトの資料、共通プロフィール、会議背景、直近の文字起こしを利用し、短い口頭回答と詳細回答を生成する。発言案と実際の発言は明確に分離して表示する。既存の会議後質問は確定文字起こしを対象とする別機能として維持する。

初期音声はChromeの画面共有音声とマイク音声の既存混合入力を使う。話者が確定しない場合は相手と断定しない。自動質問検出の誤発火を検証し、必要があればMac・WindowsのChromeで別音声チャネルを後から検討する。

**実装状況（2026-09-27）:** プロジェクト、共通プロフィール、テキスト資料、会議紐付け、親子の情報境界、回答支援を実装。既存のOllama / Geminiプロファイルを回答支援専用に選択し、資料・プロフィール・会話の送信確認を必須とする。開始時の参照資料・版・送信先・モデルをsnapshotで固定する。切替時は旧セッションを停止し、再確認する。送信先設定が後から変わった場合は生成を拒否する。

回答生成は `answer_live` Jobと専用 `answer-worker` を使用し、既存の要約・会議後質問・文字起こしQueueと分離する。新しい質問は未実行の旧Jobを取り下げ、実行中の旧回答は最新回答として採用しない。手動質問、現在の発言、明示的にONにした自動質問検出に対応する。自動回答は初期OFFで会議中にON／OFF可能。専用WorkerがONのSessionだけ監視し、更新された直近25発話・最大10,000文字の会話を選択AIへ送り、文脈から完成した回答が必要な質問か構造化判定する。最短5秒の予約間隔で、一つのSessionに未完了の判定・回答がある間は次の判定を予約しない。ブラウザのポーリングや疑問符の簡易ルールに依存しない。ONにする前の会話は文脈としてのみ利用し、新しく追加・変更された発話を質問の根拠に含める。相づち・独り言・未完の質問・回答済み質問を抑制する指示と、直近8件の生成済み質問に対する同一文面の重複防止を行う。判定結果の発話IDと対象話者をBackendで検証する。OFF・対象話者変更・Session切替後の古い判定や未送信の自動回答は採用せず、手動生成は独立して利用できる。自分・相手の厳密な識別は保証しない。候補は短い回答・詳細回答・情報不足・出典を構造化検証し、存在しない出典を拒否する。回答案と実際の発言・確定議事録は別に保持する。

初期資料検索は文字列一致による抜粋選択とし、ベクトル検索・PDF/Word・過去会議横断検索・トークン単位の回答ストリーミングは対象外。停止時は未送信Jobを送信しないが、すでにAIへ送信されたHTTP処理を撤回できるとは限らない。


## 42. 要約再生成

「高精度版を作成」と要約画面の「生成」は、共通会議ノートの「要約を再生成」へ統合する。設定ダイアログでAIプロファイルと議事録テンプレートを選び、初期値は会議の設定と保存済みテンプレートsnapshotとする。新しく選び直す場合はその時点のテンプレート版を使用する。選択は今回の生成だけに適用し、会議のAI・テンプレートやリアルタイム解析設定を変更しない。テンプレートを使用する生成ではsummary_formatの指示を重ねない。旧テンプレート未使用会議ではsummary_formatを後方互換として使用する。

要約の入力は同じ会議のcompleted Final Transcriptに限定する。activeがFinalなら優先し、なければ保存済みの最新completed Finalを使用する。Live Transcriptは入力にしない。Finalがない初回だけ、保存・動画変換完了を確認してTRANSCRIBE Jobを作成する。Final保存後にANALYZE Jobへ進み、以後のモデル・テンプレート変更は解析だけ行う。

Job.analysis_requestへ接続先・プロファイルID・モデル・Temperature・テンプレート内容とrevisionを保存する。Final待ちや再試行でもこの設定を引き継ぐ。解析履歴のtemplate_snapshotをAI指示・出力検証・表示で共通使用し、後のテンプレート編集を過去の履歴へ反映しない。選択画面のrevisionが更新されていた場合は競合を返す。予約後にモデル設定が変わっても保存したモデルを使い、接続先が変わった場合は送信せずfailedとする。Secretはsnapshotへ含めない。

受付と再試行は会議行ロックで直列化する。処理中の全体Jobがあれば新規要求を409で拒否し、同一request_idの再送には既存Jobを返す。TRANSCRIBE Jobの再開は保存済みFinalと解析継続JobのIDを確認し、WhisperXと後続解析を重複実行しない。録音・録画中および保存中には開始しない。外部API・Evidence・設定のエラーでは既存active解析を維持する。ユーザー編集・確認済み項目の保護を維持する。

DB変更は20260927_0022に続く20260927_0023でjobs.analysis_request（JSONB）とrequest_id（nullable UUID、unique）を追加する。POST /meetings/{id}/analysesはprofile_id、template_id、template_revision、request_idを受け、Final待ちの応答ではanalysisをnullとする。既存POST /meetings/{id}/transcriptは文字起こしを明示的に再処理する詳細APIとして残すが、再生成UIからは呼ばない。アップロード会議の自動処理、Live解析、会議後質問を維持する。


---

## 43. 表示テーマ（ダークモード）

ライト／ダーク／システムに合わせるの3択とし、初期値はシステム設定とする。ホーム、会議詳細、AI設定、プロジェクト、404・エラー画面でテーマを選択できる。設定はブラウザのlocalStorageへ `speak-note.theme` として保存し、会議・AI・テンプレートの設定とは独立させる。ブラウザ・端末間の同期は行わず、同じオリジンの別タブはstorageイベントで同期する。保存不可時も現在の画面では切替できる。

`prefers-color-scheme` によりOS設定へ追従し、明示的なライト／ダーク選択を優先する。初回描画前に保存設定を適用し、SSR・Hydrationで表示の不一致を起こさない。CSSにもJavaScriptなしのシステム追従を用意する。`color-scheme` とブラウザのテーマ色も更新する。切替はページ更新・API通信・録音／再生要素の再作成を行わない。

全画面の背景、カード、文字、入力、選択・Hover・Focus、処理中・成功・警告・エラー、Evidence、確認済み、暫定発言、ダイアログとそのBackdropを共通の意味別CSS変数へ集約する。各画面でテーマ変数を上書きしたり、色を直接指定しない。元映像・画像は色反転しない。映像上の字幕・録画プレビュー・操作部は固定のmedia変数を用いて判読性を維持する。音声プレイヤーと動画脇の文字起こしは選択テーマへ追従する。

スマートフォンでもテーマ選択を操作でき、見た目のラベル省略時もアクセシブル名を維持する。会議ヘッダーの高さと固定プレイヤーの位置を揃える。全CSSの色の直接指定・テーマ上書き・未定義変数をテストで検査し、通常テキストは原則4.5:1、入力境界は3:1以上の配色を確認する。ブラウザで両テーマの画面・タブ・ダイアログ・エラーと狭い画面を確認する。
