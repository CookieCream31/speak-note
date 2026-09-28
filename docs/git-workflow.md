# Git運用ガイド

[READMEへ戻る](../README.md) · [開発ガイド](development.md)

最終照合: 2026-09-28。

## 現在の状態

`/home/llm/speak-note` をGitの `main` ブランチで管理します。現在の実装を初回commitの基準点として保存します。`origin` は `https://github.com/CookieCream31/speak-note.git` に設定済みです。現在の環境ではHTTPS認証が未設定のため、`git ls-remote` はユーザー名を取得できず、リモート履歴を未確認です。初回pushは認証とリモート履歴の確認後に行います。WhisperX API ServerとLLM Serverは別Projectで、このリポジトリへ含めません。

`.gitignore` は `.env` とその派生ファイル（`.env.example` を除く）、`storage/`、`backend/storage/`、DB、`node_modules/`、`.next/`、Pythonキャッシュ、ログ、`.orig` 等のバックアップ、鍵ファイルを除外します。既にGitへ登録されたファイルには後からのignore設定だけでは効かないため、毎回stage一覧を確認してください。録音データや本物の認証情報を登録しません。

## 機能ごとの手順

```bash
cd /home/llm/speak-note
git status --short
# 実装、README・関連docsの更新、適切なテストを実行
git add <今回変更したファイル>
git diff --cached --check
git diff --cached --stat
git diff --cached
# 内容に問題がなければ
git commit -m "feat: 変更内容を短く説明"
git status --short
# リモート設定後のみ
git push origin main
```

修正は `fix:`、文書だけは `docs:` など、内容が分かる短いcommitメッセージを使います。複数の機能を一度にstageしません。共有前の履歴を書き換える場合も、既に共有した履歴のrebase・force pushは通常行いません。commitの作成にはGitの表示名とメールアドレスの設定が必要です。共有リポジトリでは個人の秘密メールを避けたい場合、GitHubの非公開メールなどを利用できます。

## リモートを作成した後

GitHub等でリポジトリを作り、`origin` のURLを確認します。現在のURLは上記のとおりです。認証情報をREADMEや`.env`へ保存しません。リモート側でREADMEや初回commitを作成している場合は、push前に履歴を確認して統合方法を決めます。既存履歴をforce pushで上書きしません。

```bash
cd /home/llm/speak-note
git remote -v
git ls-remote --symref origin HEAD
git push -u origin main
```

初回以降は機能単位のcommitごとに `git push origin main` を実行します。認証はホストのSSH鍵やCredential Manager等を使い、トークンをコマンド文字列・ソース・ログへ埋め込みません。送信先や権限が分からない場合はpushを止め、ローカルcommitを保持して報告します。
