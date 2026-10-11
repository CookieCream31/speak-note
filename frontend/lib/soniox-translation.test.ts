import { describe, expect, it } from "vitest";
import { SonioxTranslationAccumulator } from "./soniox-translation";
import { parseSonioxResponse, SonioxTranscriptAccumulator } from "./soniox-speech-stream";
import { createLiveTranslationStore } from "./live-translation-store";

const token = (text: string, is_final = true, language = "ja", source_language = "en") => ({ text, is_final, language, source_language, speaker: "1", translation_status: "translation" });
describe("Soniox live translation", () => {
  it("replaces drafts, assembles final subwords without timestamps and flushes once", () => {
    const accumulator = new SonioxTranslationAccumulator("socket");
    expect(accumulator.accept({ tokens: [token("おは", false)] }).interim?.text).toBe("おは");
    expect(accumulator.accept({ tokens: [token("おはよう", false)] }).interim?.text).toBe("おはよう");
    accumulator.accept({ tokens: [token("おは"), token("よう", false)] });
    const final = accumulator.accept({ tokens: [token("よう"), token("ございます"), { text: "<end>", is_final: true }] }).finals;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ resultId: "socket:translation:0", text: "おはようございます", sourceLanguage: "en", targetLanguage: "ja" });
    expect(final[0]).not.toHaveProperty("startMs");
    expect(accumulator.flush()).toEqual([]);
  });
  it("keeps original transcripts separate and supports both directions in token order", () => {
    const translated = new SonioxTranslationAccumulator("x"), original = new SonioxTranscriptAccumulator("x", 2000);
    const response = parseSonioxResponse({ tokens: [
      { text: "Hello", is_final: true, start_ms: 0, end_ms: 100, speaker: "1", translation_status: "original" },
      token("こんにちは"),
      { text: "お元気", is_final: true, start_ms: 100, end_ms: 200, speaker: "1", translation_status: "original" },
      token("How are you?", true, "en", "ja"),
    ], finished: true });
    expect(translated.accept(response).finals.map((row) => row.text)).toEqual(["こんにちは", "How are you?"]);
    expect(original.accept(response).finals.map((row) => row.text).join("")).toBe("Helloお元気");
    expect(new SonioxTranslationAccumulator("y").accept({ tokens: [token("こんにちは")], finished: true }).finals[0].resultId).not.toBe("x:translation:0");
  });
  it("rejects translation metadata without inventing missing times", () => {
    expect(parseSonioxResponse({ tokens: [token("翻訳")] }).tokens).toHaveLength(1);
    expect(() => parseSonioxResponse({ tokens: [{ ...token("翻訳"), language: undefined }] })).toThrow("翻訳言語");
    expect(() => parseSonioxResponse({ tokens: [{ ...token("翻訳"), source_language: 1 }] })).toThrow("翻訳言語");
  });
  it("separates drafts, ignores duplicate finals, and marks only acknowledged results as saved", () => {
    const store = createLiveTranslationStore();
    const result = { resultId: "x", text: "Hello", sourceLanguage: "ja", targetLanguage: "en", speakerLabel: "話者 1" };
    store.accept(result, false); store.accept({ ...result, text: "Hello world" }, false);
    expect(store.getSnapshot().history).toEqual([]);
    expect(store.getSnapshot().interim?.text).toBe("Hello world");
    store.accept(result, true); store.accept(result, true);
    expect(store.getSnapshot().history).toHaveLength(1);
    expect(store.getSnapshot().interim).toBeNull();
    store.markSaved("x"); expect(store.getSnapshot().history[0].saved).toBe(true);
    store.reset(); expect(store.getSnapshot().history).toEqual([]);
  });
});
