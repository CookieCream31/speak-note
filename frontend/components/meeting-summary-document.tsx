"use client";

import { Check, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./meeting-summary-document.module.css";

interface SavedDocument {
  content: string;
  revision: number;
  updated_at: string;
}

export function MeetingSummaryDocument({ meetingId, analysisId, text, revision = 0, edited = false, readOnly, onDirtyChange }: {
  meetingId: string;
  analysisId: string;
  text?: string;
  revision?: number;
  edited?: boolean;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState({ content: text, revision, edited });
  const [draft, setDraft] = useState(text ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const saving = useRef(false);
  const dirty = editing && draft !== saved.content;

  useEffect(() => {
    onDirtyChange(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); onDirtyChange(false); };
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!editing || !textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${textarea.current.scrollHeight}px`;
  }, [editing, draft]);

  async function save() {
    if (saving.current || readOnly || saved.content === undefined) return;
    saving.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/analyses/${analysisId}/document`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, expected_revision: saved.revision }),
      });
      if (!response.ok) {
        let detail = `本文を保存できませんでした (${response.status})`;
        try {
          const body = await response.json() as { detail?: unknown };
          if (typeof body.detail === "string") detail = body.detail;
        } catch { /* Keep the status message. */ }
        throw new Error(detail);
      }
      const result = await response.json() as SavedDocument;
      setSaved({ content: result.content, revision: result.revision, edited: true });
      setDraft(result.content); setEditing(false); setMessage("本文を保存しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "本文を保存できませんでした");
    } finally { saving.current = false; setBusy(false); }
  }

  return (
    <section className={styles.document} aria-label="議事録の本文">
      <div className={styles.toolbar}>
        <span className={styles.state}>{saved.edited ? "編集済みの本文" : "要約の本文"}</span>
        {!readOnly && !editing && saved.content !== undefined && (
          <button type="button" className={styles.edit} onClick={() => { setDraft(saved.content ?? ""); setEditing(true); setError(""); setMessage(""); }}>
            <Pencil size={15} aria-hidden="true" />全文を編集
          </button>
        )}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.message} role="status"><Check size={15} aria-hidden="true" />{message}</p>}
      {editing && !readOnly ? (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <p className={styles.hint} id={`document-hint-${analysisId}`}>見出し・追記・メモも自由に編集できます。「保存」で本文を保存します。</p>
          <textarea ref={textarea} autoFocus aria-label="議事録の本文を編集" aria-describedby={`document-hint-${analysisId}`}
            value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={5_000_000} disabled={busy} rows={16} />
          <div className={styles.actions}>
            <button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            <button type="button" disabled={busy} onClick={() => {
              if (dirty && !window.confirm("保存していない変更を破棄しますか？")) return;
              setEditing(false); setDraft(saved.content ?? ""); setError("");
            }}>キャンセル</button>
            {dirty && <span>未保存の変更があります</span>}
          </div>
        </form>
      ) : (
        <div className={styles.content} data-summary-document>{saved.content === undefined
          ? "本文を取得できませんでした。ページを再読み込みしてください。"
          : saved.content || "本文は空です。「全文を編集」から追記できます。"}</div>
      )}
      <p className={styles.hint}>編集した本文はこの要約の履歴に保存されます。要約を再生成した場合も、以前の本文は履歴から開けます。</p>
    </section>
  );
}
