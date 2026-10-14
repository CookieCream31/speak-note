# speak-note

録音・動画・画面共有から、文字起こしと根拠付きのAI議事録を作るWebアプリです。
確定版の文字起こし・話者分離にはWhisperXまたはSoniox非同期API、要約・質問回答にはOllama / Geminiを使用します。
録音中のリアルタイム文字起こしはSonioxを使用します。ファイルアップロード・録音終了後の全体文字起こしはWhisperXまたはSonioxから選べます。

最終照合: **2026-10-14**（文字クリックによる再生を単語の先頭の0.1秒前へ修正し、分割された英単語と単語時刻のない旧履歴を確認。ユーザーの確認に基づき再生ハイライトを固定で0.1秒早め、同期設定UIを廃止。短い単語間と空白tokenによる再生ハイライトのちらつきを抑制。Soniox Liveの単語・subword時刻の保存と再生追従を追加し、非同期Soniox・WhisperXの同じ再生経路を検証。Soniox録音の開始準備時間とPCM通知遅延が再生時刻へ混入する問題を修正。Sonioxの途中結果を話者ごとに分割し、公式仕様に沿った置換・確定・保存と表示を照合。Realtimeテンプレート追加項目の保存不具合を修正し、回帰テストとWorker反映手順を更新。[機能・設定の整合性確認](docs/function-audit-20261014.md)、Soniox固定後の旧説明・Workerの役割・生成設定の制約を訂正。再生設定、録音UI、言語、保存済み原文からの要約、話者名、現行Migration 0031、Git運用・新規環境の導入手順を照合）。この文書は現在のソースコードとCompose設定を説明します。機能ごとの検証と過去の反映ログは関連ガイドへ記録しています。
外部APIの実接続、認識精度、すべての端末での動作を保証するものではありません。

2026-10-14の追加照合: 「AI設定」の画面名・入口を「設定」へ統一し、表示テーマを設定画面の先頭へ移動しました。会議詳細のヘッダーにも「新しい会議」を追加し、録音・録画の画面では設定と会議作成を別タブで開きます。[変更・検証・反映](docs/settings-navigation.md)。

今後の機能追加・修正では毎回、実装とこのREADMEを照合し、操作・構成・設定・制約などの説明に影響する変更を同じ作業で反映します。詳しい作業ルールは[AGENTS.md](AGENTS.md)と[開発ガイド](docs/development.md)を参照してください。

## はじめに読むもの

| 文書 | 役割 |
| --- | --- |
| [README（この文書）](README.md) | 概要、起動、現在できること、注意点 |
| [AGENTS.md](AGENTS.md) | 人間・AIエージェントの作業範囲と安全ルール |
| [CLAUDE.md](CLAUDE.md) | Claude Code向けの入口。AGENTS.mdを読み込み、リデザインの進め方を示す |
| [DESIGN.md](DESIGN.md) | 仕様の正。変更前に対象機能の設計を確認する |
| [開発ガイド](docs/development.md) | 実際のコード配置、変更箇所、テスト、引き継ぎ |
| [運用ガイド](docs/operations.md) | Dockerへの反映、環境変数、HTTPS、障害調査 |
| [操作ガイド](docs/usage.md) | 会議作成、設定、再生、Live / Finalの使い分け |
| [設定と会議作成の入口](docs/settings-navigation.md) | 表示テーマの移動、会議詳細の作成ボタン、検証と反映 |
| [議事録テンプレートガイド](docs/meeting-templates.md) | テンプレートの管理、会議ごとのsnapshot、表示 |
| [要約再生成の実装・検証記録](docs/summary-regeneration.md) | 変更ファイル、テスト結果、未検証事項 |
| [機能・設定の整合性確認（2026-10-14）](docs/function-audit-20261014.md) | 未修正の不具合、使われない設定、残す互換処理と整理の優先順位 |
| [共有音声録音の実装・検証記録](docs/shared-audio.md) | 映像を保存しない録音、テスト、Migration 0025 |
| [Soniox文字起こし](docs/soniox-transcription.md) | リアルタイム／非同期の設定、公式仕様、再試行 |
| [会議ごとの文字起こし言語](docs/meeting-transcription-languages.md) | 自動判定・言語ヒント・Strict、互換性、Migration 0027 |
| [リアルタイム翻訳](docs/realtime-translation.md) | Sonioxの一方向・双方向翻訳、原文直下の表示、保存とMigration 0028・0029 |
| [表示テーマガイド](docs/dark-mode.md) | ダークモード、設定の保存、全画面の対応範囲と検証 |
| [リデザイン実装ガイド](docs/redesign.md) | 画面デザイン変更の段階・配色・レイアウト（未実装の計画。モックアップは `docs/redesign/mockups/`） |

## バージョン管理

このディレクトリはGitの `main` ブランチで管理します。現在の実装を初回の基準点とし、今後は機能・修正ごとにコード、テスト、必要なREADME・docs更新をまとめてcommitします。作業前後に既存変更を確認し、対象ファイルだけを追加して差分・秘密情報・検証結果を確認します。詳しい手順は[Git運用ガイド](docs/git-workflow.md)を参照してください。

`origin` はSSHの `git@github.com:CookieCream31/speak-note.git` です。初回commitはGitHubの `origin/main` にpush済みです。このリポジトリ専用のDeploy keyを書き込み許可で登録しており、以降は機能単位のcommitをpushします。`.env`、録音・録画、DB、生成物、古い `.orig` バックアップは追跡しません。認証情報をソースに書き込まないでください。

DESIGNの「推奨ディレクトリ」「実装Phase」は設計上の説明を含みます。
実ファイルの場所は開発ガイドを参照し、仕様と実装の差を見つけても独断で仕様変更しないでください。

## 現在の機能

