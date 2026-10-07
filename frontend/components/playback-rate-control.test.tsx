// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlaybackRateControl } from "./playback-rate-control";
import { VideoSettings } from "./video-settings";

let host: HTMLElement;
let root: Root;
let media: HTMLMediaElement;
function mount(kind: "video" | "audio", withSettings = false) {
  host = document.createElement("section");
  host.dataset.transcriptPlayer = "";
  host.innerHTML = `<div data-media-stage><${kind} data-meeting-media></${kind}><div data-mount></div></div>`;
  document.body.append(host);
  media = host.querySelector(kind)!;
  media.currentTime = 42;
  root = createRoot(host.querySelector("[data-mount]")!);
  act(() => root.render(<><PlaybackRateControl video={kind === "video"} />{withSettings && <VideoSettings playbackUrl="/video" />}</>));
}
function trigger() { return host.querySelector<HTMLButtonElement>("[data-playback-rate] > button")!; }
function panel() { return host.querySelector<HTMLDivElement>('[aria-label="再生速度"][role="dialog"]')!; }
function option(value: number) { return host.querySelector<HTMLButtonElement>(`[data-playback-rate-option="${value}"]`)!; }

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("playback rate menu", () => {
  it.each(["video", "audio"] as const)("uses a settings-style menu and changes only the %s speed", (kind) => {
    mount(kind);
    expect(host.querySelector("select")).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLElement>("[data-playback-rate-option]")).map((item) => Number(item.dataset.playbackRateOption)))
      .toEqual([2, 1.75, 1.5, 1.25, 1, 0.75, 0.5]);
    act(() => trigger().click());
    expect(panel().hidden).toBe(false);
    expect(option(1).getAttribute("aria-pressed")).toBe("true");
    act(() => option(1.5).click());
    expect(media.playbackRate).toBe(1.5);
    expect(media.currentTime).toBe(42);
    expect(media.paused).toBe(true);
    expect(trigger().textContent).toBe("1.5×");
    expect(option(1.5).getAttribute("aria-pressed")).toBe("true");
    expect(panel().hidden).toBe(true);
  });

  it("synchronizes changes from shortcuts or restored media state", () => {
    mount("video");
    act(() => { media.playbackRate = 1.75; media.dispatchEvent(new Event("ratechange")); });
    expect(trigger().getAttribute("aria-label")).toBe("再生速度: 1.75倍");
    expect(option(1.75).getAttribute("aria-pressed")).toBe("true");
    act(() => { media.playbackRate = 0.75; media.dispatchEvent(new Event("loadedmetadata")); });
    expect(trigger().textContent).toBe("0.75×");
  });

  it("supports arrows, Home, End and Escape without propagating playback shortcuts", () => {
    mount("video");
    act(() => trigger().click());
    expect(document.activeElement).toBe(option(1));
    const listener = vi.fn();
    host.addEventListener("keydown", listener);
    act(() => option(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(option(0.75));
    act(() => option(0.75).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(option(2));
    act(() => option(2).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(option(0.5));
    expect(listener).not.toHaveBeenCalled();
    act(() => option(0.5).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps the player expanded through pointer focus until switching menus on click", () => {
    mount("video", true);
    const settingsTrigger = host.querySelector<HTMLButtonElement>('[aria-label="画質・字幕の設定"]')!;
    const settingsPanel = host.querySelector<HTMLDivElement>('[aria-label="再生設定"]')!;
    act(() => settingsTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    act(() => {
      trigger().dispatchEvent(new Event("pointerdown", { bubbles: true }));
      trigger().focus();
    });
    expect(settingsPanel.hidden).toBe(false);
    act(() => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(settingsPanel.hidden).toBe(true);
    expect(panel().hidden).toBe(false);
    act(() => {
      settingsTrigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      settingsTrigger.focus();
    });
    expect(panel().hidden).toBe(false);
    act(() => settingsTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(settingsPanel.hidden).toBe(false);
    expect(panel().hidden).toBe(true);
  });

  it("closes on outside pointer or focus and allows only one player menu to stay open", () => {
    mount("video", true);
    act(() => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(panel().contains(document.activeElement)).toBe(false);
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(panel().hidden).toBe(true);
    act(() => trigger().click());
    const settingsTrigger = host.querySelector<HTMLButtonElement>('[aria-label="画質・字幕の設定"]')!;
    act(() => settingsTrigger.focus());
    expect(panel().hidden).toBe(true);
    act(() => settingsTrigger.click());
    const settingsPanel = host.querySelector<HTMLDivElement>('[aria-label="再生設定"]')!;
    expect(settingsPanel.hidden).toBe(false);
    act(() => trigger().focus());
    expect(settingsPanel.hidden).toBe(true);
  });
});
