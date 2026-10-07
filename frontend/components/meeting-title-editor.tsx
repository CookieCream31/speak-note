"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { meetingsApi } from "@/lib/api";
import styles from "./meeting-title-editor.module.css";

export function MeetingTitleEditor({ meetingId, title }: { meetingId: string; title: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const restoreFocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setEditing(false);
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const nextTitle = draft.trim();
    if (!nextTitle || nextTitle.length > 200) {
      setError("タイトルを1〜200文字で入力してください");
      return;
    }
    if (nextTitle === title) {
      close();
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await meetingsApi.update(meetingId, { title: nextTitle });
      close();
      setMessage("タイトルを保存しました");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "タイトルを保存できませんでした");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={styles.editor}>
      {editing ? (
        <form className={styles.form} onSubmit={(event) => void save(event)}>
          <label htmlFor={"meeting-title-" + meetingId}>会議タイトル</label>
          <input
            ref={input}
            id={"meeting-title-" + meetingId}
            value={draft}
            required
            maxLength={200}
            disabled={busy}
            onChange={(event) => { setDraft(event.target.value); setError(""); }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending.current) {
                event.preventDefault();
                close();
              }
            }}
          />
          <div className={styles.actions}>
            <button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            <button type="button" disabled={busy} onClick={close}>キャンセル</button>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </form>
      ) : (
        <div className={styles.heading}>
          <h1>{title}</h1>
          <button
            ref={trigger}
            className={styles.editButton}
            type="button"
            aria-label="会議タイトルを編集"
            title="会議タイトルを編集"
            onClick={() => { setDraft(title); setError(""); setMessage(""); setEditing(true); }}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {message && <p className={styles.message} role="status">{message}</p>}
    </div>
  );
}
