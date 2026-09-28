import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AnalysisVersion, AnalysisVersionSummary, MeetingTemplateSnapshot } from "@/lib/api";
import { REALTIME_ANALYSIS_HISTORY_ID } from "@/lib/realtime-analysis-history";

import { MeetingReviewPanel } from "./meeting-review-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const realtimeHistory: AnalysisVersion = {
  id: REALTIME_ANALYSIS_HISTORY_ID,
  meeting_id: "meeting-1",
  transcript_version_id: "",
  provider_id: null,
  profile_id: null,
  job_id: null,
  version: 0,
  model: "gemini-realtime",
  temperature: 0,
  prompt_version: "realtime-history-v1",
  status: "completed",
  error_message: null,
  created_at: "2026-09-11T00:00:00Z",
  completed_at: "2026-09-11T00:00:01Z",
  items: [{
    id: "realtime-decision-0",
    kind: "decision",
    state: "generated",
    content: "Realtimeで確認した決定",
    assignee: null,
    deadline: null,
    start_ms: 40_000,
    end_ms: 80_000,
    sequence: 0,
    evidence: [],
    created_at: "2026-09-11T00:00:00Z",
    updated_at: "2026-09-11T00:00:01Z",
  }, {
    id: "realtime-summary-0",
    kind: "summary",
    state: "generated",
    content: "会議全体の要約",
    assignee: null,
    deadline: null,
    start_ms: null,
    end_ms: null,
    sequence: 1,
    evidence: [],
    created_at: "2026-09-11T00:00:00Z",
    updated_at: "2026-09-11T00:00:01Z",
  }],
};

const finalVersions: AnalysisVersionSummary[] = [{
  id: "analysis-1",
  version: 1,
  model: "gemini-final",
  status: "completed",
  created_at: "2026-09-11T00:01:00Z",
  completed_at: "2026-09-11T00:01:01Z",
}];

describe("MeetingReviewPanel", () => {
  it("keeps one protected summary row when a generated summary is also present", () => {
    const templateSnapshot: MeetingTemplateSnapshot = {
      template_id: "template-1",
      revision: 1,
      name: "Test",
      definition: {
        realtime: [],
        final: [{
          id: "summary-card",
          title: "会議概要",
          visible: true,
          show_when_empty: true,
          core_kind: "summary",
          fields: [],
        }],
      },
    };
    const baseSummary = realtimeHistory.items.find((item) => item.kind === "summary");
    if (!baseSummary) throw new Error("Test summary fixture is missing");
    const protectedSummary = {
      ...baseSummary,
      id: "summary-confirmed",
      state: "confirmed" as const,
      content: "ユーザーが確認した要約",
      sequence: 1,
      updated_at: "2026-09-12T00:00:00Z",
    };
    const generatedSummary = {
      ...baseSummary,
      id: "summary-regenerated",
      state: "generated" as const,
      content: "再生成された要約",
      sequence: 2,
      updated_at: "2026-09-13T00:00:00Z",
    };
    const analysis: AnalysisVersion = {
      ...realtimeHistory,
      id: "analysis-final-1",
      version: 1,
      template_snapshot: templateSnapshot,
      template_values: [],
      items: [protectedSummary, generatedSummary],
    };

    const html = renderToStaticMarkup(
      <MeetingReviewPanel
        meetingId="meeting-1"
        analysis={analysis}
        versions={finalVersions}
        realtimeHistory={realtimeHistory}
        regeneration={{ meetingId: "meeting-1", ready: true, processing: false, profiles: [], templates: [], currentProfileId: null, currentTemplate: null }}
        evidenceSegments={[]}
        playerAvailable={false}
      />,
    );

    expect(html).toContain("ユーザーが確認した要約");
    expect(html).not.toContain("再生成された要約");
  });

  it("shows realtime and final notes in the same history picker and overview", () => {
    const html = renderToStaticMarkup(
      <MeetingReviewPanel
        meetingId="meeting-1"
        analysis={realtimeHistory}
        versions={finalVersions}
        realtimeHistory={realtimeHistory}
        regeneration={{ meetingId: "meeting-1", ready: true, processing: false, profiles: [], templates: [], currentProfileId: null, currentTemplate: null }}
        evidenceSegments={[]}
        playerAvailable
      />,
    );

    expect(html).toContain("リアルタイム解析 · gemini-realtime");
    expect(html).toContain("リアルタイム解析 · gemini-realtime · completed");
    expect(html).toContain("確定版 v1 · gemini-final · completed");
    expect(html).toContain("data-analysis-overview");
    expect(html).toContain('data-analysis-kind="summary"');
    expect(html).toContain('data-analysis-kind="decision"');
    expect(html).toContain("会議全体の要約");
    expect(html).toContain("Realtimeで確認した決定");
    expect(html).toContain("0:40〜1:20");
    expect(html).not.toContain('aria-label="AI議事録の項目"');
    expect(html).not.toContain(">編集</button>");
    expect(html).not.toContain("確認済みにする");
  });
});

