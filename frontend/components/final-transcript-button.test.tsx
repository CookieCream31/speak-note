import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SummaryRegenerationButton } from "./final-transcript-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const settings = { profiles: [], templates: [], currentProfileId: null, currentTemplate: null };

describe("summary regeneration", () => {
  it("offers manual creation once recording is saved", () => {
    const html = renderToStaticMarkup(<SummaryRegenerationButton {...settings} meetingId="m" ready processing={false} />);
    expect(html).toContain("要約を再生成");
    expect(html).toContain("初回はWhisperX");
    expect(html).not.toContain("disabled");
  });
  it("waits for video conversion", () => {
    const html = renderToStaticMarkup(<SummaryRegenerationButton {...settings} meetingId="m" ready={false} processing={false} />);
    expect(html).toContain("録音の保存・動画変換");
    expect(html).toContain("disabled");
  });
  it("does not allow duplicate generation while processing", () => {
    const html = renderToStaticMarkup(<SummaryRegenerationButton {...settings} meetingId="m" ready processing />);
    expect(html).toContain("要約を再生成中");
    expect(html).toContain("disabled");
  });
});
