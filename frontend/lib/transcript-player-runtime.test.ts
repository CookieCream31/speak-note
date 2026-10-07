// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = readFileSync("public/transcript-player.js", "utf8");
let media: HTMLVideoElement;
let now = 1000;
let lineTop = 300;
let scroll: ReturnType<typeof vi.fn>;

beforeAll(() => {
  window.eval(runtime);
});
beforeEach(() => {
  document.body.innerHTML = `
    <section data-transcript-player data-media-kind="video">
      <div data-meeting-player><div data-media-stage><video data-meeting-media></video>
        <div data-custom-media-controls>
          <button data-play-toggle>再生</button>
          <button data-fullscreen-toggle>全画面</button>
          <div data-player-settings><button data-settings-trigger>設定</button></div>
          <button data-subtitle-toggle>字幕</button>
          <div data-playback-rate data-player-settings>
            <button data-playback-rate-option="2">2×</button>
            <button data-playback-rate-option="1.75">1.75×</button>
            <button data-playback-rate-option="1.5">1.5×</button>
            <button data-playback-rate-option="1.25">1.25×</button>
            <button data-playback-rate-option="1">1×</button>
            <button data-playback-rate-option="0.75">0.75×</button>
            <button data-playback-rate-option="0.5">0.5×</button>
          </div>
        </div>
      </div></div>
      <div data-transcript-document>
        <article data-transcript-turn><button data-transcript-text data-turn-index="0">
          <span data-karaoke-before></span><span data-karaoke-highlight></span><span data-karaoke-after>あいうえ😀</span>
        </button></article>
      </div>
      <span data-follow-status></span><button data-follow-resume hidden>再開</button>
      <script type="application/json" data-transcript-timeline>[[[0,10000,5]]]</script>
    </section>`;
  media = document.querySelector("video")!;
  Object.defineProperty(media, "paused", { configurable: true, value: false });
  Object.defineProperty(media, "readyState", { value: 4 });
  Object.defineProperty(media, "videoWidth", { value: 1440 });
  Object.defineProperty(media, "videoHeight", { value: 1080 });
  Object.defineProperty(document.querySelector("[data-transcript-document]"), "offsetParent", { value: document.body });
  vi.spyOn(document.querySelector("[data-transcript-document]")!, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(800, 200, 600, 3000));
  vi.spyOn(document.querySelector("[data-meeting-player]")!, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 80, 700, 500));
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true, value: () => new DOMRect(820, lineTop, 20, 32),
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scroll = vi.fn();
  vi.stubGlobal("scrollBy", scroll);
  vi.stubGlobal("innerHeight", 1000);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  now = 1000;
  lineTop = 300;
  (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } })
    .speakNoteTranscriptPlayer.initialize();
});
afterEach(() => {
  document.body.innerHTML = "";
  document.dispatchEvent(new Event("wheel"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function advance(time: number, top: number) {
  now += 1000;
  lineTop = top;
  media.currentTime = time;
  media.dispatchEvent(new Event("timeupdate"));
}

describe("transcript playback runtime", () => {
  it("changes menu rates with Shift shortcuts and preserves the playback position", () => {
    const shortcut = (code: string) => document.body.dispatchEvent(
      new KeyboardEvent("keydown", { code, shiftKey: true, bubbles: true, cancelable: true }),
    );
    media.currentTime = 42;
    shortcut("Period");
    expect(media.playbackRate).toBe(1.25);
    shortcut("Period");
    expect(media.playbackRate).toBe(1.5);
    shortcut("Comma");
    expect(media.playbackRate).toBe(1.25);
    expect(media.currentTime).toBe(42);
    media.playbackRate = 2;
    shortcut("Period");
    expect(media.playbackRate).toBe(2);
    media.playbackRate = 0.5;
    shortcut("Comma");
    expect(media.playbackRate).toBe(0.5);
  });

  it("releases pointer-clicked controls so Space pauses the video", () => {
    const fullscreen = document.querySelector<HTMLButtonElement>("[data-fullscreen-toggle]")!;
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {});
    fullscreen.focus();
    fullscreen.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(fullscreen);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "Space", key: " " }));
    expect(pause).toHaveBeenCalledTimes(1);

    const subtitles = document.querySelector<HTMLButtonElement>("[data-subtitle-toggle]")!;
    subtitles.focus();
    subtitles.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(subtitles);

    const play = document.querySelector<HTMLButtonElement>("[data-play-toggle]")!;
    play.focus();
    play.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(play);
  });

  it("uses Space for playback even if fullscreen regains focus", () => {
    const fullscreen = document.querySelector<HTMLButtonElement>("[data-fullscreen-toggle]")!;
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {});
    fullscreen.focus();
    const space = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space", key: " " });
    fullscreen.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(fullscreen);

    const settings = document.querySelector<HTMLButtonElement>("[data-settings-trigger]")!;
    settings.focus();
    const settingsSpace = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space", key: " " });
    settings.dispatchEvent(settingsSpace);
    expect(settingsSpace.defaultPrevented).toBe(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("follows the current character inside the same long word / speaker turn", () => {
    advance(1, 300);
    expect(scroll).not.toHaveBeenCalled();
    advance(9, 950);
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(scroll.mock.calls[0][0].top).toBeGreaterThan(400);
    expect(document.querySelector("[data-karaoke-highlight]")?.textContent).toBe("あいうえ😀");
  });

  it("does not scroll repeatedly while the current text is comfortably visible", () => {
    advance(2, 300);
    advance(4, 330);
    advance(6, 360);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("pauses follow after manual scrolling and resumes at the current character", () => {
    advance(1, 300);
    document.dispatchEvent(new Event("wheel"));
    advance(9, 950);
    expect(scroll).not.toHaveBeenCalled();
    const resume = document.querySelector<HTMLButtonElement>("[data-follow-resume]")!;
    expect(resume.hidden).toBe(false);
    resume.click();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(resume.hidden).toBe(true);
  });

  it("does not jump back to the start of a long turn between words", () => {
    advance(9, 950);
    expect(scroll).toHaveBeenCalledTimes(1);
    scroll.mockClear();
    advance(11, 420);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("does not mistake a long smooth auto-scroll for manual scrolling", () => {
    advance(9, 950);
    for (let i = 0; i < 12; i += 1) {
      now += 150;
      window.dispatchEvent(new Event("scroll"));
    }
    expect(document.querySelector<HTMLButtonElement>("[data-follow-resume]")!.hidden).toBe(true);
    document.dispatchEvent(new Event("wheel"));
    expect(document.querySelector<HTMLButtonElement>("[data-follow-resume]")!.hidden).toBe(false);
  });

  it("uses actual video dimensions for the stage aspect ratio", () => {
    expect(document.querySelector<HTMLElement>("[data-media-stage]")?.style.getPropertyValue("--video-aspect"))
      .toBe(String(1440 / 1080));
  });
});
