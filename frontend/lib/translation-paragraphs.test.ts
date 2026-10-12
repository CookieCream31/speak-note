import { describe, expect, it } from "vitest";
import type { LiveTranslation } from "./api";
import { groupTranslationParagraphs, translationSeparator } from "./translation-paragraphs";

const row: LiveTranslation = { id: "r", result_id: "r", sequence: 0, text: "Hello", source_language: "en", target_language: "ja", speaker_label: "話者 1" };

describe("translation paragraphs", () => {
  it("groups consecutive captions without changing saved data and separates languages or speakers", () => {
    const rows = [row, { ...row, id: "r2", result_id: "r2" }, { ...row, id: "r3", result_id: "r3", target_language: "fr" }, { ...row, id: "r4", result_id: "r4", speaker_label: "話者 2" }, { ...row, id: "r5", result_id: "r5" }];
    const original = structuredClone(rows);
    const groups = groupTranslationParagraphs(rows);
    expect(groups.map((group) => group.rows.map((item) => item.result_id))).toEqual([["r", "r2"], ["r3"], ["r4"], ["r5"]]);
    expect(rows).toEqual(original);
    expect(groupTranslationParagraphs([])).toEqual([]);
  });
  it.each([
    ["Hello", "world.", "en", " "],
    ["Hello", ",", "en", ""],
    ["(", "hello", "en", ""],
    ["Hello ", "world", "en", ""],
    ["こんにちは。", "次の議題", "ja", ""],
    ["你好", "世界", "zh", ""],
    ["API", "Key", "ja", " "],
    ["مرحبا", "بالعالم", "ar", " "],
  ])("joins %s / %s naturally for %s", (previous, next, language, expected) => {
    expect(translationSeparator(previous, next, language)).toBe(expected);
  });
});
