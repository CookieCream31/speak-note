"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { LiveTranslation, RealtimeTranslationConfig } from "@/lib/api";
import { getLiveTranslationStore } from "@/lib/live-translation-store";
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
    <ol className={styles.rows}>
      {rows.map((row) => <li key={row.result_id} data-interim={row.isFinal === false}>
        <div className={styles.meta}><strong>翻訳</strong>{showSpeaker && <span>{row.speaker_label && row.speaker_label !== "SPEAKER_UNKNOWN" ? row.speaker_label : "話者不明"}</span>}<span>{names.of(row.source_language) ?? row.source_language} → {names.of(row.target_language) ?? row.target_language}</span><small>{row.error ? "保存失敗" : row.isFinal === false ? "翻訳中" : row.saved ? "保存済み" : "保存待ち"}</small></div>
        <p dir="auto">{row.text}</p>
        {row.error && <p className={styles.error} role="alert">{row.error}</p>}
      </li>)}
    </ol>
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
