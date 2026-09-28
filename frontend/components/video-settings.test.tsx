// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoSettings } from "./video-settings";

let stage: HTMLDivElement;
let root: Root;
let media: HTMLVideoElement;
let play: ReturnType<typeof vi.fn>;

function select(label: string, value: string) {
  const valueLabels: Record<string, string> = {
    large: "大",
    none: "なし",
    hide: "非表示",
    original: "元動画（再圧縮なし）",
    playback: "互換MP4（標準）",
  };
  const dialog = stage.querySelector<HTMLElement>('[role="dialog"]')!;
  if (dialog.hidden) {
    act(() => stage.querySelector<HTMLButtonElement>('button[aria-label="画質・字幕の設定"]')!.click());
  }
  const row = Array.from(dialog.querySelectorAll<HTMLButtonElement>("[data-setting]"))
    .find((button) => button.getAttribute("aria-label")?.startsWith(label + ": "));
  expect(row).toBeDefined();
  act(() => row!.click());
  const option = Array.from(dialog.querySelectorAll<HTMLButtonElement>("[data-setting-option]"))
    .find((button) => button.textContent?.trim() === valueLabels[value]);
  expect(option).toBeDefined();
  act(() => option!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stage = document.createElement("div");
  stage.dataset.mediaStage = "";
  stage.innerHTML = '<video src="/playback"></video><div data-mount></div>';
  document.body.append(stage);
  media = stage.querySelector("video")!;
  play = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(media, "play").mockImplementation(play);
  vi.spyOn(media, "load").mockImplementation(() => {
    media.currentTime = 0;
    media.playbackRate = 1;
  });
  Object.defineProperty(media, "duration", { value: 120 });
  root = createRoot(stage.querySelector("[data-mount]")!);
  act(() => root.render(<VideoSettings playbackUrl="/playback" originalUrl="/original" />));
});
afterEach(() => {
  act(() => root.unmount());
  stage.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("video settings", () => {
  it("does not move focus into the settings menu after a pointer click", () => {
    const trigger = stage.querySelector<HTMLButtonElement>('button[aria-label="画質・字幕の設定"]')!;
    const dialog = stage.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
    expect(dialog.hidden).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(false);

    const quality = dialog.querySelector<HTMLButtonElement>('[data-setting="quality"]')!;
    act(() => { quality.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
    expect(dialog.querySelector('[data-setting-option][aria-pressed="true"]')).not.toBe(document.activeElement);
  });

  it("closes on outside clicks and Escape, but not on settings interaction", () => {
    const button = stage.querySelector<HTMLButtonElement>("button")!;
    const dialog = stage.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => button.click());
    expect(dialog.hidden).toBe(false);
    select("字幕サイズ", "large");
    expect(dialog.hidden).toBe(false);
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(dialog.hidden).toBe(true);
    act(() => button.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(dialog.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("shows current values and returns focus to the setting after a choice or Back", () => {
    const trigger = stage.querySelector<HTMLButtonElement>('button[aria-label="画質・字幕の設定"]')!;
    const dialog = stage.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => trigger.click());

    const quality = dialog.querySelector<HTMLButtonElement>('[data-setting="quality"]')!;
    expect(quality.textContent).toContain("互換MP4（標準）");
    act(() => quality.click());
    const selected = dialog.querySelector<HTMLButtonElement>('[data-setting-option][aria-pressed="true"]')!;
    expect(selected.textContent).toContain("互換MP4（標準）");
    expect(document.activeElement).toBe(selected);

    const original = Array.from(dialog.querySelectorAll<HTMLButtonElement>("[data-setting-option]"))
      .find((button) => button.textContent?.includes("元動画（再圧縮なし）"))!;
    act(() => original.click());
    const updatedQuality = dialog.querySelector<HTMLButtonElement>('[data-setting="quality"]')!;
    expect(updatedQuality.textContent).toContain("元動画（再圧縮なし）");
    expect(document.activeElement).toBe(updatedQuality);

    const background = dialog.querySelector<HTMLButtonElement>('[data-setting="subtitleBackground"]')!;
    act(() => background.click());
    const back = dialog.querySelector<HTMLButtonElement>('button[aria-label="設定一覧に戻る"]')!;
    act(() => back.click());
    const returnedBackground = dialog.querySelector<HTMLButtonElement>('[data-setting="subtitleBackground"]')!;
    expect(document.activeElement).toBe(returnedBackground);
  });

  it("applies subtitle size, background and speaker visibility to the stage", () => {
    select("字幕サイズ", "large");
    select("字幕背景", "none");
    select("字幕の話者名", "hide");
    expect(stage.dataset.subtitleSize).toBe("large");
    expect(stage.dataset.subtitleBackground).toBe("none");
    expect(stage.dataset.subtitleSpeaker).toBe("hide");
  });

  it.each([true, false])("preserves time, speed, volume and paused=%s when switching sources", async (paused) => {
    Object.defineProperty(media, "paused", { configurable: true, value: paused });
    media.currentTime = 42;
    media.playbackRate = 1.75;
    media.volume = 0.3;
    media.muted = true;
    select("画質", "original");
    expect(media.getAttribute("src")).toBe("/original");
    await act(async () => { media.dispatchEvent(new Event("loadedmetadata")); });
    expect(media.currentTime).toBe(42);
    expect(media.playbackRate).toBe(1.75);
    expect(media.volume).toBe(0.3);
    expect(media.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(paused ? 0 : 1);
  });

  it("restores the snapshot through an unsupported-original fallback without looping", async () => {
    media.currentTime = 54;
    media.playbackRate = 1.5;
    select("画質", "original");
    act(() => media.dispatchEvent(new Event("error")));
    expect(media.getAttribute("src")).toBe("/playback");
    expect(stage.querySelector('[role="status"]')?.textContent).toContain("互換MP4に戻しました");
    await act(async () => { media.dispatchEvent(new Event("loadedmetadata")); });
    expect(media.currentTime).toBe(54);
    expect(media.playbackRate).toBe(1.5);
    act(() => media.dispatchEvent(new Event("error")));
    expect(media.load).toHaveBeenCalledTimes(2);
  });

  it("keeps the original position during rapid consecutive source changes", () => {
    media.currentTime = 62;
    select("画質", "original");
    select("画質", "playback");
    act(() => media.dispatchEvent(new Event("loadedmetadata")));
    expect(media.currentTime).toBe(62);
  });
});
