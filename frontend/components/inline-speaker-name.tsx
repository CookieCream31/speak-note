"use client";

import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useState,
} from "react";

import type { Speaker } from "@/lib/api";
import { dispatchSpeakerRenamed } from "@/lib/speaker-events";

import styles from "./inline-speaker-name.module.css";

interface InlineSpeakerNameProps {
  meetingId: string;
  speakerId: string;
  speakerName: string;
}

export function InlineSpeakerName({
  meetingId,
  speakerId,
  speakerName,
}: InlineSpeakerNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(speakerName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function cancel() {
    setDraft(speakerName);
    setError("");
    setEditing(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = draft.trim();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/speakers/${speakerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName || null }),
      });
      if (!response.ok) {
        let message = `話者名を保存できませんでした (${response.status})`;
        try {
          const body = await response.json() as { detail?: string };
          if (body.detail) message = body.detail;
        } catch {
          // Keep the status-based message.
        }
        throw new Error(message);
      }

      const speaker = await response.json() as Speaker;
      const nextName = speaker.display_name ?? speaker.internal_name;
      dispatchSpeakerRenamed({
        speakerId: speaker.id,
        displayName: speaker.display_name,
        speakerName: nextName,
      });
      setDraft(nextName);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "話者名を保存できませんでした");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.nameButton}
        onClick={() => { setDraft(speakerName); setError(""); setEditing(true); }}
        aria-label={`${speakerName}の名前を変更`}
        title="クリックして話者名を変更"
      >
        {speakerName}<span aria-hidden="true">✎</span>
      </button>
    );
  }

  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={200}
        aria-label={`${speakerName}の新しい名前`}
      />
      <div className={styles.actions}>
        <button type="submit" disabled={busy}>{busy ? "保存中" : "保存"}</button>
        <button type="button" onClick={cancel} disabled={busy}>取消</button>
      </div>
      {error && <span className={styles.error} role="alert">{error}</span>}
    </form>
  );
}
