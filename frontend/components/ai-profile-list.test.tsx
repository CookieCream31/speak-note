// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProfile, AIProvider } from "@/lib/api";
import { AISettingsManager } from "./ai-settings-manager";

vi.mock("@/app/actions", () => ({ createAIProviderAction: vi.fn() }));

const provider: AIProvider = {
  id: "provider", provider_type: "gemini", name: "Gemini接続", base_url: null,
  enabled: true, has_api_key: true, api_key_masked: "****",
  created_at: "", updated_at: "",
};
const profiles: AIProfile[] = [
  { id: "first", name: "標準", provider_id: "provider", model: "model-a", temperature: 0.2, is_default: true, created_at: "", updated_at: "" },
  { id: "second", name: "高精度", provider_id: "provider", model: "model-b", temperature: 0.1, is_default: false, created_at: "", updated_at: "" },
];
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
function render(items = profiles, providers = [provider]) {
  act(() => root.render(<AISettingsManager
    initialProviders={providers} initialProfiles={items} initialTemplates={[]}
    initialUsage={[{ usage: "final_minutes", profile_id: "second", disabled: false, updated_at: "" }]}
    initialTranscriptionSettings={{ provider: "whisperx", azure_region: null, azure_language: "ja-JP", has_api_key: false, api_key_masked: null, updated_at: "" }}
  />));
}
function button(label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!found) throw new Error("Missing button: " + label);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}
function radio(id: string) {
  return container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)!;
}
function form() { return container.querySelector<HTMLFormElement>('form[aria-label]')!; }
function change(name: string, value: string) {
  const input = form().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AI profile list interactions", () => {
  it("shows compact summaries and one default, with editors initially closed", () => {
    render();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(radio("first").checked).toBe(true);
    expect(radio("second").checked).toBe(false);
    expect(form()).toBeNull();
    expect(button("標準を編集").textContent).toContain("Gemini接続 · model-a");
    expect(button("高精度を編集").getAttribute("aria-expanded")).toBe("false");
  });

  it("persists only the default flag and does not open an editor", async () => {
    render();
    respond({ ...profiles[1], is_default: true });
    await click(radio("second"));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/ai/profiles/second", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ is_default: true }),
    }));
    expect(radio("second").checked).toBe(true);
    expect(radio("first").checked).toBe(false);
    expect(form()).toBeNull();
  });

  it("keeps the saved selection on failure and disables duplicate submissions", async () => {
    render();
    let finish!: (response: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await click(radio("second"));
    expect(radio("first").disabled).toBe(true);
    await click(radio("first"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false, status: 503, json: async () => ({ detail: "保存できませんでした" }) }));
    expect(radio("first").checked).toBe(true);
    expect(radio("second").checked).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("保存できませんでした");
    expect(radio("second").disabled).toBe(false);
  });

  it("preserves drafts when selecting a default and saves edits without overwriting it", async () => {
    render();
    await click(button("高精度を編集"));
    change("name", "精密な議事録");
    change("model", "model-c");
    respond({ ...profiles[1], is_default: true });
    await click(radio("second"));
    expect(form().querySelector<HTMLInputElement>('[name="name"]')?.value).toBe("精密な議事録");
    respond({ ...profiles[1], name: "精密な議事録", model: "model-c", is_default: true });
    await submit();
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toEqual({ name: "精密な議事録", model: "model-c", provider_id: "provider", temperature: 0.1 });
    expect(body).not.toHaveProperty("is_default");
    expect(form()).toBeNull();
    expect(radio("second").checked).toBe(true);
    expect(button("精密な議事録を編集").textContent).toContain("model-c");
    expect(container.querySelector('option[value="second"]')?.textContent).toBe("精密な議事録");
  });

  it("retains entered values on save failure and confirms discarding unsaved edits", async () => {
    render();
    await click(button("高精度を編集"));
    change("name", "変更中");
    respond({ detail: "Profile名は重複できません" }, 409);
    await submit();
    expect(form().querySelector<HTMLInputElement>('[name="name"]')?.value).toBe("変更中");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(button("標準を編集"));
    expect(confirm).toHaveBeenCalled();
    expect(form().getAttribute("aria-label")).toBe("高精度の編集");
    confirm.mockReturnValue(true);
    await click(button("キャンセル"));
    expect(form()).toBeNull();
    expect(button("高精度を編集")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adds the first profile as default and makes it available to usage settings", async () => {
    render([]);
    await click(button("＋ プロファイルを追加"));
    change("name", "標準");
    change("model", "model-a");
    respond(profiles[0]);
    await submit();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ai/profiles");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).is_default).toBe(true);
    expect(radio("first").checked).toBe(true);
    expect(container.querySelector('option[value="first"]')).not.toBeNull();
  });

  it("does not replace an existing default when adding another profile", async () => {
    render();
    await click(button("＋ プロファイルを追加"));
    change("name", "追加");
    change("model", "model-c");
    respond({ ...profiles[1], id: "third", name: "追加", model: "model-c" });
    await submit();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).is_default).toBe(false);
    expect(radio("first").checked).toBe(true);
    expect(radio("third").checked).toBe(false);
  });

  it("confirms deletion and falls back to default in usage settings", async () => {
    render();
    await click(button("高精度を編集"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(button("削除", form()));
    expect(fetchMock).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    respond(null, 204);
    await click(button("削除", form()));
    expect(radio("second")).toBeNull();
    expect(container.querySelector('option[value="second"]')).toBeNull();
    const usage = container.querySelector<HTMLOptionElement>('option[value="default"]')!.parentElement as HTMLSelectElement;
    expect(usage.value).toBe("default");
  });

  it("explains how to proceed with no providers and prevents adding a profile", () => {
    render([], []);
    expect(button("＋ プロファイルを追加").disabled).toBe(true);
    expect(container.textContent).toContain("先に接続先を追加してください。");
  });
});
