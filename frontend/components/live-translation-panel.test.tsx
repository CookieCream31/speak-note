// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineTranslations, LiveTranslationPanel } from "./live-translation-panel";
import { getLiveTranslationStore } from "@/lib/live-translation-store";
import type { LiveTranslation } from "@/lib/api";

let host: HTMLDivElement, root: Root;
const meetingId = "translation-test";
const result = { resultId: "r", text: "翻訳された発言", sourceLanguage: "en", targetLanguage: "ja", speakerLabel: "話者 1" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getLiveTranslationStore(meetingId).reset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe("translated captions", () => {
  it("shows drafts separately and keeps the finalized text when only an old draft is cleared", async () => {
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} translation={{ type: "one_way", target_language: "ja" }} />));
    await act(async () => getLiveTranslationStore(meetingId).accept(result, false));
    expect(host.textContent).toContain("翻訳中");
    await act(async () => getLiveTranslationStore(meetingId).accept(result, true));
    await act(async () => getLiveTranslationStore(meetingId).clearInterim("r"));
    expect(host.querySelectorAll("[data-translation-result-id]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-translation-paragraph]")).toHaveLength(1);
    expect(host.textContent).toContain("保存待ち");
    await act(async () => getLiveTranslationStore(meetingId).markSaved("r"));
    expect(host.textContent).toContain("保存済み");
  });
  it("merges persisted captions without duplication, preserves ordering and never offers audio seeking", async () => {
    await act(async () => getLiveTranslationStore(meetingId).accept(result, true));
    const persisted: LiveTranslation[] = [{ id: "db-r", result_id: "r", sequence: 1, text: "保存した翻訳", source_language: "en", target_language: "ja", speaker_label: "話者 1" }];
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} persisted={persisted} />));
    expect(host.querySelectorAll("[data-translation-result-id]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-translation-paragraph]")).toHaveLength(1);
    expect(host.textContent).toContain("保存した翻訳");
    expect(host.textContent).not.toContain("翻訳された発言");
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("英語 → 日本語");
  });
  it("escapes translated text and hides the unused panel", async () => {
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} />));
    expect(host.querySelector("section")).toBeNull();
    await act(async () => getLiveTranslationStore(meetingId).accept({ ...result, text: '<img src="x" onerror="alert(1)">' }, true));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain('<img src="x"');
  });
  it("flags same-language metadata while preserving saved captions and their reported languages", async () => {
    const row = Object.freeze({ id: "same", result_id: "same", sequence: 0, text: "残りの分を計上に入れましょう。", source_language: "ja", target_language: "ja", speaker_label: "話者 3", saved: true });
    await act(async () => root.render(<InlineTranslations rows={[row]} />));
    expect(host.textContent).toContain("日本語（原言語の判定要確認）");
    expect(host.textContent).not.toContain("日本語 → 日本語");
    expect(host.textContent).not.toContain("英語");
    expect(host.querySelector('p[dir="auto"]')?.textContent).toBe(row.text);
    expect(host.querySelector('small')?.textContent).toBe("保存済み");
    expect(row).toMatchObject({ source_language: "ja", target_language: "ja", text: "残りの分を計上に入れましょう。" });
  });
  it("keeps a rejected translation visible as a failure without claiming it was saved", async () => {
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} />));
    await act(async () => getLiveTranslationStore(meetingId).accept(result, true));
    await act(async () => getLiveTranslationStore(meetingId).markFailed("r", "録音の保存は続いています"));
    expect(host.textContent).toContain("保存失敗");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("録音の保存は続いています");
    expect(host.textContent).not.toContain("保存済み");
  });
  it("reads many saved chunks as one paragraph with a single language and status label", async () => {
    const rows: LiveTranslation[] = ["Hi, hello.", "So, um, well,", "since this is in", "English."].map((text, index) => ({
      id: `r${index}`, result_id: `r${index}`, text, sequence: index, source_language: "ja", target_language: "en", speaker_label: "話者 1", saved: true,
    }));
    await act(async () => root.render(<InlineTranslations rows={rows} />));
    expect(host.querySelectorAll('[data-translation-paragraph]')).toHaveLength(1);
    expect(host.querySelectorAll('p[dir="auto"]')).toHaveLength(1);
    expect(host.querySelector('p[dir="auto"]')?.textContent).toBe("Hi, hello. So, um, well, since this is in English.");
    expect(host.querySelectorAll('strong')).toHaveLength(1);
    expect(host.querySelectorAll('small')).toHaveLength(1);
    expect(host.querySelector('li')).toBeNull();
    expect(host.querySelector('small')?.textContent).toBe("保存済み");
  });
  it("replaces a draft within the same paragraph and deduplicates save errors without hiding text", async () => {
    const base: LiveTranslation = { id: "first", result_id: "first", sequence: 0, text: "Hello", source_language: "en", target_language: "ja", speaker_label: "話者 1", saved: true };
    const draft = { ...base, id: "draft", result_id: "draft", text: "途中", isFinal: false, saved: false };
    await act(async () => root.render(<InlineTranslations rows={[base, draft]} />));
    const paragraph = host.querySelector('p[dir="auto"]');
    const tail = host.querySelector('[data-translation-result-id="draft"]');
    expect(host.querySelector('small')?.textContent).toBe("翻訳中");
    await act(async () => root.render(<InlineTranslations rows={[base, { ...draft, text: "確定した翻訳", isFinal: true, saved: true }]} />));
    expect(host.querySelector('p[dir="auto"]')).toBe(paragraph);
    expect(host.querySelector('[data-translation-result-id="draft"]')).toBe(tail);
    expect(paragraph?.textContent).toBe("Hello確定した翻訳");
    expect(host.textContent).not.toContain("途中");
    await act(async () => root.render(<InlineTranslations rows={[{ ...base, error: "保存できませんでした" }, { ...draft, isFinal: true, error: "保存できませんでした" }]} />));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('small')?.textContent).toBe("保存失敗");
  });
});
