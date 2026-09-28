// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTranscriptStream } from "./realtime-analysis-panel";
import { getLiveTranscriptStore } from "@/lib/live-transcript-store";
import type { LiveTranscriptUpsertDetail } from "@/lib/live-transcript-events";
import type { TranscriptSegment } from "@/lib/api";

let root: Root;
let container: HTMLDivElement;
let meetingId: string;

function update(id: string, text: string, final = false, speaker = "SPEAKER_00") {
  const detail: LiveTranscriptUpsertDetail = {
    type: "upsert", meetingId, resultId: id, text, isFinal: final,
    startMs: id === "first" ? 0 : 2000, endMs: id === "first" ? 1500 : 4000,
    speakerLabel: speaker, confidence: null,
  };
  act(() => getLiveTranscriptStore(meetingId).accept(detail));
}
function render(persistedSegments: TranscriptSegment[] = []) {
  act(() => root.render(
    <LiveTranscriptStream meetingId={meetingId} recording persistedSegments={persistedSegments} />,
  ));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  meetingId = crypto.randomUUID();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("mounted live transcript transitions", () => {
  it("retains the actual phrase DOM node on finalization and same-speaker grouping", () => {
    render();
    update("first", "最初の発話。", true);
    update("second", "続きの発話", false, "SPEAKER_UNKNOWN");
    const row = container.querySelector('[data-result-id="second"]');
    const textNode = container.querySelector("#live-segment-second");
    expect(row).not.toBeNull();
    update("second", "続きの発話。", true);
    expect(container.querySelector('[data-result-id="second"]')).toBe(row);
    expect(container.querySelector("#live-segment-second")).toBe(textNode);
    expect(row?.getAttribute("data-continuation")).toBe("true");
    expect(row?.querySelector("[hidden]")).not.toBeNull();
    expect(container.textContent).toContain("最初の発話。");
    expect(container.textContent).toContain("続きの発話。");
    // A final for a different speaker keeps its own visible label.
    update("third", "別の話者", false, "SPEAKER_UNKNOWN");
    const third = container.querySelector('[data-result-id="third"]');
    update("third", "別の話者。", true, "SPEAKER_01");
    expect(container.querySelector('[data-result-id="third"]')).toBe(third);
    expect(third?.getAttribute("data-continuation")).toBe("false");
    expect(third?.textContent).toContain("SPEAKER_01");
  });

  it("renders final text immediately without a parent render or a persistence ACK", () => {
    render();
    update("first", "途中の文");
    update("first", "確定した文。", true);
    expect(container.querySelector("#live-segment-first")?.textContent).toBe("確定した文。");
    expect(container.querySelector('[data-final="false"]')).toBeNull();
    update("first", "遅れた途中結果");
    render([]); // an older polling response must not erase browser finals
    expect(container.querySelector("#live-segment-first")?.textContent).toBe("確定した文。");
  });

  it("retains the next draft when an earlier final and ACK arrive", () => {
    render();
    update("second", "次の発話");
    const row = container.querySelector('[data-result-id="second"]');
    update("first", "前の確定。", true);
    act(() => getLiveTranscriptStore(meetingId).accept({
      type: "persisted", meetingId, resultId: "first", segmentId: "db-first",
    }));
    render([]);
    expect(container.querySelector('[data-result-id="second"]')).toBe(row);
    expect(row?.textContent).toContain("次の発話");
    expect(container.querySelector("#live-segment-first")?.textContent).toBe("前の確定。");
  });
});
