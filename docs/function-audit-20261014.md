# 機能と設定の整合性確認（2026-10-14）

[README](../README.md) · [現行Soniox構成](soniox-realtime-only.md)

対象はコード版`20b7989`、Migration headは`20261014_0031`。AGENTS.md・DESIGN.md・README・設定画面・録音開始／再接続・各Worker・停止後の要約とテンプレート・既存テストを照合しました。今回は調査と文書の訂正で、機能の削除・API／DBの変更・Docker操作はしていません。運用DBの状態や旧セッション／未処理Jobの有無は未確認です。
同日の後続作業で、項目1の解析保存エラーは修正しました。以下の検証結果は初回調査時点の記録で、現在の修正内容・追加検証は末尾の[修正記録](#realtime-template-fix)へ分けて記載します。他の整理候補は未修正です。

## 現行の構成で保持するもの

| 用途 | 現在の実装 | 整理時の境界 |
| --- | --- | --- |
| 新しい録音・画面共有の文字起こし | Soniox固定。未設定なら開始を拒否 | WhisperX／Azureへ自動で切り替えない |
| ファイルアップロード・全体文字起こし | WhisperX／Sonioxを独立選択 | Live固定を理由にWhisperX Clientを消さない |
| 停止後の要約再生成 | Finalを優先、なければ保存済みLiveを明示して使用 | 原文を再処理しない。Live入力は暫定 |
| 全体文字起こし作成 | 要約の「その他」から別操作 | 要約再生成と区別する |
| 要約のモデルとテンプレート | JobとAnalysisVersionへ設定を保存 | 過去のsnapshot・Evidence・編集保護を維持 |
| 話者名 | 保存後、同じLive版・同じ元話者番号へ反映 | 接続世代・別版・Finalの人物を推測で統合しない |
| 会議への質問・本文編集 | Finalが必要 | Live要約ができることと区別する |
| live-worker | 旧Live Jobと、切断された録音の保存・終了処理 | Sonioxだけでも録音の終了処理に必要 |

根拠: [文字起こし設定](../backend/app/services/transcription/settings.py)、[再生成予約](../backend/app/services/analysis/regeneration.py)、[Live Worker](../backend/app/workers/live_transcription.py)、[話者名](../backend/app/services/transcription/live_speaker_names.py)。

## 優先して修正する不整合

### 1. リアルタイム解析の追加項目が返ると処理が失敗する

**調査時の優先度: 高。再現後、同日修正済み。** 修正前の[realtime.py](../backend/app/services/analysis/realtime.py)の887行で`type(value).model_validate(value)`を呼んでいました。[merge_realtime_template_values](../backend/app/services/analysis/realtime_templates.py)の返り値は辞書の一覧なので、値が1件でもあれば`type object 'dict' has no attribute 'model_validate'`になりました。

隔離したSQLiteと保存先、SonioxのLive Session、正しい追加フィールド1件・存在するEvidence IDを返すmock AIを使い、`process_realtime_analysis_job`まで実行して再現しました。通常のテストは追加値が空のため、この保存処理を通過します。音声認識そのものの不具合ではなく、AI解析の結果保存の不具合です。

後続修正では`TemplateValueOutput.model_validate`へ変換を統一し、追加項目がある初回生成・既存値を残す更新・数値0／真偽値falseを実際のProcessorまで検証する回帰テストを追加しました。既存snapshotと根拠検証を維持します。[反映手順](operations.md#realtime-template-values)。

### 2. テンプレートと「要約形式」の指定が重複している

**優先度: 高。UIと生成指示を確認済み。** [会議作成画面](../frontend/components/meetings-manager.tsx)はテンプレートの選択と同時に「標準／簡潔／詳細／箇条書き」を表示します。しかし[通常生成](../backend/app/services/analysis/processor.py)はテンプレートがあれば`summary_format`を使いません。テンプレートがある一般的な会議では「詳細」を選んでも、その指示はAIに届きません。

さらに[手動AI取り込みのプロンプト](../backend/app/services/analysis/manual.py)はテンプレートと従来形式を両方含み、通常生成と優先関係が異なります。同じ会議で両プロンプトを作成し、この違いを確認しました。[DESIGN](../DESIGN.md)の再生成仕様と[テンプレートガイド](meeting-templates.md)ではテンプレート使用時に従来形式を重ねません。

推奨: 新規会議の設定をテンプレートへ集約し、「要約形式」はテンプレートを使わない場合だけ表示するか、旧会議向けの互換設定にします。手動生成の指示も同じ優先関係へ合わせます。旧会議のDBカラム・既存履歴は削除しません。

### 3. Soniox Liveの言語選択が全体処理エンジンに制限される

**優先度: 中。再現済み。現行の設計による制限。** [languages.py](../backend/app/services/transcription/languages.py)はLiveと全体処理の共通言語設定を使います。全体処理が既定のWhisperXだと、LiveはSonioxでも自動判定・複数言語が無効になります。新しい会議UIの初期値は空配列＝自動判定なので、そのまま録音会議を作成するとAPIが422で拒否します。言語を1つ選べば作成できます。

画面には理由を表示していますが、「リアルタイムはSoniox固定」「全体処理は独立選択」という構成を理解しにくくしています。案内文にも現在選べないAzureや「リアルタイム・確定版の両方をSonioxに」という旧選択方式が残っています。また、APIで言語を省略した場合の初期値は`["ja"]`で、画面の初期値とは異なります。

推奨: Soniox Liveの会議言語ヒントと、WhisperXで全体処理する際の単一言語を分けます。録音開始時には全体処理側の制約を適用せず、WhisperXを明示して全体処理するときだけ言語を選ぶ案です。これは現行の共通設定仕様を変えるため、単なる不要コード削除として実装しません。WhisperX外部サービスの変更は不要です。

### 4. 設定しても使われない用途別AIが残っている

**優先度: 中。参照箇所を確認済み。** [AI設定](../frontend/components/ai-settings-manager.tsx)には「質問候補」「チャプター」のProfileと「AIなし」を保存する選択欄がありますが、[通常解析](../backend/app/services/analysis/processor.py)は確定議事録のProfileだけを解決し、同じ生成結果から両項目を保存します。別Profileや「AIなし」を選んでも個別の生成には反映されません。

画面の注記・READMEにも制限は書かれていますが、実際に効かない設定を操作できるため混乱につながります。リアルタイム解析／確定議事録の割り当ては使われています。

推奨: 未使用の2用途を通常の設定UIから外し、「確定議事録のAIで生成」と説明します。既存の用途設定のDB値・APIは互換性のため保持します。機能追加として用途別生成を実装する必要はありません。

### 5. Live原文がない会議の要約入口が待機のままになる

**優先度: 中。コード上で確認。** [会議詳細](../frontend/app/meetings/[meeting_id]/page.tsx)の再生成ボタンはFinalまたは非空の保存済みLiveがある場合だけ有効になります。一方で[ダイアログ](../frontend/components/final-transcript-button.tsx)と[API](../backend/app/services/analysis/regeneration.py)には、原文がなければ初回Finalを作る経路が残っています。現在の会議詳細からは、その経路を直接選べません。

音声は保存できたものの認識障害などでLive原文が残らない場合、「文字起こしの完了を待ってください」と出ても全体処理は自動で始まりません。「その他」の全体文字起こし作成が必要です。

推奨: 全体処理を要約と分離する現在の方針を保ち、原文がない場合は全体文字起こし作成への案内を表示します。APIの初回処理経路は旧クライアント等との互換性を確認してから整理します。

## コード・依存関係の整理候補

- [live-meeting-recorder.tsx](../frontend/components/live-meeting-recorder.tsx)から旧Azure実装を静的importし、その[モジュール](../frontend/lib/azure-speech-stream.ts)がSpeech SDKを静的importしています。隔離したesbuild解析ではSDKの223モジュール・828,741 bytesが録音コンポーネントのbundleへ含まれました。これは非圧縮の単独bundleで、実際のNext.js配信量や速度の測定ではありません。旧Azure Sessionを再開する場合だけ動的に読み込むのが候補です。
- Sonioxが`AzureSpeechResult`／`AzureSpeechStreamController`という型名を使い、共有PCM Workletも`azure-speech-*`という名前です。共通のストリーミング型とPCM処理へ名称を整理できます。WorkletはSonioxでも実際に使うので削除しません。
- `RealtimeTranscriptionSettings.provider`のFrontend型は旧3エンジンですが、設定APIはSoniox固定です。現在の設定型と過去Sessionのprovider型を分けると、旧設定を新規設定として扱う誤りを減らせます。AzureのDB列・過去Session／Job用enumは保持します。
- `LiveMeetingRecorder`の`hasFinalTranscript`は型と呼び出し側にありますが、Componentで使っていません。[final-transcript-button.tsx](../frontend/components/final-transcript-button.tsx)は現在、要約再生成ボタンです。未使用propsと旧役割のファイル名は小さな整理候補です。
- `REALTIME_WINDOW_MS`、`AZURE_SPEECH_*`、旧Client・Token API・Workerの文字起こし分岐は旧Session／Job向けです。既存履歴だけでなく、停止中・再開待ちSessionと未処理Jobも確認してから廃止範囲を決めます。過去Migrationは削除しません。

## 文書の不整合と今回の訂正

READMEに「Liveエンジンを選択」「両方WhisperXが初期値」「既存設定を自動変更しない」「Azureを新規設定できる」が残っていたため、現行のSoniox固定・Migration 0031へ訂正しました。live-workerの録音保存処理、Finalがない場合の明示操作、暗号化対象のSonioxも運用説明へ反映しました。.env.exampleとComposeは説明コメントだけを訂正し、変数・サービス構成・値は変えていません。

要約形式の重複、使われない用途別設定、上記の解析保存エラーは現行の制約としてREADMEへ記載しました。過去の反映ログや旧Azureガイドは削除せず、互換性の記録として残します。AGENTS.mdの「全体WhisperX処理をFinalとして優先」の記載も、現在のWhisperX／Soniox全体処理に合わせる整理候補です。今回、作業規則自体は変更していません。

## 検証結果（初回調査時点）

| 実行コマンド | 結果 |
| --- | --- |
| Backend: `pytest -q` | 335件成功、既存の非推奨warning 6件 |
| Frontend（Node 22）: `node node_modules/vitest/vitest.mjs run` | 53ファイル・340件成功 |
| Frontend: `node node_modules/eslint/bin/eslint.js .` | 成功 |
| Frontend: `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| Backend: `alembic heads` | コード上のheadは0031。運用DBへの接続・変更なし |
| Backend: `ruff check app tests` | 既存8件。テンプレートAPI／モデル、手動・リアルタイム解析、旧Azureの行長・import順 |
| Backend: `ruff format --check app tests` | 既存25ファイルに整形差分、129ファイルは整形済み |
| Backend: `mypy app --cache-dir /tmp/speak-note-function-audit-mypy` | 既存4ファイル・7件。うち`dict.model_validate`は実行時エラーも再現 |
| `python /tmp/speak-note-function-audit.py`（PYTHONPATHにbackendとbackend/tests、隔離SQLite・保存先・mock AI） | 追加項目で解析失敗、通常／手動プロンプトの優先差、Soniox Live＋WhisperXの自動判定拒否を確認。調査用scriptは一時ファイル |
| `git diff --check`・文書の相対リンク確認・設定ファイルの有効行比較 | 成功。`.env.example`とComposeの値・構成は変更なし |

既存mypy cacheではSQLiteの`attempt to write a readonly database`によるツール内部エラーが出ました。既存cacheを変更せず、一時cacheを指定して上記7件を取得しました。これはコードの型エラーと別の環境問題です。テンプレート更新の`definition=null`も確認し、Schemaによる422の拒否を確認しました。nullable型の警告だけで500が発生すると判断していません。

実Soniox／WhisperX／LLMでの認識精度、運用DB上の旧データ、実機・Docker反映は未検証です。全テストの成功だけで、上記の未修正条件も正常とは判断しません。

推奨順序は、解析保存エラーの修正 → テンプレートへの設定集約 → 未使用用途のUI整理 → 言語の用途別制約を設計 → 旧依存の遅延読み込み・型／名称の整理です。今回の文書・コメント変更だけならDockerへの反映やMigrationは必要ありません。

<a id="realtime-template-fix"></a>
## 後続修正: リアルタイム解析の追加項目保存（2026-10-14）

ユーザー指定により、項目1の不具合だけを修正しました。`app/services/analysis/realtime.py`でマージ後の辞書を`TemplateValueOutput.model_validate`へ渡し、正式なSchemaの値として保存します。同ファイルのimport順とformatterの指摘も整えました。テンプレート／Evidenceの既存検証とマージの条件は変更していません。

追加した`tests/test_realtime_analysis_template_values.py`の11ケースは、短文・長文・数値・日付・真偽値・単一選択とnullを実際のProcessorからDBへ保存し、取得APIでも確認します。更新時には新しい根拠へ対応する値だけを変更し、以前の0・false・nullとその根拠を保持します。不正な根拠・選択肢・AI障害では専用Workerの失敗処理でも以前のsnapshotを表示でき、Job再試行APIから同じ解析を成功させることを検証します。文字起こしJobは追加しません。11件は修正前にすべて同じAttributeErrorで失敗することも確認しました。

| 実行コマンド | 結果 |
| --- | --- |
| `pytest -q tests/test_realtime_analysis_template_values.py tests/test_realtime_analysis.py tests/test_analysis_templates.py tests/test_template_row_mapping.py` | 関連28件成功 |
| `pytest -q` | Backend全346件成功、既存warning 6件 |
| Frontend: `node node_modules/vitest/vitest.mjs run` | 全340件成功 |
| `ruff format --check app/services/analysis/realtime.py tests/test_realtime_analysis_template_values.py` | 2ファイル成功 |
| `ruff check app/services/analysis/realtime.py tests/test_realtime_analysis_template_values.py` | 成功 |
| `ruff check app tests` | 既存7件が残る。修正ファイルのimport指摘を解消し8件から減少 |
| `ruff format --check app tests` | 既存24ファイルに整形差分。131ファイルは整形済み |
| `mypy app --cache-dir /tmp/speak-note-realtime-template-fix-mypy` | 既存4ファイル・6件。辞書へのmodel_validateの型エラーを解消し7件から減少 |

残る型エラーには同じ解析ファイルの既存row_idマッピングの代入型1件も含みます。型チェックを無効化したり、型エラーを隠したりしていません。テンプレートと旧要約形式の重複、言語の用途別制限、未使用の用途別UI等は未修正です。

DB・環境変数・依存・Frontendコードの変更はありません。専用Workerへの反映と失敗した解析Jobの再試行は[運用ガイド](operations.md#realtime-template-values)を使用します。エージェントはDockerの再起動・運用DBへの変更・実APIでの録音／生成を行っていません。
