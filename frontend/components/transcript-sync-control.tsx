"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./transcript-sync-control.module.css";

const LIMIT_MS = 2000;
const STEP_MS = 100;

function validOffset(value: string | null): number {
  const offset = Number(value);
  return Number.isInteger(offset) && offset % STEP_MS === 0 && Math.abs(offset) <= LIMIT_MS ? offset : 0;
}

function label(offset: number): string {
  if (!offset) return "補正なし";
  return `${(Math.abs(offset) / 1000).toFixed(1)}秒${offset > 0 ? "早める" : "遅らせる"}`;
}

export function TranscriptSyncControl({ meetingId }: { meetingId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const value = useRef(0);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const panelId = useId();
  const key = `speak-note:transcript-sync:v1:${meetingId}`;

  function apply(next: number) {
    value.current = next;
    setOffset(next);
    const player = container.current?.closest<HTMLElement>("[data-transcript-player]");
    if (player) {
      player.dataset.transcriptSyncMs = String(next);
      player.dispatchEvent(new Event("speak-note:transcript-sync"));
    }
  }

  useEffect(() => {
    const restore = () => {
      try { apply(validOffset(window.localStorage.getItem(key))); setSaved(true); }
      catch { apply(0); setSaved(false); }
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      restore();
    };
    restore();
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [key]);

  function change(next: number) {
    apply(Math.max(-LIMIT_MS, Math.min(LIMIT_MS, next)));
    try { window.localStorage.setItem(key, String(value.current)); setSaved(true); }
    catch { setSaved(false); }
  }

  return (
    <div ref={container} className={styles.control} data-open={open} data-transcript-sync
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      }}>
      <button ref={trigger} type="button" className={styles.trigger} data-transcript-sync-toggle
        aria-label="文字ハイライトの同期調整" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}>
        <SlidersHorizontal size={14} aria-hidden="true" /> 同期
        {offset !== 0 && <span>{label(offset)}</span>}
      </button>
      <div id={panelId} className={styles.panel} role="group" aria-label="文字ハイライトの同期調整" hidden={!open}>
        <p>文字が音声より遅い場合は「早める」で調整してください。</p>
        <div className={styles.actions}>
          <button type="button" data-transcript-sync-earlier disabled={offset >= LIMIT_MS}
            onClick={() => change(value.current + STEP_MS)}>0.1秒早める</button>
          <button type="button" data-transcript-sync-later disabled={offset <= -LIMIT_MS}
            onClick={() => change(value.current - STEP_MS)}>0.1秒遅らせる</button>
        </div>
        <div className={styles.result}>
          <output aria-live="polite">{label(offset)}</output>
          <button type="button" data-transcript-sync-reset disabled={offset === 0} onClick={() => change(0)}>リセット</button>
        </div>
        <small>{saved ? "このブラウザのこの会議に保存します。" : "設定を保存できないため、この画面だけに適用します。"}
          音声の再生位置・字幕・保存済み文字起こしは変わりません。</small>
      </div>
    </div>
  );
}
