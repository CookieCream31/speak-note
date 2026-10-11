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
});
