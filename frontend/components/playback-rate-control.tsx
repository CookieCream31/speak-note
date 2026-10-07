"use client";

import { Check } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import styles from "./transcript-player.module.css";

const PLAYBACK_RATES = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5] as const;

export function PlaybackRateControl({ video = false }: { video?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusAfterOpen = useRef(true);
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState(1);
  const panelId = useId();

  function getMedia() {
    return container.current?.closest("[data-transcript-player]")
      ?.querySelector<HTMLMediaElement>("[data-meeting-media]");
  }

  useEffect(() => {
    const media = container.current?.closest("[data-transcript-player]")
      ?.querySelector<HTMLMediaElement>("[data-meeting-media]");
    if (!media) return;
    const sync = () => setRate(media.playbackRate);
    sync();
    media.addEventListener("ratechange", sync);
    media.addEventListener("loadedmetadata", sync);
    return () => {
      media.removeEventListener("ratechange", sync);
      media.removeEventListener("loadedmetadata", sync);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    if (focusAfterOpen.current) {
      panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    }
    let switchingByPointer = false;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || container.current?.contains(event.target)) return;
      if (event.type === "pointerdown") {
        // Keep the expanded mobile player stable until the other menu's click opens it.
        switchingByPointer = event.target instanceof Element
          && Boolean(event.target.closest("[data-player-settings]"));
        if (switchingByPointer) return;
      }
      if (event.type === "focusin" && switchingByPointer) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("click", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("click", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-playback-rate-option]") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div
      ref={container}
      className={`${styles.playbackRate} ${video ? styles.videoRateContainer : styles.audioRateContainer}`}
      data-playback-rate
      data-player-settings
      data-open={open}
      onPointerDownCapture={() => { focusAfterOpen.current = false; }}
      onClickCapture={(event) => { if (event.detail > 0) focusAfterOpen.current = false; }}
      onKeyDownCapture={() => { focusAfterOpen.current = true; }}
    >
      <button
        ref={trigger}
        type="button"
        className={`${styles.playbackRateButton} ${video ? styles.videoPlaybackRate : ""}`}
        aria-label={`再生速度: ${rate}倍`}
        title="再生速度"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.playbackRateValue} data-playback-rate-value>{rate}×</span>
      </button>
      <div
        ref={panel}
        id={panelId}
        className={`${styles.settingsPanel} ${styles.playbackRatePanel} ${video ? "" : styles.audioPlaybackRatePanel}`}
        role="dialog"
        aria-label="再生速度"
        hidden={!open}
        onKeyDown={handleMenuKeyDown}
      >
        <p className={styles.playbackRateHeading}>再生速度</p>
        <div className={styles.settingsOptions} role="group" aria-label="速度を選択">
          {PLAYBACK_RATES.map((value) => (
            <button
              key={value}
              type="button"
              className={styles.settingsOption}
              data-playback-rate-option={value}
              aria-pressed={rate === value}
              onClick={(event) => {
                const media = getMedia();
                if (!media) return;
                media.playbackRate = value;
                setRate(media.playbackRate);
                setOpen(false);
                if (event.detail === 0) trigger.current?.focus();
              }}
            >
              <span className={styles.settingsOptionCheck} aria-hidden="true">
                {rate === value && <Check size={18} />}
              </span>
              <span>{value === 1 ? "1×（標準）" : `${value}×`}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
