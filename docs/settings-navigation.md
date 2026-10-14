# 設定と会議作成の入口

最終照合: 2026-10-15（会議の設定アイコンと文字起こしのサイズ・幅を追加照合）。[README](../README.md) · [操作](usage.md#設定) · [Frontend反映](operations.md#settings-navigation)

「AI設定」の画面名・ナビゲーション・会議詳細の入口を「設定」と歯車アイコンへ統一しました。URLは`/settings/ai`を維持し、既存の保存先・リンク・接続情報を変更しません。表示テーマを設定画面の先頭と目次へ移し、名前とアイコンのある3択ボタンにしました。幅560px以下では縦に並び、44px以上の高さを維持します。

ホーム・会議詳細・プロジェクト・テンプレート・404／エラーのヘッダーからテーマ選択を外しました。初回描画前のScriptと`ThemeObserver`によって、操作UIがないページも保存テーマ・OS追従・別タブ同期を維持します。テーマ変更は即時にブラウザへ保存し、AIフォームの保存とは独立しています。設定ページのAIデータ取得は従来どおりBackendを使います。

会議詳細のヘッダーへ「新しい会議」を追加し、`/?create=1`で既存の3方式の作成ダイアログを開きます。録音開始前・録音／録画・保存中の会議では、設定と会議作成を別タブで開いて元の画面を維持します。別タブで開くことをTooltip・読み上げ用ラベルへ示します。完了した会議では通常のページ移動です。スマートフォンでは設定と作成を44pxのアイコンボタンで表示します。

会議内の設定はPCでも歯車アイコンだけです。本文は画面幅によらず16pxに揃え、左右表示の文字起こし側を最大720pxへ広げました。[2026-10-15の表示改善](#meeting-readability)。以下は設定集約を実装した時点の変更・検証記録です。

## 変更ファイル

| ファイル（計30件） | 内容 |
| --- | --- |
| `frontend/components/ai-settings-manager.tsx` | 設定への改称、先頭と目次に表示テーマを追加 |
| `frontend/components/theme-selector.tsx`、`theme-selector.module.css` | 名前付き3択・44px操作領域・スマートフォンの縦配置 |
| `frontend/components/theme-observer.tsx`、`frontend/app/layout.tsx`、`global-error.tsx` | 選択UIのないページでもOS・storageを監視 |
| `frontend/components/meetings-manager.tsx`、`app-sidebar.tsx`、`project-manager.tsx` | 名称・歯車アイコン、ヘッダーのテーマ選択を移動 |
| `frontend/app/meetings/[meeting_id]/page.tsx`、`page.module.css` | 設定と会議作成の入口、録音画面を維持、モバイル操作 |
| `frontend/app/settings/templates/page.tsx`、`frontend/app/page.tsx`、`frontend/components/answer-assist-panel.tsx` | パンくず・案内を現行の設定名へ揃える |
| `frontend/components/app-status-page.tsx`、`app-status-page.module.css` | エラー画面はテーマ選択を設定への入口へ変更 |
| `frontend/components/{settings-navigation,theme-observer,theme-selector,app-status-page}.test.tsx` | 設定内の選択、未保存入力・音声保持、OS・別タブ同期、エラーの再試行 |
| `frontend/app/meetings/[meeting_id]/page.test.tsx`、`frontend/lib/theme-styles.test.ts` | 完了・録音・保存中のリンク、全ヘッダーで重複選択なし、Observerと配色 |
| `README.md`、`DESIGN.md`、`docs/{settings-navigation,usage,dark-mode,development,operations,meeting-templates}.md` | 現行名称・操作・反映・適用範囲・検証 |

## 検証

Node 22.16.0（`/tmp/node-v22.16.0-linux-x64/bin/node`）から実行しました。

```bash
# frontend内
node node_modules/vitest/vitest.mjs run components/settings-navigation.test.tsx components/theme-observer.test.tsx components/theme-selector.test.tsx components/app-status-page.test.tsx lib/theme-styles.test.ts lib/theme.test.ts 'app/meetings/[meeting_id]/page.test.tsx'
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
# Project内
git diff --check
```

関連51件、Frontend全体57ファイル402件、型チェック・ESLint・空白検査が成功しました。旧テストの「各ヘッダーにテーマ選択」は現行仕様の「設定内へ集約・全画面の監視」へ変更し、保存・Hydration・OS・別タブ同期・入力保持・エラー再試行の検証を維持しています。新しく8件追加し、テーマ操作でAI入力や音声要素を作り直さないこと、ホームの会議作成、会議詳細の録音／保存中に元のタブを閉じないリンクを確認しました。Frontend専用formatterは未設定で、既存の記法に合わせて限定差分を確認しました。Backend・DBを変更していないため、その検証は再実行していません。

Chromiumの一時プレビューで、実Component・CSS・ホーム／設定／テンプレートのデータ取得処理・会議詳細の実ヘッダーを使用しました。ライト／ダーク×幅320・393・560・844・1280・1920px×ホーム・設定・テンプレート・プロジェクト・完了会議・録音画面のヘッダー・404の7画面、84条件が成功しました。横はみ出しなし・page errorなし・名前付きテーマ選択・mobileの44px操作領域を確認しています。設定と会議作成の実際の別タブ遷移、作成ダイアログの3方式、OS追従・設定変更の別タブ同期、元の入力・再生中の合成音声の保持も確認しました。

```bash
FONTCONFIG_FILE=/tmp/speak-note-provisional-speakers-browser/fonts.conf \
PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers \
LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu \
XDG_CACHE_HOME=/tmp/speak-note-browser-font-cache \
/tmp/speak-note-title-speed-verify-env/bin/python /tmp/speak-note-settings-navigation-browser/check.py
```

一時プレビューの初回実行は、検証用bundleのBackend環境変数の置換不足（`process is not defined`）で表示できませんでした。一時bundleを修正して再実行し、アプリの環境変数やDockerを変更していません。録音・外部API・DBへの保存は模擬です。実マイク／画面共有・Safari／iPhone実機・Docker反映は未検証で、別タブやバックグラウンドでの録音継続はブラウザ・OSの制約があります。依存・環境変数・Migrationの追加はありません。

## 反映と確認

録音・録画と保存を終えてから[Frontendだけの反映](operations.md#settings-navigation)を行います。エージェントは稼働Dockerを再起動していません。

1. ホーム・スマートフォンのタブバー・会議詳細に「設定」と歯車があることを確認します。
2. 設定の「表示テーマ」でダーク／ライト／システムを選び、保存ボタンなしで反映・再読込後の保持・別タブ同期・OS追従を確認します。
3. 保存済み会議のヘッダーで「新しい会議」を押し、3方式の作成ダイアログを開きます。
4. 録音画面で設定・会議作成を開いた場合、元の会議タブを閉じずに残します。テーマ変更で元の会議の色も変わることを確認します。
5. AI接続・プロファイル・文字起こし設定・テンプレートの保存や接続テストを従来どおり操作できることを確認します。

<a id="meeting-readability"></a>
## 会議の設定アイコンと文字起こしの表示改善（2026-10-15）

文字起こしの本文は`clamp(16px, 1.45vw, 20px)`で画面幅に応じて大きくなる一方、左右表示の左欄は最大620pxでした。本文・録音中の途中表示を16pxに揃え、保存後と録音中の両レイアウトで左欄の上限を720pxへ広げました。1279px以下の上下配置・幅、字幕設定、文字起こしデータ・録音・時刻の処理は保持します。翻訳は親の文字サイズを継承するため16pxで揃います。

会議ヘッダーの設定をすべての画面幅で歯車アイコンだけにしました。通常34px、560px以下44pxの正方形ボタンにし、読み上げ名・Tooltip、録音／保存中の別タブ遷移を維持します。

変更した11ファイル:

| ファイル | 内容 |
| --- | --- |
| `frontend/app/meetings/[meeting_id]/{page.tsx,page.module.css,page.test.tsx}` | 設定アイコン、中央配置、操作名・遷移の検証 |
| `frontend/components/meeting-workspace.module.css` | 保存後の左欄を最大720pxへ拡大 |
| `frontend/components/transcript-player.module.css` | 保存済み原文を16pxへ統一 |
| `frontend/components/realtime-analysis-panel.module.css` | 録音中の原文・途中表示を16px、左欄を最大720pxへ統一 |
| `README.md`、`DESIGN.md`、`docs/{settings-navigation,usage,operations}.md` | 操作・サイズ・適用範囲・検証・反映を更新 |

実行コマンド（Node 22.16.0の`/tmp/node-v22.16.0-linux-x64/bin/node`）:

```bash
# frontend内
node node_modules/vitest/vitest.mjs run 'app/meetings/[meeting_id]/page.test.tsx' lib/theme-styles.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
# Project内
git diff --check
```

関連27件、Frontend全体57ファイル402件、型チェック・ESLint・空白検査が成功しました。既存の会議ヘッダーの3状態のテストへアイコンのみ・読み上げ名・Tooltipの確認を追加しました。Frontend専用formatterは未設定で、既存書式に合わせた限定差分を確認しています。Backend・DBを変更していないため、その検証は再実行していません。

Chromiumでは設定アイコンをライト／ダーク×幅320・393・560・844・1280・1920px×完了／録音画面の24条件で確認しました。正方形の大きさ・中央配置・横はみ出しなし・page errorなし、通常遷移と録音画面を維持する別タブ遷移が成功しました。文字起こしは実Component・CSSを使い、ライト／ダーク×幅320・393・560・844・1279・1280・1920・3840px×保存音声／保存動画／録音中の48条件を修正前後で比較しました。全条件で16px、左右表示で欄と本文が100px広がること、モバイルの幅・原文・単語ハイライトの保持、途中原文・翻訳の同じサイズ、横はみ出しなし・page errorなしを確認しました。

検証コマンドは、`FONTCONFIG_FILE=/tmp/speak-note-provisional-speakers-browser/fonts.conf PLAYWRIGHT_BROWSERS_PATH=/tmp/speak-note-browsers LD_LIBRARY_PATH=/tmp/speak-note-browser-libs/usr/lib/x86_64-linux-gnu XDG_CACHE_HOME=/tmp/speak-note-browser-font-cache /tmp/speak-note-title-speed-verify-env/bin/python`に続けて、`/tmp/speak-note-settings-navigation-browser/check_settings_icon.py`と`/tmp/speak-note-meeting-readability-browser/check.py`を実行しました。一時server・合成WAV・模擬APIだけを使用し、運用会議を変更していません。

実マイク・画面共有・Safari／iPhone実機・Docker反映は未検証です。追加Migration・依存・環境変数はありません。録音・録画と保存の終了後に[Frontendだけの反映](operations.md#settings-navigation)を行い、会議ページを再読み込みして設定アイコンと文字サイズ・幅を確認します。再録音・文字起こし再処理は不要です。
