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
          <div data-chapter-track><span data-seek-thumb hidden></span></div>
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

function initializeAudio(timeline = "[]") {
  document.body.innerHTML = `
    <section data-transcript-player data-media-kind="audio">
      <audio data-meeting-media></audio>
      <output data-media-time></output>
      <output data-player-status data-player-errors-only hidden></output>
      <button data-play-toggle><span data-play-label>再生</span></button>
      <script type="application/json" data-transcript-timeline>${timeline}</script>
    </section>`;
  const audio = document.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { value: 60 });
  Object.defineProperty(audio, "readyState", { value: 4 });
  (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } })
    .speakNoteTranscriptPlayer.initialize();
  return { audio, status: document.querySelector<HTMLOutputElement>("[data-player-status]")! };
}

function initializeGappedTranscript() {
  // The first token starts at 100ms; the fixed display lead begins at media 0.
  document.body.innerHTML = `<section data-transcript-player data-media-kind="video">
    <video data-meeting-media></video><div data-transcript-document>
      ${["Hello world.！また", "別"].map((text, index) => `<article data-transcript-turn>
        <button data-transcript-text data-turn-index="${index}">
          <span data-karaoke-before></span><span data-karaoke-highlight></span><span data-karaoke-after>${text}</span>
        </button></article>`).join("")}</div>
    <script type="application/json" data-transcript-timeline>[[[100,200,3],[250,300,2],[305,325,1],[360,500,6],[550,550,1],[800,1000,2]],[[1050,1100,1]]]</script></section>`;
  media = document.querySelector("video")!;
  Object.defineProperty(media, "paused", { configurable: true, value: false });
  Object.defineProperty(media, "readyState", { value: 4 });
  (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } }).speakNoteTranscriptPlayer.initialize();
  return Array.from(document.querySelectorAll<HTMLElement>("[data-karaoke-highlight]"));
}

