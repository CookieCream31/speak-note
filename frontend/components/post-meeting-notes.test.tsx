// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisVersion, MeetingQuestion } from "@/lib/api";
import { MeetingQuestionPanel } from "./meeting-question-panel";
import { MeetingReviewPanel } from "./meeting-review-panel";

const router = { refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const analysis: AnalysisVersion = {
  id: "saved-summary", meeting_id: "meeting", transcript_version_id: "live", transcript_kind: "live",
  provider_id: "provider", profile_id: "profile", job_id: "analysis-job", version: 1, model: "model",
  temperature: 0, prompt_version: "test", status: "completed", error_message: null,
  created_at: "", completed_at: "", template_values: [],
  document_text: "全体要約\n元の要約", document_content: null, document_revision: 0,
  template_snapshot: { template_id: "template", revision: 1, name: "標準", definition: { realtime: [], final: [
    { id: "summary", title: "全体要約", visible: true, show_when_empty: true, core_kind: "summary", fields: [] },
  ] } },
  items: [{ id: "summary-item", kind: "summary", state: "generated", content: "元の要約", sequence: 0,
    assignee: null, deadline: null, start_ms: null, end_ms: null,
    evidence: [{ segment_id: "segment" }], created_at: "", updated_at: "" }],
};
const question: MeetingQuestion = {
  id: "question", meeting_id: "meeting", transcript_version_id: "live", transcript_kind: "live",
  provider_id: "provider", profile_id: "profile", job_id: "job", question: "以前の質問",
  answer: "以前の回答", insufficient_information: false, model: "model", status: "completed",
  error_message: null, created_at: "", completed_at: "", evidence: [],
};
let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
async function renderReview(value = analysis, captureStopped = true) {
  await act(async () => { root.render(<MeetingReviewPanel meetingId="meeting" analysis={value}
    versions={[]} realtimeHistory={null} evidenceSegments={[]} playerAvailable={false}
    finalTranscriptAvailable={false} captureStopped={captureStopped} />); });
}
async function renderQuestions(available = true, initialQuestions: MeetingQuestion[] = []) {
  await act(async () => { root.render(<MeetingQuestionPanel meetingId="meeting" available={available}
    analysisId="saved-summary" transcriptVersionId="live" transcriptKind="live" initialQuestions={initialQuestions} />); });
}
async function input(value: string) {
  await act(async () => {
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  vi.resetAllMocks(); vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("post-meeting Live summary", () => {
  it("edits the whole templated summary without a Final and preserves confirmed source items", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const patch = JSON.parse(String(init?.body));
      return response({ content: patch.content, revision: 1, updated_at: "2026-10-16T00:00:00Z" });
    });
    const savedAnalysis: AnalysisVersion = { ...analysis, items: [{ ...analysis.items[0], state: "confirmed" }] };
    const original = JSON.stringify(savedAnalysis);
    await renderReview(savedAnalysis);
    expect(host.textContent).toContain("要約の全文編集・質問ができます");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "全文を編集")!.click(); });
    await input("修正した要約\n\n追記のメモ"); await submit();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/meetings/meeting/analyses/saved-summary/document");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ content: "修正した要約\n\n追記のメモ", expected_revision: 0 });
    expect(JSON.stringify(savedAnalysis)).toBe(original);
    expect(savedAnalysis.items[0].state).toBe("confirmed");
    expect(host.querySelectorAll("[data-summary-document]")).toHaveLength(1);
    expect(host.querySelector("[data-template-card]")).toBeNull();
    expect(host.textContent).not.toContain("AIの生成内容・根拠を確認");
    expect(host.textContent).not.toContain("元の要約");
    expect(host.textContent).toContain("修正した要約");
    expect(host.textContent).toContain("編集済みの本文");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["realtime", "processing", "recording"])("keeps %s notes read-only", async (mode) => {
    await renderReview({ ...analysis, id: mode === "realtime" ? "realtime" : analysis.id,
      status: mode === "processing" ? "processing" : "completed" }, mode !== "recording");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "全文を編集")).toBe(false);
    expect(host.textContent).not.toContain("確認済みにする");
    expect(host.textContent).not.toContain("高精度版が必要");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends selected summary identity, polls answers, and keeps histories by original version", async () => {
    fetchMock.mockResolvedValueOnce(response({ ...question, id: "new", question: "新しい質問", status: "queued" }))
      .mockResolvedValue(response([{ ...question, id: "new", question: "新しい質問", answer: "保存原文の回答" },
        { ...question, id: "final", transcript_version_id: "final", answer: "別の原文の回答" }]));
    await renderQuestions(true, [{ ...question, id: "final", transcript_version_id: "final", answer: "別の原文の回答" }]);
    expect(host.textContent).not.toContain("別の原文の回答");
    await input("新しい質問"); await submit();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ question: "新しい質問", analysis_id: "saved-summary" });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
    expect(host.textContent).toContain("原文・話者は暫定");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.textContent).toContain("保存原文の回答");
    expect(host.textContent).not.toContain("別の原文の回答");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  });
  it("retains the question text on failure and permits resubmission", async () => {
    fetchMock.mockResolvedValueOnce(response({ detail: "AIに接続できません" }, 503))
      .mockResolvedValue(response({ ...question, status: "queued" }));
    await renderQuestions(); await input("担当者は？"); await submit();
    expect(host.querySelector("textarea")?.value).toBe("担当者は？");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("AIに接続できません");
    await submit();
    expect(host.querySelector("textarea")?.value).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not retry questions while the view is unavailable", async () => {
    await renderQuestions(false, [{ ...question, status: "failed" }]);
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "再試行")!;
    expect(retry.disabled).toBe(true);
    await act(async () => { retry.click(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
