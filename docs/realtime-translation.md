# Sonioxリアルタイム翻訳

最終照合: 2026-10-12。[README](../README.md) · [会議言語](meeting-transcription-languages.md) · [反映手順](operations.md#realtime-translation)

## 設定と操作

1. AI設定の「リアルタイム文字起こし」でSonioxのキー・モデルを保存します。確定版がWhisperXでも翻訳できます。会議言語の自動判定・複数選択の条件とは独立しています。
2. 新しい画面共有・マイク会議の「会議で話す言語」を選び（英語の音声なら英語）、右側の「リアルタイム翻訳」をONにします。既定はOFFです。アップロード会議では表示しません。
3. 一方向では翻訳先を1つ選びます（ON時の初期値は日本語）。双方向では異なる言語A／Bを選びます（初期値は英語／日本語）。原文の言語ヒントと翻訳先は独立しており、どちらを変更しても他方を自動変更しません。双方向でStrictを使う場合は両方の話す言語をヒントに含めます。含められない構成ではStrictをOFFにしてください。
4. 作成前の会議ページでも「文字起こし設定」で選び直して保存できます。録音開始後は翻訳設定を変更できません。既存会議はOFFのままです。
5. 録音中は原文の下に「リアルタイム翻訳」を表示します。翻訳中の仮説は置き換え、確定した翻訳は履歴へ追加します。保存応答前は「保存待ち」、保存後は「保存済み」、拒否・送信失敗時は「保存失敗」です。
6. 録音停止後・ページ再読み込み後も、別に保存した翻訳を会議ページで確認できます。保存音声・Live原文・Final・要約・ユーザー編集済み情報は保持します。

Sonioxへ送るのは既存のリアルタイム音声です。追加のLLMや音声合成サービスは使いません。API権限は従来のLiveと同じSpeech-to-text, real-time／Temporary API keys／Model listingのAccessです。[キー権限](soniox-transcription.md#モデル一覧とapiキーの権限)。文字起こし・翻訳の利用料金や残高はSoniox側で確認してください。

## 公式仕様と保存の境界

公式[リアルタイム翻訳](https://soniox.com/docs/stt/rt/real-time-translation)、[翻訳モード・token仕様](https://soniox.com/docs/translation/stt-translation)、[WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)、[対応言語](https://soniox.com/docs/translation/supported-languages)、[モデル一覧](https://soniox.com/docs/api-reference/stt/get_models)を確認しました。

- WebSocketの設定に`translation`を追加します。一方向は`type: one_way`と`target_language`、双方向は`type: two_way`と`language_a`／`language_b`です。OFFでは送信しません。
- 翻訳tokenは`translation_status: translation`で原文と分け、`language`を翻訳先、`source_language`を原言語として扱います。`is_final`がtrueのtokenだけ保存します。途中の仮説や制御tokenを本文へ保存しません。
- 公式仕様で翻訳tokenには音声の時刻がなく、原文tokenと1対1の対応もありません。翻訳に時刻・Word・Evidence IDを作らず、再生位置のリンクも付けません。翻訳を原文やFinalへ混ぜず、AI解析・回答支援・会議後質問・要約再生成は従来の原文を根拠にします。
- 翻訳の話者表示も接続単位の暫定ラベルです。恒久的な人物IDとして扱いません。「保存済み」はDBへの保存であり、ユーザーが内容を確認・確定した意味ではありません。
- 翻訳の設定はMeetingへ保存し、録音開始時のRealtimeSessionの既存`transcription_request`へ固定します。一時キー更新・再接続は現在のMeetingではなく固定済み設定を使用します。非同期のJob設定には追加しません。
- 接続前の公式モデル情報でモード・対応言語と`one_way_translation`／`two_way_translation`を検証します。現在の連携は`all_languages`を明示したモデルを受け付け、非対応・情報不足ならキー発行と音声送信を止めます。
- 翻訳履歴は`realtime_translations`へ原文と別に保存します。Sessionとresult IDから作る一意IDで重複を防ぎ、同じIDで本文を上書きしません。Backend接続断では未確認の確定翻訳を再送し、保存応答後に再送を止めます。検証で拒否された翻訳も再送を止め、録音・原文の接続を継続します。Soniox切断時は確定済みtokenだけを残します。失敗時に過去の結果を削除しません。

## DBとDocker反映

Migration `20261012_0028`は0027に続き、Meetingのnullable JSONB設定と、Sessionへcascadeする翻訳履歴テーブルを追加します。既存会議の設定はnull（OFF）で、元音声・原文・Job・要約・認証情報を変更しません。環境変数・依存追加はありません。downgradeは翻訳設定と翻訳履歴を失うため、バックアップして処理停止後に行います。

運用DBへの0028適用とDocker反映は未実施です。[反映手順](operations.md#realtime-translation)で、録音・録画・保存・実行中Jobを終了してから反映します。

## 変更したファイル

| 役割 | ファイル |
| --- | --- |
| DB | `backend/alembic/versions/20261012_0028_realtime_translation.py`、`backend/app/models/{__init__,meeting,translation}.py` |
| Backendの設定・検証・保存 | `backend/app/schemas/{meeting,realtime,translation,transcription_language,transcription_settings}.py`、`backend/app/api/routes/{meetings,realtime}.py`、`backend/app/services/realtime/translation.py`、`backend/app/services/transcription/{languages,soniox}.py` |
| 会議設定UI・タグの高さ | `frontend/components/{meeting-language-fields,meeting-transcription-settings,meetings-manager,meeting-translation-fields}.tsx`、言語欄と翻訳設定のCSS、`frontend/app/meetings/[meeting_id]/page.tsx`、`frontend/lib/api.ts` |
| Live翻訳・表示・再送 | `frontend/lib/{soniox-speech-stream,soniox-translation,live-translation-store,recording-connection}.ts`、`frontend/components/{live-meeting-recorder,realtime-analysis-panel,live-translation-panel}.tsx`、翻訳パネルのCSS |
| テスト | `backend/tests/test_realtime_translation.py`、`frontend/lib/{soniox-speech-stream,soniox-translation,recording-connection}.test.ts`、`frontend/components/{meeting-language-fields,meeting-capture-settings,live-translation-panel}.test.tsx` |
| 文書 | `README.md`、`DESIGN.md`、`docs/{realtime-translation,soniox-transcription,meeting-transcription-languages,usage,development,operations}.md` |

言語タグ内の削除ボタンが44pxで、タグの上下の枠を加えると46pxになる問題も修正しました。タグと「言語を選ぶ」の外枠を44pxに揃え、ライト／ダークの既存配色を維持しています。

## 検証と残る確認

Backend・Frontendのテストは外部APIをmockし、APIテストのDBはSQLiteです。設定の独立・不正設定・原文と翻訳の分離・時刻を作らない保存・双方向の組み合わせ・重複と書換え拒否・再接続とACK・停止後の履歴・モデル能力の確認・UIの保存・処理中・エラー・取り込み方法変更中の操作禁止を検証します。

実Sonioxアカウント・実音声・実Safari／スマートフォン・運用PostgreSQLへの0028適用と同時要求は未検証です。反映後、英語音声→日本語の短い録音、日英の双方向、停止後の再読み込みを確認してください。既存の非同期Finalと要約再生成も別に確認します。録音中にDockerを再起動したりページを更新したりしないでください。

Soniox切断中や停止時に未確定だった翻訳は保存しません。保存音声のFinalは原文を補完し、翻訳の再処理は行いません。

| コマンド | 結果 |
| --- | --- |
| `pytest -q` | Backend全体297件成功、既存deprecation warning 7件 |
| `ruff format --check`／`ruff check`（変更した15のPython・テスト・Migration） | 成功 |
| `mypy --follow-imports=silent`（変更した12のアプリファイル） | 成功 |
| `ruff check app tests`／`mypy app` | 未変更部分の既存lint 11件・型エラー8件が残る。以前の記録と同じ |
| `node node_modules/vitest/vitest.mjs run` | Frontend全体264件・47ファイル成功 |
| `node node_modules/typescript/bin/tsc --noEmit`／`node node_modules/eslint/bin/eslint.js .` | 成功。Frontendは専用formatterなし |
| `alembic heads` | `20261012_0028 (head)`、headは1つ |
| `DATABASE_URL=postgresql+psycopg://dummy:dummy@localhost/dummy alembic upgrade 20261012_0027:head --sql` | PostgreSQL用SQL生成成功。運用DB接続・適用なし |
| Playwright Chromium（mock API＋実Component＋実CSS） | light／dark × 5画面幅 × 会議作成／設定編集 × Sonioxのみ／混在の40条件、翻訳表示10条件、失敗表示2条件の計52条件で選択・送信・枠の高さ・横overflowなしを確認 |

ブラウザ確認の画面幅は320、393、560、844、1280pxです。タグ3つと「言語を選ぶ」は外枠44pxで揃い、原文の言語変更でも翻訳設定を保持します。取り込み方法変更後の対応情報の再取得、翻訳を拒否した後の音声送信継続と無限再送の防止も回帰テストへ追加しました。
