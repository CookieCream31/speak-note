import { describe, expect, it } from "vitest";

import type { RealtimeAnalysis } from "@/lib/api";

import {
  isCompletedLiveMeetingNotes,
  REALTIME_ANALYSIS_HISTORY_ID,
  realtimeAnalysisToHistoryVersion,
} from "./realtime-analysis-history";

const analysis: RealtimeAnalysis = {
  status: "completed",
  input_revision: 2,
  processed_revision: 2,
  analyzed_through_ms: 80_000,
  model: "gemini-test",
  error_message: null,
  updated_at: "2026-09-11T00:00:00Z",
  completed_at: "2026-09-11T00:00:01Z",
  snapshot: {
    input_revision: 2,
    as_of_ms: 80_000,
    summary: {
      content: "会議の要約",
      evidence_segment_ids: ["early", "late"],
    },
    decisions: [{
      content: "採用を決定",
      status: "explicit",
      evidence_segment_ids: ["late", "early"],
    }],
    action_items: [],
    attention_items: [],
    key_facts: [],
  },
  evidence: [
    {
      evidence_id: "late",
      segment_id: "segment-late",
      start_ms: 70_000,
      end_ms: 80_000,
      status: "confirmed",
    },
    {
      evidence_id: "early",
      segment_id: "segment-early",
      start_ms: 40_000,
      end_ms: 50_000,
      status: "confirmed",
    },
  ],
};

describe("realtime analysis history", () => {
  it("converts a realtime snapshot into read-only meeting-note items", () => {
    const version = realtimeAnalysisToHistoryVersion("meeting-1", analysis);

    expect(version?.id).toBe(REALTIME_ANALYSIS_HISTORY_ID);
    expect(version?.model).toBe("gemini-test");
    expect(version?.items[0]).toMatchObject({
      kind: "summary",
      content: "会議の要約",
      start_ms: null,
      end_ms: null,
    });
    expect(version?.items[1]).toMatchObject({
      kind: "decision",
      content: "採用を決定",
      start_ms: 40_000,
      end_ms: 80_000,
    });
  });

  it("preserves the completed-final fallback for older callers", () => {
    const completedVersion = [{
      id: "analysis-1",
      version: 1,
      model: "gemini-test",
      status: "completed" as const,
      created_at: "2026-09-11T00:00:00Z",
      completed_at: "2026-09-11T00:00:01Z",
    }];

    expect(isCompletedLiveMeetingNotes("live", "final", completedVersion)).toBe(true);
    expect(isCompletedLiveMeetingNotes("audio_recording", "final", completedVersion)).toBe(true);
    expect(isCompletedLiveMeetingNotes("live", "live", completedVersion)).toBe(false);
    expect(isCompletedLiveMeetingNotes("video_upload", "final", completedVersion)).toBe(false);
  });
});

describe("stopped recording layout", () => {
  it("shows the common notes immediately after capture stops, without final processing", () => {
    expect(isCompletedLiveMeetingNotes("live", "live", [], "completed")).toBe(true);
    expect(isCompletedLiveMeetingNotes("audio_recording", "live", [], "completed")).toBe(true);
    expect(isCompletedLiveMeetingNotes("live", null, [], "completed")).toBe(true);
    expect(isCompletedLiveMeetingNotes("live", "final", [], "recording")).toBe(false);
    expect(isCompletedLiveMeetingNotes("live", "live", [], "finalizing")).toBe(false);
    expect(isCompletedLiveMeetingNotes("video_upload", "final", [], "completed")).toBe(false);
  });
});
