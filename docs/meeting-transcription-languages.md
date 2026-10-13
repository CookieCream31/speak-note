# 会議ごとの文字起こし言語

最終照合: 2026-10-13（初期値を自動判定・未選択時のタグ非表示・最後のタグ解除）。[README](../README.md) · [Soniox](soniox-transcription.md) · [反映手順](operations.md#meeting-languages)

現行ソースはリアルタイム翻訳と原文直下の表示用対応情報のMigration `20261012_0029`まで含みます。翻訳はこの言語ヒントと独立した設定です。[翻訳の操作・反映](realtime-translation.md)を参照してください。下記の0027の検証・反映ログは当時の記録です。

## 操作

1. AI設定ではリアルタイム／非同期のエンジン・モデル・API Keyを保存します。言語の入力欄はありません。
2. 「新しい会議」は未選択（自動判定）・Strict OFFで始まります。自動判定のタグは表示しません。「会議で話す言語」の「＋ 言語を選ぶ」から日本語名・英語名・ISOコード（例: フランス語／French／fr）で検索できます。日本語・英語を先頭に表示します。AI利用OFFでも文字起こし言語を保存します。
3. 明示選択した言語だけをタグと一覧のチェックで表示します。Sonioxで複数言語に対応した構成なら、言語を追加し、チェック済み行またはタグの×で外せます。最後の1つも解除でき、すべて外すと自動判定・Strict OFFに戻ります。単一言語の構成では別の言語を押すと入れ替わって一覧が閉じます。非対応のWhisperX／Azureでは使用エンジンと理由を表示するため、1言語を選んでから作成してください。既存会議の選択は保持し、新規作成Dialogは開くたびに初期値へ戻ります。
4. 必要なら「詳細設定」を開き、右側の「選択した言語に限定する」をONにします。通常はOFFを推奨します。閉じていてもStrict ON／OFFを表示します。自動判定へ切り替えるとStrictもOFFになります。
5. 録音開始前、または録音停止・保存後で初回Final予約前なら、会議ページの「文字起こし設定」でも変更して「保存」できます。保存してから録音／全体処理を開始してください。
6. 録音・保存・処理中とFinal作成後は言語変更できません。既存Finalがある「要約を再生成」は保存済みFinalを再利用し、言語・AIモデル・テンプレート変更を理由に音声を再処理しません。

この設定は話される音声の認識に使います。翻訳・AI要約の出力言語を指定する機能ではありません。会議のAI・議事録テンプレートとは独立しています。

検索欄でEnterを押しても会議作成・保存は実行しません。矢印・Home／Endで一覧の移動、Escapeや一覧外の操作で閉じることができます。スマホでは言語タグが折り返し、一覧の中だけがスクロールします。取得失敗時は選択を保持して「再取得」を表示します。録音・処理中や保存済みFinalによる言語ロック時は選択できません。

## Language hintsとStrict

| 設定 | 動作 | 使用例 |
| --- | --- | --- |
| 自動判定 | `language_hints`を送らない | 使用言語が不明 |
| 日本語・Strict OFF | `language_hints: ["ja"]`、他の言語も認識可能 | 日本語中心で英単語も含む |
| 日本語＋英語・Strict OFF | `language_hints: ["ja", "en"]` | 両言語を話す会議 |
| 日本語・Strict ON | `language_hints: ["ja"]`、`language_hints_strict: true` | 確実に日本語だけで、別言語・文字体系への誤認識を抑えたい |

Language hintsは指定言語へ認識を寄せるヒントです。Strictは指定言語をさらに強く優先しますが、完全な保証ではありません。単一言語が最も安定し、複数言語のStrictは精度が不安定になる場合があります。[公式Language hints](https://soniox.com/docs/stt/concepts/language-hints)、[公式Language restrictions](https://soniox.com/docs/stt/concepts/language-restrictions)。

Sonioxではリアルタイム／非同期の両APIへ同じ形式の設定を送ります。モデルの対応言語とStrict対応は公式モデル一覧の`languages`／`supports_language_hints_strict`を音声upload／一時キー発行前に確認します。未対応なら音声を送らずエラーにします。現在のモデル情報の確認にもModel listingのAccess権限が必要です。[公式モデル情報](https://soniox.com/docs/api-reference/stt/get_models)、[WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)、[非同期API](https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription)。

現行WhisperX / Azure連携は単一言語を使います。使用するエンジンにWhisperX／Azureがある場合、UIでは自動・複数言語を選べず、APIでも拒否します。アップロードでは非同期エンジンだけを判定します。StrictはSonioxの処理にだけ適用し、Sonioxがない構成では新規指定できません。AzureはISOコードを既定ロケールへ変換します（日本語→ja-JP、英語→en-US、ポルトガル語→pt-BR等）。モデル・リージョンによる対応制限は外部APIのエラーとして表示します。[Azure公式言語一覧](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt)。既存WhisperXサービスの言語設定は変更していません。

## 保存と互換性

- Meetingの`transcription_language_hints`は配列です。`[]`は自動、`null`は既存会議の従来の用途別設定を維持する状態です。新規作成APIの省略時は`["ja"]`。Strictの既定はfalseです。
- 既存会議は「従来の設定を維持」と表示し、明示的に選び直すまではSoniox／Azureの既存言語、WhisperXの環境設定を使用します。AI設定の旧言語項目はDBとAPIの互換性のため保持しますが、フォームでは変更しません。PATCHでnullへ戻すことはできません。
- Live開始時にモデル・単一言語の表示値をTranscriptVersionへ、配列・StrictをRealtimeSessionの`transcription_request`へ固定します。再開・短期キー更新・再接続でも同じ設定を使います。WhisperXのLive Workerも保存済みLive版の言語・モデルを使用します。
- 非同期処理は予約時のエンジン・モデル・言語・配列・StrictをJobの既存`transcription_request`へ保存し、動画変換から文字起こし・AI解析への引き継ぎと再試行で維持します。現在のMeetingや共通言語をWorkerで読み直しません。checkpointに認証情報を保存しません。
- 更新・録音開始・全体処理予約はMeetingのrow lockを使います。録音／finalizing Session、保存／処理中状態、queued／runningの関連Job、完成済みFinalを確認して言語変更を拒否します。
- 過去のLive／Final／要約、ユーザーの編集・確認済み情報を変更・削除しません。Finalがなければ保存音声を全体処理し、リアルタイム文字起こしをFinalの入力へ置き換えません。外部障害時のJob失敗・同じ処理IDでの再試行・Evidence検証は従来どおりです。

Migration `20261012_0027`は0026に続きMeetingの2カラムとRealtimeSessionのnullable JSONBを追加します。既存Meetingの配列とSession snapshotはnull、Strictはfalseとし、既存TranscriptとJobを変更しません。downgradeは今回の設定・Live snapshotを失うため、処理を止めてバックアップした上で行います。運用DBへの適用は[利用者の提示ログ](#deployment-confirmation)で確認しました。

## 動作確認

1. リアルタイム・非同期を両方Sonioxにし、新しいマイク会議で英語・Strict ONを選んで短い英語音声を録音します。別の日本語会議の言語が変わらないことも確認します。
2. 録音中は会議ページの言語が無効で、AI設定の共通モデルを変更しても開始済みLiveの設定が変わらないことを確認します。録音中にページを更新・Dockerを再起動しないでください。
3. 停止・保存完了後、初回「要約を再生成」でAI・テンプレートを選びます。Finalと要約が保存され、Live版も残ることを確認します。
4. もう一度AI／テンプレートを変えて再生成し、文字起こしJobが増えずFinalを再利用することを確認します。Final作成後は言語変更できません。
5. 新しい会議で自動、日英の複数言語、WhisperXの単一言語、アップロードでも確認します。モデルがStrict非対応なら音声送信前にエラーになることを確認します。

## 実装・検証

2026-10-13の初期値・タグ表示の変更はFrontendだけです。`meetings-manager.tsx`が空配列を保存し、`meeting-language-fields.tsx`が選択済み言語だけを表示します。API項目省略時の日本語既定値・既存会議のnull互換性・エンジンの対応条件は維持しています。追加Migration・環境変数はありません。

`vitest run components/meeting-language-fields.test.tsx components/meeting-capture-settings.test.tsx`は30件成功。対象ファイルのESLint・`tsc --noEmit`・`git diff --check`も成功しました。Chromiumは2テーマ×6幅（320・393・560・844・1280・1920px）の12条件で初期表示・言語の追加／最後の解除・横はみ出しなしを確認し、WhisperXの自動判定非対応と明示選択も確認しました（合計13条件）。iPhone実機・実音声認識・Docker反映は未実施です。現行Composeはソース共有なので、録音・保存完了後のブラウザ再読み込みで確認できます。

| 役割 | 変更ファイル |
| --- | --- |
| DB・schema | `backend/alembic/versions/20261012_0027_meeting_transcription_languages.py`、`backend/app/models/{meeting,realtime}.py`、`backend/app/schemas/{meeting,transcription_settings,transcription_language}.py` |
| 設定・予約・固定 | `backend/app/services/transcription/{languages,settings,soniox}.py`、`backend/app/api/routes/{meetings,realtime,transcription_settings,transcripts}.py`、`backend/app/services/{realtime/capture,media/processor,analysis/regeneration}.py` |
| UI・Live送信 | `frontend/components/{meeting-language-fields,meeting-transcription-settings,meetings-manager,ai-settings-manager,async-transcription-settings}.tsx`、言語欄と文字起こし設定のCSS、`frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/{api,soniox-speech-stream}.ts` |
| テスト | `backend/tests/{test_meeting_transcription_languages,test_soniox_transcription}.py`、`frontend/components/{meeting-language-fields,meeting-capture-settings,ai-settings-manager,transcription-settings-dom}.test.tsx`、`frontend/lib/soniox-speech-stream.test.ts` |
| 文書 | `README.md`、`DESIGN.md`、`docs/{meeting-transcription-languages,soniox-transcription,usage,operations,development}.md` |

検証はUbuntuの一時Python／Node環境で行いました。

| コマンド | 結果 |
| --- | --- |
| `pytest -q` | Backend全体278件成功、既存deprecation warning 7件 |
| `ruff format --check`／`ruff check`（変更Python・新規Migration・テスト） | 成功 |
| `mypy --follow-imports=silent`（変更した14のアプリファイル） | 成功 |
| `ruff check app tests`／`mypy app` | 未変更部分の既存lint 11件・型エラー8件が残る。変更前Git版は13件／12件で、新規エラーなし |
| `ruff format --check app tests` | 未変更の27ファイルに既存整形差分が残る。変更前Git版も27ファイル |
| `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `node node_modules/eslint/bin/eslint.js .` | 成功（Frontendは専用formatterなし） |
| `node node_modules/vitest/vitest.mjs run` | Frontend全体244件成功 |
| `alembic heads` | `20261012_0027 (head)`、headは1つ |
| `DATABASE_URL=postgresql+psycopg://dummy:dummy@localhost/dummy alembic upgrade 20261012_0026:head --sql` | PostgreSQL用SQL生成成功、DB接続なし |
| Playwright Chromium（mock API＋実Component＋実CSS） | light／dark × 320、393、560、844、1280px × 会議作成／設定編集の20条件で横overflowなし、選択・送信・右側スイッチ・エラー表示を確認 |

テストは会議別設定・既定値・不正指定の拒否・処理中変更禁止・一時キー更新時の固定設定・単一言語エンジン・初回Finalへの選択AI／テンプレート引継ぎ・Final再利用・障害時履歴保持・再試行・自動時hints省略・モデル能力の検証・UIの選択／保存／連打／処理中／エラーを確認します。

実Soniox API・実音声・Safari／実スマートフォン・PostgreSQLでの同時要求は未検証です。エージェントはDockerや既存サービスを操作していません。運用PostgreSQLへの0027適用は、下記の利用者の提示ログで確認しました。最初の通常shell実行はサンドボックス起動エラーでしたが、承認付き実行で検証しています。

### 言語選択UIの改善（2026-10-12）

`frontend/components/meeting-language-fields.tsx`とCSS、`meeting-language-fields.test.tsx`、会議作成の`meeting-capture-settings.test.tsx`を更新しました。文書はREADME・DESIGN・このガイド・usage・development・operationsを更新しています。この表示改善時点のheadは0027でした。現在のソースはリアルタイム翻訳と表示用対応情報の0028・0029も含みます。[最新の反映手順](operations.md#realtime-translation)。

| コマンド | 結果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run` | Frontend全体248件・45ファイル成功 |
| `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `node node_modules/eslint/bin/eslint.js .` | 成功。専用formatterはなく既存ESLintを使用 |
| Playwright Chromium（mock API＋実Component＋実CSS） | light／dark × 320、393、560、844、1280px × 会議作成／詳細 × Sonioxのみ／混在の40条件で選択・送信・Strict表示・右側スイッチ・横overflowなしを確認 |
| `git diff --check` | 成功 |

検索名・ISOコード・全角英字、選択済みチェック・タグの解除、最後の1言語の保護、単一言語の置換、自動判定への明示切替とStrict OFF、制限理由、キーボード操作・日本語IME変換・フォーカス復帰、処理中・Finalロック・取得再試行・保存障害を確認します。検索Enterでは会議作成・保存を送信せず、詳細設定が閉じていてもStrict ONを確認できます。

実Soniox API・実音声・Safari／実スマートフォンと運用画面は未確認です。Backendは変更していないため、このUI変更ではBackendテストを再実行していません。途中の編集は利用上限で自動承認レビューを完了できず未適用でしたが、再開後に通常の差分編集で適用・検証を完了しました。コードの不具合による編集失敗ではありません。エージェントはDockerを再起動していません。

<a id="deployment-confirmation"></a>
## 利用者の運用反映ログ

記録日: 2026-10-12（日本時間）。利用者が実行したコマンドの提示ログに基づく記録です。

- `docker compose stop worker live-worker realtime-ai-worker answer-worker`で4つのWorkerがすべてStopped。
- Backendの再起動後、`docker compose up -d --wait --no-deps backend`でHealthy（7.5秒）。
- `docker compose exec -T backend alembic current`が`20261012_0027 (head)`。
- `docker compose up -d --no-deps worker live-worker realtime-ai-worker answer-worker`で4つのWorkerがすべてStarted。
- 初回の`docker compose restart frontend`の提示ログはRestarting表示まででした。後続の言語UI変更後のログで、下記のとおり再起動後のUpを確認しました。

録音・録画中でなければブラウザを再読み込みし、「新しい会議」の言語選択、AI設定の言語欄の廃止、会議ページの文字起こし設定を確認してください。画面表示・Soniox接続・実音声認識はこのログだけでは確認できないため、[動作確認](#動作確認)の短い録音と再生成で確認します。

### 言語選択UI変更後のFrontend起動確認

記録日: 2026-10-12（日本時間）。利用者が実行した`sudo docker compose restart frontend`に続く`sudo docker compose ps frontend`の提示ログで、`speak-note-frontend-1`の`Up 5 seconds`と公開ポート`3001 -> 3000`を確認しました。

このログはFrontendの起動確認です。新UIの表示・検索・選択・保存や実音声認識は未確認で、録音・録画と保存の完了後にブラウザを再読み込みして[操作](#操作)を確認します。エージェントはDockerを操作していません。
