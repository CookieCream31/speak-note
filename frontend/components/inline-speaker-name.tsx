"use client";

import { Pencil } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { Speaker, TranscriptSegment } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error-message";
import {
  dispatchLiveSpeakerRenamed,
  dispatchSpeakerRenamed,
  LIVE_SPEAKER_RENAMED_EVENT,
  liveSpeakerRenamedDetail,
  SPEAKER_RENAMED_EVENT,
  speakerRenamedDetail,
} from "@/lib/speaker-events";

import styles from "./inline-speaker-name.module.css";

interface InlineSpeakerNameProps {
  meetingId: string;
  speakerId?: string | null;
  segmentIds?: string[];
  provisionalSpeakerLabel?: string | null;
  speakerName: string;
}

export function InlineSpeakerName({
  meetingId,
  speakerId,
  segmentIds,
  provisionalSpeakerLabel,
  speakerName,
}: InlineSpeakerNameProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(speakerName);
  const [draft, setDraft] = useState(speakerName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const unknownSpeaker = provisionalSpeakerLabel === null || provisionalSpeakerLabel === "SPEAKER_UNKNOWN";

  useEffect(() => {
    const syncSpeaker = (event: Event) => {
      const detail = speakerRenamedDetail(event);
      if (detail && detail.speakerId === speakerId) setName(detail.speakerName);
    };
    const syncLiveSpeaker = (event: Event) => {
      const detail = liveSpeakerRenamedDetail(event);
      if (detail && segmentIds?.some((id) => detail.segmentIds.includes(id))) {
        setName(detail.speakerName);
      }
    };
    window.addEventListener(SPEAKER_RENAMED_EVENT, syncSpeaker);
    window.addEventListener(LIVE_SPEAKER_RENAMED_EVENT, syncLiveSpeaker);
    return () => {
      window.removeEventListener(SPEAKER_RENAMED_EVENT, syncSpeaker);
      window.removeEventListener(LIVE_SPEAKER_RENAMED_EVENT, syncLiveSpeaker);
    };
  }, [speakerId, segmentIds]);

  function cancel() {
    if (pending.current) return;
    setDraft(name);
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
    if (pending.current) return;
    const displayName = draft.trim();
    if (displayName.length > 200) {
      setError("話者名は200文字以内で入力してください");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const live = !speakerId && Boolean(segmentIds?.length);
      if (!speakerId && !live) throw new Error("変更対象の話者が見つかりません");
      const path = live ? "transcript/live-speaker-name" : `speakers/${speakerId}`;
      const response = await fetch(`/api/v1/meetings/${meetingId}/${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName || null, ...(live ? { segment_ids: segmentIds } : {}) }),
      });
      if (!response.ok) {
        let message = `話者名を保存できませんでした (${response.status})`;
        try {
          message = apiErrorMessage(await response.json(), message);
        } catch {
          // Keep the status-based message.
        }
        throw new Error(message);
      }

      let nextName: string;
      if (live) {
        const segments = await response.json() as TranscriptSegment[];
        nextName = segments[0].provisional_speaker_name ?? segments[0].provisional_speaker_label ?? "話者不明";
        dispatchLiveSpeakerRenamed({ segmentIds: segments.map((segment) => segment.id), speakerName: nextName });
      } else {
        const speaker = await response.json() as Speaker;
        nextName = speaker.display_name ?? speaker.internal_name;
        dispatchSpeakerRenamed({
          speakerId: speaker.id,
          displayName: speaker.display_name,
          speakerName: nextName,
        });
      }
      setName(nextName);
      setDraft(nextName);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "話者名を保存できませんでした");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.nameButton}
        onClick={() => { setDraft(name); setError(""); setEditing(true); }}
        aria-label={`${name}の名前を変更`}
        title={speakerId ? "クリックして話者名を変更" : unknownSpeaker
          ? "この発言の話者名を変更（暫定）" : "同じ話者番号の名前を全体に反映（暫定）"}
      >
        {name}<span aria-hidden="true"><Pencil size={12} /></span>
      </button>
    );
  }

  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      {!speakerId && <span className={styles.scope}>{unknownSpeaker
        ? "この発言の話者名（暫定）" : "同じ話者番号を全体に反映（暫定）"}</span>}
      <input
        autoFocus
        disabled={busy}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={200}
        aria-label={`${name}の新しい名前`}
      />
      <div className={styles.actions}>
        <button type="submit" disabled={busy}>{busy ? "保存中" : "保存"}</button>
        <button type="button" onClick={cancel} disabled={busy}>取消</button>
      </div>
      {error && <span className={styles.error} role="alert">{error}</span>}
    </form>
  );
}
