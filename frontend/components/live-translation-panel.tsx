"use client";

import { useSyncExternalStore } from "react";
import type { LiveTranslation, RealtimeTranslationConfig } from "@/lib/api";
import { getLiveTranslationStore } from "@/lib/live-translation-store";
import styles from "./live-translation-panel.module.css";

const names = new Intl.DisplayNames(["ja"], { type: "language" });
const EMPTY: LiveTranslation[] = [];
export function LiveTranslationPanel({ meetingId, translation, persisted = EMPTY }: {
  meetingId: string; translation?: RealtimeTranslationConfig | null; persisted?: LiveTranslation[];
}) {
  const store = getLiveTranslationStore(meetingId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const persistedIds = new Set(persisted.map((row) => row.result_id));
  const rows = [...persisted.map((row) => ({ ...row, saved: true })), ...snapshot.history.filter((row) => !persistedIds.has(row.result_id))];
  if (snapshot.interim && !rows.some((row) => row.result_id === snapshot.interim!.result_id)) rows.push(snapshot.interim);
  if (!translation && !rows.length) return null;
  return <section className={styles.panel} aria-label="リアルタイム翻訳">
    <header><h3>リアルタイム翻訳</h3><span>Soniox · 原文とは別の暫定翻訳</span></header>
    <p>翻訳には音声の時刻がないため、再生位置や議事録の根拠には使用しません。</p>
    {!rows.length ? <p role="status">翻訳した発言がここに表示されます。</p> : <ol className={styles.rows}>
      {rows.map((row) => <li key={row.result_id} data-interim={row.isFinal === false}>
        <div className={styles.meta}><strong>{row.speaker_label && row.speaker_label !== "SPEAKER_UNKNOWN" ? row.speaker_label : "話者不明"}</strong><span>{names.of(row.source_language) ?? row.source_language} → {names.of(row.target_language) ?? row.target_language}</span><small>{row.error ? "保存失敗" : row.isFinal === false ? "翻訳中" : row.saved ? "保存済み" : "保存待ち"}</small></div>
        <p dir="auto">{row.text}</p>
        {row.error && <p className={styles.error} role="alert">{row.error}</p>}
      </li>)}
    </ol>}
  </section>;
}
