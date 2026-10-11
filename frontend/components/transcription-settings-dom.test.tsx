// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncTranscriptionSettingsForm } from "./async-transcription-settings";
import { AISettingsManager } from "./ai-settings-manager";
import type { AsyncTranscriptionSettings } from "@/lib/api";

vi.mock("@/app/actions", () => ({ createAIProviderAction: vi.fn() }));
vi.mock("./theme-selector", () => ({ ThemeSelector: () => null }));
let host: HTMLDivElement, root: Root;
const initial: AsyncTranscriptionSettings = { provider: "whisperx", soniox_model: "stt-async-v5", soniox_language: "ja", has_soniox_api_key: false, soniox_api_key_masked: null, updated_at: "" };
const fetchMock = vi.fn();
async function submit(form: HTMLFormElement) { await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
function field(name: string, form: ParentNode = host) { return form.querySelector<HTMLInputElement>(`[name="${name}"]`)!; }
async function inputKey(value: string, form: ParentNode = host) {
  const input = field("soniox_api_key", form);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function modelButton(form: ParentNode = host) { return [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "モデル一覧を取得")!; }

describe("independent transcription settings forms", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  it("selects Soniox, validates the key, and preserves it on save without echoing it", async () => {
    await act(async () => root.render(<AsyncTranscriptionSettingsForm initialSettings={initial} />));
    const form = host.querySelector("form")!;
    await act(async () => field("async_transcription_provider").parentElement?.nextElementSibling?.querySelector<HTMLInputElement>("input")?.click());
    expect(field("soniox_model").disabled).toBe(false);
    await submit(form);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("API Key"); expect(fetchMock).not.toHaveBeenCalled();
    field("soniox_api_key").value = "private-key";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...initial, provider: "soniox", has_soniox_api_key: true }) });
    await submit(form);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/transcription/async-settings");
    expect(JSON.parse(init.body)).toEqual({ provider: "soniox", soniox_model: "stt-async-v5", soniox_language: "ja", soniox_api_key: "private-key" });
    expect(field("soniox_api_key").value).toBe("");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("保存しました");
    await submit(form);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).soniox_api_key).toBeUndefined();
  });
  it("disables repeat submissions during processing and renders provider errors", async () => {
    await act(async () => root.render(<AsyncTranscriptionSettingsForm initialSettings={{ ...initial, provider: "soniox", has_soniox_api_key: true }} />));
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const form = host.querySelector("form")!;
    await submit(form);
    expect(host.textContent).toContain("処理中…"); expect(form.querySelector('button[type="submit"]')).toHaveProperty("disabled", true);
    await submit(form); expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: false, status: 502, json: async () => ({ detail: "Sonioxに接続できません" }) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sonioxに接続できません");
    expect(field("soniox_model").value).toBe("stt-async-v5");
  });
  it("saves realtime Soniox settings separately from the async form", async () => {
    await act(async () => root.render(<AISettingsManager initialProviders={[]} initialProfiles={[]} initialUsage={[]} initialTemplates={[]} initialTranscriptionSettings={{ provider: "whisperx", azure_region: null, azure_language: "ja-JP", has_api_key: false, api_key_masked: null, updated_at: "" }} initialAsyncTranscriptionSettings={initial} />));
    const form = host.querySelector<HTMLFormElement>("#stt form")!;
    await act(async () => form.querySelector<HTMLInputElement>('[name="transcription_provider"][value="soniox"]')!.click());
    field("soniox_api_key", form).value = "rt-key";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await submit(form);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/transcription/realtime-settings");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ provider: "soniox", soniox_model: "stt-rt-v5", soniox_api_key: "rt-key" });
    expect(host.querySelector<HTMLInputElement>('[name="async_transcription_provider"]:checked')!.value).toBe("whisperx");
  });
  it("discovers models with the draft key before saving, selects one, and saves that model", async () => {
    await act(async () => root.render(<AsyncTranscriptionSettingsForm initialSettings={{ ...initial, provider: "soniox" }} />));
    expect(modelButton().disabled).toBe(true);
    await inputKey(" draft-secret ");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [
      { id: "stt-async-v5", name: "Async v5" }, { id: "stt-async-v6", name: "Async v6" },
    ] }) });
    await act(async () => modelButton().click());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/transcription/soniox-models");
    expect(request.method).toBe("POST"); expect(request.cache).toBe("no-store");
    expect(JSON.parse(request.body)).toEqual({ purpose: "async", soniox_api_key: "draft-secret" });
    expect(host.textContent).not.toContain("draft-secret");
    expect(field("soniox_model").tagName).toBe("SELECT");
    expect(field("soniox_model").value).toBe("stt-async-v5");
    await act(async () => { field("soniox_model").value = "stt-async-v6"; field("soniox_model").dispatchEvent(new Event("change", { bubbles: true })); });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...initial, provider: "soniox", has_soniox_api_key: true }) });
    await submit(host.querySelector("form")!);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/transcription/async-settings");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ soniox_model: "stt-async-v6", soniox_api_key: "draft-secret" });
    expect(field("soniox_api_key").value).toBe("");
  });
  it("uses the saved key without returning it, blocks duplicates and saving while loading, and recovers from errors", async () => {
    await act(async () => root.render(<AsyncTranscriptionSettingsForm initialSettings={{ ...initial, provider: "soniox", has_soniox_api_key: true }} />));
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const button = modelButton();
    await act(async () => { button.click(); button.click(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ purpose: "async" });
    expect(host.textContent).toContain("取得中…");
    expect(field("soniox_api_key").disabled).toBe(true);
    expect(host.querySelector('button[type="submit"]')).toHaveProperty("disabled", true);
    await submit(host.querySelector("form")!); expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: false, status: 403, json: async () => ({ detail: "Model listingのAccess権限を確認してください" }) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Model listing");
    expect(field("soniox_model").value).toBe("stt-async-v5");
    expect(modelButton().disabled).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ id: "stt-async-v5", name: "Async v5" }] }) });
    await act(async () => modelButton().click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("1件");
  });
  it("preserves the current model on an empty list and requires a choice if the model is no longer listed", async () => {
    await act(async () => root.render(<AsyncTranscriptionSettingsForm initialSettings={{ ...initial, provider: "soniox", has_soniox_api_key: true }} />));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) });
    await act(async () => modelButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("モデルがありません");
    expect(field("soniox_model").value).toBe("stt-async-v5");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ id: "stt-async-v6", name: "Async v6" }] }) });
    await act(async () => modelButton().click());
    expect(field("soniox_model").value).toBe("");
    expect(field("soniox_model").checkValidity()).toBe(false);
    expect(fetchMock.mock.calls.every(([, request]) => JSON.parse(request.body).purpose === "async")).toBe(true);
  });
  it("keeps realtime model discovery and selection independent from async settings", async () => {
    await act(async () => root.render(<AISettingsManager initialProviders={[]} initialProfiles={[]} initialUsage={[]} initialTemplates={[]} initialTranscriptionSettings={{ provider: "soniox", soniox_model: "stt-rt-v5", has_soniox_api_key: true, soniox_language: "ja", azure_region: null, azure_language: "ja-JP", has_api_key: false, api_key_masked: null, updated_at: "" }} initialAsyncTranscriptionSettings={initial} />));
    const realtime = host.querySelector<HTMLFormElement>("#stt form")!;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ id: "stt-rt-v6", name: "Realtime v6" }] }) });
    await act(async () => modelButton(realtime).click());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ purpose: "realtime" });
    await act(async () => { field("soniox_model", realtime).value = "stt-rt-v6"; field("soniox_model", realtime).dispatchEvent(new Event("change", { bubbles: true })); });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await submit(realtime);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ provider: "soniox", soniox_model: "stt-rt-v6" });
    const asyncForm = host.querySelector<HTMLFormElement>("#async-stt form")!;
    expect(field("soniox_model", asyncForm).value).toBe("stt-async-v5");
    expect(asyncForm.querySelector<HTMLInputElement>('input[type="radio"]:checked')!.value).toBe("whisperx");
    expect(realtime.textContent).toContain("Temporary API keys → Access");
    expect(asyncForm.textContent).toContain("Files → Write");
  });
});
