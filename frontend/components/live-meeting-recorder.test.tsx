import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LiveMeetingRecorder } from "./live-meeting-recorder";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("LiveMeetingRecorder", () => {
  it("directs saved recordings to the single summary regeneration entry", () => {
    const html = renderToStaticMarkup(<LiveMeetingRecorder
      meetingId="meeting" existingRecording transcriptionReady
      hasFinalTranscript={false} finalProcessing={false} aiDisabled={false}
    />);
    expect(html).toContain("画面上部の「要約を再生成」");
    expect(html).not.toContain("確定版の文字起こし・AI解析を開始");
    expect(html).not.toContain("確定版の文字起こし・AI解析をやり直す");
  });

  it("renders microphone-only recording without screen sharing controls", () => {
    const html = renderToStaticMarkup(
      <LiveMeetingRecorder
        meetingId="meeting-1"
        captureMode="microphone"
        existingRecording={false}
        transcriptionReady={false}
        hasFinalTranscript={false}
        finalProcessing={false}
        aiDisabled={false}
      />,
    );

    expect(html).toContain("マイク音声を録音");
    expect(html).toContain("画面共有は行いません");
    expect(html).not.toContain("マイク音声も含める");
    expect(html).not.toContain("<video");
  });
  it.each(["display", "microphone", "shared_audio"] as const)("starts %s capture with the microphone muted by default", (captureMode) => {
    const html = renderToStaticMarkup(<LiveMeetingRecorder
      meetingId="meeting" captureMode={captureMode} existingRecording={false}
      transcriptionReady={false} hasFinalTranscript={false} finalProcessing={false} aiDisabled={false}
    />);
    expect(html).toContain('aria-label="開始時のマイクミュートを解除"');
    expect(html).toContain("マイク：ミュートで開始");
    expect(html).not.toContain('type="checkbox"');
  });
  it("renders shared audio without a video preview or saved-video conversion guidance", () => {
    const props = { meetingId: "m", captureMode: "shared_audio" as const, transcriptionReady: true,
      hasFinalTranscript: false, finalProcessing: false, aiDisabled: false };
    const html = renderToStaticMarkup(<LiveMeetingRecorder {...props} existingRecording={false} />);
    expect(html).toContain("共有音声とマイクを録音");
    expect(html).toContain("映像は保存しません");
    expect(html).not.toContain("<video");
    const saved = renderToStaticMarkup(<LiveMeetingRecorder {...props} existingRecording />);
    expect(saved).toContain("録音済みです");
    expect(saved).not.toContain("変換しています");
  });
  it("supports choosing microphone ON before capture starts", () => {
    const html = renderToStaticMarkup(<LiveMeetingRecorder
      meetingId="meeting" existingRecording={false} initialIncludeMicrophone
      transcriptionReady={false} hasFinalTranscript={false} finalProcessing={false} aiDisabled={false}
    />);
    expect(html).toContain('aria-label="開始時のマイクをミュート"');
    expect(html).toContain("マイク：ONで開始");
  });

});
