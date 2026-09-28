# Git運用ガイド

[READMEへ戻る](../README.md) · [開発ガイド](development.md)

最終照合: 2026-09-28。

## 現在の状態

`/home/llm/speak-note` をGitの `main` ブランチで管理します。現在の実装は初回commit `1b6d52e` に保存しました。`origin` はSSHの `git@github.com:CookieCream31/speak-note.git` です。専用Deploy keyの公開鍵をGitHubへ書き込み許可で登録し、空のリモートへ初回commitをpushしました。`main` は `origin/main` を追跡しています。WhisperX API ServerとLLM Serverは別Projectで、このリポジトリへ含めません。

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

## SSH認証とGitHubへの送信

GitHubの `CookieCream31/speak-note` を作成し、`origin` のSSH URLを確認しました。このサーバー専用のEd25519鍵は `.git/keys/speak-note_ed25519` に保存し、権限を0600にしています。公開鍵は同名の `.pub` ファイルです。GitHubのリポジトリで **Settings → Deploy keys → Add deploy key** を開き、公開鍵を **Allow write access** で登録済みです。[GitHub公式手順](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)。

秘密鍵はGitに追加されず、このチェックアウトの `.git/` にだけあります。新しい環境へのcloneにはこの鍵を含めず、新しいホストで別のSSH鍵を作成・登録します。[新規環境での起動手順](../README.md#fresh-install)。自動push用なのでこのサーバーの鍵にパスフレーズは設定していません。サーバーへのアクセス権を限定し、不要になった場合や漏えいが疑われる場合はGitHubのDeploy keyを削除して鍵を更新します。ホスト鍵は[GitHub公式のEd25519指紋](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)と照合したうえで `.git/keys/known_hosts` に固定しています。

認証情報をREADMEや`.env`へ保存しません。初回push前の `git ls-remote` でリモートに既存ブランチがないことを確認しました。今後も履歴の競合をforce pushで上書きしません。

```bash
cd /home/llm/speak-note
git remote -v
git ls-remote --symref origin HEAD
git push origin main
```

初回以降は機能単位のcommitごとに `git push origin main` を実行します。認証はこのリポジトリ専用のSSH鍵を使い、トークンや秘密鍵をソース・ログへ埋め込みません。送信先や権限が分からない場合はpushを止め、ローカルcommitを保持して報告します。
