// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AISettingsManager } from "./ai-settings-manager";
import { MeetingsManager } from "./meetings-manager";
import { ThemeObserver } from "./theme-observer";
import { THEME_STORAGE_KEY } from "@/lib/theme";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions", () => ({
  createAIProviderAction: vi.fn(), bulkManageMeetingsAction: vi.fn(), createMeetingTagAction: vi.fn(),
  deleteMeetingAction: vi.fn(), deleteMeetingTagAction: vi.fn(), updateMeetingFavoriteAction: vi.fn(),
  updateMeetingTitleAction: vi.fn(),
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ languages: ["ja", "en"], supports_auto: true, supports_multiple: true, supports_strict: true }) })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("settings and meeting creation navigation", () => {
  it("places labelled theme choices in settings and switches immediately without saving AI forms", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await act(async () => root.render(<><ThemeObserver /><AISettingsManager
      initialProviders={[]} initialProfiles={[]} initialUsage={[]} initialTemplates={[]}
      initialTranscriptionSettings={{ provider: "soniox", azure_region: "", azure_language: "ja-JP", has_api_key: false, api_key_masked: null, soniox_model: "stt-rt-v5", updated_at: "" }}
    /></>));
    expect(host.querySelector("header h1")?.textContent).toBe("設定");
    expect(host.querySelector("header [data-theme-option]")).toBeNull();
    expect(host.querySelector('nav[aria-label="設定の項目"] a')?.getAttribute("href")).toBe("#appearance");
    const section = host.querySelector("#appearance")!;
    expect(section.querySelector("h2")?.textContent).toBe("表示テーマ");
    expect(section.querySelectorAll("[data-theme-option]")).toHaveLength(3);
    expect(section.querySelector('[aria-pressed="true"]')?.textContent).toBe("ダーク");
    const input = host.querySelector<HTMLInputElement>('[name="name"]')!;
    input.value = "未保存の接続設定";
    await act(async () => section.querySelector<HTMLButtonElement>('[data-theme-option="light"]')!.click());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(host.querySelector('[name="name"]')).toBe(input);
    expect(input.value).toBe("未保存の接続設定");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps home creation working through the new meeting button with no header theme control", async () => {
    await act(async () => root.render(<><ThemeObserver /><MeetingsManager meetings={[]} tags={[]} aiProfiles={[]} /></>));
    expect(host.querySelector('a[href="/settings/ai"]')?.textContent).toBe("設定");
    expect(host.querySelector("header [data-theme-option]")).toBeNull();
    const create = Array.from(host.querySelectorAll<HTMLButtonElement>("header button")).find((button) => button.textContent === "新しい会議")!;
    await act(async () => create.click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("新しい会議");
    expect(dialog.querySelectorAll('[name="source_type"]')).toHaveLength(3);
    expect(dialog.querySelector('[name="source_type"][value="media_upload"]')).not.toBeNull();
  });
});
