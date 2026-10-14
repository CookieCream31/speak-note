// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptDocument, TranscriptRuntime, type PlaybackTurn } from "./transcript-player";

let host: HTMLElement;
let root: Root;
const turns: PlaybackTurn[] = [{ id: "turn", startMs: 100, speakerId: null, speakerName: "話者 1",
  words: [{ id: "word", text: "本文", startMs: 100, endMs: 200, exact: true }] }];
function mount(kind: "audio" | "video") {
  host = document.createElement("section");
  host.dataset.transcriptPlayer = "";
  host.innerHTML = `<${kind} data-meeting-media></${kind}><div data-mount></div>`;
  document.body.append(host);
  root = createRoot(host.querySelector("[data-mount]")!);
  act(() => root.render(<>
    <TranscriptDocument meetingId="meeting-1" mediaUrl="/media" turns={turns} />
    <TranscriptRuntime turns={turns} />
  </>));
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("fixed transcript display lead", () => {
  it.each(["audio", "video"] as const)("removes the sync settings UI for %s while preserving transcript and original timings", (kind) => {
    mount(kind);
    expect(host.querySelector("[data-transcript-sync]")).toBeNull();
    expect(host.querySelector('[aria-label="文字ハイライトの同期調整"]')).toBeNull();
    expect(host.textContent).not.toContain("0.1秒早める");
    expect(host.querySelector("[data-follow-status]")).not.toBeNull();
    expect(host.querySelector("[data-transcript-text]")?.textContent).toBe("本文");
    expect(JSON.parse(host.querySelector("[data-transcript-timeline]")!.textContent!)).toEqual([[[100, 200, 2]]]);
    expect(turns[0].words[0]).toMatchObject({ startMs: 100, endMs: 200 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not read or rewrite the previous meeting-specific preference", () => {
    localStorage.setItem("speak-note:transcript-sync:v1:meeting-1", "2000");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    mount("audio");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(host.hasAttribute("data-transcript-sync-ms")).toBe(false);
  });
  it("renders without sync settings when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    mount("video");
    expect(host.querySelector("[data-transcript-text]")?.textContent).toBe("本文");
    expect(host.querySelector("[data-transcript-sync]")).toBeNull();
  });
});
