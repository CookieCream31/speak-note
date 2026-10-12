"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { LiveTranslation, RealtimeTranslationConfig } from "@/lib/api";
import { getLiveTranslationStore } from "@/lib/live-translation-store";
import { groupTranslationParagraphs, translationSeparator } from "@/lib/translation-paragraphs";
import styles from "./live-translation-panel.module.css";

const names = new Intl.DisplayNames(["ja"], { type: "language" });
const EMPTY: LiveTranslation[] = [];
export function useLiveTranslations(meetingId: string, persisted: LiveTranslation[] = EMPTY, enabled = true) {
  const store = getLiveTranslationStore(meetingId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return useMemo(() => {
    if (!enabled) return EMPTY;
    const persistedIds = new Set(persisted.map((row) => row.result_id));
    const rows = [...persisted.map((row) => ({ ...row, saved: true })), ...snapshot.history.filter((row) => !persistedIds.has(row.result_id))];
    if (snapshot.interim && !rows.some((row) => row.result_id === snapshot.interim!.result_id)) rows.push(snapshot.interim);
    return rows;
  }, [persisted, snapshot, enabled]);
}

export function InlineTranslations({ rows, showSpeaker = false }: { rows: LiveTranslation[]; showSpeaker?: boolean }) {
  if (!rows.length) return null;
  return <div className={styles.inline} aria-label="リアルタイム翻訳">
    {groupTranslationParagraphs(rows).map((paragraph) => {
      const first = paragraph.rows[0];
      const errors = [...new Set(paragraph.rows.flatMap((row) => row.error ? [row.error] : []))];
      const status = errors.length ? "保存失敗"
        : paragraph.rows.some((row) => row.isFinal === false) ? "翻訳中"
        : paragraph.rows.some((row) => !row.saved) ? "保存待ち" : "保存済み";
      return <div className={styles.paragraph} key={paragraph.id} data-translation-paragraph>
        <div className={styles.meta}>
          <strong>翻訳</strong>
          {showSpeaker && <span>{first.speaker_label && first.speaker_label !== "SPEAKER_UNKNOWN" ? first.speaker_label : "話者不明"}</span>}
          <span>{names.of(first.source_language) ?? first.source_language} → {names.of(first.target_language) ?? first.target_language}</span>
          <small>{status}</small>
        </div>
        <p className={styles.text} dir="auto">
          {paragraph.rows.map((row, index) => <span key={row.result_id}
            data-translation-result-id={row.result_id} data-interim={row.isFinal === false}>
            {index > 0 ? translationSeparator(paragraph.rows[index - 1].text, row.text, row.target_language) : ""}{row.text}
          </span>)}
        </p>
        {errors.map((error) => <p key={error} className={styles.error} role="alert">{error}</p>)}
      </div>;
    })}
  </div>;
}

/** Legacy/unmatched captions stay immediately below the originals in the same viewport. */
export function TranslationRemainder({ rows, waiting = false }: { rows: LiveTranslation[]; waiting?: boolean }) {
  if (!rows.length && !waiting) return null;
  return <section className={styles.remainder} aria-label="翻訳履歴">
    {!rows.length ? <p role="status">翻訳した発言がここに表示されます。</p> : <>
      <h3>翻訳履歴</h3><p>対応する原文を確認できない翻訳</p>
      <InlineTranslations rows={rows} showSpeaker />
    </>}
  </section>;
}

export function LiveTranslationPanel({ meetingId, translation, persisted = EMPTY }: {
  meetingId: string; translation?: RealtimeTranslationConfig | null; persisted?: LiveTranslation[];
}) {
  const rows = useLiveTranslations(meetingId, persisted);
  return <TranslationRemainder rows={rows} waiting={Boolean(translation)} />;
}
