import { describe, expect, it } from "vitest";

import { formatDate, sourceLabels, statusLabels } from "./format";

describe("meeting labels", () => {
  it("provides labels for API enum values", () => {
    expect(sourceLabels.audio_upload).toBe("音声");
    expect(sourceLabels.media_upload).toBe("ファイル");
    expect(sourceLabels.video_upload).toBe("動画");
    expect(statusLabels.completed).toBe("完了");
    expect(statusLabels.failed).toBe("失敗");
  });

  it("formats dates in a deterministic display time zone", () => {
    expect(formatDate("2026-09-04T19:06:34.173100Z")).toBe("2026年9月5日 04:06");
  });
});

