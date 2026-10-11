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
function pickerTrigger() { return host.querySelector<HTMLButtonElement>('button[aria-label="言語を選ぶ"]')!; }
function selected() { return host.querySelector('[aria-label="文字起こし言語"]')!; }
function languageButton(code: string) {
  const label = code === "auto" ? "自動判定" : new Intl.DisplayNames(["ja"], { type: "language" }).of(code);
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}を選択"]`)!;
}
function toggle() { return host.querySelector<HTMLInputElement>('[role="switch"]')!; }
async function openPicker() {
  if (pickerTrigger().getAttribute("aria-expanded") === "false") await act(async () => pickerTrigger().click());
}
async function clickLanguage(code: string) {
  await openPicker();
  await act(async () => languageButton(code).click());
}
async function choose(code: string) {
  await clickLanguage(code);
  // Use the visible tags to keep only the requested language in a multi-select configuration.
  if (code === "auto") return;
  const keep = new Intl.DisplayNames(["ja"], { type: "language" }).of(code);
  const others = Array.from(selected().querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.getAttribute("aria-label")?.endsWith("を外す") && button.getAttribute("aria-label") !== `${keep}を外す`);
  for (const button of others) await act(async () => button.click());
}
async function openAdvanced() {
  const details = host.querySelector<HTMLDetailsElement>("fieldset details")!;
  if (!details.open) await act(async () => details.querySelector("summary")!.click());
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
    expect(selected().textContent).toContain("日本語"); expect(toggle().checked).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("fieldset details")?.open).toBe(false);
    expect(host.querySelector("summary")?.textContent).toContain("Strict OFF");
    expect(toggle().parentElement?.lastElementChild).toBe(toggle());
    await openAdvanced();
    await act(async () => toggle().click()); expect(toggle().checked).toBe(true);
    expect(host.querySelector("summary")?.textContent).toContain("Strict ON");
    await choose("auto");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":[],"strict":false}');
    expect(toggle().disabled).toBe(true);
  });
  it("adds and removes languages without duplicates and explains multiple-language strict", async () => {
    await act(async () => root.render(<Harness />));
    await clickLanguage("en");
    expect(languageButton("ja").getAttribute("aria-pressed")).toBe("true");
    expect(languageButton("en").getAttribute("aria-pressed")).toBe("true");
    await openAdvanced();
    await act(async () => toggle().click());
    expect(host.textContent).toContain("Strictは1つの言語で最も安定");
    await clickLanguage("fr");
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="日本語を外す"]')!;
    await act(async () => remove.click());
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["en","fr"],"strict":true}');
    expect(document.activeElement).toBe(pickerTrigger());
    await clickLanguage("en");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["fr"],"strict":true}');
    await clickLanguage("fr"); // Clicking the last checked row cannot silently enable automatic.
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["fr"],"strict":true}');
    expect(selected().querySelector('[aria-label="フランス語を外す"]')).toBeNull();
    expect(languageButton("fr").disabled).toBe(false);
  });
  it("shows provider limits and restricts single-language engines without applying strict", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...soniox, supports_auto: false, supports_multiple: false, supports_strict: false, providers: ["whisperx"] }) });
    await act(async () => root.render(<Harness />));
    await openPicker();
    expect(languageButton("auto").disabled).toBe(true);
    expect(toggle().disabled).toBe(true);
    await choose("fr");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["fr"],"strict":false}');
    expect(host.textContent).toContain("WhisperXを使用しているため、自動判定は利用できません");
    expect(host.textContent).toContain("リアルタイム・確定版の両方をSoniox");
    expect(pickerTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pickerTrigger());
    expect(selected().textContent).toContain("フランス語");
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
    await openAdvanced();
    await act(async () => toggle().click());
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["en"],"strict":false}');
    expect(toggle().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("preserves selection on network failure, allows retry, and disables edits while loading", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await act(async () => root.render(<Harness initial={{ hints: ["en"], strict: true }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("取得できません");
    expect(pickerTrigger().disabled).toBe(true);
    let finish: (response: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "再取得")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("確認中");
    expect(toggle().disabled).toBe(true);
    await act(async () => finish({ ok: true, json: async () => soniox }));
    expect(selected().textContent).toContain("英語"); expect(toggle().checked).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("keeps historical defaults until explicitly choosing a meeting language", async () => {
    await act(async () => root.render(<Harness initial={{ hints: null, strict: false }} />));
    expect(selected().textContent).toContain("従来の設定を維持");
    await choose("en"); expect(host.querySelector("output")?.textContent).toBe('{"hints":["en"],"strict":false}');
  });
  it("searches Japanese names, English names and ISO codes without changing the selection", async () => {
    await act(async () => root.render(<Harness />));
    await openPicker();
    const input = host.querySelector<HTMLInputElement>('[aria-label="言語を検索"]')!;
    expect(document.activeElement).toBe(input);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const query of ["フランス", "FRENCH", "ｆｒ"]) {
      await act(async () => { setValue.call(input, query); input.dispatchEvent(new Event("input", { bubbles: true })); });
      expect(languageButton("fr")).not.toBeNull();
      expect(languageButton("en")).toBeNull();
    }
    await act(async () => { setValue.call(input, "unknown"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("該当する言語がありません");
    expect(host.querySelector("output")?.textContent).toBe('{"hints":["ja"],"strict":false}');
  });
  it("supports keyboard navigation and Escape while keeping the parent form from submitting during search", async () => {
    const parentKeyDown = vi.fn();
    await act(async () => root.render(<div onKeyDown={parentKeyDown}><Harness /></div>));
    await openPicker();
    const input = host.querySelector<HTMLInputElement>('[aria-label="言語を検索"]')!;
    const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(composing));
    expect(composing.defaultPrevented).toBe(false);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(languageButton("auto"));
    await act(async () => languageButton("auto").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(languageButton("de"));
    parentKeyDown.mockClear();
    await act(async () => languageButton("de").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(pickerTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pickerTrigger());
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
  it("closes on outside focus and shows Strict ON even when advanced settings are collapsed", async () => {
    await act(async () => root.render(<Harness initial={{ hints: ["en"], strict: true }} />));
    expect(host.querySelector<HTMLDetailsElement>("fieldset details")?.open).toBe(false);
    expect(host.querySelector("summary")?.textContent).toContain("Strict ON");
    await openPicker();
    await act(async () => host.querySelector<HTMLInputElement>('[aria-label="言語を検索"]')!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(pickerTrigger().getAttribute("aria-expanded")).toBe("true");
    const outside = document.createElement("button"); document.body.append(outside);
    await act(async () => outside.focus());
    expect(pickerTrigger().getAttribute("aria-expanded")).toBe("false");
    outside.remove();
  });
  it("explains limits for uploads without asking to change realtime settings", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...soniox, supports_auto: false, supports_multiple: false, supports_strict: false, providers: ["azure_speech"] }) });
    await act(async () => root.render(<Harness includeRealtime={false} />));
    expect(host.textContent).toContain("Azure AI Speechを使用しているため");
    expect(host.textContent).toContain("確定版をSoniox");
    expect(host.textContent).not.toContain("両方をSoniox");
  });
});

describe("saving meeting transcription settings", () => {
  it("sends languages and strict with speaker bounds and blocks rapid duplicate submissions", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={2} maxSpeakers={4} languageHints={["ja"]} disabled={false} />));
    await choose("en"); await openAdvanced(); await act(async () => toggle().click());
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
    expect(selected().textContent).toContain("英語");
    expect(host.querySelector('button[type="submit"]')).toHaveProperty("disabled", false);
  });
  it("disables language controls for a saved Final and preserves its options when saving speaker bounds", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={null} maxSpeakers={null} languageHints={["en"]} languageLocked disabled={false} />));
    expect(pickerTrigger().disabled).toBe(true); expect(toggle().disabled).toBe(true);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ min_speakers: null, max_speakers: null, transcription_language_hints: ["en"] }) });
    await submit();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ min_speakers: null, max_speakers: null });
    expect(host.textContent).toContain("保存済みFinalを再利用");
  });
  it("blocks all edits and submissions while recording or processing", async () => {
    await act(async () => root.render(<MeetingTranscriptionSettings meetingId="m" minSpeakers={null} maxSpeakers={null} languageHints={["ja"]} disabled />));
    expect(pickerTrigger().disabled).toBe(true);
    await submit(); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
