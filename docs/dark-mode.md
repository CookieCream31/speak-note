# 表示テーマ（ダークモード）

最終照合: 2026-10-15（ライトモードの少し明るい緑、設定内の選択、全画面のOS追従・別タブ同期を照合）。[README](../README.md) · [操作ガイド](usage.md#display-theme) · [運用手順](operations.md#settings-navigation)

## 操作と保存

「設定」→「表示テーマ」の3択ボタン（システムに合わせる／ライト／ダーク、見える名前・アイコン・`aria-pressed`付き）で選びます。各ページのヘッダー・エラー画面にはテーマ選択を重複表示しません。スマートフォンでは縦に並び、操作領域は44px以上です。初期値はシステム設定で、明示的な選択を優先します。`localStorage` の `speak-note.theme` に保存し、同一オリジンの別タブへも同期します。端末間・異なるホスト／HTTPとHTTPS間の同期は行いません。保存が拒否される場合も現在の画面では切替できます。

OS追従は「システムに合わせる」の間だけ有効です。ページ描画前に選択を適用し、CSSにもJavaScriptなしのOS追従を用意します。Native入力とスクロールバーには `color-scheme`、ブラウザのテーマ色には `theme-color` を使用します。切替時にページ更新・API要求を行わず、入力・録音・再生要素を再作成しません。

`ThemeObserver`をRoot LayoutとGlobal Errorへ置き、選択UIのない会議・ホーム等でもOS設定と別タブの変更を監視します。録音画面から設定を開くと別タブになり、元の録音画面へ色だけを反映します。設定画面自体のデータ取得には従来どおりBackendを使います。[今回の変更ファイル・検証・制約](settings-navigation.md)。以下の日付付き結果は各変更時点の記録です。

## 対応範囲と配色

- ホーム、一覧、検索・タグ・お気に入り・一括操作、会議作成とアップロード。
- 会議詳細、処理状況、要約・履歴・編集・確認済み・Evidence、質問と失敗／処理中の表示。
- 全体文字起こし・暫定発言、検索・Bookmark・話者・Timeline。
- 画面共有・マイク録音の操作とプレビュー、リアルタイム解析、回答支援。
- AI接続、AIプロファイル、認識設定、用途設定、テンプレートとAIへの指示。
- プロジェクト、共通プロフィール、資料・背景の入力。
- 要約再生成、外部AI取り込み、作成・タグ等のダイアログ、Backdrop、Hover・Focus・選択・Placeholder。
- 404、通常のError Boundary、Global Error、会議データ取得失敗時の画面。

配色はリデザイン第1段階（[リデザイン実装ガイド](redesign.md)）の値です。白・黒・グレーを基本に、差し色（リンク・再生中・フォーカス、トークン名は従来の `--blue`）はエメラルド1色、赤はエラー・削除・停止とマイクのミュート状態だけに使います。録画中の画面共有・マイクのボタンはグレー、ミュート中は薄い赤の面に赤い枠（録画中は2px）、停止は赤の塗りで区別します。会議作成時の「マイク：ミュートで開始」も赤で表示します。方眼背景は廃止し、`body` の背景は `--paper` だけです（`--background-grid` は互換のため `transparent` で残しています）。ブラウザの `theme-color` はページ背景に合わせてライト `#fafafa`、ダーク `#09090b` です。ダークでは主要ボタンが白地・黒文字になり、`--danger-solid` も黒文字で読める明るい赤にしています。

全ページ・ComponentのCSSは共通paletteへ接続し、色の直接指定やローカルのテーマ上書きを検査します。映像・画像の内容は変えません。映像上の字幕・操作部・録画プレビューには固定した `--media-*` を使い、音声プレイヤー・文字起こし等は選択テーマへ追従します。OSの画面共有ピッカー、ブラウザの権限ダイアログ、開発用フレームワークOverlayはアプリの配色対象ではありません。

<a id="light-accent"></a>
## ライトモードの緑を少し明るくする変更（2026-10-15）

ライトモードの`--blue`・`--focus`・`--success`・`--success-solid`を`#047857`から`#007e54`へ変更しました。相対輝度が約10%上がり、リンク・時刻・スイッチ・シークバー・フォーカス枠・成功表示へ同じ色を使います。フォーカスの外側は`rgba(0, 126, 84, 0.25)`です。既存の別名`--accent`・`--mint`にも反映します。ダークモード・OSのダーク配色・映像上の固定配色は従来の値です。

緑文字と白背景は約5.11:1、薄いグレーの面は約4.65:1、成功表示の薄い緑の面は約4.55:1です。少し明るくしながら、既存の4.5:1以上の検査を保持しています。

変更ファイルは`frontend/app/theme.css`、`README.md`、`DESIGN.md`、`docs/dark-mode.md`、`docs/redesign.md`の5件です。画面ごとの色を直接変更せず、共通paletteのライト定義だけを更新しました。

実行コマンド（Node 22.16.0の`/tmp/node-v22.16.0-linux-x64/bin/node`）:

```bash
# frontend内
node node_modules/vitest/vitest.mjs run lib/theme-styles.test.ts lib/theme.test.ts components/theme-selector.test.tsx components/theme-observer.test.tsx components/settings-navigation.test.tsx
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
# Project内
git diff --check
```

関連28件、型チェック・ESLint・空白検査が成功しました。両テーマのCSS・コントラスト・OS追従・設定保存・Hydration・別タブ同期を既存テストで検証しています。色定数と文書だけの変更のため、Frontend全体・Backend・DBの検証は再実行していません。Frontend専用formatterは未設定で、既存書式へ合わせた限定差分を確認しました。

Chromiumの実Component・CSSによる設定・会議作成・保存音声の3画面を、ライト／ダーク×幅320・393・844・1280pxの24条件で確認しました。設定の選択枠・フォーカス、作成スイッチ、文字起こしの時刻、音声のシークマーカー・スキップボタンへ新しい色が反映されること、ダークの色の保持、横はみ出しなし・page errorなしが成功しました。OSがダークでも明示的なライト選択を優先することも確認しています。検証は`FONTCONFIG_FILE=/tmp/speak-note-provisional-speakers-browser/fonts.conf PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu XDG_CACHE_HOME=/tmp/speak-note-browser-font-cache /tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-settings-navigation-browser/check_light_accent.py`で行いました。

録音・録画と保存の終了後にページを再読み込みし、設定の「表示テーマ」でライトを選んで確認します。必要な場合のFrontendだけの再起動は[運用手順](operations.md#display-theme)を使います。新しいMigration・依存・環境変数はありません。外部API・運用会議・稼働Dockerは操作していません。Safari／iPhone実機・実録音・Docker反映は未検証です。

## 検証

追加テストは保存・OS追従・初回描画・保存不可・別タブ同期・リスナー破棄・Hydration・入力／音声要素の保持・全CSSの直接指定／未定義変数・配色コントラスト・エラー表示を対象とします。通常テキストの基本配色は4.5:1以上、入力境界は3:1以上を確認します。

Frontendで実行する基本コマンド:

```bash
cd /home/llm/speak-note/frontend
npm test
npm run typecheck
npm run lint
```

2026-09-27の完成版で実行した結果:

| コマンド／確認 | 結果 |
| --- | --- |
| `npm test` | 35ファイル・171件成功。今回26件追加。既存の録音・アップロード・再生成・リアルタイム解析・会議後質問のFrontendテストも成功 |
| `npm run typecheck` | 成功 |
| `npm run lint` | 既存の `project-manager.tsx` の38・40行に `react-hooks/set-state-in-effect` が2件。変更前にも同じ処理への指摘があり、今回のテーマ対応による追加指摘なし |
| Prettier 3.6.2 `--check` | 新規13ファイル成功。既存ファイルは全面整形せず限定差分を維持 |
| PostCSSによるCSS解析 | 全27ファイル成功 |
| `npm run build -- --webpack` | `/tmp/speak-note-dark-mode-build` に最終ソースをコピーした隔離ビルドで成功。既存Dockerの `.next` に影響なし |
| Chromiumの画面確認 | 8画面 × 2テーマ × 5画面サイズ、80通り成功。画面内のタブ、作成・タグ・再生成・外部AI取り込みダイアログ、失敗表示も確認。横はみ出し・JavaScriptエラー・可視テキストのコントラスト不足を検出せず |
| Chromiumの切替動作 | OS追従、明示設定優先、入力保持、音声要素・3秒の再生位置と再生継続、別タブ同期、保存値復元、狭い画面のダイアログ幅、JavaScriptなしのOS配色が成功 |
| Next.jsビルドのブラウザ確認 | 404、ホームの取得失敗表示、AI設定のError Boundary、会議取得失敗画面を両テーマで確認。8通り成功、Hydrationを含むJavaScriptエラーなし |

Node.js 22.16.0を使用しました。Prettierは `/tmp` の検証用キャッシュで実行し、アプリの依存には追加していません。画面確認は実コンポーネントと保存済みサンプルデータを使い、APIはmockにしています。画面サイズは1280×800、768×1024、390×844、320×568、844×390です。可視テキストのブラウザ検査は通常4.5:1、大きな文字3:1を基準とし、半透明色と背景グラデーションを考慮しました。

検証用のブラウザ実行コマンド（用意した `/tmp` の環境がある場合）:

```bash
LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu \
FONTCONFIG_FILE=/tmp/speak-note-preview/fonts.conf \
PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers \
/tmp/speak-note-validation/bin/python /tmp/speak-note-dark-mode-browser/check.py
```

同じ環境で `behavior.py` と `next-smoke.py` も実行しました。画面確認の結果とスクリーンショットは `/tmp/speak-note-dark-mode-browser/` に保存しています。これらは一時的な検証用ファイルであり、通常の単体テストはリポジトリに含まれています。

2026-09-28のユーザー提供ログでFrontendコンテナが再起動後 `Up 43 seconds`、ホスト側ポート3001であることを確認しました。実配信の `http://localhost:3001/` はHTTP 200を返し、Chromiumの390px幅でホーム画面のダーク切替、保存値の再読み込み後の復元、横はみ出しなし、ページ内JavaScriptエラーなしを確認しました。`127.0.0.1` では開発サーバーの既定許可Origin（`localhost`）と異なるため、操作の検証には `localhost` を使用しました。別のホスト名を使う場合は[開発サーバーの許可Origin](operations.md#display-theme)を確認してください。

未検証: 実会議の全画面での運用データを使った表示、実デバイスでの録音・画面共有・動画再生中の切替、Safari／Firefox。Global Errorはソース・型・ビルドで確認し、根本Layout障害の実発生は再現していません。ブラウザの権限UIと映像そのものは対象外です。既存lint2件は未解決です。

Backend・DB・環境変数・アプリ依存は変更していません。今回はBackendテストを再実行していません。Docker・既存サービス・Volumeへの操作も行っていません。

<a id="check"></a>
## ユーザー向け動作確認

2026-10-09のスマートフォン表示修正では、会議詳細の設定ラベル・長い選択値・話者数の設定画面・ヘッダー・録音操作のアイコン・Liveパネルの見出しと状態表示を両テーマで確認しました。Chromiumで320/375/393/430/560/561/844/1280px、録音・画面共有・保存後の3状態、ライト／ダークの48通りが成功しています。録音・WebSocket・APIは模擬で、実マイク・実会議への保存は行っていません。Frontend全195件・ESLint・型チェックも成功しました。ホストの一時npm環境でnode-gypが欠けていたため、各scriptが実行するVitest／ESLint／TypeScriptをNodeから直接起動しています。独立したFrontend formatterは未設定です。WebKitは検証ホストのライブラリ不足で起動できず、iPhone Safari実機は引き続き未確認です。DB・依存パッケージ・Docker・録音処理の変更はありません。

今回の表示は録音・録画と保存を終えてからブラウザを再読み込みして確認してください。会議上部の設定ラベルが途中で改行されず、丸い録音ボタンのアイコンが中央にあり、話者数の設定が画面からはみ出さないことを確認します。

1. 録音・録画と保存の終了後に、更新したFrontendでブラウザを再読み込みする。
2. 「設定」の「表示テーマ」をダークにし、ホームのカード・文字・検索・会議作成・タグ画面を確認する。
3. 会議、設定、プロジェクトへ移動し、同じ選択が引き継がれることを確認する。
4. 要約再生成・履歴・Evidence・編集・質問・検索設定・テンプレート入力を開き、白い未対応領域や読めない文字がないか確認する。
5. 設定でライトへ戻し、両テーマで入力内容が保持されることを確認する。再生中の会議とは別タブで設定を開き、テーマ変更時に元の音声・動画の再生位置が維持されることを確認する。
6. 「システムに合わせる」でOSの配色を切り替え、追従することを確認する。明示的なライト／ダークではOS変更に追従しないことを確認する。
7. 別タブとページ再読み込み、スマートフォン・横画面でも選択・フォーム・ダイアログを確認する。

通常はDocker操作不要です。必要時のFrontendだけの再起動手順は[運用ガイド](operations.md#display-theme)を参照してください。

## 変更ファイル

- `DESIGN.md`
- `README.md`
- `docs/dark-mode.md`
- `docs/development.md`
- `docs/meeting-templates.md`
- `docs/operations.md`
- `docs/summary-regeneration.md`
- `docs/usage.md`
- `frontend/app/error.tsx`（新規）
- `frontend/app/global-error.tsx`（新規）
- `frontend/app/globals.css`
- `frontend/app/layout.tsx`
- `frontend/app/meetings/[meeting_id]/page.module.css`
- `frontend/app/meetings/[meeting_id]/page.test.tsx`
- `frontend/app/meetings/[meeting_id]/page.tsx`
- `frontend/app/not-found.tsx`（新規）
- `frontend/app/theme.css`（新規）
- `frontend/components/ai-profile-list.module.css`
- `frontend/components/ai-settings-manager.module.css`
- `frontend/components/ai-settings-manager.tsx`
- `frontend/components/answer-assist-panel.module.css`
- `frontend/components/app-status-page.module.css`（新規）
- `frontend/components/app-status-page.test.tsx`（新規）
- `frontend/components/app-status-page.tsx`（新規）
- `frontend/components/chunked-media-uploader.module.css`
- `frontend/components/inline-speaker-name.module.css`
- `frontend/components/live-meeting-recorder.module.css`
- `frontend/components/manual-ai-import.module.css`
- `frontend/components/meeting-ai-selector.module.css`
- `frontend/components/meeting-question-panel.module.css`
- `frontend/components/meeting-review-panel.module.css`
- `frontend/components/meeting-template-manager.module.css`
- `frontend/components/meeting-tools-panel.module.css`
- `frontend/components/meeting-transcription-settings.module.css`
- `frontend/components/meeting-workspace.module.css`
- `frontend/components/meetings-manager.module.css`
- `frontend/components/meetings-manager.tsx`
- `frontend/components/microphone-start-toggle.module.css`
- `frontend/components/new-meeting-project-field.module.css`
- `frontend/components/project-manager.module.css`
- `frontend/components/project-manager.tsx`
- `frontend/components/realtime-analysis-panel.module.css`
- `frontend/components/summary-regeneration.module.css`
- `frontend/components/template-analysis-cards.module.css`
- `frontend/components/theme-selector.module.css`（新規）
- `frontend/components/theme-selector.test.tsx`（新規）
- `frontend/components/theme-selector.tsx`（新規）
- `frontend/components/transcript-player.module.css`
- `frontend/lib/theme-styles.test.ts`（新規）
- `frontend/lib/theme.test.ts`（新規）
- `frontend/lib/theme.ts`（新規）
