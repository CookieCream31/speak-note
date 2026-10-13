// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptDocument, type PlaybackTurn } from "./transcript-player";
import { getLiveTranslationStore } from "@/lib/live-translation-store";
import type { LiveTranslation } from "@/lib/api";

let host: HTMLDivElement, root: Root, meetingId: string;
const turns: PlaybackTurn[] = [{ id: "turn", startMs: 0, speakerId: null, speakerName: "話者 1", sourceSegmentIds: ["segment-1", "segment-2"], words: [{ id: "word", startMs: 0, endMs: 500, text: "Original words", exact: true }] }];
const persisted: LiveTranslation[] = [{ id: "db-t", result_id: "t", sequence: 0, text: "原文の翻訳", source_language: "en", target_language: "ja", speaker_label: "話者 1", source_segment_id: "segment-2" }];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  meetingId = crypto.randomUUID();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("playback transcript translations", () => {
  it("offers Live names by selected segment only after the caller marks them saved and editable", () => {
    act(() => root.render(<TranscriptDocument meetingId={meetingId} turns={turns} />));
    expect(host.querySelector('[title="この発言の話者名を変更（暫定）"]')).toBeNull();
    act(() => root.render(<TranscriptDocument meetingId={meetingId} turns={[{ ...turns[0], editableLiveSegmentIds: turns[0].sourceSegmentIds }]} />));
    expect(host.querySelector('[title="この発言の話者名を変更（暫定）"]')).not.toBeNull();
  });
  it("puts saved captions under a grouped original and keeps player seeking limited to the original", () => {
    act(() => root.render(<TranscriptDocument meetingId={meetingId} mediaUrl="/audio" turns={turns} translations={persisted} />));
    const original = host.querySelector('[data-transcript-text]');
    const article = original?.closest("article");
    expect(article?.querySelector('[data-translation-paragraph]')?.textContent).toContain("原文の翻訳");
    expect(original?.textContent).toBe("Original words");
    expect(article?.querySelector('[data-translation-paragraph] [data-seek-ms]')).toBeNull();
    expect(article?.querySelector('[data-translation-paragraph] p')?.getAttribute('dir')).toBe("auto");
    expect(original?.parentElement).toBe(article?.querySelector('[aria-label="リアルタイム翻訳"]')?.parentElement);
    expect(host.querySelectorAll('[data-transcript-turn]')).toHaveLength(1);
  });
  it("keeps legacy and missing-original captions visible inside the transcript document", () => {
    act(() => root.render(<TranscriptDocument meetingId={meetingId} turns={turns} translations={[{ ...persisted[0], source_segment_id: null }]} />));
    expect(host.querySelector('article [data-translation-paragraph]')).toBeNull();
    expect(host.querySelector('[data-transcript-document] [aria-label="翻訳履歴"]')?.textContent).toContain("原文の翻訳");
    act(() => root.render(<TranscriptDocument meetingId={meetingId} turns={[]} translations={persisted} />));
    expect(host.textContent).toContain("原文の翻訳");
  });
  it("does not attach realtime captions to a Final or upload transcript", () => {
    act(() => getLiveTranslationStore(meetingId).accept({ resultId: "local", sourceResultId: "turn", text: "リアルタイム翻訳", sourceLanguage: "en", targetLanguage: "ja", speakerLabel: "話者 1" }, true));
    act(() => root.render(<TranscriptDocument meetingId={meetingId} turns={[{ ...turns[0], sourceSegmentIds: undefined }]} />));
    expect(host.textContent).toContain("Original words");
    expect(host.textContent).not.toContain("リアルタイム翻訳");
  });
});
