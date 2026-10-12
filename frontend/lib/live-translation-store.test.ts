import { describe, expect, it } from "vitest";
import type { LiveTranslation } from "./api";
import { partitionLiveTranslations } from "./live-translation-store";

const row: LiveTranslation = { id: "t", result_id: "t", sequence: 0, text: "翻訳", source_language: "en", target_language: "ja", speaker_label: "話者 1" };

describe("translation display anchors", () => {
  it("matches browser IDs and persisted aliases without duplicating the caption", () => {
    const result = partitionLiveTranslations([
      { ...row, source_result_id: "socket:0", source_segment_id: "db-source" },
      { ...row, id: "t2", result_id: "t2", source_segment_id: "db-source" },
    ], [{ id: "socket:0", aliases: ["db-source"] }]);
    expect(result.bySource.get("socket:0")?.map((item) => item.result_id)).toEqual(["t", "t2"]);
    expect(result.unmatched).toEqual([]);
  });
  it("never guesses from caption order, sequence, speaker or another connection's ID", () => {
    const rows = [row, { ...row, id: "other", result_id: "other", source_result_id: "previous-connection:0" }];
    const result = partitionLiveTranslations(rows, [{ id: "current-connection:0" }]);
    expect(result.bySource.size).toBe(0);
    expect(result.unmatched).toEqual(rows);
  });
});
