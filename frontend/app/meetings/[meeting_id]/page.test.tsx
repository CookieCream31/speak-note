import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingReviewPanel } from "@/components/meeting-review-panel";
import MeetingDetailPage from "./page";
import { AppStatusPage } from "@/components/app-status-page";
import { SummaryRegenerationButton } from "@/components/final-transcript-button";

vi.mock("@/app/actions", () => ({ updateSegmentAction: vi.fn() }));
vi.mock("@/components/meeting-review-panel", () => ({ MeetingReviewPanel: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
type ReviewProps = ComponentProps<typeof MeetingReviewPanel>;
type RegenerationProps = ComponentProps<typeof SummaryRegenerationButton>;
const finalTranscript = { id: "final", kind: "final", model: "whisperx", segments: [{
  id: "final-segment", text: "確定発言", start_ms: 0, end_ms: 1000, speaker: null, words: [],
}] };
const liveTranscript = { ...finalTranscript, id: "live", kind: "live", segments: [{
  ...finalTranscript.segments[0], id: "live-segment", text: "Realtimeの発言",
}] };
const realtime = { status: "completed", model: "live-ai", updated_at: "2026-09-27T00:00:00Z",
  completed_at: "2026-09-27T00:00:00Z", evidence: [], snapshot: { summary: {
    content: "保存済みRealtime要約", evidence_segment_ids: [],
  }, decisions: [], action_items: [], attention_items: [], key_facts: [] } };
let finalAnalysis: Record<string, unknown> | null;
let sharedAudio = false;
function review(node: ReactNode): ReactElement<ReviewProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = review(child); if (found) return found; }
  } else if (isValidElement<ReviewProps>(node) && node.type === MeetingReviewPanel) {
    return node;
  } else if (isValidElement<{ children?: ReactNode; notes?: ReactNode }>(node)) {
    return review(node.props.children) ?? review(node.props.notes);
  }
  return undefined;
}
function regenerationButton(node: ReactNode): ReactElement<RegenerationProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = regenerationButton(child); if (found) return found; }
  } else if (isValidElement<RegenerationProps>(node) && node.type === SummaryRegenerationButton) {
    return node;
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    return regenerationButton(node.props.children);
  }
  return undefined;
}
async function page(search: { analysis_id?: string; transcript_kind?: string } = {}) {
  const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }),
    searchParams: Promise.resolve(search) });
  const panel = review(element);
  if (!panel) throw new Error("Meeting notes were not rendered");
  return panel;
}
beforeEach(() => {
  finalAnalysis = null;
  sharedAudio = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    let data: unknown = [];
    let status = 200;
    if (path === "/api/v1/meetings/m") data = { id: "m", title: "Test", source_type: sharedAudio ? "shared_audio" : "audio_recording",
      status: "analyzing", created_at: "2026-09-27T00:00:00Z", ai_profile_id: null,
      template_snapshot: null, ai_disabled: false, tags: [], duration_ms: 1000 };
    else if (path === "/api/v1/meetings/m/transcript") data = sharedAudio ? liveTranscript : finalTranscript;
    else if (path.endsWith("/media") && sharedAudio) data = [{ id: "audio", kind: "original_audio", mime_type: "audio/webm" }];
    else if (path.endsWith("/transcript?kind=live")) data = liveTranscript;
    else if (path.endsWith("/live/analysis")) data = realtime;
    else if (path.endsWith("/live")) data = { status: "completed" };
    else if (path.endsWith("/analysis") || path.endsWith("/analyses/a")) {
      data = finalAnalysis; status = data ? 200 : 404;
    } else if (path.endsWith("/jobs")) data = sharedAudio ? [] : [{ id: "job", type: "analyze", status: "running", attempts: 1 }];
    return { ok: status === 200, status, json: async () => data };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("meeting summary regeneration presentation", () => {
  it("shows stopped shared audio as saved realtime notes ready for the first Final without video conversion", async () => {
    sharedAudio = true;
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }),
      searchParams: Promise.resolve({}) });
    expect(review(element)?.props.analysis?.id).toBe("realtime");
    expect(review(element)?.props.evidenceSegments[0].id).toBe("live-segment");
    expect(regenerationButton(element)?.props).toMatchObject({ ready: true, processing: false, hasFinal: false });
  });
  it("uses the themed status page when the meeting cannot be loaded", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Backend unavailable"));
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }),
      searchParams: Promise.resolve({}) });
    expect(element.type).toBe(AppStatusPage);
    expect(element.props.title).toBe("会議データを取得できませんでした");
  });
  it("keeps saved realtime notes as the default while Final is saved and summary is pending", async () => {
    const panel = await page();
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }),
      searchParams: Promise.resolve({}) });
    const regeneration = regenerationButton(element);
    expect(panel.props.analysis?.id).toBe("realtime");
    expect(panel.props.analysis?.items[0].content).toBe("保存済みRealtime要約");
    expect(panel.props.evidenceSegments[0].id).toBe("live-segment");
    expect(regeneration?.props.processing).toBe(true);
    expect(regeneration?.props.hasFinal).toBe(true);
  });
  it("honors an explicit Final transcript selection during summary processing", async () => {
    const panel = await page({ transcript_kind: "final" });
    expect(panel.props.analysis).toBeNull();
    expect(panel.props.evidenceSegments[0].id).toBe("final-segment");
    expect(panel.props.realtimeHistory?.id).toBe("realtime");
  });
  it("updates a selected processing version when generation completes", async () => {
    finalAnalysis = { id: "a", status: "processing", completed_at: null, items: [], model: "model" };
    const pending = await page({ analysis_id: "a" });
    finalAnalysis = { ...finalAnalysis, status: "completed", completed_at: "2026-09-27T00:00:01Z",
      items: [{ id: "summary", kind: "summary", content: "生成完了", sequence: 0, evidence: [] }] };
    const completed = await page({ analysis_id: "a" });
    expect(completed.props.analysis?.items[0].content).toBe("生成完了");
    expect(completed.key).not.toBe(pending.key);
  });
});
