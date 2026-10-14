// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TimedWord = { text: string; start: number; end: number; exact?: boolean };
let media: HTMLMediaElement;
let trigger: HTMLButtonElement;
let play: ReturnType<typeof vi.spyOn>;
beforeAll(() => window.eval(readFileSync("public/transcript-player.js", "utf8")));
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "caretPositionFromPoint");
  Reflect.deleteProperty(document, "caretRangeFromPoint");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function mount(words: TimedWord[], kind: "audio" | "video" = "audio", legacy = false, ready = 4, subwordTokens = false) {
  const rows = words.map((word) => legacy ? [word.start, word.end, Array.from(word.text).length]
    : [word.start, word.end, Array.from(word.text).length, word.exact ?? true]);
  document.body.innerHTML = `<section data-transcript-player data-media-kind="${kind}">
    <${kind} data-meeting-media></${kind}><output data-player-status></output>
    <button data-seek-ms="1000" data-timestamp>時刻</button>
    <div data-chapter-track><button data-chapter-segment data-chapter-title="会議全体" data-chapter-start-ms="0" data-chapter-end-ms="30000"><span data-chapter-progress></span></button></div>
    <div data-transcript-document><article data-transcript-turn data-subword-tokens="${subwordTokens}"><button data-transcript-text data-turn-index="0" data-seek-ms="${words[0].start}"><span data-karaoke-before></span><span data-karaoke-highlight></span><span data-karaoke-after>${words.map((word) => word.text).join("")}</span></button></article></div>
    <script type="application/json" data-transcript-timeline>${JSON.stringify([rows])}</script></section>`;
  media = document.querySelector("[data-meeting-media]")!;
  trigger = document.querySelector("[data-transcript-text]")!;
  Object.defineProperty(media, "readyState", { configurable: true, value: ready });
  Object.defineProperty(media, "duration", { value: 30 });
  play = vi.spyOn(media, "play").mockResolvedValue(undefined);
  (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } }).speakNoteTranscriptPlayer.initialize();
}
function pointAt(index: number, method: "position" | "range" = "position") {
  let remaining = index;
  let node: Text | undefined;
  let offset = 0;
  for (const span of trigger.querySelectorAll("span")) {
    const child = span.firstChild as Text | null;
    if (!child) continue;
    const characters = Array.from(child.data);
    if (remaining < characters.length) {
      node = child; offset = characters.slice(0, remaining).join("").length; break;
    }
    remaining -= characters.length;
  }
  if (!node) throw new Error("Click character not found");
  if (method === "position") Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true, value: () => ({ offsetNode: node, offset }),
  });
  else Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => {
    const range = document.createRange(); range.setStart(node!, offset); range.collapse(true); return range;
  } });
}
function click() { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 100, clientY: 100 })); }

describe("transcript click playback", () => {
  it.each([
    ["audio", "position"], ["video", "position"], ["audio", "range"], ["video", "range"],
  ] as const)("starts the whole timed word 100ms earlier for %s with the %s caret API", (kind, method) => {
    mount([{ text: "Beautiful", start: 1000, end: 2200 }, { text: " world", start: 2500, end: 3000 }], kind);
    for (const index of [0, 4, 8]) {
      pointAt(index, method); click();
      expect(media.currentTime).toBe(0.9);
    }
    pointAt(14, method); click();
    expect(media.currentTime).toBe(2.4);
    expect(play).toHaveBeenCalledTimes(4);
    expect(JSON.parse(document.querySelector("[data-transcript-timeline]")!.textContent!)[0][0]).toEqual([1000, 2200, 9, true]);
  });
  it("returns to the beginning of an English word split into Soniox subwords", () => {
    mount([{ text: "Capac", start: 1000, end: 1500 }, { text: "itance", start: 1500, end: 1900 }, { text: " next", start: 2200, end: 2500 }], "audio", false, 4, true);
    pointAt(10); click(); expect(media.currentTime).toBe(0.9);
    pointAt(14); click(); expect(media.currentTime).toBe(2.1);
  });
  it("does not join separate WhisperX words when their stored text has no spaces", () => {
    mount([{ text: "Hello", start: 1000, end: 1500 }, { text: "world", start: 2200, end: 2500 }]);
    pointAt(8); click(); expect(media.currentTime).toBe(2.1);
  });
  it("keeps unspaced Japanese tokens separate and supports Unicode caret offsets", () => {
    mount([{ text: "あ😀", start: 1000, end: 1200 }, { text: "次", start: 1500, end: 1700 }], "audio", false, 4, true);
    pointAt(1); click(); expect(media.currentTime).toBe(0.9);
    pointAt(2); click(); expect(media.currentTime).toBe(1.4);
  });
  it("keeps the estimated character position for old transcripts without word timings", () => {
    mount([{ text: "あいうえお", start: 1000, end: 11000, exact: false }]);
    pointAt(3); click(); expect(media.currentTime).toBe(6.9);
  });
  it("clamps the early playback position to zero at the beginning of a recording", () => {
    mount([{ text: "最初", start: 50, end: 500 }]);
    pointAt(1); click(); expect(media.currentTime).toBe(0);
    expect(play).toHaveBeenCalledOnce();
  });
  it("uses the turn's early start when the caret API is unavailable or activation is by keyboard", () => {
    mount([{ text: "本文", start: 1000, end: 2000 }]);
    click(); expect(media.currentTime).toBe(0.9);
    pointAt(1); trigger.click(); expect(media.currentTime).toBe(0.9);
  });
  it("leaves timestamps and the chapter seek bar at their original playback positions", () => {
    mount([{ text: "本文", start: 1000, end: 2000 }]);
    document.querySelector<HTMLButtonElement>("[data-timestamp]")!.click();
    expect(media.currentTime).toBe(1);
    const chapter = document.querySelector<HTMLButtonElement>("[data-chapter-segment]")!;
    vi.spyOn(chapter, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 10));
    chapter.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 50 }));
    expect(media.currentTime).toBe(15);
  });
  it("preserves compatibility with the previous compact timeline and starts safely before its word", () => {
    mount([{ text: "Legacy", start: 1000, end: 2200 }], "audio", true);
    pointAt(5); click(); expect(media.currentTime).toBe(0.9);
  });
  it("keeps the early target while waiting for media metadata without applying it twice", () => {
    mount([{ text: "本文", start: 1000, end: 2000 }], "audio", false, 0);
    const load = vi.spyOn(media, "load").mockImplementation(() => {});
    pointAt(1); click();
    expect(load).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    Object.defineProperty(media, "readyState", { value: 4 });
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(media.currentTime).toBe(0.9);
    expect(play).toHaveBeenCalledOnce();
  });
});
