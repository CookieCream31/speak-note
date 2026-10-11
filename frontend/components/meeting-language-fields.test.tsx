// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingLanguageFields, type MeetingLanguageSelection } from "./meeting-language-fields";
import { MeetingTranscriptionSettings } from "./meeting-transcription-settings";

const soniox = { languages: ["ja", "en", "fr", "de"], supports_auto: true, supports_multiple: true, supports_strict: true, providers: ["soniox"] };
let host: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
function Harness({ includeRealtime = true, disabled = false, initial = { hints: ["ja"], strict: false } }: {
  includeRealtime?: boolean; disabled?: boolean; initial?: MeetingLanguageSelection;
}) {
  const [value, setValue] = useState(initial);
  return <><MeetingLanguageFields value={value} onChange={setValue} includeRealtime={includeRealtime} disabled={disabled} /><output>{JSON.stringify(value)}</output></>;
}
function select(label = "文字起こし言語") { return host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; }
function toggle() { return host.querySelector<HTMLInputElement>('[role="switch"]')!; }
async function choose(value: string, label = "文字起こし言語") {
  await act(async () => { select(label).value = value; select(label).dispatchEvent(new Event("change", { bubbles: true })); });
}
async function submit() {
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => soniox });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("meeting language selection", () => {
  it("defaults to Japanese with strict OFF and turns strict off when choosing automatic", async () => {
    await act(async () => root.render(<Harness />));
    expect(select().value).toBe("ja"); expect(toggle().checked).toBe(false);
    expect(toggle().parentElement?.lastElementChild).toBe(toggle());
    await act(async () => toggle().click()); expect(toggle().checked).toBe(true);
    await choose("auto");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":[],"strict":false}');
    expect(toggle().disabled).toBe(true);
  });
  it("adds and removes languages without duplicates and explains multiple-language strict", async () => {
    await act(async () => root.render(<Harness />));
    await choose("custom"); await choose("en", "追加する言語");
    expect(select("追加する言語").querySelector('option[value="ja"]')).toBeNull();
    await act(async () => toggle().click());
    expect(host.textContent).toContain("Strictは1つの言語で最も安定");
    await choose("fr", "追加する言語");
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="日本語を外す"]')!;
    await act(async () => remove.click());
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["en","fr"],"strict":true}');
  });
  it("shows provider limits and restricts single-language engines without applying strict", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...soniox, supports_auto: false, supports_multiple: false, supports_strict: false, providers: ["whisperx"] }) });
    await act(async () => root.render(<Harness />));
    expect(select().querySelector('option[value="auto"]')).toHaveProperty("disabled", true);
    expect(toggle().disabled).toBe(true);
    await choose("custom"); await choose("fr", "追加する言語");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["fr"],"strict":false}');
    expect(host.textContent).toContain("現在のエンジンでは言語を1つ");
  });
  it("refreshes capabilities when switching capture method and keeps incompatible choices visible", async () => {
    await act(async () => root.render(<Harness includeRealtime={false} initial={{ hints: ["ja", "en"], strict: false }} />));
    expect(fetchMock.mock.calls[0][0]).toContain("include_realtime=false");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...soniox, supports_multiple: false, supports_auto: false, providers: ["soniox", "azure_speech"] }) });
    await act(async () => root.render(<Harness includeRealtime />));
    expect(fetchMock.mock.calls[1][0]).toContain("include_realtime=true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("選び直してください");
    expect(host.querySelector("output")?.textContent).toContain('["ja","en"]');
  });
  it("allows switching strict OFF after changing to an engine without strict support", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...soniox, supports_auto: false, supports_multiple: false, supports_strict: false, providers: ["whisperx"] }) });
    await act(async () => root.render(<Harness initial={{ hints: ["en"], strict: true }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("選び直してください");
    expect(toggle().disabled).toBe(false);
    await act(async () => toggle().click());
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["en"],"strict":false}');
    expect(toggle().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("preserves selection on network failure, allows retry, and disables edits while loading", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await act(async () => root.render(<Harness initial={{ hints: ["en"], strict: true }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("取得できません");
    expect(select().disabled).toBe(true);
    let finish: (response: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("確認中");
    expect(toggle().disabled).toBe(true);
    await act(async () => finish({ ok: true, json: async () => soniox }));
    expect(select().value).toBe("en"); expect(toggle().checked).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("keeps historical defaults until explicitly choosing a meeting language", async () => {
    await act(async () => root.render(<Harness initial={{ hints: null, strict: false }} />));
    expect(select().value).toBe("legacy");
    await choose("en"); expect(host.querySelector("output")?.textContent).toBe('{"hints":["en"],"strict":false}');
  });
});

describe("saving meeting transcription settings", () => {
  it("sends languages and strict with speaker bounds and blocks rapid duplicate submissions", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={2} maxSpeakers={4} languageHints={["ja"]} disabled={false} />));
    await choose("en"); await act(async () => toggle().click());
    let finish: (response: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      const form = host.querySelector("form")!;
      for (let i = 0; i < 2; i += 1) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // One capability read, one PATCH.
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/v1/meetings/m");
    expect(JSON.parse(request.body)).toEqual({ min_speakers: 2, max_speakers: 4, transcription_language_hints: ["en"], transcription_language_hints_strict: true });
    expect(host.querySelector('button[type="submit"]')).toHaveProperty("disabled", true);
    await act(async () => finish({ ok: true, json: async () => ({ min_speakers: 2, max_speakers: 4, transcription_language_hints: ["en"], transcription_language_hints_strict: true }) }));
    expect(host.querySelector("output")?.textContent).toContain("保存済み");
  });
  it("retains draft choices and renders processing conflicts and provider errors", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={null} maxSpeakers={null} languageHints={["ja"]} disabled={false} />));
    await choose("en");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ detail: "録音中は変更できません" }) });
    await submit();
    expect(host.querySelector("output")?.textContent).toBe("録音中は変更できません");
    expect(host.querySelector('output[role="alert"]')).toHaveProperty("dataset.error", "true");
    expect(select().value).toBe("en");
    expect(host.querySelector('button[type="submit"]')).toHaveProperty("disabled", false);
  });
  it("disables language controls for a saved Final and preserves its options when saving speaker bounds", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={null} maxSpeakers={null} languageHints={["en"]} languageLocked disabled={false} />));
    expect(select().disabled).toBe(true); expect(toggle().disabled).toBe(true);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ min_speakers: null, max_speakers: null, transcription_language_hints: ["en"] }) });
    await submit();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ min_speakers: null, max_speakers: null });
    expect(host.textContent).toContain("保存済みFinalを再利用");
  });
  it("blocks all edits and submissions while recording or processing", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={null} maxSpeakers={null} languageHints={["ja"]} disabled />));
    expect(select().disabled).toBe(true);
    await submit(); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
