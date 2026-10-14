# Soniox文字起こし

最終照合: 2026-10-14（録音時計とPCM取得時刻の同期、途中の話者ブロック、LiveのSoniox固定、独立した全体処理を照合）。[README](../README.md) · [操作ガイド](usage.md) · [現行構成・反映](soniox-realtime-only.md)

## 公式仕様と実装の境界

Soniox公式ドキュメントを読み、リアルタイムと非同期を独立して実装しました。

| 用途 | API／モデル | 処理場所 |
| --- | --- | --- |
| 録音・画面共有中のLive | WebSocket、`stt-rt-v5` | ブラウザの混合音声をPCMで直接送信。確定発話をBackendへ保存 |
| アップロード／録音停止後のFinal | Files + Transcriptions REST、`stt-async-v5` | 既存の通常Workerが保存音声を送信・状態確認・結果保存 |

確認した公式ページ: [モデル](https://soniox.com/docs/stt/models)、[リアルタイム仕様](https://soniox.com/docs/stt/rt/real-time-transcription)、[WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)、[WebSocket認証](https://soniox.com/docs/guides/websocket-authentication)、[一時キー](https://soniox.com/docs/api-reference/auth/create_temporary_api_key)、[非同期処理](https://soniox.com/docs/stt/async/async-transcription)、[ファイル送信](https://soniox.com/docs/api-reference/stt/files/upload_file)、[処理予約](https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription)、[結果取得](https://soniox.com/docs/api-reference/stt/transcriptions/get_transcription_transcript)、[ファイル削除](https://soniox.com/docs/api-reference/stt/files/delete_file)。モデル名やAPIの提供状況が変わった場合は公式ページと接続テストで再確認してください。

## 設定と操作

1. 最新コードのMigration 0031まで反映します。録音・録画・保存・処理中Jobが終わってから[反映手順](operations.md#soniox-realtime-only)を実行します。
2. `MASTER_ENCRYPTION_KEY`を設定済みであることを確認します。SonioxのAPI Keyは`.env`へ追加せず、画面からDBへ暗号化保存します。既存のGemini／Azureと同じ暗号化基盤です。
3. AI設定 →「リアルタイム文字起こし」にSonioxのAPI Keyを入力します。「モデル一覧を取得」を押してモデル（既定`stt-rt-v5`）を選び、「設定を保存」を押します。「接続テスト」はモデル取得と一時キー発行を確認し、音声を送信しません。必要な権限は下の表を参照してください。
4. 「アップロード・録音終了後の文字起こし」でWhisperXまたはSonioxを選びます。Sonioxの場合はAPI Keyを入力してモデル一覧を取得し、非同期モデル（既定`stt-async-v5`）とAPI Keyを別途保存し、接続テストします。同じキーを両方へ入力しても構いません。片方の保存はもう片方の選択や過去のAzureキーを変更しません。
5. 新しい会議は言語未選択（自動判定）・Strict OFFで始まります。ただし全体処理がWhisperXの場合は、共通言語設定の制約により言語を1つ選ばないと会議を作成できません。全体処理にもSonioxを選べば、自動判定・複数言語を使用できます。途中認識の表示と発話確定後の保存を確認します。共有音声とマイクは従来どおり混合され、映像の保存ON/OFFは文字起こし設定と独立です。[会議言語・Language hints・Strictの詳細](meeting-transcription-languages.md)と[用途別に分ける整理案](function-audit-20261014.md)。
6. 停止・保存完了後、「要約を再生成」でAIとテンプレートを選びます。保存済みFinalを優先し、なければ保存済みLiveから暫定要約を作ります。要約生成でSonioxへ音声を再送しません。全体処理は要約の「その他」から高精度版作成を明示して実行します。エンジン設定変更でも既存Final・生成履歴を自動更新しません。
7. 音声・動画アップロードでも、アップロード時に選んだ非同期設定でFinalが自動生成されることを確認します。AIを使う会議では、その後の解析Jobと根拠・会議後質問も確認します。

全体処理をWhisperXへ戻すと、新しい全体文字起こしJobからWhisperXを使用します。LiveはSonioxのままです。非同期Sonioxキーの削除はPUTの`clear_soniox_api_key`（全体処理をWhisperXへ切り替える同じ要求で指定）に対応します。Liveでキーを削除して使用を続ける設定は拒否します。画面にはキーの全文を表示せず、マスクだけ返します。リアルタイム用と非同期用のキーは別々に管理します。

<a id="diarization-accuracy"></a>
## 話者分離の精度優先（2026-10-13）

ユーザー指定により、Soniox Liveは`enable_speaker_diarization: true`を維持し、`enable_endpoint_detection: false`で接続します。再接続でも同じ設定です。公式は早期確定が話者分離の精度を下げると説明しており、精度を最優先する場合はendpoint detectionを使わないことを推奨しています。[公式の話者分離](https://soniox.com/docs/stt/concepts/speaker-diarization)、[早期確定のトレードオフ](https://soniox.com/docs/stt/rt/endpoint-detection)。

認識途中の原文・翻訳は引き続き表示します。Sonioxが自然に確定したtokenだけを保存し、定期的なmanual finalizeは送りません。アプリの10秒区間は既に確定したtokenの保存単位であり、Sonioxの確定を強制しません。短い発話は、話者変更・次の区間・録音停止まで保存を待つ場合があります。確定表示・保存・原文を根拠にしたAI更新は遅くなることがあります。停止時は従来どおりPCM末尾と空text frameを送り、最終応答を最大8秒待ちます。

原文・翻訳の話者Mapを共用し、確定履歴へ採用するときだけ表示番号を作成します。暫定表示では既知の番号だけ参照し、未知の話者は`SPEAKER_UNKNOWN`とします。暫定IDが1→9→2と変わっても、最初の確定発言は「話者1」から始まります。再接続では別のnamespaceを使い、前の接続の同名IDを同じ人物と断定しません。Liveと会議後のFinalの人物対応も自動では保証しません。人数指定欄は「WhisperXの話者数」と明示し、Soniox・Azureは自動判定と説明します。

この変更はFrontendだけで、追加Migration・依存・環境変数はありません。現行headは0029のままです。既存の履歴・会議設定・録音・Jobは書き換えず、新しく開始・再接続するSoniox WebSocketから適用します。録音・録画・保存を終えてから[反映手順](operations.md#soniox-accuracy)を実行します。

| 役割 | 変更したファイル |
| --- | --- |
| Sonioxの送信設定・話者表示 | `frontend/lib/soniox-speech-stream.ts`、`soniox-speech-stream.test.ts` |
| WhisperX用人数指定の説明 | `frontend/components/meeting-transcription-settings.tsx`、`meeting-transcription-settings.test.tsx` |
| 文書 | `README.md`、`DESIGN.md`、`docs/{soniox-transcription,realtime-translation,usage,development,operations}.md` |

| コマンド | 結果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run` | Frontend全体290件・50ファイル成功 |
| `node node_modules/eslint/bin/eslint.js .`／`node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `git diff --check` | 成功。Frontendには専用formatterなし |

mockで早期確定OFF・再接続への引継ぎ、暫定話者による欠番の防止、原文と翻訳の番号一致、endpointのない自然な確定・10秒区間・停止、未確定文字の保存防止、定期的な強制確定を送らないことを確認しました。暫定のspeaker 1から確定のspeaker 2へ変わる再現ケースも「話者2」ではなく「話者1」で始まります。Backend・DBを変更していないため、この変更ではBackendテスト・Migration検証を再実行していません。

実Soniox音声による話者分離精度・確定遅延、実機Safari、Docker反映は未検証です。精度向上の幅を保証するものではありません。反映後は2人以上で交互に話し、認識途中の表示、話者番号の推移、翻訳との一致、停止後の保存履歴を確認します。会議後のより安定した話者分離は、保存音声を使うFinalで確認します。

<a id="provisional-speaker-blocks"></a>
## 途中結果の話者ブロック表示（2026-10-14）

[公式のリアルタイム認識](https://soniox.com/docs/stt/rt/real-time-transcription#how-processing-works)では、非確定tokenは毎応答で置換し、確定tokenだけを一度ずつ追加します。公式の表示例も途中tokenを含めて話者変更で区切っています。[話者分離仕様](https://soniox.com/docs/stt/concepts/speaker-diarization#real-time-considerations)には追加の音声で話者判定が安定することが明記されています。

従来は途中結果を1件へまとめて先頭の話者を付けていたため、APIが別の話者を返しても確定まで前の文章につながっていました。現在は未保存の確定部分＋当該応答の途中部分を、連続した`speaker`ごとに分割して表示します。話者1→2→1は3ブロックです。本文の短縮、話者の訂正、区切りの結合、空の応答による撤回は途中配列の置換で反映し、確定履歴を変更しません。未知の途中話者には番号を割り当てず「認識中」、既知番号には「認識中・話者は暫定」と表示します。

途中表示の区切りは保存やEvidenceの境界には使いません。APIが確定したtokenだけを従来の話者・単語・時間区切りで保存し、翻訳の原文参照を維持します。切断・停止・finishedではすべての途中表示を消します。接続ごとのIDと話者Map、早期確定OFF、強制finalizeを送らない設定を保持します。Soniox自身がまだ話者変更を返していない場合には、後から分割・結合される表示が残ります。

変更ファイルは以下の17件です。Backend・DB・外部サービス・保存済み履歴は変更しません。反映と実音声の確認は[Frontendのみの手順](operations.md#soniox-provisional-speakers)を使います。

| ファイル | 内容 |
| --- | --- |
| `frontend/lib/soniox-speech-stream.ts`、`soniox-speech-stream.test.ts` | 話者ごとの途中配列、訂正・撤回・停止・再接続、確定だけの保存 |
| `frontend/lib/live-transcript-events.ts`、`live-transcript-store.ts`、`live-transcript-store.test.ts` | 途中配列の一括置換、確定履歴・ACK・旧単一途中結果の保護 |
| `frontend/components/live-meeting-recorder.tsx`、`shared-audio-recorder.test.tsx` | 配列イベントの通知、確定結果だけBackendへ送信 |
| `frontend/components/realtime-analysis-panel.tsx`、`live-transcript-dom.test.tsx` | 全途中ブロックの表示、暫定ラベル、訂正・確定時のDOMと翻訳の位置 |
| `frontend/components/answer-assist-panel.tsx`、`answer-assist-panel.test.tsx` | 「今の発言に回答」は末尾の途中ブロックを参照 |
| `README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,development,operations}.md` | 現行動作、公式根拠、検証結果、Frontendだけの反映・確認手順 |

Node 22（`/tmp/node-v22.16.0-linux-x64/bin/node`）と隔離Python環境で実行しました。

```bash
# frontend内
node node_modules/vitest/vitest.mjs run lib/soniox-speech-stream.test.ts lib/soniox-translation.test.ts lib/live-transcript-store.test.ts components/live-transcript-dom.test.tsx components/shared-audio-recorder.test.tsx components/realtime-analysis-panel.test.tsx
node node_modules/vitest/vitest.mjs run components/answer-assist-panel.test.tsx
node node_modules/vitest/vitest.mjs run
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc --noEmit
# backend内
/tmp/speak-note-shared-audio-verify-env/bin/pytest -q
# Project内
git diff --check
```

関連6ファイル76件・回答支援6件、Frontend全53ファイル353件、Backend全346件（既存の非推奨warning 6件）、ESLint・型チェック・空白検査が成功しました。Frontend専用formatterは未設定のため既存の記法に合わせて差分を確認しました。途中の話者1→2→1、話者変更と本文短縮／撤回、確定へのID維持、旧Azureの単一途中表示、原文と翻訳の保持、最後の話者への回答を検証しています。Backendの外部認識・AIはmock、DBはテスト用SQLiteです。

実Component・CSS・原文accumulatorの一時プレビューをChromiumで確認し、ライト／ダーク×幅320・393・560・844・1280・1920pxの12条件で、話者分割・訂正・確定・撤回・原文直下の翻訳・DOM保持・横はみ出しなし・page errorなしが成功しました。検証コマンドは`FONTCONFIG_FILE=/tmp/speak-note-provisional-speakers-browser/fonts.conf PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu XDG_CACHE_HOME=/tmp/speak-note-browser-font-cache /tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-provisional-speakers-browser/check.py chromium`です。一時環境のフォント設定不足は検証用fontconfigとフォントだけで解消し、アプリの設定を変更していません。

WebKitは環境の`libgles2`・`gstreamer1.0-libav`不足で起動できませんでした。これはコード／テストの失敗とは区別します。実Soniox音声による判定遅延・精度、Safari／iPhone実機、Docker反映は未検証です。稼働サービスは再起動していません。新しいMigration・依存・環境変数は追加しません。

<a id="audio-timeline"></a>
## 録音と文字起こしの開始時刻ずれ（2026-10-14）

従来は会議の時計を開始してからSonioxの一時キー・接続・Workletを準備し、その後にMediaRecorderを開始していました。この準備時間が文字起こしと保存Chunkの時刻へ加わり、音声ファイルの再生位置より文字起こしが一定量遅れる原因になります。また、最初のPCM通知を受け取った時刻から固定100msを引く推定は、ブラウザの通知待ちや短いflush末尾を正しく扱えませんでした。

現在はSonioxの準備中にPCM音声の入力を接続せず、保存用MediaRecorderと会議時計を開始してからPCMを有効化します。各frameとflush末尾に先頭sampleのAudioContext時刻を付け、録音時計へ換算します。再接続時も、最初に送信した音声を実際に取得した時刻を使います。[Sonioxのtoken時刻仕様](https://soniox.com/docs/stt/concepts/timestamps)の`start_ms`／`end_ms`と送信形式は保持し、接続ごとの取得時刻を加えて会議の整数msへ変換します。[AudioWorkletのcurrentFrame](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame)とAudioContextの時計を使うため、メインスレッドへの通知の遅れを発言時刻へ加えません。

ユーザー指定の停止済みマイク会議を読取APIで確認し、Soniox Live・保存会議時間118.012秒・音声の再生時間115.497秒を確認しました。差は2.515秒で、準備時間が含まれる不具合と整合します。ただし当時の録音開始差・生PCM時刻は保存されていないため、差の全量が各発言の正確な補正量であるとは断定しません。元音声・保存済み文字起こし・要約・Jobを変更する操作は行っていません。

この修正は更新後に新しく開始する録音へ適用します。過去の時刻を推測で変更せず、保存履歴の再処理も自動で行いません。Live版の単語位置は保存された発話区間から推定しており、この修正はその区間の時計を合わせるものです。Sonioxモデル自身のtoken時刻の精度を保証する変更ではありません。[Frontendのみの反映・確認手順](operations.md#soniox-audio-timeline)。

変更した13ファイル:

| ファイル | 内容 |
| --- | --- |
| `frontend/components/live-meeting-recorder.tsx`、`shared-audio-recorder.test.tsx` | Soniox準備後に録音時計を開始し、MediaRecorder起動後にPCMを有効化。マイク／録画／共有音声での準備遅延と失敗の検証 |
| `frontend/lib/pcm-audio-input.ts`、`pcm-audio-input.test.ts` | 入力接続の遅延開始、AudioContextと会議時計の対応、通知待ち・flush・再サンプルの検証 |
| `frontend/lib/soniox-speech-stream.ts`、`soniox-speech-stream.test.ts` | 取得時刻を使う接続ごとのoffset、短いframe・再接続・停止後の入力再開防止 |
| `frontend/public/azure-speech-pcm-worklet.js` | 各PCM frameと末尾の先頭sample時刻を保持。旧Azure向けのPCM・level・flushも保持 |
| `README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,development,operations}.md` | 原因・適用範囲・操作・検証とFrontend反映手順を更新 |

実行コマンド（FrontendはNode 22の`/tmp/node-v22.16.0-linux-x64/bin/node`）:

```bash
# frontend内
node node_modules/vitest/vitest.mjs run lib/soniox-speech-stream.test.ts lib/pcm-audio-input.test.ts components/shared-audio-recorder.test.tsx lib/azure-speech-stream-reconnect.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
# backend内
/tmp/speak-note-shared-audio-verify-env/bin/pytest -q
# Project内
git diff --check
```

関連テストは修正途中で66件成功し、最終的にはFrontend全53ファイル363件、Backend全346件（既存の非推奨warning 6件）、型チェック・ESLint・空白検査が成功しました。Frontend専用formatterは未設定で、既存の記法に合わせて差分を確認しました。準備4秒を録音時間へ含めないこと、通知が5秒遅れてもPCM時刻を使うこと、10msの短いframeと再接続、16／44.1／48kHzの再サンプル、flush末尾の時刻・音声保持、準備失敗時に録音しないこと、旧Azureの互換性を検証しています。

Chromiumの実MediaRecorder・AudioWorklet・Opus録音／デコードを使い、750msの準備待ち×合成音源16／44.1／48kHz×メインスレッド遅延0／600msの6条件を確認しました。保存音声の3つの音とPCMの取得時刻の差は3〜30msで、600ms待たされた通知でも先頭frameの取得時刻は0〜3msでした。ブラウザ検証は`FONTCONFIG_FILE=/tmp/speak-note-provisional-speakers-browser/fonts.conf PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu XDG_CACHE_HOME=/tmp/speak-note-browser-font-cache /tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-audio-timing-browser/check.py`で実行し、一時server・生成音源だけを使用しました。外部APIへ合成音を送信していません。

実マイク／画面共有とSoniox APIを組み合わせた認識・時刻精度、Safari／iPhone実機、長時間録音や端末の省電力状態、Docker反映は未検証です。旧会議についてはユーザーの指定により修復・時刻補正のUIを追加せず、保存済み会議を保持しています。追加Migration・依存・環境変数はありません。

<a id="word-boundaries"></a>
## Live原文の単語分断防止（2026-10-13）

[公式のリアルタイム仕様](https://soniox.com/docs/stt/rt/real-time-transcription#how-processing-works)ではtokenは単語の一部・単語・空白として届きます。従来の保存処理は10秒を超えたtokenの直前で区切っていたため、`Capac`と`itance`の間に訳文が入り、原文の単語が分断されることがありました。

現在は単語の続きと句読点を同じ保存区間に残し、約10秒以降の空白などで区切ります。日本語等の空白を使わない文字の区切りは維持します。話者変更・終了marker・停止は従来どおり優先し、自然に確定したtokenだけを保存します。早期確定・強制finalizeは引き続きOFFです。翻訳の表示用参照も原文の実際の区切りに従います。

変更は`frontend/lib/soniox-speech-stream.ts`と同テスト・`soniox-translation.test.ts`、`components/live-translation-panel.tsx`と同テスト、README・DESIGN・関連ガイドです。Frontend全体テスト301件・50ファイル、ESLint、型チェック、`git diff --check`が成功しました。単語・短縮形・数字と単位・アクセント・キリル／ハングル文字・句読点、話者変更、停止、翻訳の原文参照、同言語メタデータの表示と本文保持を検証しました。既存の日本語区切り・再接続・未確定結果の保護も全体テストで確認しています。Chromiumのライト／ダーク×幅320・393・560・844・1280・1920px×Live／停止後／Final履歴の36条件で文章表示・保存状態・同言語メタデータの確認表示・横はみ出しなしを確認しました。Frontend専用formatterは未設定です。

実行コマンド: Frontend内で`node node_modules/vitest/vitest.mjs run`、`node node_modules/eslint/bin/eslint.js .`、`node node_modules/typescript/bin/tsc --noEmit`、Project内で`git diff --check`。ブラウザ検証は一時プレビューに実Component・CSSをbundleしてPlaywrightで実施しました（`/tmp/speak-note-inline-translation-browser/check.py`）。

追加Migration・環境変数・依存はありません。録音と保存を終え、更新後のページで新しく開始する録音から適用します（[Frontend反映手順](operations.md#soniox-accuracy)）。過去に分断して保存した原文は、失われたtoken境界を推測して書き換えません。実Soniox音声・iPhone実機・Docker反映は未検証です。Backend・DBは変更していないため、BackendテストやMigration検証は今回再実行していません。

翻訳の言語ラベルはAPIの`source_language`（原言語）と`language`（翻訳先）を使用します。同じ言語が両方に入った場合は「日本語（原言語の判定要確認）」などと表示し、本文・言語情報・保存状態を維持します。表示中の英単語だけから原言語を推測して上書きしません。既存履歴にも同じ表示を適用します。

確認対象の会議はHTTP GETで読取を行い、保存原文の単語分断と、翻訳25件中1件の`ja`→`ja`を確認しました。会議の保存設定は自動判定・Strict OFF・日本語への一方向翻訳でした。Sonioxの生token応答は保存していないため、言語判定の原因は未確定です。録音開始時snapshotのDB直接確認はDockerアクセス権限とsudo認証が必要なため未実施で、コード障害ではありません。DB・会議設定・履歴を書き換える操作は行っていません。次回の会議で使用言語が分かっていれば、日本語・英語のヒント指定を検討します（[公式Language hints](https://soniox.com/docs/stt/concepts/language-hints)）。

## モデル一覧とAPIキーの権限

モデル一覧は保存前の入力キーで取得できます。キーの入力欄が空なら、その用途の保存済みキーを使用します。取得APIは`POST /api/v1/transcription/soniox-models`で、Backendが公式`GET /v1/models`へ問い合わせ、`transcription_mode`でリアルタイム／非同期を分けます。入力キーをURLへ含めず、モデルIDと名前だけを返し、設定やキーをDBへ保存しません。[公式モデル一覧API](https://soniox.com/docs/api-reference/stt/get_models)。

取得中は再取得と保存を無効にします。失敗・空一覧の場合は現在の選択を保持してエラーを表示します。取得した一覧に現在のモデルがなければ、自動的に別のモデルへ変更せず、モデルの選び直しを求めます。「設定を保存」を押すまで会議・録音・予約済みJobへ影響しません。

Full accessをOFFにし、用途別に以下を指定します。WriteはReadの一覧・取得に加えて作成・削除も許可します。短期キーの発行には、そのサービスの権限とTemporary API keysの両方が必要です。[公式のAPIキー権限](https://soniox.com/docs/guides/api-key-permissions)。

| Consoleの権限 | リアルタイム用キー | 非同期用キー |
| --- | --- | --- |
| Full access | OFF | OFF |
| Speech-to-text, real-time | Access | No Access |
| Speech-to-text, async | No Access | Write |
| Files | No Access | Write |
| Model listing | Access | Access |
| Temporary API keys | Access | No Access |
| Text-to-speech, real-time | No Access | No Access |
| Cloned voices | No Access | No Access |
| Usage and limits | No Access | No Access |
| Legacy API | No Access | No Access |

同じキーを両用途で使う場合は、上表の必要な権限を合わせ、Speech-to-text, real-time／Model listing／Temporary API keysをAccess、Speech-to-text, async／FilesをWriteにします。その他はNo Accessです。HTTP 401はキーの不正・削除、403は権限不足を確認します。権限変更の反映には数分かかる場合があり、開始済みストリーム・発行済み短期キーには反映されません。

## 保存・障害・再試行

- Liveは16kHz・16bit・monoの`pcm_s16le`を送信します。恒久キーはBackendに残し、録音中のSoniox Sessionに限って60秒・一回限り・最大5時間の一時キーを発行します。接続期限は開始済みのストリームを60秒で切る意味ではありません。再接続ごとに新しいキーを取得します。[一時キーの期限](https://soniox.com/docs/guides/temporary-api-keys)。
- 非確定tokenは表示用だけです。Sonioxが確定したtokenを連結し、話者変更・発話区切り・10秒区間で保存します。空白とsubwordを保持し、翻訳tokenと制御markerを本文へ含めません。接続ごとの話者番号は暫定IDです。停止時にPCM末尾をflushし、空text frameを送り、最終応答を待ちます。
- Soniox通信断は最大3回自動再接続します。認証・残高・権限エラーでは再接続を繰り返しません。録音保存用のMediaRecorder／Backend接続は独立して継続します。Soniox切断中の音声はLiveへ遡って再送せず、保存音声から非同期Finalで処理します。録音中にブラウザを更新しないでください。
- 非同期はJobの`transcription_request`に予約時のprovider／model／language／language_hints／language_hints_strict、file／transcription ID、送信状態を保存します。設定変更は予約済みJobに影響しません。Liveも開始時にSessionへ配列・Strictを固定し、短期キー更新でも同じ設定を返します。保存内容にAPI Keyは含めません。動画の変換Jobから後続文字起こしJobにも設定を引き継ぎます。旧Jobのnull設定はWhisperXです。
- pollがタイムアウトした場合や取得APIが失敗した場合は、そのJobの「再試行」で同じSoniox処理IDへ戻ります。POSTを無条件に再送しません。送信成功が不明な場合は`client_reference_id`で一覧を照合し、一致が一つだけなら再開します。これはSoniox側のunique制約ではありません。照合不能・重複時は「二重送信を防ぐため再送を停止」として失敗します。Consoleで該当Job UUIDの処理を確認してください。
- Sonioxが`error`になった処理や、復旧不能な送信では保存音声・Live・既存Final・要約を保持します。Soniox側のFile／Transcriptionは調査・再試行用に残ります。不要になったものはConsoleで、処理がcompleted／errorであることを確認してから削除します。processing中のFileを先に削除しないでください。
- 正常時はFinalをDBへcommitしてからSoniox側のTranscriptionとFileを削除します。削除に失敗してもFinalは保持し、Job checkpointの`cleanup_pending`に残します。Consoleで後から削除できます。speak-note内の元音声やDocker volumeは削除しません。
- Sonioxは最小／最大話者数指定を提供していないため、この指定はWhisperX利用時だけ適用します。Sonioxの話者分離自体は有効です。新しい環境変数・SDK依存は追加していません。

## 実装と検証

主要な変更はBackendの`services/transcription/soniox.py`・設定API／モデル／schema・Job／Worker・Liveの結果保存と一時キー発行、Frontendの`soniox-speech-stream.ts`・`pcm-audio-input.ts`・録音UI・独立した設定フォームです。初回導入のMigrationは`20261012_0026`（0025の後）、現在のheadはLiveをSonioxへ統一する`20261014_0031`です。既存Azure PCM Workletを共有し、停止時の末尾flushを追加しました。恒久キーや音声をGitへ含めません。0027は[会議言語ガイド](meeting-transcription-languages.md#実装検証)、0028・0029は[リアルタイム翻訳ガイド](realtime-translation.md)、0030・0031と全体処理との使い分けは[現行構成](soniox-realtime-only.md)を参照してください。

テストはmock HTTP／WebSocketとSQLiteのAPIテストで、設定の独立・暗号化、Sonioxのtoken連結／時刻／話者、失敗時保護、初回FinalからのAI／テンプレート引継ぎ、処理ID再利用、曖昧な送信の再送停止、重複発話の防止、停止処理、UIの保存・処理中・エラーを確認します。PostgreSQL Migrationは運用DBへ接続せずoffline SQLで検証します。

実Sonioxアカウント・課金API・Safari／実スマートフォン・長時間録音は未検証です。運用PostgreSQLへのMigration適用は、0026を下記の利用者の反映ログ、0027を[会議言語設定の反映記録](meeting-transcription-languages.md#deployment-confirmation)で確認しました。接続テストだけでは音声認識品質、残高、同時接続枠、ファイル容量制限まで保証しないため、短い実録音と小さいアップロードで両用途を確認してください。LiveはHTTPS／localhost、WebSocketとAudioWorkletに対応したブラウザが必要です。

### 利用者の運用反映ログ

記録日: 2026-10-12（日本時間）。利用者が実行したコマンドの提示ログに基づく記録です。エージェントは稼働中Dockerや運用DBを操作していません。

- `docker compose stop worker live-worker realtime-ai-worker answer-worker`で4つのWorkerが停止。
- Backendの再起動後、`docker compose up -d --wait --no-deps backend`でHealthy。
- `docker compose exec -T backend alembic current`が`20261012_0026 (head)`。
- 4つのWorkerの再開がすべてStarted。
- Frontendの再起動操作が報告されています。再起動後の状態・ブラウザ表示・Soniox接続テスト・実音声認識は未確認です。

次はブラウザを再読み込みし、上記「設定と操作」の手順でリアルタイムと非同期をそれぞれ確認します。

### 変更したファイル

| 役割 | ファイル（同じディレクトリの項目はまとめて記載） |
| --- | --- |
| DB | `backend/alembic/versions/20261012_0026_soniox_transcription.py`、`backend/app/models/{__init__,job,transcription}.py` |
| Backendの設定・接続・全体処理 | `backend/app/schemas/transcription_settings.py`、`backend/app/api/routes/transcription_settings.py`、`backend/app/services/transcription/{soniox,settings,base,processor,azure}.py` |
| Backendの予約・再利用・Live保存 | `backend/app/api/routes/{meetings,realtime,transcripts}.py`、`backend/app/services/analysis/regeneration.py`、`backend/app/services/media/processor.py`、`backend/app/services/realtime/capture.py`、`backend/app/workers/main.py` |
| Frontendの設定・再生成説明 | `frontend/app/settings/ai/page.tsx`、`frontend/components/{ai-settings-manager,async-transcription-settings,final-transcript-button}.tsx`、`frontend/components/ai-settings-manager.module.css`、`frontend/lib/api.ts` |
| FrontendのLive認識・保存 | `frontend/components/live-meeting-recorder.tsx`、`frontend/lib/{soniox-speech-stream,pcm-audio-input,live-transcript-events,live-transcript-store,recording-connection}.ts`、`frontend/public/azure-speech-pcm-worklet.js` |
| 新規テスト | `backend/tests/test_soniox_transcription.py`、`frontend/lib/{soniox-speech-stream,pcm-audio-input}.test.ts`、`frontend/components/transcription-settings-dom.test.tsx` |
| 既存テストの拡張・表示更新 | `frontend/components/{ai-profile-list,ai-settings-manager,final-transcript-button,summary-regeneration}.test.tsx`、`frontend/lib/{live-transcript-store,recording-connection}.test.ts` |
| 文書 | `README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,operations,development,summary-regeneration}.md` |

### 検証コマンドと結果

Ubuntu上の一時検証環境で実行しました。Frontendの専用formatter設定はなく、既存ESLintを使用します。

| コマンド | 結果 |
| --- | --- |
| Backend: `pytest -q` | 全体テスト230件成功 |
| Backend: `ruff format --check`（変更したPythonファイル） | 成功（既存Azureファイルの追加はmodel属性1行だけで、全体formatter対象から除外） |
| Backend: `ruff check`（Soniox・設定・予約・保存・Migration・新規テスト） | 成功 |
| Backend: `mypy --follow-imports=silent app/services/transcription/soniox.py app/services/transcription/settings.py app/api/routes/transcription_settings.py app/services/transcription/processor.py app/api/routes/realtime.py` | 5ファイル成功 |
| Backend: `ruff check app tests` / `mypy app` | 既存lint 13件／型エラー12件が残る。変更前Git版の15件／12件と比較し、新しいエラーなし |
| Frontend: `node node_modules/vitest/vitest.mjs run` | 全体テスト225件成功 |
| Frontend: `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Frontend: `node node_modules/eslint/bin/eslint.js .` | 成功 |
| Backend: `alembic heads` | `20261012_0026 (head)`、headは一つ |
| Backend: `DATABASE_URL=postgresql+psycopg://dummy:dummy@localhost/dummy alembic upgrade 20261010_0025:head --sql` | 0025→0026のPostgreSQL用SQL生成成功。DB接続なし |
| Playwright Chromium（mock API＋実Component） | light／dark × 320、393、560、844、1280pxの10条件で横overflowなし・設定選択／送信成功 |

初回の`npm run typecheck`は一時Node環境の`node-gyp/bin/node-gyp.js`不足で実行できず、npm scriptと同じTypeScript／ESLint／VitestをNodeから直接実行しました。mypyの既存cacheではinternal errorが出たため、`--cache-dir=/tmp/speak-note-soniox-mypy-cache`で再検証しました。いずれも環境問題として扱い、ソースやテストを無効化していません。

全体lintの残件はテンプレートRoute・Analysisモデル／手動取り込み／Realtime解析・Meeting schema・Azureの既存行長です。全体mypyの残件はMeeting／Analysisのdict型、Azureの数値変換、Realtimeテンプレート／解析、会議一覧SQL型、テンプレートRouteです。今回はSonioxの変更に範囲を限定しています。

### モデル一覧選択の追加変更（2026-10-12）

変更ファイルはBackendの`app/schemas/transcription_settings.py`、`app/api/routes/transcription_settings.py`、`app/services/transcription/soniox.py`、新規`tests/test_soniox_models.py`、Frontendの`components/{async-transcription-settings,ai-settings-manager,transcription-settings-dom.test}.tsx`、`components/ai-settings-manager.module.css`、文書の`README.md`、`DESIGN.md`、`docs/{soniox-transcription,usage,operations,development}.md`です。追加Migrationはなく、headは0026のままです。

- `pytest -q`: 全体244件成功。新規14件で用途による絞込・保存前キー・用途別保存済みキー・設定非更新・キー非返却・401／403／503・不正応答を確認。
- `node node_modules/vitest/vitest.mjs run`: 全体229件成功。設定画面で取得・モデル選択・保存、処理中の重複防止、失敗復旧、空一覧、用途の独立を確認。
- `ruff format --check`、`ruff check`（変更した4つのPythonファイル）: 成功。
- `mypy --cache-dir=/tmp/speak-note-soniox-models-mypy-cache --follow-imports=silent app/schemas/transcription_settings.py app/services/transcription/soniox.py app/api/routes/transcription_settings.py`: 3ファイル成功。
- `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/eslint/bin/eslint.js .`: 成功。
- Playwright Chromium: light／dark × 320、393、560、844、1280pxの10条件で、一覧取得・選択したモデルの送信・横overflowなし・ページエラーなし。

モデル取得もmock APIで検証しています。実Sonioxアカウントによるキーの権限・取得モデル一覧、実端末は未検証です。稼働中Dockerの再起動は行っていません。反映は[運用ガイド](operations.md#sonioxモデル一覧の追加を反映する場合)を参照してください。

追加変更の運用反映も、利用者の提示ログで確認しました（記録日: 2026-10-12、日本時間）。`docker compose restart backend frontend`後、`docker compose up -d --wait --no-deps backend`でBackendがHealthy、4つのWorkerがRunningです。`docker compose ps backend frontend`ではBackendが`Up 26 seconds (healthy)`、Frontendが`Up 36 seconds`で、ホスト側8001／3001からコンテナ側8001／3000への公開を確認しました。エージェントはDockerを操作していません。反映後のブラウザ表示・実キーでの一覧取得・選択・保存・音声認識は未確認のままです。
