import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeetingTranscriptionSettings } from "./meeting-transcription-settings";

describe("MeetingTranscriptionSettings", () => {
  it("renders optional minimum and maximum speaker counts", () => {
    const html = renderToStaticMarkup(
      <MeetingTranscriptionSettings
        meetingId="meeting-1"
        minSpeakers={2}
        maxSpeakers={4}
        disabled={false}
      />,
    );

    expect(html).toContain('aria-label="最小話者数"');
    expect(html).toContain('value="2"');
    expect(html).toContain('aria-label="最大話者数"');
    expect(html).toContain('value="4"');
    expect(html).toContain("空欄なら自動判定");
  });
});
