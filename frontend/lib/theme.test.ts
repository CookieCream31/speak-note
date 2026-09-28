// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ThemeModule from "./theme";

let theme: typeof ThemeModule;
let dark: boolean;
let changes: Set<() => void>;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="theme-color" content="#f6f7f9">';
  dark = false;
  changes = new Set();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, callback: () => void) =>
        changes.add(callback),
      removeEventListener: (_: string, callback: () => void) =>
        changes.delete(callback),
    })),
  );
  theme = await import("./theme");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function subscribe() {
  const listener = vi.fn();
  cleanups.push(theme.subscribeTheme(listener));
  return listener;
}
function system(value: boolean) {
  dark = value;
  for (const callback of changes) callback();
}
function bootstrap() {
  new Function(
    "document",
    "localStorage",
    "matchMedia",
    theme.THEME_BOOTSTRAP_SCRIPT,
  )(document, localStorage, window.matchMedia);
}

describe("theme preference", () => {
  it.each([null, "unknown", "SYSTEM", {}, 1])(
    "falls back to system for invalid stored value %j",
    (value) => {
      expect(theme.parseThemePreference(value)).toBe("system");
    },
  );
  it("applies the OS initially and follows changes only in system mode", () => {
    dark = true;
    subscribe();
    expect(document.documentElement.dataset.theme).toBe("dark");
    system(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    theme.setThemePreference("dark");
    system(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.setThemePreference("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    system(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#11151c");
  });
  it.each(["light", "dark"] as const)(
    "uses saved %s before first paint and after subscription",
    (preference) => {
      localStorage.setItem(theme.THEME_STORAGE_KEY, preference);
      dark = preference === "light";
      bootstrap();
      expect(document.documentElement.dataset.theme).toBe(preference);
      subscribe();
      expect(theme.getThemePreference()).toBe(preference);
      expect(document.documentElement.dataset.theme).toBe(preference);
    },
  );
  it("uses the OS before first paint when no explicit preference is saved", () => {
    dark = true;
    bootstrap();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });
  it("saves choice and reads it again after page subscription is recreated", () => {
    subscribe();
    theme.setThemePreference("dark");
    expect(localStorage.getItem(theme.THEME_STORAGE_KEY)).toBe("dark");
    cleanups.pop()!();
    subscribe();
    expect(theme.getThemePreference()).toBe("dark");
  });
  it("synchronizes changes and clearing storage from another tab", () => {
    const listener = subscribe();
    localStorage.setItem(theme.THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(
      new StorageEvent("storage", { key: theme.THEME_STORAGE_KEY }),
    );
    expect(theme.getThemePreference()).toBe("dark");
    const calls = listener.mock.calls.length;
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(listener).toHaveBeenCalledTimes(calls);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(theme.getThemePreference()).toBe("system");
  });
  it("works when storage reads/writes are blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    dark = true;
    expect(bootstrap).not.toThrow();
    subscribe();
    expect(theme.getThemePreference()).toBe("system");
    expect(() => theme.setThemePreference("light")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("falls back to light without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(bootstrap).not.toThrow();
    subscribe();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("removes listeners only after the last selector unmounts", () => {
    const first = theme.subscribeTheme(vi.fn());
    const second = theme.subscribeTheme(vi.fn());
    expect(changes.size).toBe(1);
    first();
    expect(changes.size).toBe(1);
    second();
    expect(changes.size).toBe(0);
  });
});
