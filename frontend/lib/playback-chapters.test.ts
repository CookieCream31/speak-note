import { describe, expect, it } from "vitest";

import type { AnalysisVersion, TimelineMarker } from "@/lib/api";

import { resolvePlaybackChapters } from "./playback-chapters";

function analysisWithItems(items: AnalysisVersion["items"]): AnalysisVersion {
  return {
    id: "analysis-1",
    meeting_id: "meeting-1",
    transcript_version_id: "transcript-1",
    provider_id: null,
    profile_id: null,
    job_id: null,
    version: 1,
    model: "test-model",
    temperature: 0,
    prompt_version: "test",
    status: "completed",
    error_message: null,
    created_at: "2026-09-12T00:00:00Z",
    completed_at: "2026-09-12T00:00:01Z",
    items,
  };
}

const timeline: TimelineMarker[] = [{
  id: "timeline-chapter-2",
  kind: "chapter",
  timestamp_ms: 20_000,
  end_ms: 40_000,
  title: "本題",
}, {
  id: "timeline-chapter-1",
  kind: "chapter",
  timestamp_ms: 0,
  end_ms: 20_000,
  title: "導入",
}, {
  id: "important-1",
  kind: "important_point",
  timestamp_ms: 5_000,
  end_ms: 8_000,
  title: "重要情報",
}];

describe("resolvePlaybackChapters", () => {
  it("uses chapters from the selected final analysis", () => {
    const analysis = analysisWithItems([{
      id: "selected-chapter",
      kind: "chapter",
      state: "generated",
      content: "選択中の確定版チャプター",
      assignee: null,
      deadline: null,
      start_ms: 1_000,
      end_ms: 10_000,
      sequence: 0,
      evidence: [],
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
    }]);

    expect(resolvePlaybackChapters(analysis, timeline)).toEqual([{
      id: "selected-chapter",
      title: "選択中の確定版チャプター",
      startMs: 1_000,
      endMs: 10_000,
    }]);
  });

  it("does not mix active final chapters into realtime history", () => {
    const realtimeHistory = analysisWithItems([{
      id: "realtime-summary",
      kind: "summary",
      state: "generated",
      content: "リアルタイム要約",
      assignee: null,
      deadline: null,
      start_ms: null,
      end_ms: null,
      sequence: 0,
      evidence: [],
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
    }]);

    expect(resolvePlaybackChapters(realtimeHistory, timeline)).toEqual([]);
  });

  it("uses the active timeline only when no analysis is displayed", () => {
    expect(resolvePlaybackChapters(null, timeline)).toEqual([{
      id: "timeline-chapter-1",
      title: "導入",
      startMs: 0,
      endMs: 20_000,
    }, {
      id: "timeline-chapter-2",
      title: "本題",
      startMs: 20_000,
      endMs: 40_000,
    }]);
  });
});
