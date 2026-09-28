# AGENTS.md

## Project

このプロジェクト名は `speak-note`。

作業対象:

```text
/home/llm/speak-note
```

Codexは原則としてこのディレクトリ内だけを変更すること。

---

## Existing Services

以下は既存サービスであり、`speak-note` から利用するだけとする。

```text
/home/llm/whisperx-api-server
/home/llm/llm-server
```

明示的な指示がない限り、これらの:

```text
source code
.env
compose files
Docker containers
Docker volumes
Docker networks
model files
```

を変更・削除しないこと。

WhisperX:

```text
http://localhost:8000
```

Ollama:

```text
http://localhost:11434
```

---

## Docker Safety

`speak-note` 用Dockerリソースだけを操作すること。

明示的な許可なく以下を実行しない。

```text
docker system prune
docker volume prune
docker network prune
```

他ProjectのContainer・Volume・Networkを削除しないこと。

Compose操作を行う場合、可能な限り `/home/llm/speak-note` 内から実行すること。

---

## Development Environment

開発はUbuntu Server上で行う。

MacはVS Code Remote SSHを使う操作端末であり、アプリケーション自体はUbuntu上で実行する。

`speak-note` はDocker Composeで動かす。

想定Port:

```text
Frontend  3000
Backend   8001
WhisperX  8000
Ollama    11434
```

---

## Specification

`DESIGN.md` を仕様の正とする。

実装前に必ず:

```text
DESIGN.md
AGENTS.md
既存コード
```

を確認すること。

DESIGN.mdと実際の技術制約が衝突する場合、勝手に仕様変更せず問題点と推奨案を報告すること。

---

## Scope Control

ユーザーが指定したPhaseのみ実装すること。

Phase 1を依頼された場合、Phase 2以降を勝手に実装しない。

将来機能のための過剰な抽象化を避ける。

ただし以下は交換可能な境界を維持する。

```text
WhisperX Client
LLM Provider
Storage
FFmpeg / Media Service
Job Worker
```

---

## Timeline

会議内の時間はDBでは整数ミリ秒を基本とする。

```text
start_ms
end_ms
timestamp_ms
```

浮動小数秒をDB上の主要表現として使用しない。

秒への変換はPlayerや外部API境界で行う。

---

## Long Running Jobs

以下の長時間処理を通常のHTTP Request内で完了まで待たない。

```text
FFmpeg
WhisperX transcription
diarization
AI analysis
thumbnail generation
```

Job + Workerを利用する。

---

## Secrets

以下をSource Codeへハードコードしない。

```text
API Key
Token
Password
Encryption Key
Database Password
```

`.env` をGitへCommitしない。

`.env.example` にはダミー値のみ記載する。

Frontendへ以下を返さない。

```text
WHISPERX_API_KEY
Gemini API Key
Encryption Key
その他Secret
```

Secretをlogへ出力しない。

---

## Media Safety

Uploadした元ファイル名をそのままStorage Pathに使用しない。

Path Traversalを防止する。

MIME Typeと許可拡張子を検証する。

ユーザー入力を任意のFFmpeg optionとして渡さない。

Original Mediaは原則変更しない。

---

## Database

DB変更時はAlembic Migrationを作成すること。

Schemaを手動変更だけで済ませない。

Relationship / Cascade Delete / Transaction境界を意識する。

---

## External APIs

WhisperX、Ollama、Gemini等のClientはService層へ分離する。

Unit Testでmock可能にする。

外部API障害時にJobをfailedへ遷移させ、errorを記録できるようにする。

---

## AI Rules

AI Outputは可能な限りPydanticでStructured Validationする。

AIに不明情報を推測させない。

例:

```text
assigneeが不明 → null
deadlineが不明 → null
```

AI Evidenceで返されたTranscript Segment IDはBackendでも存在確認する。

存在しないIDを保存しない。

AI生成状態とユーザー確定・編集状態を区別する。

---

## Realtime

Realtime Transcriptは暫定版として扱う。

ChunkごとのSpeaker Labelを永久的な人物IDとみなさない。

会議終了後の全体WhisperX処理をFinal Transcriptとして優先する。

---

## Code Quality

機能追加・修正・設定変更のたびに、実装と`README.md`を照合すること。
機能、操作、構成、環境変数、起動・反映・テスト手順、制約に影響する場合は、コードと同じ作業で`README.md`および該当する`docs/`のガイドを更新する。
READMEの変更が不要な場合も照合を省略せず、終了報告にその理由を記す。
READMEを更新した場合は、記載された最終照合日も更新する。

既存コードを確認してから変更する。

不要な全面rewriteを行わない。

責務の異なる処理を巨大な1ファイルへまとめない。

新しい環境変数を追加した場合:

```text
.env.example
README.md
```

を更新する。

---

## Version Control

このProjectはGitで管理する。機能追加・修正ごとに、実装・必要なREADME/docs更新・検証を終えてから1つのまとまった変更としてcommitする。ユーザーが明示的に別の進め方を指定した場合は従う。

作業前後に `git status --short` を確認し、既存変更と他者の変更を勝手に含めたり戻したりしない。対象ファイルだけをstageし、`git diff --cached --check` とstage内容を確認してからcommitする。テスト結果と未解決事項を報告する。

`.env`、認証情報、録音・録画、DB、生成物、バックアップをGitへ追加しない。リモートが設定された後は機能単位のcommitをpushする。リモート未設定や認証失敗時はローカルcommitまで進め、pushできなかった理由を報告する。履歴の改変・force pushは明示的な指示がない限り行わない。

---

## Testing

実装後、利用可能な範囲で以下を実行する。

```text
formatter
lint
type check
unit test
```

テストを通すために以下を行わない。

```text
test削除
skip追加
assertion弱体化
機能の無効化
```

失敗した場合は原因を調査する。

---

## Reporting

作業終了時は必ず以下を報告する。

```text
1. 変更したファイル
2. 実装内容
3. 実行したコマンド
4. テスト結果
5. 未解決事項
```
