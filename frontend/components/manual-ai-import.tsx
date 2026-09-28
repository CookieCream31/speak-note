"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";

import type {
  AnalysisVersion,
  ManualAnalysisPreview,
  ManualAnalysisPrompt,
} from "@/lib/api";

import styles from "./manual-ai-import.module.css";

interface ManualAIImportProps {
  meetingId: string;
  available: boolean;
}

const countLabels: Record<string, string> = {
  decisions: "決定事項",
  action_items: "Action Item",
  open_questions: "未解決事項",
  important_points: "重要点",
  chapters: "チャプター",
  suggested_questions: "質問候補",
  highlights: "重要区間",
};

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `処理に失敗しました (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based message for non-JSON responses.
    }
    throw new Error(message);
  }
  return await response.json() as T;
}

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP LAN access can reject Clipboard API, so use the selection fallback.
    }
  }
  if (!fallbackCopy(text)) throw new Error("クリップボードへコピーできませんでした");
}

export function ManualAIImport({ meetingId, available }: ManualAIImportProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [prompt, setPrompt] = useState<ManualAnalysisPrompt | null>(null);
  const [responseText, setResponseText] = useState("");
  const [preview, setPreview] = useState<ManualAnalysisPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function resetFeedback() {
    setPreview(null);
    setMessage("");
    setError("");
  }

  async function preparePrompt() {
    setBusy(true);
    resetFeedback();
    try {
      const result = await request<ManualAnalysisPrompt>(
        `/meetings/${meetingId}/analyses/manual/prompt`,
      );
      setPrompt(result);
      setMessage("外部AIへ渡すプロンプトを準備しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "プロンプトを準備できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    if (!prompt) return;
    try {
      await copyText(prompt.prompt);
      setError("");
      setMessage("プロンプトをコピーしました。任意のAIチャットへ貼り付けてください");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "コピーできませんでした");
    }
  }

  function downloadPrompt() {
    if (!prompt) return;
    const url = URL.createObjectURL(new Blob([prompt.prompt], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = prompt.filename;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("プロンプトをテキストファイルで保存しました");
  }

  async function loadResponseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5_000_000) {
      setError("回答ファイルは5MB以下にしてください");
      return;
    }
    setResponseText(await file.text());
    resetFeedback();
  }

  async function validateResponse() {
    if (!prompt || !responseText.trim()) return;
    setBusy(true);
    resetFeedback();
    try {
      const result = await request<ManualAnalysisPreview>(
        `/meetings/${meetingId}/analyses/manual/validate`,
        {
          method: "POST",
          body: JSON.stringify({
            transcript_version_id: prompt.transcript_version_id,
            response_text: responseText,
          }),
        },
      );
      setPreview(result);
      setMessage("回答を検証しました。内容を確認して保存できます");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回答を検証できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function saveResponse() {
    if (!prompt || !preview) return;
    setBusy(true);
    setError("");
    try {
      const analysis = await request<AnalysisVersion>(
        `/meetings/${meetingId}/analyses/manual/import`,
        {
          method: "POST",
          body: JSON.stringify({
            transcript_version_id: prompt.transcript_version_id,
            response_text: responseText,
          }),
        },
      );
      router.push(`/meetings/${meetingId}?analysis_id=${analysis.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "議事録を保存できませんでした");
      setBusy(false);
    }
  }

  async function copyCorrectionRequest() {
    if (!error || !responseText) return;
    const correction = [
      "次のJSON回答を修正してください。JSONオブジェクトだけを返してください。",
      `検証エラー: ${error}`,
      "元の回答:",
      responseText,
    ].join("\n\n");
    try {
      await copyText(correction);
      setError("");
      setMessage("修正依頼をコピーしました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "修正依頼をコピーできませんでした");
    }
  }

  return (
    <div className={styles.launcher}>
      <button type="button" className={styles.openButton} onClick={() => setOpen(true)}>
        <span>外部AI</span>
        Ollama / Geminiを使わず作成
      </button>
      <p>プロンプトを任意のAIチャットへ渡して取り込みます。</p>

      {open && (
        <div
          className={styles.overlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-ai-title"
          >
            <header className={styles.dialogHeader}>
              <div>
                <p>MANUAL AI IMPORT</p>
                <h2 id="manual-ai-title">外部AIで議事録を作成</h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="閉じる">×</button>
            </header>
            <ol className={styles.stepper} aria-label="取り込み手順">
              <li data-complete={prompt !== null}><span>1</span>準備</li>
              <li data-complete={prompt !== null}><span>2</span>AIへ渡す</li>
              <li data-complete={responseText.trim().length > 0}><span>3</span>回答を貼る</li>
              <li data-complete={preview !== null}><span>4</span>確認・保存</li>
            </ol>
            <div className={styles.content}>
        <p className={styles.description}>
          speak-noteから外部サービスへは送信しません。プロンプトを任意のAIチャットへ渡し、
          返ってきたJSONをここで検証してから議事録として保存します。
        </p>
        <p className={styles.warning}>
          プロンプトには会議タイトルと全文の文字起こしが含まれます。送信先の利用規約・
          データ保持方針を確認し、機密情報や個人情報の取り扱いに注意してください。
        </p>
        <label className={styles.confirm}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          外部AIへ文字起こしを渡すことを確認しました
        </label>

        {!available && <p className={styles.error}>確定文字起こしが完了すると利用できます。</p>}
        {(message || error) && (
          <p className={error ? styles.error : styles.message} role="status">
            {error || message}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            disabled={!available || !confirmed || busy}
            onClick={() => void preparePrompt()}
          >
            1. プロンプトを準備
          </button>
          <button type="button" disabled={!prompt || !confirmed || busy} onClick={() => void copyPrompt()}>
            コピー
          </button>
          <button type="button" disabled={!prompt || !confirmed || busy} onClick={downloadPrompt}>
            TXT保存
          </button>
        </div>

        {prompt && (
          <>
            <label className={styles.responseLabel} htmlFor="manual-ai-response">
              2. AIのJSON回答を貼り付け
            </label>
            <textarea
              id="manual-ai-response"
              value={responseText}
              onChange={(event) => { setResponseText(event.target.value); resetFeedback(); }}
              rows={10}
              maxLength={5_000_000}
              placeholder="AIが返したJSONをそのまま貼り付けてください。```json ... ```でも検証できます。"
            />
            <div className={styles.actions}>
              <label className={styles.fileButton}>
                JSON / TXTを読み込む
                <input type="file" accept=".json,.txt,text/plain,application/json" onChange={(event) => void loadResponseFile(event)} />
              </label>
              <button
                type="button"
                disabled={!responseText.trim() || busy}
                onClick={() => void validateResponse()}
              >
                3. 回答を検証
              </button>
              {error && responseText && (
                <button type="button" disabled={busy} onClick={() => void copyCorrectionRequest()}>
                  AIへの修正依頼をコピー
                </button>
              )}
            </div>
          </>
        )}

        {preview && (
          <section className={styles.preview} aria-label="手動AI回答のプレビュー">
            <h4>保存前プレビュー</h4>
            <p>{preview.summary}</p>
            <ul className={styles.counts}>
              {Object.entries(preview.item_counts).map(([kind, count]) => (
                <li key={kind}>{countLabels[kind] ?? kind}: {count}</li>
              ))}
            </ul>
            <ol className={styles.chapters}>
              {preview.chapters.map((chapter, index) => (
                <li key={`${chapter.start_ms}-${index}`}>
                  <time>{formatTimestamp(chapter.start_ms)}–{formatTimestamp(chapter.end_ms)}</time>
                  {chapter.title}
                </li>
              ))}
            </ol>
            <button type="button" disabled={busy} onClick={() => void saveResponse()}>
              4. 議事録として保存
            </button>
          </section>
        )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
