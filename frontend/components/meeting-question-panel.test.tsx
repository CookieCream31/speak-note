import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MeetingQuestion } from "@/lib/api";

import { MeetingQuestionPanel } from "./meeting-question-panel";

const completedQuestion: MeetingQuestion = {
  id: "question-1",
  meeting_id: "meeting-1",
  transcript_version_id: "transcript-1",
  provider_id: "provider-1",
  profile_id: "profile-1",
  job_id: "job-1",
  question: "認証方式は何ですか？",
  answer: "JWT認証を採用します。",
  insufficient_information: false,
  model: "test-model",
  status: "completed",
  error_message: null,
  created_at: "2026-09-09T00:00:00Z",
  completed_at: "2026-09-09T00:00:01Z",
  evidence: [{ segment_id: "segment-1" }],
};

describe("MeetingQuestionPanel", () => {
  it("renders the question and answer without exposing evidence", () => {
    const html = renderToStaticMarkup(
      <MeetingQuestionPanel
        meetingId="meeting-1"
        initialQuestions={[completedQuestion]}
        available
      />,
    );

    expect(html).toContain("認証方式は何ですか？");
    expect(html).toContain("JWT認証を採用します。");
    expect(html).not.toContain("根拠となる発言");
    expect(html).toContain("Enterで送信 / Shift+Enterで改行");
  });

  it("disables input until a final transcript and AI profile are available", () => {
    const html = renderToStaticMarkup(
      <MeetingQuestionPanel
        meetingId="meeting-1"
        initialQuestions={[]}
        available={false}
      />,
    );

    expect(html).toContain("確定文字起こしの完了後に質問できます");
    expect(html).toContain("disabled=\"\"");
  });
});
