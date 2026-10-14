// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSyncControl } from "./transcript-sync-control";

let host: HTMLElement;
let root: Root;
const key = (meeting: string) => `speak-note:transcript-sync:v1:${meeting}`;
function mount(meeting = "m1") {
  host = document.createElement("section");
  host.dataset.transcriptPlayer = "";
  host.innerHTML = '<audio data-meeting-media></audio><div data-mount></div>';
  document.body.append(host);
  host.querySelector("audio")!.currentTime = 42;
  root = createRoot(host.querySelector("[data-mount]")!);
  act(() => root.render(<TranscriptSyncControl meetingId={meeting} />));
}
function button(name: string) { return host.querySelector<HTMLButtonElement>(`[data-transcript-sync-${name}]`)!; }
beforeEach(() => { localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("transcript display sync", () => {
  it("defaults to no correction, applies 100ms steps immediately and does not change media or call APIs", () => {
    mount();
    expect(host.dataset.transcriptSyncMs).toBe("0");
    expect(button("reset").disabled).toBe(true);
    act(() => button("toggle").click());
    expect(button("toggle").getAttribute("aria-expanded")).toBe("true");
    act(() => { button("earlier").click(); button("earlier").click(); });
    expect(host.dataset.transcriptSyncMs).toBe("200");
    expect(host.querySelector("output")?.textContent).toBe("0.2秒早める");
    expect(localStorage.getItem(key("m1"))).toBe("200");
    act(() => { button("later").click(); button("later").click(); button("later").click(); });
    expect(host.dataset.transcriptSyncMs).toBe("-100");
    expect(host.querySelector("output")?.textContent).toBe("0.1秒遅らせる");
    expect(host.querySelector("audio")?.currentTime).toBe(42);
    expect(fetch).not.toHaveBeenCalled();
    act(() => button("reset").click());
    expect(host.dataset.transcriptSyncMs).toBe("0");
    expect(localStorage.getItem(key("m1"))).toBe("0");
  });
  it("restores this meeting's setting and isolates other meetings", () => {
    localStorage.setItem(key("m1"), "300");
    localStorage.setItem(key("m2"), "-200");
    mount();
    expect(host.dataset.transcriptSyncMs).toBe("300");
    act(() => root.render(<TranscriptSyncControl meetingId="m2" />));
    expect(host.dataset.transcriptSyncMs).toBe("-200");
    act(() => root.render(<TranscriptSyncControl meetingId="m3" />));
    expect(host.dataset.transcriptSyncMs).toBe("0");
    expect(localStorage.getItem(key("m1"))).toBe("300");
  });
  it.each(["invalid", "NaN", "Infinity", "100000", "-2100", "123", "100.5"])("ignores invalid saved settings: %s", (value) => {
    localStorage.setItem(key("m1"), value); mount();
    expect(host.dataset.transcriptSyncMs).toBe("0");
  });
  it("bounds changes to two seconds and disables the limit button", () => {
    mount();
    act(() => { for (let i = 0; i < 25; i++) button("earlier").click(); });
    expect(host.dataset.transcriptSyncMs).toBe("2000");
    expect(button("earlier").disabled).toBe(true);
    act(() => { for (let i = 0; i < 45; i++) button("later").click(); });
    expect(host.dataset.transcriptSyncMs).toBe("-2000");
    expect(button("later").disabled).toBe(true);
  });
  it("still adjusts this screen if browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount();
    act(() => { button("toggle").click(); button("earlier").click(); });
    expect(host.dataset.transcriptSyncMs).toBe("100");
    expect(host.textContent).toContain("この画面だけに適用");
  });
  it("synchronizes only this meeting's changes from another tab and handles clearing storage", () => {
    mount();
    localStorage.setItem(key("m1"), "400");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: key("m2") })));
    expect(host.dataset.transcriptSyncMs).toBe("0");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: key("m1") })));
    expect(host.dataset.transcriptSyncMs).toBe("400");
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(host.dataset.transcriptSyncMs).toBe("0");
  });
  it("closes with Escape, restores focus and does not trigger player shortcuts", () => {
    mount(); const listener = vi.fn(); host.addEventListener("keydown", listener);
    act(() => button("toggle").click());
    act(() => button("earlier").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    act(() => button("earlier").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(listener).not.toHaveBeenCalled();
    expect(button("toggle").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button("toggle"));
  });
  it("renders an uncorrected SSR snapshot regardless of browser storage", () => {
    localStorage.setItem(key("m1"), "300");
    expect(renderToStaticMarkup(<TranscriptSyncControl meetingId="m1" />)).toContain("補正なし");
  });
});
