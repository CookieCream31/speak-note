// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeObserver } from "./theme-observer";
import { THEME_STORAGE_KEY } from "@/lib/theme";

let host: HTMLDivElement;
let root: Root;
let systemChanged: () => void;
const mediaQuery = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
beforeEach(() => {
  localStorage.clear();
  mediaQuery.matches = false;
  mediaQuery.addEventListener.mockImplementation((_event, callback) => { systemChanged = callback; });
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount() { act(() => root.render(<><ThemeObserver /><input defaultValue="未保存の入力" /><audio /></>)); }
function receivePreference(value: string | null) {
  if (value === null) localStorage.removeItem(THEME_STORAGE_KEY);
  else localStorage.setItem(THEME_STORAGE_KEY, value);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY })));
}

describe("theme observation without a visible control", () => {
  it("applies a saved choice on a page without theme buttons", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark"); mount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(host.querySelector("button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("receives another tab's settings without replacing inputs or media", () => {
    mount();
    const input = host.querySelector("input")!, audio = host.querySelector("audio")!;
    input.value = "編集中の入力"; audio.currentTime = 12;
    receivePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    receivePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("編集中の入力");
    expect(host.querySelector("audio")).toBe(audio);
    expect(audio.currentTime).toBe(12);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("follows the OS only in system mode without theme buttons", () => {
    mount();
    mediaQuery.matches = true; act(() => systemChanged());
    expect(document.documentElement.dataset.theme).toBe("dark");
    receivePreference("dark");
    mediaQuery.matches = false; act(() => systemChanged());
    expect(document.documentElement.dataset.theme).toBe("dark");
    receivePreference(null);
    expect(document.documentElement.dataset.theme).toBe("light");
    mediaQuery.matches = true; act(() => systemChanged());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
