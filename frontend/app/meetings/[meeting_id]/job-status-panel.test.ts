import type { Job } from "@/lib/api";
import { describe, expect, it } from "vitest";

import { groupJobsForDisplay } from "./job-status-panel";

function job(id: string, type: Job["type"], status: Job["status"], createdAt: string): Job {
  return {
    id,
    meeting_id: "meeting-1",
    realtime_chunk_id: null,
    realtime_window_start_ms: null,
    realtime_window_end_ms: null,
    realtime_commit_start_ms: null,
    type,
    status,
    attempts: 1,
    progress: status === "completed" ? 100 : null,
    error_message: status === "failed" ? "old failure" : null,
    created_at: createdAt,
    started_at: null,
    finished_at: null,
  };
}

describe("groupJobsForDisplay", () => {
  it("keeps only the newest execution of each type in the current status", () => {
    const oldAnalysis = job("analyze-old", "analyze", "failed", "2026-09-01T10:00:00Z");
    const latestAnalysis = job("analyze-new", "analyze", "completed", "2026-09-01T10:10:00Z");
    const transcription = job("transcribe", "transcribe", "completed", "2026-09-01T09:00:00Z");

    const grouped = groupJobsForDisplay([oldAnalysis, transcription, latestAnalysis]);

    expect(grouped.currentJobs.map((item) => item.id)).toEqual([
      "transcribe",
      "analyze-new",
    ]);
    expect(grouped.historyJobs.map((item) => item.id)).toEqual(["analyze-old"]);
    expect(grouped.currentJobs.some((item) => item.status === "failed")).toBe(false);
  });

  it("keeps an unresolved live window failure visible after later windows complete", () => {
    const failedWindow = job(
      "live-failed",
      "transcribe_live",
      "failed",
      "2026-09-01T10:00:00Z",
    );
    const laterWindow = job(
      "live-later",
      "transcribe_live",
      "completed",
      "2026-09-01T10:01:00Z",
    );

    const grouped = groupJobsForDisplay([failedWindow, laterWindow]);

    expect(grouped.currentJobs.map((item) => item.id)).toEqual(["live-failed"]);
    expect(grouped.historyJobs.map((item) => item.id)).toEqual(["live-later"]);
  });
});