| 分野 | 実装されている内容 |
| --- | --- |
| 取り込み | ホーム・会議詳細の「新しい会議」から3つの方法（音声・動画をアップロード、画面共有、マイク音声を録音）を選択。画面共有内で映像の録画をON/OFFでき、OFFでは共有音声とONにしたマイク音だけを保存 |
| 会議管理 | 一覧・詳細からのタイトル変更、検索、並べ替え、お気に入り、タグ、複数選択の一括操作、親子2階層のプロジェクトと会議の紐付け |
| 文字起こし | SonioxのLive文字起こし、WhisperX / Sonioxのアップロード・会議後の確定版、話者名・本文の編集、テキスト出力。過去のLive履歴も保持 |
| 再生 | 音声・動画ダウンロード、文字単位の追従、シーク、画質・字幕設定、設定と同じ形式の速度選択メニュー、全画面。動画設定は半透明の一覧メニューから画質・字幕を個別に変更でき、選択画面は内容に合わせて滑らかにサイズが変わります |
| 表示 | 「設定」の「表示テーマ」でライト／ダーク／システムに合わせるを選択。ブラウザごとに保存し、ホーム・会議詳細・設定・プロジェクト・404／エラー画面へ適用 |
| AI | Ollama / Gemini接続、プロファイル一覧・デフォルト選択、構造化議事録、生成履歴、会議テンプレート。AIが存在しない根拠IDや文字起こし範囲外の時刻を返した場合は一度だけ修正を求めて再生成し、再び不正なら失敗にします（その場合AI利用料・処理時間は最大2回分） |
| 見返し | 根拠から再生、会議への質問、全文検索、Bookmark、チャプター、重要区間の連続再生 |
| 手動AI連携 | 外部AI用プロンプト出力、回答JSONの検証・取り込み（自動送信はしない） |
| プロジェクト情報 | 共通プロフィール、プロジェクトの背景、テキスト・Markdown資料の保存・参照対象の切替 |
| 回答支援 | 会議中の発言案、独立したAI選択、手動/任意の自動質問検出、詳細・根拠・生成履歴 |

会議開始時のマイクは初期ミュートです。開始前のボタンでONにするか、会議中にミュート解除できます。画面共有でミュート開始した場合は、解除時にマイク権限を要求して既存の録音へ音を追加します。共有音声はマイクのミュートに影響されません。マイクのみの録音でも解除まで無音です。

設定の「リアルタイム文字起こし」にSonioxのキー・モデルを保存してください。キー未設定では録音を開始せず設定を案内します。「アップロード・録音終了後の文字起こし」はWhisperX／Sonioxを選べ、選択・モデル・キーを別々に保存します。WhisperXは既存のWhisperX API Serverを利用します。録音後の全体処理は要約の「その他」から明示して開始し、要約だけの再生成では保存済み原文を再処理しません。Migration 0031はLiveの既存エンジン設定をSonioxへ変更し、キー・履歴・非同期設定・予約済みJobを保持します。[設定・反映・検証](docs/soniox-realtime-only.md)を参照してください。

