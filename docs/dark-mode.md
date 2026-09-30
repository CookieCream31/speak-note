# 表示テーマ（ダークモード）

最終照合: 2026-09-30。[README](../README.md) · [操作ガイド](usage.md#display-theme) · [運用手順](operations.md#display-theme)

## 操作と保存

各画面上部の「表示テーマ」でライト／ダーク／システムに合わせるを選びます。初期値はシステム設定で、明示的な選択を優先します。`localStorage` の `speak-note.theme` に保存し、同一オリジンの別タブへも同期します。端末間・異なるホスト／HTTPとHTTPS間の同期は行いません。保存が拒否される場合も現在の画面では切替できます。

OS追従は「システムに合わせる」の間だけ有効です。ページ描画前に選択を適用し、CSSにもJavaScriptなしのOS追従を用意します。Native入力とスクロールバーには `color-scheme`、ブラウザのテーマ色には `theme-color` を使用します。切替時にページ更新・API要求を行わず、入力・録音・再生要素を再作成しません。

## 対応範囲と配色

- ホーム、一覧、検索・タグ・お気に入り・一括操作、会議作成とアップロード。
- 会議詳細、処理状況、要約・履歴・編集・確認済み・Evidence、質問と失敗／処理中の表示。
- 全体文字起こし・暫定発言、検索・Bookmark・話者・Timeline。
- 画面共有・マイク録音の操作とプレビュー、リアルタイム解析、回答支援。
- AI接続、AIプロファイル、認識設定、用途設定、テンプレートとAIへの指示。
- プロジェクト、共通プロフィール、資料・背景の入力。
- 要約再生成、外部AI取り込み、作成・タグ等のダイアログ、Backdrop、Hover・Focus・選択・Placeholder。
- 404、通常のError Boundary、Global Error、会議データ取得失敗時の画面。

配色はリデザイン第1段階（[リデザイン実装ガイド](redesign.md)）の値です。白・黒・グレーを基本に、差し色（リンク・再生中・フォーカス、トークン名は従来の `--blue`）はエメラルド1色、赤はエラー・削除・停止とマイクのミュート状態だけに使います。録画中の画面共有・マイクのボタンはグレー、ミュート中は薄い赤の面に赤い枠（録画中は2px）、停止は赤の塗りで区別します。会議作成時の「マイク：ミュートで開始」も赤で表示します。方眼背景は `--background-grid: transparent` で無効化しています。ブラウザの `theme-color` はページ背景に合わせてライト `#fafafa`、ダーク `#09090b` です。ダークでは主要ボタンが白地・黒文字になり、`--danger-solid` も黒文字で読める明るい赤にしています。

すべてのアプリCSS（27ファイル）は共通paletteへ接続し、色の直接指定やローカルのテーマ上書きを検査します。映像・画像の内容は変えません。映像上の字幕・操作部・録画プレビューには固定した `--media-*` を使い、音声プレイヤー・文字起こし等は選択テーマへ追従します。OSの画面共有ピッカー、ブラウザの権限ダイアログ、開発用フレームワークOverlayはアプリの配色対象ではありません。

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

1. 録音・録画と保存の終了後に、更新したFrontendでブラウザを再読み込みする。
2. ホームの「表示テーマ」をダークにし、カード・文字・検索・会議作成・タグ画面を確認する。
3. 会議、AI設定、プロジェクトへ移動し、同じ選択が引き継がれることを確認する。
4. 要約再生成・履歴・Evidence・編集・質問・検索設定・テンプレート入力を開き、白い未対応領域や読めない文字がないか確認する。
5. ライトへ戻し、両テーマで入力内容が保持されることを確認する。音声・動画の再生中にも切り替え、再生位置が維持されることを確認する。
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
