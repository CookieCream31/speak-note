import { describe, expect, it, vi } from "vitest";
import { answerAssistApi, isLikelyQuestion } from "./answer-assist";

describe("answer assistance", () => {
  it.each(["経験はありますか？", "担当を教えてください", "どう考えていますか", "なぜ応募しましたか"])("detects a likely question: %s", (text) => {
    expect(isLikelyQuestion(text)).toBe(true);
  });
  it.each(["はい、経験があります。", "よろしくお願いします。", ""])("does not trigger on an ordinary statement: %s", (text) => {
    expect(isLikelyQuestion(text)).toBe(false);
  });
  it("starts only the explicitly selected profile and sends explicit consent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "session" }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await answerAssistApi.start("meeting", "selected-profile");
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/meetings/meeting/answer-assist/session", expect.objectContaining({
        method: "POST", body: JSON.stringify({ profile_id: "selected-profile", consent: true }),
      }));
    } finally { vi.unstubAllGlobals(); }
  });
});
