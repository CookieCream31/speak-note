"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import styles from "./transcript-player.module.css";

interface VideoSettingsProps {
  playbackUrl: string;
  originalUrl?: string;
}

type SettingKey = "quality" | "subtitleSize" | "subtitleBackground" | "subtitleSpeaker";
type SubtitleSettingKey = Exclude<SettingKey, "quality">;

interface SettingItem {
  key: SettingKey;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}

export function VideoSettings({ playbackUrl, originalUrl }: VideoSettingsProps) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelContent = useRef<HTMLDivElement>(null);
  const focusAfterNavigation = useRef(true);
  const lastSetting = useRef<SettingKey>("quality");
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<SettingKey | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [quality, setQuality] = useState("playback");
  const [message, setMessage] = useState("");
  const [subtitleValues, setSubtitleValues] = useState<Record<SubtitleSettingKey, string>>({
    subtitleSize: "medium",
    subtitleBackground: "dark",
    subtitleSpeaker: "show",
  });
  const pending = useRef<{ time: number; rate: number; playing: boolean } | null>(null);
  const selectedQuality = useRef("playback");

  useEffect(() => {
    const element = container.current;
    const stage = element?.closest<HTMLElement>("[data-media-stage]");
    const media = stage?.querySelector("video");
    if (!media) return;
    const loaded = () => {
      const snapshot = pending.current;
      if (!snapshot) return;
      pending.current = null;
      media.currentTime = Number.isFinite(media.duration)
        ? Math.min(snapshot.time, Math.max(0, media.duration - 0.01)) : snapshot.time;
      media.playbackRate = snapshot.rate;
      if (snapshot.playing) void media.play().catch(() => setMessage("再生ボタンを押してください"));
    };
    const failed = () => {
      if (selectedQuality.current !== "original") return;
      pending.current ??= { time: media.currentTime, rate: media.playbackRate, playing: !media.paused };
      selectedQuality.current = "playback";
      setQuality("playback");
      setMessage("元動画を再生できないため、互換MP4に戻しました");
      media.src = playbackUrl;
      media.load();
    };
    media.addEventListener("loadedmetadata", loaded);
    media.addEventListener("error", failed);
    return () => {
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("error", failed);
    };
  }, [playbackUrl]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false);
        setPage(null);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setPage(null);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !focusAfterNavigation.current) return;
    const selector = page
      ? '[data-setting-option][aria-pressed="true"]'
      : '[data-setting="' + lastSetting.current + '"]';
    panel.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    if (panel.current) panel.current.scrollTop = 0;
  }, [open, page]);

  useLayoutEffect(() => {
    const content = panelContent.current;
    if (!open || !content) return;

    const measure = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height > 0) setPanelHeight((current) => current === height + 12 ? current : height + 12);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, page, message]);

  function changeQuality(value: string) {
    const media = container.current?.closest("[data-media-stage]")?.querySelector("video");
    const url = value === "original" ? originalUrl : playbackUrl;
    if (!media || !url) return;
    pending.current ??= { time: media.currentTime, rate: media.playbackRate, playing: !media.paused };
    selectedQuality.current = value;
    setQuality(value);
    setMessage("");
    media.src = url;
    media.load();
  }

  function setSubtitleSetting(name: SubtitleSettingKey, value: string) {
    const stage = container.current?.closest<HTMLElement>("[data-media-stage]");
    if (stage) stage.dataset[name] = value;
    setSubtitleValues((current) => ({ ...current, [name]: value }));
  }

  const settings: SettingItem[] = [
    {
      key: "quality",
      label: "画質",
      value: quality,
      options: [
        { value: "playback", label: "互換MP4（標準）" },
        ...(originalUrl && originalUrl !== playbackUrl
          ? [{ value: "original", label: "元動画（再圧縮なし）" }]
          : []),
      ],
    },
    {
      key: "subtitleSize",
      label: "字幕サイズ",
      value: subtitleValues.subtitleSize,
      options: [
        { value: "small", label: "小" },
        { value: "medium", label: "標準" },
        { value: "large", label: "大" },
      ],
    },
    {
      key: "subtitleBackground",
      label: "字幕背景",
      value: subtitleValues.subtitleBackground,
      options: [
        { value: "dark", label: "半透明" },
        { value: "solid", label: "黒" },
        { value: "none", label: "なし" },
      ],
    },
    {
      key: "subtitleSpeaker",
      label: "字幕の話者名",
      value: subtitleValues.subtitleSpeaker,
      options: [
        { value: "show", label: "表示" },
        { value: "hide", label: "非表示" },
      ],
    },
  ];
  const activeSetting = settings.find((setting) => setting.key === page);

  function selectOption(key: SettingKey, value: string) {
    if (key === "quality") {
      if (value !== quality) changeQuality(value);
    } else {
      setSubtitleSetting(key, value);
    }
    setPage(null);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "ArrowLeft" && page) {
      event.preventDefault();
      setPage(null);
      return;
    }
    if (event.key === "ArrowRight" && !page) {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-setting]");
      if (row) {
        event.preventDefault();
        row.click();
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-settings-nav]") ?? []);
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
      className={styles.settingsContainer}
      data-player-settings
      data-open={open}
      onPointerDownCapture={() => { focusAfterNavigation.current = false; }}
      onClickCapture={(event) => { if (event.detail > 0) focusAfterNavigation.current = false; }}
      onKeyDownCapture={() => { focusAfterNavigation.current = true; }}
    >
      <button
        ref={trigger}
        type="button"
        className={styles.controlButton}
        aria-label="画質・字幕の設定"
        title="画質・字幕の設定"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setPage(null);
          setOpen((current) => !current);
        }}
      >
        <svg className={styles.videoSettingsIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m9 3-.6 2.2-2 .9L4.3 5.5 2 9.5l1.6 1.6v2L2 14.5l2.3 4 2.1-.6 2 .9L9 21h6l.6-2.2 2-.9 2.1.6 2.3-4-1.6-1.4v-2L22 9.5l-2.3-4-2.1.6-2-.9L15 3Z" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      </button>
      <div
        ref={panel}
        className={styles.settingsPanel}
        role="dialog"
        aria-label="再生設定"
        data-page={page ?? "root"}
        hidden={!open}
        style={{ height: panelHeight ?? undefined }}
        onKeyDown={handleMenuKeyDown}
      >
        <div ref={panelContent} key={page ?? "root"} className={styles.settingsPanelContent}>
        {activeSetting ? (
          <>
            <button
              type="button"
              className={styles.settingsBack}
              data-settings-nav
              aria-label="設定一覧に戻る"
              onClick={() => setPage(null)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 5-7 7 7 7" />
              </svg>
              <span>{activeSetting.label}</span>
            </button>
            <div className={styles.settingsOptions} role="group" aria-label={activeSetting.label}>
              {activeSetting.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.settingsOption}
                  data-setting-option
                  data-settings-nav
                  aria-pressed={activeSetting.value === option.value}
                  onClick={() => selectOption(activeSetting.key, option.value)}
                >
                  <span className={styles.settingsOptionCheck} aria-hidden="true">
                    {activeSetting.value === option.value && (
                      <svg viewBox="0 0 24 24"><path d="m5 12 5 5L19 7" /></svg>
                    )}
                  </span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            {activeSetting.key === "quality" && (
              <p className={styles.settingsHelp}>元動画の解像度が上限です。非対応形式は互換MP4に戻ります。</p>
            )}
          </>
        ) : (
          <div className={styles.settingsOptions} role="group" aria-label="再生設定一覧">
            {settings.map((setting) => {
              const selectedOption = setting.options.find((option) => option.value === setting.value)?.label ?? "";
              return (
                <button
                  key={setting.key}
                  type="button"
                  className={styles.settingsRow}
                  data-setting={setting.key}
                  data-settings-nav
                  aria-label={setting.label + ": " + selectedOption}
                  onClick={() => {
                    lastSetting.current = setting.key;
                    setPage(setting.key);
                  }}
                >
                  <span className={styles.settingsRowLabel}>{setting.label}</span>
                  <span className={styles.settingsRowValue}>{selectedOption}</span>
                  <svg className={styles.settingsChevron} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m9 5 7 7-7 7" />
                  </svg>
                </button>
              );
            })}
          </div>
        )}
        <p className={styles.settingsMessage} role="status">{message}</p>
        </div>
      </div>
    </div>
  );
}
