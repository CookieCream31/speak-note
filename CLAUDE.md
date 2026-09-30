# CLAUDE.md

このリポジトリの作業ルールは AGENTS.md に従う。

@AGENTS.md

## リデザイン作業

画面デザインの変更は `docs/redesign.md` の段階（第1〜第4段階）に沿って進める。
完成形の見た目は `docs/redesign/mockups/*.dc.html`（静的なHTMLのモックアップ）を参照する。
1段階（画面ごとの作業なら1画面）ごとに `cd frontend && npm test && npm run typecheck && npm run lint` を通してから commit する。
