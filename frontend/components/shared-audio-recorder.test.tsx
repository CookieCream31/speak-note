// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveMeetingRecorder } from "./live-meeting-recorder";
import { getLiveTranscriptStore } from "@/lib/live-transcript-store";

const mocks = vi.hoisted(() => ({
  router: { refresh: vi.fn() }, createMixer: vi.fn(), pending: vi.fn(),
  start: vi.fn(), send: vi.fn(), stop: vi.fn(), close: vi.fn(), azure: vi.fn(), soniox: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/live-capture", async (original) => ({
  ...await original<typeof import("@/lib/live-capture")>(),
  LiveCaptureMixer: { create: mocks.createMixer },
}));
vi.mock("@/lib/pending-live-capture", () => ({ takePendingLiveCapture: mocks.pending }));
vi.mock("@/lib/display-capture", async (original) => ({
  ...await original<typeof import("@/lib/display-capture")>(),
  detectDisplayCaptureSupport: () => "supported",
}));
vi.mock("@/lib/azure-speech-stream", () => ({ startAzureSpeechStream: mocks.azure }));
vi.mock("@/lib/soniox-speech-stream", () => ({ startSonioxSpeechStream: mocks.soniox }));
vi.mock("@/lib/recording-connection", () => ({ RecordingConnection: class {
  start = mocks.start; send = mocks.send; stop = mocks.stop; close = mocks.close;
} }));

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(readonly kind: "audio" | "video") { super(); }
  getSettings() { return { width: 3840, height: 2160 }; }
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
}
class Recorder extends EventTarget {
  static isTypeSupported = () => true;
  static instances: Recorder[] = [];
  state = "inactive";
  mimeType: string;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.chunk();
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  });
  constructor(readonly stream: Stream, readonly options: MediaRecorderOptions) {
    super(); this.mimeType = options.mimeType!; Recorder.instances.push(this);
  }
  chunk() {
    const event = new Event("dataavailable");
    Object.assign(event, { data: new Blob(["mixed audio"], { type: "audio/webm" }) });
    this.dispatchEvent(event);
  }
}
let root: Root;
let host: HTMLDivElement;
let display: Stream;
let microphone: Stream;
let mixed: Stream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let mixer: {
  audioStream: Stream; currentVideoTrack: () => Track;
  replaceDisplay: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  isCurrentDisplay: (stream: Stream) => boolean; handleDisplayEnded: ReturnType<typeof vi.fn>;
  setMicrophoneMuted: ReturnType<typeof vi.fn>; attachMicrophone: ReturnType<typeof vi.fn>;
};
async function render(includeMicrophone = true, resumePendingCapture = false, captureMode: "shared_audio" | "display" | "microphone" = "shared_audio") {
  await act(async () => root.render(<LiveMeetingRecorder meetingId="m" captureMode={captureMode}
    existingRecording={false} transcriptionReady={false} hasFinalTranscript={false}
    finalProcessing={false} aiDisabled={false} initialIncludeMicrophone={includeMicrophone}
    resumePendingCapture={resumePendingCapture} />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((element) => (
    element.getAttribute("aria-label") === label || element.textContent === label
  ));
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0)); return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("MediaStream", Stream);
  Recorder.instances = [];
  display = new Stream([new Track("video"), new Track("audio")]);
  microphone = new Stream([new Track("audio")]);
  mixed = new Stream([new Track("audio")]);
  getDisplayMedia = vi.fn().mockResolvedValue(display);
  getUserMedia = vi.fn().mockResolvedValue(microphone);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
  let current = display;
  mixer = {
    audioStream: mixed, currentVideoTrack: () => current.getVideoTracks()[0],
    replaceDisplay: vi.fn(async (stream: Stream) => { current = stream; return true; }),
    isCurrentDisplay: (stream: Stream) => current === stream,
    handleDisplayEnded: vi.fn(), stop: vi.fn(), attachMicrophone: vi.fn(),
    setMicrophoneMuted: vi.fn((muted: boolean) => { microphone.getAudioTracks()[0].enabled = !muted; }),
  };
  mocks.createMixer.mockResolvedValue(mixer);
  mocks.pending.mockReturnValue(null);
  mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: "whisperx" });
  mocks.azure.mockResolvedValue({ stop: vi.fn(), close: vi.fn() });
  mocks.soniox.mockResolvedValue({ stop: vi.fn(), close: vi.fn() });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared audio recording", () => {
  it("does not start saved media or PCM when Soniox preparation fails", async () => {
    mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: "soniox" });
    mocks.soniox.mockRejectedValueOnce(new Error("Sonioxの準備に失敗しました"));
    await render(); await click("画面共有を開始");
    expect(Recorder.instances[0].start).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
    expect(host.textContent).toContain("Sonioxの準備に失敗しました");
  });
  it.each(["microphone", "shared_audio", "display"] as const)("starts the %s media timeline after delayed Soniox setup and before PCM activation", async (mode) => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const activate = vi.fn(() => {
      expect(Recorder.instances[0].state).toBe("recording");
      if (mode === "display") expect(Recorder.instances[1].state).toBe("recording");
    });
    mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: "soniox" });
    mocks.soniox.mockImplementationOnce(async (options) => {
      expect(options.deferAudioStart).toBe(true);
      expect(Recorder.instances[0].state).toBe("inactive");
      now = 5000; // Key issuance, WebSocket and AudioWorklet setup take 4 seconds.
      expect(options.getTimelinePositionMs()).toBe(0);
      return { startAudio: activate, stop: vi.fn() };
    });
    await render(true, false, mode); await click(mode === "microphone" ? "録音を開始" : "画面共有を開始");
    expect(activate).toHaveBeenCalledOnce();
    const options = mocks.soniox.mock.calls[0][0];
    expect(options.getTimelinePositionMs()).toBe(0);
    now = 6500;
    act(() => Recorder.instances[0].chunk());
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ start_ms: 0, end_ms: 1500 }), expect.any(Blob));
    expect(options.getTimelinePositionMs()).toBe(1500);
    await click(mode === "display" ? "録画を終了して確定" : "録音を終了して確定");
  });
  it("publishes Soniox speaker drafts together and sends only confirmed results to the backend", async () => {
    mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: "soniox" });
    await render(); await click("画面共有を開始");
    const options = mocks.soniox.mock.calls[0][0] as Parameters<typeof import("@/lib/soniox-speech-stream").startSonioxSpeechStream>[0];
    const words = [{ text: "Hel", start_ms: 100, end_ms: 250, confidence: 0.9 }, { text: "lo", start_ms: 300, end_ms: 450, confidence: 0.9 }];
    const first = { resultId: "s:0", text: "Hello", speakerLabel: "話者 1", startMs: 0, endMs: 1000, confidence: null, words };
    const second = { ...first, words: undefined, resultId: "s:1", text: "こんにちは", speakerLabel: "SPEAKER_UNKNOWN", startMs: 1000, endMs: 2000 };
    act(() => options.onInterims?.([first, second]));
    expect(getLiveTranscriptStore("m").getInterims().map((row) => row.text)).toEqual(["Hello", "こんにちは"]);
    expect(mocks.send).not.toHaveBeenCalled();
    act(() => options.onResult(first));
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ type: "soniox_result", result_id: "s:0", text: "Hello", words });
    expect(getLiveTranscriptStore("m").getHistory()[0].words.map((word) => [word.text, word.start_ms])).toEqual([["Hel", 100], ["lo", 300]]);
    act(() => options.onInterims?.([second]));
    expect(getLiveTranscriptStore("m").getInterims().map((row) => row.text)).toEqual(["こんにちは"]);
    act(() => options.onInterims?.([]));
    expect(getLiveTranscriptStore("m").getInterims()).toEqual([]);
    expect(mocks.send).toHaveBeenCalledOnce();
    await click("録音を終了して確定");
  });
  it.each(["shared_audio", "display"] as const)("uses named icon-only controls during %s capture and keeps original recording quality", async (mode) => {
    mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: "soniox" });
    await render(true, false, mode); await click("画面共有を開始");
    const toolbar = host.querySelector('[role="toolbar"]')!;
    const buttons = Array.from(toolbar.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.textContent).toBe("");
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.getAttribute("title")).toBe(button.getAttribute("aria-label"));
    }
    expect(mocks.soniox).toHaveBeenCalledOnce();
    if (mode === "display") {
      const videoRecorder = Recorder.instances.find((item) => item.stream.getVideoTracks().length)!;
      expect(videoRecorder.stream.getVideoTracks()[0]).toBe(display.getVideoTracks()[0]);
      expect(videoRecorder.options.videoBitsPerSecond).toBe(24_000_000);
      expect(host.querySelector("video")?.closest('[data-audio-only="false"]')).not.toBeNull();
    }
    await click("マイクをミュート");
    expect(toolbar.querySelector('[data-control="microphone"]')?.getAttribute("aria-pressed")).toBe("true");
    await click("マイクのミュートを解除");
    await click(mode === "display" ? "録画を終了して確定" : "録音を終了して確定");
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances.every((item) => item.state === "inactive")).toBe(true);
  });
  it.each(["whisperx", "azure_speech"])("sends only mixed audio using %s and preserves sharing when muted", async (provider) => {
    mocks.start.mockResolvedValue({ chunk_ms: 15000, transcription_provider: provider });
    await render(); await click("画面共有を開始");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true }), video: false });
    expect(mocks.createMixer).toHaveBeenCalledWith(display, microphone, null, null);
    expect(Recorder.instances).toHaveLength(1);
    const recorder = Recorder.instances[0];
    expect(recorder.stream).toBe(mixed);
    expect(recorder.stream.getVideoTracks()).toHaveLength(0);
    expect(mocks.start).toHaveBeenCalledWith({ type: "start", capture_mode: "audio", mime_type: "audio/webm;codecs=opus", has_system_audio: true });
    expect(host.querySelector("video")).toBeNull();
    if (provider === "azure_speech") expect(mocks.azure).toHaveBeenCalledWith(expect.objectContaining({ audioStream: mixed }));
    else expect(mocks.azure).not.toHaveBeenCalled();
    await click("マイクをミュート");
    expect(microphone.getAudioTracks()[0].enabled).toBe(false);
    expect(display.getAudioTracks()[0].enabled).toBe(true);
    await click("マイクのミュートを解除");
    expect(microphone.getAudioTracks()[0].enabled).toBe(true);
    act(() => recorder.chunk());
    await click("録音を終了して確定");
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls.every(([payload]) => payload.type === "chunk")).toBe(true);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "chunk", sequence: 0 }), expect.any(Blob));
  });

  it("refuses missing shared audio before starting a server session, then allows retry", async () => {
    const silent = new Stream([new Track("video")]);
    getDisplayMedia.mockResolvedValueOnce(silent);
    await render(); await click("画面共有を開始");
    expect(host.textContent).toContain("音声共有を有効にしてください");
    expect(silent.getVideoTracks()[0].stop).toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(Recorder.instances).toHaveLength(0);
    await click("画面共有を開始");
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("keeps one audio recorder across failed changes, ended sharing and resumed sharing", async () => {
    await render(); await click("画面共有を開始");
    const silent = new Stream([new Track("video")]);
    getDisplayMedia.mockResolvedValueOnce(silent);
    await click("共有画面を変更");
    expect(mixer.replaceDisplay).not.toHaveBeenCalled();
    expect(silent.getVideoTracks()[0].stop).toHaveBeenCalled();
    getDisplayMedia.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    await click("共有画面を変更");
    expect(host.textContent).toContain("録音は継続しています");
    act(() => display.getAudioTracks()[0].dispatchEvent(new Event("ended")));
    expect(host.textContent).toContain("画面共有が停止しました");
    const replacement = new Stream([new Track("video"), new Track("audio")]);
    getDisplayMedia.mockResolvedValueOnce(replacement);
    await click("共有画面を選んで再開");
    expect(mixer.replaceDisplay).toHaveBeenCalledWith(replacement);
    expect(Recorder.instances).toHaveLength(1);
    expect(Recorder.instances[0].start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("resumes prepared sharing and adds the initially muted microphone without restarting audio", async () => {
    const audioContext = { state: "running", close: vi.fn() };
    mocks.pending.mockReturnValue({ stream: display, includeMicrophone: false, audioContext });
    await render(false, true); await click("画面共有を開始");
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mocks.createMixer).toHaveBeenCalledWith(display, null, null, audioContext);
    await click("マイクのミュートを解除");
    expect(mixer.attachMicrophone).toHaveBeenCalledWith(microphone);
    expect(Recorder.instances).toHaveLength(1);
    expect(Recorder.instances[0].stream).toBe(mixed);
  });

  it("releases a prepared audio context and shared stream when transferred sharing has no sound", async () => {
    const silent = new Stream([new Track("video")]);
    const audioContext = { state: "running", close: vi.fn() };
    mocks.pending.mockReturnValue({ stream: silent, includeMicrophone: true, audioContext });
    await render(true, true); await click("画面共有を開始");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.createMixer).not.toHaveBeenCalled();
    expect(silent.getVideoTracks()[0].stop).toHaveBeenCalledOnce();
    expect(audioContext.close).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("共有音声を取得できません");
  });
});
