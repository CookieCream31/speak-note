import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingReviewPanel } from "@/components/meeting-review-panel";
import MeetingDetailPage from "./page";
import { AppStatusPage } from "@/components/app-status-page";
import { SummaryRegenerationButton } from "@/components/final-transcript-button";
import { MeetingWorkspace } from "@/components/meeting-workspace";
import { LiveTranscriptStream } from "@/components/realtime-analysis-panel";
import type { TranscriptWord } from "@/lib/api";

vi.mock("@/app/actions", () => ({ updateSegmentAction: vi.fn() }));
vi.mock("@/components/meeting-review-panel", () => ({ MeetingReviewPanel: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
type ReviewProps = ComponentProps<typeof MeetingReviewPanel>;
type RegenerationProps = ComponentProps<typeof SummaryRegenerationButton>;
const finalTranscript = { id: "final", kind: "final", status: "completed", model: "whisperx", segments: [{
  id: "final-segment", text: "確定発言", start_ms: 0, end_ms: 1000,
  speaker: null as { id: string; internal_name: string; display_name: string | null } | null, words: [] as TranscriptWord[],
}] };
const liveTranscript = { ...finalTranscript, id: "live", kind: "live", segments: [{
  ...finalTranscript.segments[0], id: "live-segment", text: "Realtimeの発言",
  provisional_speaker_label: "話者 1", provisional_speaker_name: null as string | null,
}] };
const realtime = { status: "completed", model: "live-ai", updated_at: "2026-09-27T00:00:00Z",
  completed_at: "2026-09-27T00:00:00Z", evidence: [], snapshot: { summary: {
    content: "保存済みRealtime要約", evidence_segment_ids: [],
  }, decisions: [], action_items: [], attention_items: [], key_facts: [] } };
let finalAnalysis: Record<string, unknown> | null;
let sharedAudio = false;
let translationsEnabled = false;
let liveReady = true;
let liveStatus = "completed";
function header(node: ReactNode): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = header(child); if (found) return found; }
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    return node.type === "header" ? node : header(node.props.children);
  }
}
function workspace(node: ReactNode): ReactElement<ComponentProps<typeof MeetingWorkspace>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = workspace(child); if (found) return found; }
  } else if (isValidElement<ComponentProps<typeof MeetingWorkspace>>(node) && node.type === MeetingWorkspace) {
    return node;
  } else if (isValidElement<{ children?: ReactNode }>(node)) return workspace(node.props.children);
}
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
  finalTranscript.model = "whisperx";
  finalTranscript.segments[0].text = "確定発言";
  finalTranscript.segments[0].words = [];
  finalTranscript.segments[0].end_ms = 1000;
  liveTranscript.segments[0].text = "Realtimeの発言";
  liveTranscript.segments[0].words = [];
  liveTranscript.segments[0].end_ms = 1000;
  finalTranscript.segments[0].speaker = null;
  liveTranscript.segments.splice(1);
  liveTranscript.segments[0].provisional_speaker_name = null;
  translationsEnabled = false;
  liveReady = true;
  liveStatus = "completed";
  finalAnalysis = null;
  sharedAudio = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    let data: unknown = [];
    let status = 200;
    if (path === "/api/v1/meetings/m") data = { id: "m", title: "Test", source_type: sharedAudio ? "shared_audio" : "audio_recording",
      status: "analyzing", created_at: "2026-09-27T00:00:00Z", ai_profile_id: null,
      template_snapshot: null, ai_disabled: false, tags: [], duration_ms: 1000 };
    else if (path === "/api/v1/meetings/m/transcript") { data = sharedAudio ? (liveReady ? liveTranscript : null) : finalTranscript; status = data ? 200 : 404; }
    else if (path.endsWith("/media") && sharedAudio) data = [{ id: "audio", kind: "original_audio", mime_type: "audio/webm" }];
    else if (path.endsWith("/transcript?kind=live")) { data = liveReady ? liveTranscript : null; status = data ? 200 : 404; }
    else if (path.endsWith("/transcript?kind=final")) { data = sharedAudio ? null : finalTranscript; status = data ? 200 : 404; }
    else if (path.endsWith("/transcript?version_id=live")) data = liveTranscript;
    else if (path.endsWith("/transcript?version_id=final")) data = finalTranscript;
    else if (path.endsWith("/live/analysis")) data = realtime;
    else if (path.endsWith("/live")) data = { status: liveStatus, translation: translationsEnabled ? { type: "one_way", target_language: "ja" } : null,
      translations: translationsEnabled ? [{ id: "caption", result_id: "caption", text: "翻訳", sequence: 0, source_language: "en", target_language: "ja", source_segment_id: "live-segment", speaker_label: null }] : [] };
    else if (path.endsWith("/analysis") || path.endsWith("/analyses/a")) {
      data = finalAnalysis; status = data ? 200 : 404;
    } else if (path.endsWith("/jobs")) data = sharedAudio ? [] : [{ id: "job", type: "analyze", status: "running", attempts: 1 }];
    return { ok: status === 200, status, json: async () => data };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("meeting summary regeneration presentation", () => {
  it.each(["completed", "recording", "finalizing"])("offers settings and new meeting while preserving the %s capture page", async (status) => {
    sharedAudio = true;
    liveStatus = status;
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(header(element));
    expect(html).toContain('href="/?create=1"');
    expect(html).toContain('href="/settings/ai"');
    expect(html).not.toContain("AI設定");
    expect(html).not.toContain("data-theme-option");
    if (status === "completed") expect(html).not.toContain('target="_blank"');
    else {
      expect(html.match(/target="_blank"/g)).toHaveLength(2);
      expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
      expect(html).toContain('aria-label="新しい会議（別タブで開く）"');
    }
  });
  it.each(["whisperx", "stt-async-v5", "stt-rt-v5"])("uses stored word times for %s without stretching the whole segment", async (model) => {
    sharedAudio = model === "stt-rt-v5";
    const transcript = sharedAudio ? liveTranscript : finalTranscript;
    transcript.model = model;
    const segment = transcript.segments[0];
    segment.text = "Hello world.";
    segment.end_ms = 3000;
    segment.words = [
      { id: "w1", text: "Hel", start_ms: 100, end_ms: 250, confidence: 0.9, sequence: 0, speaker_id: null },
      { id: "w2", text: "lo", start_ms: 300, end_ms: 450, confidence: 0.9, sequence: 1, speaker_id: null },
      { id: "w3", text: " world.", start_ms: 2000, end_ms: 2200, confidence: 0.9, sequence: 2, speaker_id: null },
    ];
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }),
      searchParams: Promise.resolve({ transcript_kind: sharedAudio ? "live" : "final" }) });
    expect(workspace(element)?.props.playback.turns[0].words).toEqual([
      { id: "w1", text: "Hel", startMs: 100, endMs: 250, exact: true },
      { id: "w2", text: "lo", startMs: 300, endMs: 450, exact: true },
      { id: "w3", text: " world.", startMs: 2000, endMs: 2200, exact: true },
    ]);
    expect(workspace(element)?.props.playback.turns[0].subwordTokens).toBe(model.startsWith("stt-"));
  });
  it("never sends a provisional label as a Speaker ID and edits saved Live by segment", async () => {
    sharedAudio = true;
    liveTranscript.segments[0].provisional_speaker_name = "エージェント";
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    expect(workspace(element)?.props.playback.turns[0]).toMatchObject({
      speakerId: null, speakerName: "エージェント", editableLiveSegmentIds: ["live-segment"],
    });
  });
  it("only makes actual Final Speaker IDs editable in the Final view", async () => {
    finalTranscript.segments[0].speaker = { id: "actual-speaker-uuid", internal_name: "SPEAKER_00", display_name: "確定話者" };
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({ transcript_kind: "final" }) });
    expect(workspace(element)?.props.playback.turns[0].editableLiveSegmentIds).toBeUndefined();
    expect(workspace(element)?.props.playback.turns[0].speakerId).toBe("actual-speaker-uuid");
  });
  it("keeps adjacent provisional labels separate when their saved display names differ", async () => {
    sharedAudio = true;
    liveTranscript.segments[0].provisional_speaker_name = "エージェント";
    liveTranscript.segments.push({ ...liveTranscript.segments[0], id: "next-segment", provisional_speaker_name: null });
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    expect(workspace(element)?.props.playback.turns).toHaveLength(2);
    expect(workspace(element)?.props.playback.turns.map((turn) => turn.speakerName)).toEqual(["エージェント", "話者 1"]);
  });
  it("does not treat adjacent unknown speakers as the same person", async () => {
    sharedAudio = true;
    liveTranscript.segments.push(
      { ...liveTranscript.segments[0], id: "unknown-1", provisional_speaker_label: "SPEAKER_UNKNOWN" },
      { ...liveTranscript.segments[0], id: "unknown-2", provisional_speaker_label: "SPEAKER_UNKNOWN" },
    );
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    expect(workspace(element)?.props.playback.turns).toHaveLength(3);
    expect(workspace(element)?.props.playback.turns[1].editableLiveSegmentIds).toEqual(["unknown-1"]);
  });
  it("waits for saved realtime text and offers whole transcription only as a separate detail action", async () => {
    sharedAudio = true;
    liveReady = false;
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    expect(regenerationButton(element)!.props.ready).toBe(false);
    expect(regenerationButton(element)!.props.hasSavedLive).toBe(false);
    expect(review(element)!.props.finalTranscription?.ready).toBe(true);
  });
  it("displays a saved realtime summary by default and enables summary-only regeneration", async () => {
    sharedAudio = true;
    finalAnalysis = { id: "a", transcript_version_id: "live", transcript_kind: "live", status: "completed", version: 1, model: "selected-ai", items: [] };
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({}) });
    const panel = review(element)!;
    expect(panel.props.analysis?.id).toBe("a");
    expect(panel.props.analysis?.transcript_kind).toBe("live");
    expect(panel.props.evidenceSegments[0].id).toBe("live-segment");
    expect(panel.props.finalTranscriptAvailable).toBe(false);
    const regeneration = regenerationButton(element)!;
    expect(regeneration.props.ready).toBe(true);
    expect(regeneration.props.hasSavedLive).toBe(true);
    expect(regeneration.props.hasFinal).toBe(false);
  });
  it("loads the source version of a selected provisional summary even after Final exists", async () => {
    finalAnalysis = { id: "a", transcript_version_id: "live", transcript_kind: "live", status: "completed", version: 1, model: "selected-ai", items: [] };
    const panel = await page({ analysis_id: "a" });
    expect(panel.props.evidenceSegments[0].id).toBe("live-segment");
    expect(panel.props.analysis?.id).toBe("a");
    expect(panel.props.finalTranscriptAvailable).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("transcript?version_id=live"))).toBe(true);
  });
  it("honors an explicit Final view even if the active summary is still based on Live", async () => {
    finalAnalysis = { id: "a", transcript_version_id: "live", transcript_kind: "live", status: "completed", version: 1, model: "selected-ai", items: [] };
    const panel = await page({ transcript_kind: "final" });
    expect(panel.props.analysis).toBeNull();
    expect(panel.props.evidenceSegments[0].id).toBe("final-segment");
    expect(panel.props.finalTranscriptAvailable).toBe(true);
  });
  it("passes saved translations and original segment anchors into the Live transcript workspace", async () => {
    translationsEnabled = true;
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({ transcript_kind: "live" }) });
    const props = workspace(element)?.props;
    expect(props?.playback.turns[0].sourceSegmentIds).toEqual(["live-segment"]);
    expect(props?.transcriptTranslations?.[0].text).toBe("翻訳");
    expect(props?.realtimeTranslation).toEqual({ type: "one_way", target_language: "ja" });
  });
  it("keeps realtime translations with realtime originals in the Final transcript footer", async () => {
    translationsEnabled = true;
    const element = await MeetingDetailPage({ params: Promise.resolve({ meeting_id: "m" }), searchParams: Promise.resolve({ transcript_kind: "final" }) });
    const props = workspace(element)?.props;
    expect(props?.playback.turns[0].sourceSegmentIds).toBeUndefined();
    expect(props?.transcriptTranslations).toEqual([]);
    expect(props?.realtimeTranslation).toBeNull();
    const footer = props?.transcriptFooter as ReactElement<{ children: ReactNode[] }>;
    const details = footer.props.children[0] as ReactElement<{ children: ReactNode[] }>;
    const stream = details.props.children[1] as ReactElement<ComponentProps<typeof LiveTranscriptStream>>;
    expect(stream.type).toBe(LiveTranscriptStream);
    expect(stream.props.persistedSegments[0].id).toBe("live-segment");
    expect(stream.props.persistedTranslations?.[0].text).toBe("翻訳");
  });
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
