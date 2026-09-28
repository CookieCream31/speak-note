"use client";

import styles from "./microphone-start-toggle.module.css";

export function MicrophoneStartToggle({ muted, disabled, onChange }: {
  muted: boolean; disabled: boolean; onChange: (muted: boolean) => void;
}) {
  return <div className={styles.control}>
    <button type="button" disabled={disabled} aria-pressed={muted}
      aria-label={muted ? "開始時のマイクミュートを解除" : "開始時のマイクをミュート"}
      data-muted={muted} onClick={() => onChange(!muted)}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        {muted && <path d="M3 3l18 18" />}
      </svg>
      <span>{muted ? "マイク：ミュートで開始" : "マイク：ONで開始"}</span>
    </button>
    <p>{muted ? "マイク音は含めずに開始します。会議中に解除できます。" : "マイク音も含めて開始します。会議中にミュートできます。"}</p>
  </div>;
}