Sonioxの途中結果は、APIが返す話者の切替ごとに別ブロックへ表示し、文章や話者の訂正・撤回を応答ごとに反映します。既知の話者番号には「認識中・話者は暫定」を添え、未知の話者は番号を増やさず「認識中」と表示します。確定した結果だけを保存し、精度優先の早期確定OFFを維持します。Soniox自身の話者判定が遅れる場合は、後から分かれたり結合されたりすることがあります。[公式仕様・検証](docs/soniox-transcription.md#provisional-speaker-blocks)と[Frontend反映手順](docs/operations.md#soniox-provisional-speakers)を参照してください。

Sonioxの接続・音声処理の準備を終えてから、保存用録音と会議の時計を開始します。PCMの取得時刻を会議時刻へ換算し、APIのtoken時刻を加えるため、開始準備やブラウザへの通知待ちを文字起こしの時刻へ加えません。この修正は更新後に開始する録音へ適用し、既存の保存時刻を推測で変更しません。[時刻ずれの修正・検証・制約](docs/soniox-transcription.md#audio-timeline)と[Frontend反映手順](docs/operations.md#soniox-audio-timeline)を参照してください。

新しく録音するSoniox Liveでは、確定tokenの単語・単語の一部ごとの開始／終了時刻も保存します。停止後の再生はその時刻を使い、発話の間や話す速度の変化に合わせて文字を追従します。Soniox非同期のFinalも公式APIのtoken時刻を既存の単語テーブルへ保存して同じプレイヤーで使えることを確認しました。WhisperXの単語追従も保持します。時刻のない旧Liveや本文編集後は従来の発話区間による推定表示です。[公式仕様・検証・制約](docs/soniox-transcription.md#word-timing-playback)と[Backend・Frontendの反映手順](docs/operations.md#soniox-word-timings)を参照してください。

再生ハイライトは同じ発話の短い単語間で直前の表示を保持し、空白だけ・表示時間0のtokenによるちらつきを抑えます。長い無音・別の話者・発話の最後では解除し、保存時刻や再生位置は変更しません。この表示改善は再読み込み後の既存会議にも適用され、録音し直す必要はありません。[修正・検証](docs/soniox-transcription.md#playback-flicker)と[Frontendのみの反映](docs/operations.md#transcript-highlight-flicker)を参照してください。

再生ハイライトは固定で0.1秒早めて表示し、自動スクロールもその文字位置へ合わせます。「同期」ボタンと設定画面は廃止し、以前保存した会議ごとの補正値は使用しません。この表示補正は音声の再生時刻・字幕・チャプター・保存済み単語時刻へ適用しません。再読み込み後の既存会議と新しい会議、音声・動画、リアルタイム版・高精度版に共通で適用します。[実装・検証](docs/soniox-transcription.md#playback-fixed-lead)と[Frontend反映手順](docs/operations.md#transcript-display-sync)を参照してください。

文字起こし本文をクリックすると、途中の文字でもその単語の先頭の0.1秒前から再生し、冒頭が切れるのを抑えます。Sonioxで英単語が複数tokenへ分割されていても単語の先頭へ戻します。単語時刻のない旧履歴・本文編集後は文字位置から推定した時刻の0.1秒前です。時刻ボタン・Evidence・チャプターのシーク先は従来どおりです。既存会議にも再読み込みで適用し、録音・文字起こしの再処理や設定操作は不要です。[修正・検証・制約](docs/soniox-transcription.md#transcript-click-start)と[Frontend反映手順](docs/operations.md#transcript-click-start)を参照してください。

会議作成の「映像を録画する」と「AIを使う」は、タイトル・説明が左、スイッチが右の共通UIです。アップロードの「文字起こし後にAI要約を自動作成する」も同じ配置です。スマートフォンでは説明を折り返し、スイッチを右側に保ちます。

映像が不要な場合は「画面共有」を選び、その中の「映像を録画する」をOFFにして、共有ダイアログで音声共有を有効にします。録画スイッチの初期値はONで、新しい会議を開くたびにONへ戻ります。切替時も選択済みの共有画面とマイク設定を保持します。作成後は方式を固定し、録音中に映像保存へ切り替えません。OFFでは映像を保存・送信せず、共有音声とONにしたマイク音声を1つの音声として保存し、Live文字起こし・解析・回答支援に使用します。停止後の「要約を再生成」は保存済み文字起こしを使います。Finalがなければ保存済みLiveから暫定要約を作り、高精度版の文字起こしは詳細操作から追加できます。ブラウザ・OS・共有元によって音声共有の対応が異なり、音声を取得できない場合は開始しません。ブラウザ上は画面共有の許可が必要です。詳しい[操作手順](docs/usage.md#shared-audio)と[Migration 0025の反映手順](docs/operations.md#shared-audio)を確認してください。会議作成の取り込み方法の選択・録画スイッチ・ホームの作成入口の整理はFrontendの変更で、追加のMigrationはありません。

2026-10-11受領のユーザー提供ログで、運用DBの`20261010_0025 (head)`、BackendのHealthy、4つのWorkerのStartedを確認しました。Frontendの再起動実行ログも確認しましたが、再起動後の稼働状態と実録音・要約生成は未確認です。[反映状況の記録](docs/shared-audio.md#反映状況)を参照してください。

画面共有録画は最大4K・解像度別ビットレートで取得し、対応H.264動画の再圧縮を避けます。
実際の画質は共有元・ブラウザ・端末性能に依存し、過去の低画質録画は自動復元されません。
画質選択（元動画 / 互換MP4）と字幕設定の詳細は[操作ガイド](docs/usage.md)を参照してください。歯車メニューの各行を押すと選択肢へ進み、選択後や「戻る」でもメニューを開いたまま操作できます。項目を押すと閉じてしまう問題を修正しました。[反映・確認手順](docs/operations.md#player-settings)。

会議詳細のタイトル横の鉛筆から、作成後もタイトルを変更できます（前後の空白を除いて1〜200文字）。保存後は見出し・パンくず・一覧へ反映し、再生や録音を続けられます。通信失敗時は入力を保持して再試行できます。一覧の「…」からも編集できます。

動画・音声の「1×」などの速度表示を押すと、設定と同じ形式のメニューから0.5〜2倍を選べます。現在の選択にはチェックを表示し、外側クリック・Escapeで閉じます。ライト／ダークと狭い画面に対応します。この変更はFrontendのみで、DB変更や新しい環境変数はありません。現行の開発Composeではソースを共有しているため、録音・録画停止後のブラウザ再読み込みで反映を確認でき、Docker再起動は不要です。

音声プレイヤーの再生／一時停止は44pxの円形アイコンボタンです。左右の操作領域を同じ幅にしてバー全体の中央へ固定します。ダウンロードボタンの有無や画面幅で中央がずれません。時間は左側だけに表示し、中央の「再生中／一時停止」と時刻の重複表示はしません。再生中は一時停止アイコンに切り替わり、読み上げラベルも現在の操作に合わせて更新します。再生エラーは別行に表示し、スマートフォンでも確認できます。

動画・音声のシークバーには、現在位置を示す丸いマーカーを共通の差し色で表示します。チャプターの区切りを保ち、再生・一時停止・シークに追従します。長さが不明な間はマーカーを表示しません。ホバー・キーボードフォーカス時のチャプター名と時刻は縦横に拡縮せず表示します。長い名前は枠内で折り返し、先頭・末尾の表示はバーの端に揃えます。

プレイヤー内の操作ボタンをクリックした後はフォーカスを解除し、Spaceを再生・一時停止に使えます。Tab・Enterによるボタン操作ではフォーカスを維持します。
全画面切替後にボタンへフォーカスが戻ってもSpaceは再生・一時停止を優先します。設定メニュー内は選択操作を優先します。

Phase 1〜6の機能に加え、マイク録音、Sonioxストリーミング、モバイル向け表示などが追加されています。旧Azure処理は過去Session／Jobの互換性のため保持しています。
「Phase 6実装済み」だけを根拠に、設計書のすべてが実装・実機検証済みとは判断しないでください。

### プロジェクトと共通プロフィール

ホームの「プロジェクト」から親プロジェクトと子プロジェクト（2階層まで）を作成し、各階層に背景情報と資料を保存できます。共通プロフィールはAIモデルの「プロファイル」と別物で、子プロジェクトは親の情報を引き継ぎます。兄弟プロジェクト間では資料を共有しません。資料は現時点で100KB以下の .txt / .md または貼り付けたテキストに対応します。保存後も本文の編集と参照対象からの除外ができます。

会議作成時にプロジェクトを選ぶか、既存会議の詳細画面から紐付け先を変更できます。会議作成画面の「＋ 新規作成」から親・子プロジェクトを作成し、そのまま会議の所属先として自動選択できます。プロジェクト・議事録テンプレートの選択欄は他の入力と統一したデザインです。未分類の会議もそのまま残ります。会議中の「回答支援」では、AI設定に登録したOllama / Geminiのプロファイルを要約とは独立して選択できます。送信確認後に開始し、質問の手入力・現在の発言・任意の自動質問検出から、短い回答案・詳細・根拠・履歴を表示します。開始時の資料・設定を固定し、AI切替時は停止と再確認を行います。現在の「会議への質問」は従来どおり確定文字起こしを対象とし、保存したプロジェクト資料を自動送信しません。詳しくは[操作ガイド](docs/usage.md)を参照してください。

回答支援の導入にはMigration `20260927_0022` と新しい `answer-worker` が必要です。[回答支援ガイド](docs/answer-assist.md)に反映コマンド・使い方・検証手順・制約を記載しています。自動回答は初期OFFで、会議中にON／OFFできます。ONの間は専用Workerが新しい発話と直近の会話をAIで判断し、完成した質問に回答案を生成します。判定にもAI利用料・処理時間がかかります。混合音声の話者番号から自分と相手を完全には区別できません。任意のAIサービス全般への対応ではなく、現在のOllama / Gemini接続境界を共通利用します。回答AIが存在しない根拠IDを返した場合は一度だけ修正を求め、再び不正ならその回答Jobだけを失敗にします。過去の回答と録音は保持します。

### LiveとFinalの違い

| 取り込み方 | 録音・録画中 | 停止・アップロード完了後 |
| --- | --- | --- |
| 音声ファイル | なし | 選択した非同期エンジンでFinalを自動作成 |
| 動画ファイル | なし | FFmpeg変換 → 選択した非同期エンジンでFinalを自動作成 |
| マイク録音 | Soniox | リアルタイム版を保存・表示。要約は保存済み文字起こしから生成。Final作成は詳細操作 |
| 画面共有録画・共有音声のみ | Soniox | 録画は動画変換、音声のみは録音保存。要約は保存済み文字起こしから生成。Final作成は詳細操作 |

会議のAI利用の有無・プロファイル・要約形式・背景は、取り込み方法によらず会議作成画面で選べます（画面共有・マイク録音ではリアルタイム解析と「要約を再生成」の初期値に使用）。Final完了後、会議のAIが有効で利用可能なプロファイルがあればAI解析Jobを作成します。
Liveの発話確定は、会議全体のFinal作成とは別です。Liveの話者番号を永久的な人物IDとみなしません。
会議テンプレートはAI Profileとは別に管理します。会議と解析Versionは選択時の定義をsnapshotとして保持するため、後日のテンプレート編集は過去の表示を変えません。[テンプレートの仕様と操作](docs/meeting-templates.md)。
会議作成には従来の「要約形式」も残っていますが、テンプレートを使う通常生成では反映されません。テンプレート未使用会議の互換設定です。手動AI取り込みでは両方の指示を含む不整合が残っています。[整理候補・未修正事項](docs/function-audit-20261014.md)。

## 構成

現在のComposeは**開発用**です。FrontendはNext.js開発サーバー、BackendはUvicornのreloadで動きます。
Dockerfileだけで判断せず、[docker-compose.yml](docker-compose.yml)のcommandとvolumeを確認してください。

| サービス | 役割 | ホスト側ポート（既定） |
| --- | --- | --- |
| frontend | Next.js / React / TypeScript | 3000 |
| backend | FastAPI / SQLAlchemy、API・WebSocket、起動時Migration | 8001 |
| worker | 動画変換、WhisperX / Soniox非同期文字起こし、確定議事録、質問回答 | 公開なし |
| live-worker | 切断された録音の保存・終了処理と、旧Live文字起こしJob。Soniox固定でも必要。1台で動かす | 公開なし |
| realtime-ai-worker | Live文字起こしを使うAI解析 | 公開なし |
| answer-worker | 会議中の回答支援専用の生成Job | 公開なし |
| postgres | PostgreSQL 17、Jobと会議データ | 公開なし |
| caddy | HTTPS、通常画面と /api の振り分け | 3443 |
| cloudflared | 任意のCloudflare Tunnel（tunnel profile） | 公開なし |

WhisperX（ホスト8000）とOllama（ホスト11434）は既存の別サービスです。このComposeでは起動・変更しません。
コンテナからは `host.docker.internal` を使います。

<a id="fresh-install"></a>
## 新しいUbuntu環境でGitから起動

アプリはUbuntu Server上で実行します。以下はユーザー `llm`、配置先 `/home/llm/speak-note` の例です。別のユーザーならホームディレクトリと `.env` のUID/GIDを読み替えてください。Mac等はブラウザ・Remote SSHの操作端末です。

### 1. 前提とSSHでclone

- UbuntuにGit、Python 3、curl、OpenSSH client、[Docker Engine](https://docs.docker.com/engine/install/ubuntu/)と[Docker Composeプラグイン](https://docs.docker.com/compose/install/linux/)を用意します。Dockerはリンク先の公式手順で導入してください。
- 全体文字起こしにWhisperXを使う場合は、このリポジトリに含まれないWhisperX API ServerとAPI Keyが必要です。既定の接続先はホストの8000番です。リアルタイム認識にはSonioxのアカウント・残高・用途に必要な権限を持つAPI KeyをAI設定で保存します。AI解析には別途Ollama（既定はホストの11434番）かGemini API Keyを用意します。新しい環境ではAzure設定は不要です。[Sonioxの導入手順](docs/soniox-transcription.md)も参照してください。
- GitHubの `CookieCream31/speak-note` へのSSH読み取り権限が必要です。新しいホストでは新しい鍵を作り、**公開鍵だけ**をリポジトリの **Settings → Deploy keys** に登録します。cloneだけなら読み取り権限、以後このホストからpushするなら **Allow write access** を有効にします。既存の鍵を上書きせず、必要ならファイル名を変えてください。[GitHubのDeploy key手順](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)。

```bash
sudo apt update
sudo apt install -y git python3 curl openssh-client
git --version
python3 --version
sudo docker compose version
```

```bash
install -d -m 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -C "speak-note on new host" -f "$HOME/.ssh/speak-note_ed25519"
cat "$HOME/.ssh/speak-note_ed25519.pub"
```

公開鍵の登録後にcloneします。初回接続時は表示されたGitHubのホスト鍵指紋を[GitHub公式一覧](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)と照合してから承認してください。秘密鍵をGitHubやこのリポジトリに登録しないでください。

```bash
cd "$HOME"
git -c core.sshCommand="ssh -i $HOME/.ssh/speak-note_ed25519 -o IdentitiesOnly=yes" clone git@github.com:CookieCream31/speak-note.git
cd speak-note
git config --local core.sshCommand "ssh -i $HOME/.ssh/speak-note_ed25519 -o IdentitiesOnly=yes"
git status --short --branch
```

このホストから変更をpushする場合は、Deploy keyの書き込み権限に加え、リポジトリ内で `git config --local user.name "cookie"` と `git config --local user.email "74705675+CookieCream31@users.noreply.github.com"` を設定します。鍵やGit設定はcloneに含まれません。[Git運用ガイド](docs/git-workflow.md)も参照してください。

### 2. ローカル設定

`.env` はGitに含まれません。既にある場合は上書きしないでください。

```bash
cd "$HOME/speak-note"
test -e .env || cp .env.example .env
mkdir -p storage
id -u
id -g
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```

[.env.example](.env.example)を参考に `.env` を編集します。最後のコマンドの出力は `MASTER_ENCRYPTION_KEY` に設定し、安全に保管します。

- `POSTGRES_PASSWORD` をダミー値から変更し、`DATABASE_URL` 内の認証情報と一致させる。
- `SPEAK_NOTE_UID` / `SPEAK_NOTE_GID` を上記のホストユーザーに合わせ、`storage/` を書き込み可能にする。
- `WHISPERX_API_KEY` のダミー値を実値へ変更し、必要なら `WHISPERX_BASE_URL` を接続先に合わせる。
- `MASTER_ENCRYPTION_KEY` を設定する。Gemini / Azure / Sonioxの暗号化された設定を別環境へ移す場合は、元環境と**同じ鍵**が必要です。
- 利用するホスト名・ポートに合わせて `FRONTEND_PORT`、`BACKEND_PORT`、`SPEAK_NOTE_HTTPS_HOST`、`NEXT_ALLOWED_DEV_ORIGINS`、必要なら `CORS_ORIGINS` を確認する。Cloudflare Tunnelを使わない初回起動では `tunnel` profileを指定しません。

### 3. 起動と確認

```bash
cd "$HOME/speak-note"
sudo docker compose config --quiet
sudo docker compose up --build -d
sudo docker compose ps
curl --fail http://localhost:8001/api/v1/health
sudo docker compose exec -T backend alembic current
```

`config --quiet` は構文確認のみです。値を展開する `docker compose config` の出力にはSecretが含まれ得るため、共有しないでください。Backendは起動時にAlembic Migrationを実行します。現行ソースのheadは `20261014_0031` です。Frontendは起動時にlockfileを確認し、必要なら `npm ci` を実行します。初回ビルド中はヘルスチェックが通るまで待ってから確認してください。エラー時は[障害調査](docs/operations.md#troubleshooting)を参照してください。

- 画面（Compose既定）: [http://localhost:3000](http://localhost:3000)。`FRONTEND_PORT` を変えた場合はそのホスト側ポートを使用します。2026-09-28のユーザー提供ログでは3001→コンテナ3000です。
- APIドキュメント: [http://localhost:8001/docs](http://localhost:8001/docs)
- ヘルスチェック: [http://localhost:8001/api/v1/health](http://localhost:8001/api/v1/health)

上の `localhost` はUbuntuホスト自身からの接続です。`FRONTEND_PORT` / `BACKEND_PORT` を変更した場合はURLと `curl` コマンドのポートも読み替えます。Macなど別端末のブラウザからは[LAN HTTPS設定](docs/operations.md#https)後にUbuntuホストのIPアドレスでアクセスしてください。

画面が開いたら[操作ガイド](docs/usage.md)に従ってAI設定・Profileを登録し、短いファイルをアップロードして会議・Job・Final文字起こしを確認します。WhisperXへ接続できない場合は上記の外部サービスとAPI Keyを確認してください。録音・画面共有にはHTTPSまたはlocalhostのSecure Contextが必要です。別端末からの録音や長時間録画は、WebSocketをBackendへ直接振り分けるCaddy経由を使います。[LAN HTTPS / Cloudflareの手順](docs/operations.md#https)。

### 既存環境の会議データを移す場合

Gitからcloneしただけでは**空の新規環境**です。`.env`、PostgreSQL volume内の会議・文字起こし・AI設定、`storage/` の原本、CaddyのローカルCAはGitに入りません。移行時はDBと `storage/` の整合するバックアップ、元の `MASTER_ENCRYPTION_KEY` を含む設定を用意し、新環境で復旧してから起動してください。鍵を変えると保存済みのAPI Keyは復号できません。[永続データと保護](docs/operations.md#永続データと保護)。volumeや既存サービスを削除して初期化しないでください。

### 表示テーマ（ダークモード）

「設定」→「表示テーマ」で、名前付きの3択ボタンからライト・ダーク・システムに合わせるを選べます。ヘッダーにはテーマ選択を表示しません。初期値はシステム設定です。選択はブラウザに保存し、OS設定への追従・別タブとの同期に対応します。切替は再読み込みやAPI通信を行わず、入力・録音・再生を続けたまま適用します。フォーム、議事録履歴、リアルタイム解析、回答支援、ダイアログ、状態・エラー表示にも共通配色を使用します。配色は白・黒・グレーにエメラルドの差し色1色です（[リデザイン](docs/redesign.md)第1段階）。文字はGeist・Noto Sans JP、時刻などの数字はGeist Monoで、最小11pxです。画面の見出しは日本語だけで、英字の大文字ラベルと番号付き見出しは表示しません。アイコンは `lucide-react` の線のアイコンです。角丸はボタン・入力8px、カード12px、ダイアログ16pxにそろえ、影はダイアログ・メニュー・プレイヤー操作部だけです。状態表示は完了＝グレー、処理中＝差し色の点、失敗＝赤、録画・録音中＝赤い点です（第2段階まで。第3段階の画面レイアウト（ホーム・会議詳細・新しい会議・録画中・プロジェクト・設定・ダイアログ・スマートフォン表示）を反映。議事録テンプレートは専用画面 `/settings/templates` で編集）。フォントは `next/font/google` がFrontendの起動・ビルド時に取得してアプリから配信するため、ブラウザからGoogleへは接続しません。Frontendコンテナがインターネットへ出られない場合は代替フォントで表示されます。映像・画像の内容は変更せず、映像上の字幕・操作部には読める固定配色を使います。保存領域を利用できない場合も、その画面で切替できます。操作と検証範囲は[表示テーマガイド](docs/dark-mode.md)を参照してください。

「設定」は従来の`/settings/ai`を引き続き使い、接続先・プロファイル・テンプレート・文字起こし設定も同じ画面で管理します。会議詳細のヘッダーには歯車の「設定」と「新しい会議」を表示し、スマートフォンでは44pxのアイコンボタンになります。保存済み会議の「新しい会議」はホームへ移って作成ダイアログを開きます。録音開始前・録音／録画・保存中の画面では別タブで開き、元の画面を維持します。録音画面から開いた設定でテーマを変えると、同じoriginの元のタブにも反映します。[操作・検証・制約](docs/settings-navigation.md)。

DB・環境変数の変更はありません。リデザイン第2段階でFrontendの依存に `lucide-react` を追加したため、この変更を取り込んだ後は一度 `sudo docker compose restart frontend` を実行します（起動時に `npm ci` されます）。それ以外は開発用ComposeのHMRで反映し、録音・録画と保存の完了後にブラウザを再読み込みします。2026-09-28のユーザー提供ログでFrontendの再起動後 `Up 43 seconds` を確認しました。ホストの `http://localhost:3001/` はHTTP 200を返し、実配信のホーム画面でテーマ切替と保存値の復元を確認しています。その他の実会議画面・録音中の操作は引き続き未確認です。[確認範囲と手順](docs/dark-mode.md)を参照してください。

## 変更を反映するには

| 変更内容 | 通常必要な操作 |
| --- | --- |
| README・文書だけ | Docker操作不要 |
| FrontendのTSX / CSS | bind mountとHMRで反映。ブラウザを再読み込み |
| Frontendの依存関係 / 起動スクリプト | `sudo docker compose restart frontend` |
| BackendのPython | APIはreload。Workerにも関係するなら `sudo docker compose restart worker live-worker realtime-ai-worker` |
| DB Migration追加 | 録音を終えてBackendを再起動し、Migration結果を確認 |
| .env / Compose / Dockerfile / Python依存関係 | 再起動だけでは不十分な場合あり。[反映手順](docs/operations.md#apply)を参照 |

スマートフォンの会議詳細では、プロジェクト・AI・話者数・処理状況を幅の揃った行に表示します。長い設定名は選択欄の中へ収め、ラベルの途中折り返しを防ぎます。上部は会議一覧へのリンク・設定・新しい会議を44px以上の高さで操作でき、録音・録画の丸いボタンではアイコンを中央に表示します。Live文字起こしと解析タブの補足は狭い画面で行を分けます。DB・環境変数・依存パッケージの変更はありません。

録画中の共有プレビューは横幅最大280px・高さ158px以下（画面の高さの20%以下）へ縮小し、文字起こしや要約の表示領域を確保します。元の映像トラックと録画の解像度・ビットレートは変えません。共有変更・マイクのミュート・終了は、全画面幅で丸いアイコンだけのボタンです（通常48px、幅420px以下は44px）。操作名はツールチップと読み上げ用ラベルで確認でき、ミュートの斜線・赤色、停止の赤色、経過時間と共有停止の案内を維持します。[変更・検証・反映](docs/compact-capture.md)を参照してください。

録音中の再読み込み・再起動は避け、保存完了を確認してから操作してください。
新しい録音処理のコードを試すときは、更新後のページで新しい録音を開始します。

### Live文字起こし専用Worker

録音中のLive文字起こしは `live-worker` が担当し、通常の `worker` は担当しません。これにより、別の会議のFinal文字起こしやAI要約が長時間かかっても、会議中の文字起こしが止まりません。各区間の音声は録音ファイル全体をコピーせずに切り出すため、長い会議でも1区間あたりの処理時間が増えません。

この変更を取り込んだ既存環境では、録音・録画を終えてから `sudo docker compose up -d --build live-worker` と `sudo docker compose restart worker` を実行します。`live-worker` を起動しないと、Live文字起こしのJobが `queued` のまま進みません。DB Migration・環境変数の追加はありません。[反映手順](docs/operations.md#live-worker)。

### 録音中の接続切れと自動再接続

録音・画面共有の途中で通信が切れたりBackendが再起動したりしても、ブラウザは録音を続け、最大5分間自動で再接続します。再接続すると同じ録音セッションへ戻り、切断中に録った分を含めて未送信のデータを順番どおり送ります（Backendは重複を無視します）。再接続中は録音画面に「再接続しています…」と表示されます。

ブラウザの再読み込み・タブを閉じる・録音画面から移動する操作は意図した終了として扱い、従来どおり受信済みのデータですぐ確定します。5分以内に再接続できなかった場合や、ブラウザ自体が終了した場合は、最後にデータが届いてから `REALTIME_RESUME_TIMEOUT_SECONDS`（既定600秒）後に `live-worker` が受信済みデータで確定します。送信待ちのデータはブラウザのメモリに保持するため、タブが閉じると未送信分は失われます。

この変更にはMigration `20261005_0024`（録音セッションの最終受信時刻）と `live-worker` が必要です。新しい環境変数 `REALTIME_RESUME_TIMEOUT_SECONDS` は省略できます（既定600秒）。[反映手順](docs/operations.md#recording-resume)。

## 既知の制約・引き継ぎ時の注意

- アプリ内のログイン・利用者ごとの権限分離は未実装です。インターネットへ無認証で公開しないでください。Cloudflare利用時もAccess設定と、迂回できる公開ポートがないことを確認します。
- iOS / iPadOSを含む画面共有は、実行時のブラウザAPI対応判定に依存します。非対応時は端末の画面収録ファイルをアップロードする案内です。ネイティブ画面共有の実装はありません。
- Soniox／WhisperXの認識精度・話者分離は音源・接続・設定の影響を受けます。モックテストの成功だけで実録音の品質を保証しません。
- リアルタイム解析のテンプレート追加項目で`dict.model_validate`によって保存に失敗する問題は修正済みです。6種類の値、数値0・真偽値false・不明値null、更新時の既存値保持、不正Evidence・選択肢・AI接続失敗時の結果保持と再試行をProcessor・DB・APIで検証しました。反映には`realtime-ai-worker`の再起動が必要です。DB変更はありません。[反映と動作確認](docs/operations.md#realtime-template-values)・[調査後の修正記録](docs/function-audit-20261014.md#realtime-template-fix)。
- 「質問候補」「チャプター」の用途別Profileは保存UI/APIがありますが、現在の一括議事録生成では個別には参照されません。確定議事録と同じProfileで生成します。会議への質問回答も確定議事録側のProfile解決を使用します。
- `generate_thumbnails` はJob種別にありますが、Workerの処理分岐は未実装です。
- 運用データは `storage/`、PostgreSQL Volume、暗号化キーを含む設定に分かれます。Volume削除は初期化ではなくデータ消失です。
- 旧会議とテンプレートsnapshotのない解析Versionは、従来の議事録表示を使います。テンプレート値に関する詳細は[議事録テンプレートガイド](docs/meeting-templates.md)を参照してください。

根拠ファイル・テスト・改修時の確認項目は[開発ガイド](docs/development.md)、障害時の切り分けは[運用ガイド](docs/operations.md#troubleshooting)を参照してください。

### 停止後のリアルタイム版と要約再生成

画面共有・マイク録音の停止後は、録画操作とLive専用パネルに代わり、共通の会議ノートで保存済みのリアルタイム文字起こしと解析を表示します。動画・音声再生、文字ハイライト、話者表示、要約カード、テキスト出力を利用できます。リアルタイム版は暫定データで、正式な話者ID・単語時刻の精度を保証しません。保存済みリアルタイム版でも話者名をクリックして表示名を変更できます。「話者 1」を「田中」にすると、表示しているリアルタイム版全体の「話者 1」が「田中」になります。録音・保存中は変更できません。別の話者番号・別のリアルタイム版・高精度版・別会議には引き継ぎません。原文・元の話者ラベル・翻訳・要約履歴を保持し、名前は本文表示・動画字幕・テキスト出力と、次の暫定要約生成へ反映します。名前を空欄で保存すると同じ話者番号の表示名を全体で元のラベルへ戻します。本文編集と会議後の質問には高精度版が必要です。詳しい[操作手順](docs/usage.md#speaker-names)と[Migration 0030の反映手順](docs/operations.md#live-speaker-names)を参照してください。録音中のリアルタイム解析履歴は閲覧用ですが、停止後に再生成した暫定要約は編集・確認済み操作ができ、次の再生成でも保護します。解析をOFFにしていた場合は要約がなくても文字起こしを見られます。

会議画面右上の「要約を再生成」から、今回だけ使うAIプロファイルと議事録テンプレートを選びます。初期値は会議のAI設定と保存済みテンプレートです。テンプレートの「確定後」のカード・項目・AIへの指示を使い、会議やリアルタイム解析の設定は変更しません。テンプレート選択時は従来の要約形式を重ねて指定しません。AIなしの会議でも今回使うプロファイルを明示すると生成できます。

「要約を再生成」は保存済みの全体文字起こし（Final）を優先し、Finalがなければ停止・保存が完了したリアルタイム文字起こしを使って要約だけを生成します。AIを使わず録音した会議でもAIプロファイルを選ぶと生成でき、文字起こしJobや音声の再送を行いません。Liveから作った要約は履歴で「リアルタイム原文からの要約（暫定）」と明示します。使った原文の版とテンプレートを生成履歴に固定し、後からFinalを作成しても過去の要約の参照元は変わりません。保存済み原文がない間は再生成を無効にします。

高精度版が必要な場合は、要約の「…」→「全体文字起こしを作成（高精度版）」から保存音声の全体処理を明示して実行します。既存Live・要約・翻訳を保持し、Final完成後の要約生成はFinalを再利用します。アップロード会議のFinal自動作成は維持します。

モデル・テンプレートを変更しても文字起こしをやり直しません。過去の要約とリアルタイム版を保持し、処理中も閲覧・版切替ができます。連打や処理中の要求は重複Jobを作らず、失敗時は既存結果を保持します。以前の要約またはリアルタイム版が残っている会議は、再生成に失敗しても一覧で「失敗」にならず「完了」のままです。失敗は会議画面の処理状況に再試行ボタン付きで表示されます。今回の保存済み原文の再利用に追加Migration・環境変数はありません。[Backend・Workerを含む反映手順](docs/operations.md#saved-transcript-summary)と[変更・検証記録](docs/summary-regeneration.md#saved-transcript-summary)を参照してください。

### Sonioxのリアルタイム・非同期文字起こし

設定の「リアルタイム文字起こし」はSoniox固定です。「アップロード・録音終了後の文字起こし」はWhisperX／Sonioxを選べ、既定はWhisperXです。モデル・API Keyは用途ごとに保存し、文字起こし言語は会議ごとに選択します。Migration 0031はLiveの既存providerをSonioxへ変更し、キー・履歴・非同期設定を保持します。Sonioxの既定モデルはリアルタイムが`stt-rt-v5`、非同期が`stt-async-v5`です。API Keyを入力し「モデル一覧を取得」を押すと、その用途に対応するモデルを選択できます。保存済みキーでも取得でき、取得だけではキー・設定を保存しません。選択後に「設定を保存」と接続テストを行います。両方でSonioxを使う場合はそれぞれの欄にキーを保存します。同じキーを入力しても構いません。録音中の音声と、Sonioxを選んだ非同期処理の保存音声はSonioxへ送信され、料金が発生します。

両用途を同じキーで使う場合はFull accessをOFFにし、Speech-to-text, real-time／Model listing／Temporary API keysをAccess、Speech-to-text, async／FilesをWrite、その他をNo Accessにします。WriteにはReadが含まれます。用途別の最小権限は[Sonioxガイド](docs/soniox-transcription.md#モデル一覧とapiキーの権限)を参照してください。権限変更の反映には数分かかる場合があります。

恒久キーはBackendで暗号化し、ブラウザには60秒で接続期限が切れる一回限りのキーを渡します。非同期処理は通常Workerがファイル送信・処理予約・状態確認・結果保存を行い、保存後にSoniox上のファイルと文字起こしを削除します。通信障害時は処理IDを再利用し、送信成功が不明なときは照合できるまで再送しません。Sonioxには最小／最大話者数を指定しません。設定・制約・確認手順・Docker反映は[Sonioxガイド](docs/soniox-transcription.md)を参照してください。追加環境変数・依存追加はありません。利用者の反映ログで運用DBの`20261012_0026 (head)`、BackendのHealthy、4つのWorkerの起動を確認しています。モデル一覧機能追加後の再起動ログでもBackendのhealthy、FrontendのUp、4つのWorkerのRunningを確認しました。反映後の画面表示・実キーでのモデル取得・音声認識は未確認です。

### 会議ごとの文字起こし言語

「新しい会議」の「会議で話す言語」は、初期値が自動判定・Strict OFFです。未選択時は自動判定のタグを表示せず、選んだ言語だけをタグで表示します。「＋ 言語を選ぶ」を押すと、日本語・英語を上部に置いた一覧から直接選べます。日本語名・英語名・言語コードで検索できます。単一言語の構成では入れ替わり、Sonioxで複数言語に対応した構成では追加・削除できます。すべて外すと自動判定に戻り、StrictもOFFになります。新しい会議ダイアログを開くたびに初期値へ戻ります。自動判定に非対応のWhisperX／Azureでは、理由を表示して言語を1つ選ぶよう案内します。既存会議の設定は変更しません。

Language hintsは認識のヒントで、Sonioxでは他の言語も認識します。「詳細設定」の「選択した言語に限定する」はStrictで、強く優先しますが完全な保証ではありません。通常はOFF、話す言語が確実な場合だけONにします。詳細設定を閉じていてもStrictのON／OFFを表示します。翻訳やAI要約の出力言語を指定する設定ではありません。

会議ページの「文字起こし設定」でも、録音開始前または初回Finalの予約前に変更できます。録音・保存・処理中とFinal作成後は言語変更を禁止します。選択は会議に保存し、Live開始時と全体処理Job予約時に固定します。再接続・再試行・動画変換後にも引き継ぎます。AI設定の言語入力は廃止し、既存会議の従来設定と履歴を保持します。WhisperXの全体処理は単一言語です。LiveはSoniox固定ですが、会議の共通言語設定では全体処理のエンジンも考慮します。自動判定・複数言語は全体処理にもSonioxを選んだときに使用でき、StrictはSonioxにだけ適用します。モデルの対応言語・Strict対応は音声送信前に公式モデル情報で検証します。

この追加にはMigration `20261012_0027`が必要です。利用者の提示ログで運用DBの`20261012_0027 (head)`、BackendのHealthy、4つのWorkerの起動を確認しました。言語UI変更後のログでは、再起動後のFrontendの`Up 5 seconds`も確認しています。新UIの画面表示・実APIでの音声認識は未確認です。[反映記録](docs/meeting-transcription-languages.md#deployment-confirmation)、[反映手順](docs/operations.md#meeting-languages)、[操作・検証・制約](docs/meeting-transcription-languages.md)を参照してください。

検索一覧・タグの表示改善自体にはDB変更はありません。最新コードの反映は[Migration 0031までの手順](docs/operations.md#soniox-realtime-only)を使用してください。過去の0027〜0029の反映ログは、その時点の記録です。

### Sonioxのリアルタイム翻訳

画面共有・マイク会議の言語欄で「リアルタイム翻訳」をONにし、一方向の翻訳先、または双方向の異なる2言語を選びます。既定はOFFです。リアルタイムがSonioxなら、確定版がWhisperXでも利用できます。翻訳は原文の発話ブロック直下に、同じ本文幅・文字サイズの文章として表示します。同じ言語・話者の断片を一つの段落につなげ、言語と保存状態は段落に一度だけ表示します。原文と一緒にスクロールし、保存は原文と分離します。翻訳を音声の時刻や議事録のEvidenceとして扱いません。録音開始時の設定と表示用の対応情報を保持し、遅れて届く翻訳・停止後・再読み込みでも並びを保ちます。対応情報のない旧翻訳は原文の後にまとめ、高精度版では「リアルタイム原文と翻訳」を開いて確認します。[公式仕様と操作・検証](docs/realtime-translation.md)。

Migration `20261012_0028`と`20261012_0029`が必要です。0029は翻訳履歴にnullableな表示用対応情報を追加し、既存結果を保持します。追加環境変数・依存追加はありません。運用DBへの適用と実Soniox音声による翻訳は未確認です。録音・録画・保存・実行中Jobを終了してから[反映手順](docs/operations.md#realtime-translation)を実行してください。

翻訳の文章表示への変更自体はFrontendのみで、追加のDB変更はありません。0029まで反映済みなら[Frontendのみの反映手順](docs/operations.md#translation-paragraphs)を使用します。

Soniox Live原文の保存区切りは約10秒ごとの単語境界を使い、`Capac`と`itance`のような単語途中のtokenを同じ区間に保持します。翻訳の原文参照も同じ区切りに従います。区切りの変更は新しく開始する録音から適用し、過去の保存履歴は書き換えません。翻訳の原言語と翻訳先が同じ場合は「原言語の判定要確認」と表示し、本文とAPIの言語情報を保持します。この表示は既存履歴にも適用します。[変更・検証・制約](docs/soniox-transcription.md#word-boundaries)。

Soniox Liveは**話者分離の精度を優先**し、早期確定（endpoint detection）をOFFにしています。認識途中の表示は続きますが、文字・話者の確定と保存、原文を使うAI更新が遅れる場合があります。定期的な強制確定は行いません。話者番号は確定履歴に採用した話者で作成し、暫定IDが変わっても番号を消費しません。原文と翻訳で番号を共有します。人数の最小／最大指定はWhisperXでの認識だけに適用します。[精度優先の仕様・確認手順](docs/soniox-transcription.md#diarization-accuracy)。変更はFrontendのみで、追加Migration・環境変数はありません。[反映手順](docs/operations.md#soniox-accuracy)。

Migration `20260927_0023` が必要です。追加環境変数はありません。録音・録画と保存、実行中Jobの終了を確認してから[要約再生成の反映手順](docs/operations.md#summary-regeneration)を実行してください。操作・動作確認は[操作ガイド](docs/usage.md#summary-regeneration)、実装と検証は[開発ガイド](docs/development.md#summary-regeneration)に記載しています。
