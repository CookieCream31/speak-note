// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { dispatchLiveSpeakerRenamed, dispatchSpeakerRenamed } from "./speaker-events";

beforeEach(() => {
  document.body.innerHTML = `
    <section data-transcript-player data-media-kind="video" data-subtitles-enabled="true">
      <video data-meeting-media></video>
      <div data-subtitle-overlay><span data-subtitle-speaker></span><p data-subtitle-text></p></div>
      <span data-subtitle-cue data-subtitle-start-ms="0" data-subtitle-end-ms="1000"
        data-subtitle-source-segment-ids="s1,s2" data-subtitle-speaker-name="話者 1">Live1</span>
      <span data-subtitle-cue data-subtitle-start-ms="1000" data-subtitle-end-ms="2000"
        data-subtitle-source-segment-ids="s3" data-subtitle-speaker-name="話者 1">Live2</span>
      <span data-subtitle-cue data-subtitle-start-ms="2000" data-subtitle-end-ms="3000"
        data-subtitle-speaker-id="final-speaker" data-subtitle-speaker-name="確定話者">Final</span>
      <script type="application/json" data-transcript-timeline>[]</script>
    </section>`;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const media = document.querySelector("video")!;
  Object.defineProperty(media, "paused", { value: true, configurable: true });
  Object.defineProperty(media, "readyState", { value: 4 });
  window.eval(readFileSync("public/transcript-player.js", "utf8"));
  (window as unknown as { speakNoteTranscriptPlayer: { initialize: () => void } }).speakNoteTranscriptPlayer.initialize();
});
afterEach(() => {
  document.body.innerHTML = "";
  window.dispatchEvent(new CustomEvent("speak-note:live-speaker-renamed"));
  window.dispatchEvent(new CustomEvent("speak-note:speaker-renamed"));
  vi.unstubAllGlobals();
});

it("updates the active Live subtitle without renaming another interval or a Final speaker", () => {
  const name = document.querySelector('[data-subtitle-speaker]')!;
  const media = document.querySelector("video")!;
  expect(name.textContent).toBe("話者 1");
  dispatchLiveSpeakerRenamed({ segmentIds: ["s2"], speakerName: "エージェント" });
  expect(name.textContent).toBe("エージェント");
  media.currentTime = 1.2;
  media.dispatchEvent(new Event("timeupdate"));
  expect(name.textContent).toBe("話者 1");
  media.currentTime = 2.2;
  media.dispatchEvent(new Event("timeupdate"));
  expect(name.textContent).toBe("確定話者");
  dispatchSpeakerRenamed({ speakerId: "final-speaker", displayName: "田中", speakerName: "田中" });
  expect(name.textContent).toBe("田中");
  media.currentTime = 0.2;
  media.dispatchEvent(new Event("timeupdate"));
  expect(name.textContent).toBe("エージェント");
});
