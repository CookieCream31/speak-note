# モックアップ

Claude の Design キャンバスから書き出した静的な HTML です（実装用のコードではありません）。
スタイルはすべて各要素の `style` 属性に書いてあるので、余白・サイズ・角丸はソースから読み取ってください。

- `{{c.xxx}}` は色トークン。ファイル末尾の `<script>` にライト／ダークの値があり、`docs/redesign.md` の配色表と対応します。
- `[ ]` で囲んだ文字は仮の文言です。
- `<sc-if>` `<sc-for>` はキャンバス用の分岐・繰り返しです。

| ファイル | 画面 |
| --- | --- |
| Style.dc.html | スタイルガイド |
| Main.dc.html | ホーム（会議一覧） |
| Meeting.dc.html | 会議詳細（チャプター／文字起こしタブ＋要約） |
| MeetingPanels.dc.html | 会議詳細の質問タブ・検索・ツールタブ |
| NewMeeting.dc.html | 新しい会議ダイアログ |
| LiveMeeting.dc.html | 録画・録音中 |
| Projects.dc.html | プロジェクト |
| AISettings.dc.html | AI設定 |
| TemplateEditor.dc.html | 議事録テンプレート |
| Dialogs.dc.html | 要約の再生成・タグ管理・404 |
| M*.dc.html | スマホ版（ホーム・新しい会議・会議詳細・録音中・プロジェクト・AI設定） |
