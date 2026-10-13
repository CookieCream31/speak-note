"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { transcriptsApi } from "@/lib/api";
import styles from "./final-transcript-action.module.css";

export function FinalTranscriptAction({ meetingId, ready, processing }: { meetingId: string; ready: boolean; processing: boolean }) {
  const router = useRouter();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    if (sending.current || !ready || processing || submitted) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await transcriptsApi.createFinal(meetingId);
      setSubmitted(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "全体文字起こしを開始できませんでした");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return <div className={styles.action}>
    <button type="button" disabled={!ready || processing || busy || submitted} onClick={() => void start()}>
      {busy || submitted ? "全体文字起こしを作成中…" : "全体文字起こしを作成（高精度版）"}
    </button>
    <p>保存音声を全体処理します。文字起こしの編集・会議への質問に使う高精度版を追加します。外部APIの利用料金が発生する場合があります。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
