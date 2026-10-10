// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveMeetingRecorder } from "./live-meeting-recorder";

const mocks = vi.hoisted(() => ({
  router: { refresh: vi.fn() }, createMixer: vi.fn(), pending: vi.fn(),
  start: vi.fn(), send: vi.fn(), stop: vi.fn(), close: vi.fn(), azure: vi.fn(),
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
vi.mock("@/lib/recording-connection", () => ({ RecordingConnection: class {
  start = mocks.start; send = mocks.send; stop = mocks.stop; close = mocks.close;
} }));

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(readonly kind: "audio" | "video") { super(); }
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
  constructor(readonly stream: Stream, options: MediaRecorderOptions) {
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
async function render(includeMicrophone = true, resumePendingCapture = false) {
  await act(async () => root.render(<LiveMeetingRecorder meetingId="m" captureMode="shared_audio"
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
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("shared audio recording", () => {
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