describe("transcript playback runtime", () => {
  it("always leads transcript display by 100ms, including paused playback, without using old preferences", () => {
    const [highlight] = initializeGappedTranscript();
    const player = document.querySelector<HTMLElement>("[data-transcript-player]")!;
    Object.defineProperty(media, "paused", { configurable: true, value: true });
    advance(0, 300);
    expect(highlight.textContent).toBe("H");
    advance(0.06, 300);
    expect(highlight.textContent).toBe("He");
    for (const value of ["-100", "0", "100", "2000", "NaN"]) {
      player.dataset.transcriptSyncMs = value;
      player.dispatchEvent(new Event("speak-note:transcript-sync"));
      advance(0.06, 300);
      expect(highlight.textContent).toBe("He");
      expect(media.currentTime).toBe(0.06);
    }
    advance(0.15, 300);
    expect(highlight.textContent).toBe("l");
  });
  it("keeps chapter progress, video subtitles and displayed media time on the original clock", () => {
    document.body.innerHTML = `<section data-transcript-player data-media-kind="video" data-subtitles-enabled="true" data-transcript-sync-ms="1000">
      <video data-meeting-media></video><output data-media-time></output>
      <div data-chapter-track><button data-chapter-segment data-chapter-title="会議全体" data-chapter-start-ms="0" data-chapter-end-ms="20000"><span data-chapter-progress></span></button></div>
      <div data-subtitle-overlay><span data-subtitle-speaker></span><p data-subtitle-text></p></div>
      <span data-subtitle-cue data-subtitle-start-ms="0" data-subtitle-end-ms="13050">元の字幕</span>
      <span data-subtitle-cue data-subtitle-start-ms="13050" data-subtitle-end-ms="20000">次の字幕</span>
      <div data-transcript-document><article data-transcript-turn><button data-transcript-text data-turn-index="0">
        <span data-karaoke-before></span><span data-karaoke-highlight></span><span data-karaoke-after>字</span>
      </button></article></div><script type="application/json" data-transcript-timeline>[[[13080,13180,1]]]</script></section>`;
    media = document.querySelector("video")!;
    Object.defineProperty(media, "readyState", { value: 4 });
    Object.defineProperty(media, "duration", { value: 20 });
    (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } }).speakNoteTranscriptPlayer.initialize();
    media.currentTime = 13;
    media.dispatchEvent(new Event("timeupdate"));
    expect(document.querySelector("[data-karaoke-highlight]")?.textContent).toBe("字");
    expect(document.querySelector("[data-subtitle-text]")?.textContent).toBe("元の字幕");
    expect(document.querySelector<HTMLElement>("[data-chapter-progress]")?.style.width).toBe("65%");
    expect(document.querySelector("[data-media-time]")?.textContent).toBe("0:13 / 0:20");
    expect(media.currentTime).toBe(13);
    expect(media.playbackRate).toBe(1);
  });
  it("follows the adjusted character with the correction applied once", () => {
    const targets: string[] = [];
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true, value: function (this: Range) {
        targets.push(this.toString());
        return new DOMRect(820, lineTop, 20, 32);
      },
    });
    document.querySelector<HTMLElement>("[data-transcript-player]")!.dataset.transcriptSyncMs = "1000";
    advance(3.85, 950);
    expect(targets.at(-1)).toBe("い");
    advance(3.95, 950);
    expect(targets.at(-1)).toBe("う");
    expect(media.currentTime).toBe(3.95);
  });
  it("keeps the completed token visible through brief gaps and standalone whitespace without flashing", () => {
    const [highlight] = initializeGappedTranscript();
    for (const [time, expected] of [[0.09, "Hel"], [0.11, "Hel"], [0.149, "Hel"], [0.15, "l"],
      [0.201, "lo"], [0.212, "lo"], [0.259, "lo"], [0.26, "w"]] as const) {
      advance(time, 300);
      expect(highlight.textContent).toBe(expected);
      expect(document.querySelector("[data-transcript-turn]")?.hasAttribute("aria-current")).toBe(true);
    }
  });
  it("clears long silence and speaker boundaries, ignores zero-duration tokens and resets after a backward seek", () => {
    const [first, second] = initializeGappedTranscript();
    advance(0.39, 300);
    expect(first.textContent).toBe("world.");
    for (const time of [0.41, 0.45, 0.65]) {
      advance(time, 300);
      expect(first.textContent).toBe("");
      expect(document.querySelector("[data-transcript-turn]")?.hasAttribute("aria-current")).toBe(false);
    }
    advance(0.89, 300);
    expect(first.textContent).toBe("また");
    advance(0.92, 300);
    expect(first.textContent).toBe("");
    advance(0.96, 300);
    expect(second.textContent).toBe("別");
    advance(0.212, 300);
    expect(first.textContent).toBe("lo");
    expect(second.textContent).toBe("");
    expect(document.querySelector("[data-transcript-text]")?.textContent?.trim()).toBe("Hello world.！また");
  });
  it("does not replace highlight text nodes repeatedly while a brief gap is held", () => {
    const [highlight] = initializeGappedTranscript();
    advance(0.201, 300);
    expect(highlight.textContent).toBe("lo");
    const node = highlight.firstChild;
    for (const time of [0.211, 0.225, 0.24, 0.255]) {
      advance(time, 300);
      expect(highlight.firstChild).toBe(node);
    }
  });
  it("follows API token times through pauses and changes of speaking speed instead of a constant phrase speed", () => {
    document.body.innerHTML = `<section data-transcript-player data-media-kind="video">
      <video data-meeting-media></video><div data-transcript-document>
        <article data-transcript-turn><button data-transcript-text data-turn-index="0" data-seek-ms="100">
          <span data-karaoke-before></span><span data-karaoke-highlight></span><span data-karaoke-after>Hello world.はい</span>
        </button></article></div>
      <script type="application/json" data-transcript-timeline>[[[100,250,3],[300,450,2],[2000,2200,7],[2800,3000,2]]]</script></section>`;
    media = document.querySelector("video")!;
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    Object.defineProperty(media, "readyState", { value: 4 });
    (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } }).speakNoteTranscriptPlayer.initialize();
    const highlight = () => document.querySelector("[data-karaoke-highlight]")?.textContent;
    advance(0.08, 300);
    expect(highlight()).toBe("He");
    advance(0.25, 300);
    expect(highlight()).toBe("l");
    advance(1.4, 300);
    expect(highlight()).toBe("");
    expect(document.querySelector("[data-transcript-text]")?.textContent?.replace(/\s+/g, "").trim()).toBe("Helloworld.はい");
    advance(2, 300);
    expect(highlight()).toBe(" wor");
    advance(2.85, 300);
    expect(highlight()).toBe("はい");
  });
  it("keeps audio time on the left without repeating normal playback status", () => {
    const { audio, status } = initializeAudio();
    let paused = true;
    Object.defineProperty(audio, "paused", { get: () => paused });
    audio.currentTime = 13;
    audio.dispatchEvent(new Event("timeupdate"));
    for (const event of ["loadedmetadata", "play", "pause", "ended"]) {
      paused = event !== "play";
      audio.dispatchEvent(new Event(event));
      expect(status.hidden).toBe(true);
      expect(status.textContent).toBe("");
      expect(document.querySelector("[data-media-time]")?.textContent).toBe("0:13 / 1:00");
    }
    expect(document.querySelector("[data-play-toggle]")?.getAttribute("aria-label")).toBe("再生");
  });

  it("shows audio playback failures and clears them after a successful retry", async () => {
    const { audio, status } = initializeAudio();
    audio.currentTime = 13;
    const play = vi.spyOn(audio, "play").mockRejectedValueOnce(new Error("再生が拒否されました"));
    document.querySelector<HTMLButtonElement>("[data-play-toggle]")!.click();
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("再生エラー: 再生が拒否されました");
    expect(audio.currentTime).toBe(13);

    Object.defineProperty(audio, "paused", { value: false });
    audio.dispatchEvent(new Event("play"));
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe("");

    audio.dispatchEvent(new Event("error"));
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("音声を読み込めませんでした");
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(status.hidden).toBe(true);
  });

  it("keeps malformed audio timeline errors visible", () => {
    const { status } = initializeAudio("invalid-json");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("文字起こし時刻を読み込めませんでした");
  });

  it("shows the seek marker only with a known duration and tracks playback and seeks", () => {
    const thumb = document.querySelector<HTMLElement>("[data-seek-thumb]")!;
    expect(thumb.hidden).toBe(true);
    Object.defineProperty(media, "duration", { configurable: true, value: 120 });
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(thumb.hidden).toBe(false);
    for (const [seconds, percentage] of [[0, "0%"], [60, "50%"], [120, "100%"], [180, "100%"]]) {
      media.currentTime = seconds as number;
      media.dispatchEvent(new Event("timeupdate"));
      expect(thumb.style.left).toBe(percentage);
    }
    media.currentTime = 30;
    media.dispatchEvent(new Event("seeked"));
    expect(thumb.style.left).toBe("25%");
    Object.defineProperty(media, "duration", { configurable: true, value: Number.NaN });
    media.dispatchEvent(new Event("timeupdate"));
    expect(thumb.hidden).toBe(true);
  });
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
