"use client";

import { useRef, useState, type FormEvent } from "react";

import type { Meeting, RealtimeTranslationConfig } from "@/lib/api";
import { MeetingLanguageFields, type MeetingLanguageSelection } from "./meeting-language-fields";

import styles from "./meeting-transcription-settings.module.css";

interface MeetingTranscriptionSettingsProps {
  meetingId: string;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  disabled: boolean;
  languageHints?: string[] | null;
  languageHintsStrict?: boolean;
  includeRealtime?: boolean;
  languageLocked?: boolean;
  realtimeTranslation?: RealtimeTranslationConfig | null;
  translationLocked?: boolean;
}

function parseCount(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("1以上の整数を入力してください");
  }
  return parsed;
}

export function MeetingTranscriptionSettings({
  meetingId,
  minSpeakers,
  maxSpeakers,
  disabled,
  languageHints = null,
  languageHintsStrict = false,
  includeRealtime = true,
  languageLocked = false,
  realtimeTranslation = null,
  translationLocked = false,
}: MeetingTranscriptionSettingsProps) {
  const [language, setLanguage] = useState<MeetingLanguageSelection>({ hints: languageHints, strict: languageHintsStrict, translation: realtimeTranslation });
  const [minimum, setMinimum] = useState(minSpeakers?.toString() ?? "");
  const [maximum, setMaximum] = useState(maxSpeakers?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const requestPending = useRef(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || requestPending.current) return;
    requestPending.current = true;
    setMessage("");
    setMessageIsError(false);
    try {
      const nextMinimum = parseCount(minimum);
      const nextMaximum = parseCount(maximum);
      if (
        nextMinimum !== null
        && nextMaximum !== null
        && nextMinimum > nextMaximum
      ) {
        throw new Error("最小は最大以下にしてください");
      }
      setSaving(true);
      const response = await fetch(`/api/v1/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          min_speakers: nextMinimum,
          max_speakers: nextMaximum,
          ...(!languageLocked && language.hints !== null ? {
            transcription_language_hints: language.hints,
            transcription_language_hints_strict: language.strict,
          } : {}),
          ...(!translationLocked && JSON.stringify(language.translation ?? null) !== JSON.stringify(realtimeTranslation) ? { realtime_translation: language.translation ?? null } : {}),
        }),
      });
      if (!response.ok) {
        let detail = "文字起こし設定を保存できませんでした";
        try {
          const payload = await response.json() as { detail?: unknown };
          if (typeof payload.detail === "string") detail = payload.detail;
        } catch {
          // Keep the generic message for non-JSON responses.
        }
        throw new Error(detail);
      }
      const meeting = await response.json() as Meeting;
      setMinimum(meeting.min_speakers?.toString() ?? "");
      setMaximum(meeting.max_speakers?.toString() ?? "");
      setLanguage({ hints: meeting.transcription_language_hints ?? null, strict: meeting.transcription_language_hints_strict ?? false, translation: meeting.realtime_translation ?? null });
      setMessage("保存済み。次の文字起こしから適用します");
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "文字起こし設定を保存できませんでした");
    } finally {
      requestPending.current = false;
      setSaving(false);
    }
  }

  return (
    <form className={styles.settings} onSubmit={(event) => void save(event)}>
      <MeetingLanguageFields value={language} onChange={setLanguage} includeRealtime={includeRealtime} disabled={disabled || saving || languageLocked} translationLocked={translationLocked} />
      <p>{languageLocked ? "確定文字起こしの作成後は言語を変更できません。要約再生成は保存済みFinalを再利用します。" : "言語は録音開始前、または初回の確定文字起こしを予約する前に保存してください。"}</p>
      <div className={styles.heading}>
        <span>文字起こしの話者数</span>
        <small>任意</small>
      </div>
      <div className={styles.fields}>
        <label>
          <span>最小</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={minimum}
            disabled={disabled || saving}
            placeholder="自動"
            aria-label="最小話者数"
            onChange={(event) => setMinimum(event.target.value)}
          />
        </label>
        <label>
          <span>最大</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maximum}
            disabled={disabled || saving}
            placeholder="自動"
            aria-label="最大話者数"
            onChange={(event) => setMaximum(event.target.value)}
          />
        </label>
        <button type="submit" disabled={disabled || saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      <p>
        {disabled
          ? "文字起こし処理中は変更できません。"
          : "最小は下限、最大は上限です。空欄なら自動判定。同じ数にすると固定できます。"}
      </p>
      {message && <output role={messageIsError ? "alert" : "status"} data-error={messageIsError} aria-live="polite">{message}</output>}
    </form>
  );
}
