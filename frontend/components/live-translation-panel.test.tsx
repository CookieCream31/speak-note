// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTranslationPanel } from "./live-translation-panel";
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
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.textContent).toContain("保存待ち");
    await act(async () => getLiveTranslationStore(meetingId).markSaved("r"));
    expect(host.textContent).toContain("保存済み");
  });
  it("merges persisted captions without duplication, preserves ordering and never offers audio seeking", async () => {
    await act(async () => getLiveTranslationStore(meetingId).accept(result, true));
    const persisted: LiveTranslation[] = [{ id: "db-r", result_id: "r", sequence: 1, text: "保存した翻訳", source_language: "en", target_language: "ja", speaker_label: "話者 1" }];
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} persisted={persisted} />));
    expect(host.querySelectorAll("li")).toHaveLength(1);
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
  it("keeps a rejected translation visible as a failure without claiming it was saved", async () => {
    await act(async () => root.render(<LiveTranslationPanel meetingId={meetingId} />));
    await act(async () => getLiveTranslationStore(meetingId).accept(result, true));
    await act(async () => getLiveTranslationStore(meetingId).markFailed("r", "録音の保存は続いています"));
    expect(host.textContent).toContain("保存失敗");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("録音の保存は続いています");
    expect(host.textContent).not.toContain("保存済み");
  });
});
