// @vitest-environment jsdom
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeSelector } from "./theme-selector";
import { THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});
async function choose(value: string) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(`button[data-theme-option="${value}"]`)!
      .click();
  });
}
function pressed(scope: ParentNode = container) {
  return [...scope.querySelectorAll('button[aria-pressed="true"]')].map(
    (button) => button.getAttribute("data-theme-option"),
  );
}

describe("ThemeSelector", () => {
  it("exposes all three choices as labelled icon buttons in a named group", async () => {
    root = createRoot(container);
    await act(async () => root!.render(<ThemeSelector />));
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("表示テーマ");
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "システムに合わせる",
      "ライト",
      "ダーク",
    ]);
    expect(buttons.every((button) => button.type === "button")).toBe(true);
    expect(buttons.every((button) => button.querySelector("svg"))).toBe(true);
    expect(pressed()).toEqual(["system"]);
  });
  it("changes all selectors together without remounting inputs or media or requesting the backend", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <>
          <ThemeSelector />
          <ThemeSelector />
          <input defaultValue="未保存の文字" />
          <audio />
        </>,
      ),
    );
    const input = container.querySelector("input")!;
    const audio = container.querySelector("audio")!;
    input.value = "編集を続ける";
    audio.currentTime = 12;
    await choose("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(pressed()).toEqual(["dark", "dark"]);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("編集を続ける");
    expect(container.querySelector("audio")).toBe(audio);
    expect(audio.currentTime).toBe(12);
    expect(fetch).not.toHaveBeenCalled();
    await choose("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("hydrates saved dark mode without mismatches", async () => {
    container.innerHTML = renderToString(<ThemeSelector />);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(
      "document",
      "localStorage",
      "matchMedia",
      THEME_BOOTSTRAP_SCRIPT,
    )(document, localStorage, window.matchMedia);
    const recoverable = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <ThemeSelector />, {
        onRecoverableError: recoverable,
      });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(pressed()).toEqual(["dark"]);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
