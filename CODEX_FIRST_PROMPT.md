# Codex 最初のプロンプト

以下をそのままCodexへ渡す。

```text
このリポジトリにAI議事録Webアプリ「speak-note」を実装します。

まず以下を全文読んでください。

- DESIGN.md
- AGENTS.md

DESIGN.mdをこのプロジェクトの仕様の正としてください。
AGENTS.mdのルールを必ず守ってください。

この段階ではコード変更を開始しないでください。

まず現在のリポジトリと実行環境を調査し、Phase 1の実装計画を作成してください。

確認してほしい内容:

1. 現在のリポジトリ構成
2. DESIGN.mdの要件整理
3. frontend / backend / database / worker の責務
4. 推奨ディレクトリ構成
5. Phase 1で必要なDBテーブル
6. Phase 1で必要なAPI
7. Docker Compose構成
8. 開発用ポート構成
9. Phase 1で変更・作成予定のファイル
10. 仕様上の不明点・矛盾・技術的リスク

前提:

- 開発はUbuntu Server上で行う
- MacのVS CodeからRemote SSHで接続して開発する
- speak-note自体はDocker Composeで動かす
- WhisperX Serverは既存の外部サービスとして利用する
- Ollamaも既存の外部サービスとして利用する
- WhisperXやOllamaの既存プロジェクトは変更しない
- WhisperXは localhost:8000
- Ollamaは localhost:11434
- speak-note Backendは8001番を使用する
- Frontendは3000番を使用する
- PostgreSQLはspeak-note専用Containerを使用する

重要:

- 今回はまだ実装しない
- 勝手にPhase 2以降へ進まない
- 不明な部分を推測で実装しない
- 既存サービスへ影響する操作をしない

最後に以下の形式で報告してください。

## 実装計画

## ディレクトリ構成

## DB設計

## API一覧

## Docker構成

## Phase 1変更予定ファイル

## 確認が必要な点

私が計画を確認するまでコード変更は開始しないでください。
```
