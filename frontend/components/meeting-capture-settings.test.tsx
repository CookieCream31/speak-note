// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { meetingsApi, type Meeting } from "@/lib/api";
import { stagePendingLiveCapture } from "@/lib/pending-live-capture";
import { MeetingsManager } from "./meetings-manager";

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions", () => ({
  bulkManageMeetingsAction: vi.fn(), createMeetingTagAction: vi.fn(), deleteMeetingAction: vi.fn(),
  deleteMeetingTagAction: vi.fn(), updateMeetingFavoriteAction: vi.fn(), updateMeetingTitleAction: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  meetingsApi: { create: vi.fn(), update: vi.fn(), selectAI: vi.fn() },
}));
vi.mock("@/lib/pending-live-capture", () => ({ stagePendingLiveCapture: vi.fn() }));
vi.mock("@/lib/display-capture", async (original) => ({
  ...await original<typeof import("@/lib/display-capture")>(),
  detectDisplayCaptureSupport: () => "supported",
}));
vi.mock("./theme-selector", () => ({ ThemeSelector: () => null }));

class Track extends EventTarget {
  readyState = "live";
  label = "選択した会議タブ";
  stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(readonly kind: "audio" | "video") { super(); }
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
}
let host: HTMLDivElement;
let root: Root;
let display: Stream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
const meeting = { id: "m", title: "議事録" } as Meeting;
const audioContexts: { state: string; close: ReturnType<typeof vi.fn> }[] = [];
function videoSwitch() { return host.querySelector<HTMLInputElement>('[name="record_video"]')!; }
async function selectMethod(value: string) {
  await act(async () => host.querySelector<HTMLInputElement>(`[name="source_type"][value="${value}"]`)!.click());
}
async function toggleVideo() { await act(async () => videoSwitch().click()); }
async function chooseDisplay() {
  const button = Array.from(host.querySelectorAll("button")).find((element) => (
    element.textContent?.includes("共有する画面・ウィンドウを選択")
  ))!;
  await act(async () => button.click());
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function submitButton() { return host.querySelector<HTMLButtonElement>('button[type="submit"]')!; }
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0)); return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  audioContexts.length = 0;
  vi.stubGlobal("AudioContext", class {
    state = "running";
    close = vi.fn();
    constructor() { audioContexts.push(this); }
  });
  display = new Stream([new Track("video"), new Track("audio")]);
  getDisplayMedia = vi.fn().mockResolvedValue(display);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  vi.mocked(meetingsApi.create).mockResolvedValue(meeting);
  vi.mocked(meetingsApi.update).mockResolvedValue(meeting);
  vi.mocked(meetingsApi.selectAI).mockResolvedValue({} as Awaited<ReturnType<typeof meetingsApi.selectAI>>);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MeetingsManager meetings={[]} tags={[]} aiProfiles={[]} initialCreateOpen />));
  host.querySelector<HTMLInputElement>('[name="title"]')!.value = "議事録";
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("screen sharing recording setting", () => {
  it("offers three methods and shows the recording switch only for screen sharing", async () => {
    expect(host.querySelectorAll('[name="source_type"]')).toHaveLength(3);
    expect(videoSwitch()).toBeNull();
    await selectMethod("live");
    expect(videoSwitch().checked).toBe(true);
    expect(videoSwitch().getAttribute("role")).toBe("switch");
    expect(submitButton().textContent).toBe("作成して録画開始");
    await selectMethod("audio_recording");
    expect(videoSwitch()).toBeNull();
    expect(submitButton().textContent).toBe("作成して録音開始");
    await selectMethod("media_upload");
    expect(videoSwitch()).toBeNull();
  });

  it.each([true, false])("creates the matching saved capture type when video is %s", async (recordVideo) => {
    await selectMethod("live"); await chooseDisplay();
    if (!recordVideo) await toggleVideo();
    expect(submitButton().textContent).toBe(recordVideo ? "作成して録画開始" : "作成して録音開始");
    await submit();
    expect(meetingsApi.create).toHaveBeenCalledWith("議事録", recordVideo ? "live" : "shared_audio", expect.any(Object));
    expect(stagePendingLiveCapture).toHaveBeenCalledWith("m", display, false, audioContexts[0]);
    expect(router.push).toHaveBeenCalledWith("/meetings/m?start_recording=1");
  });

  it("keeps the prepared shared stream and microphone choice while video is toggled", async () => {
    await selectMethod("live"); await chooseDisplay();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="開始時のマイクミュートを解除"]')!.click());
    await toggleVideo(); await toggleVideo(); await toggleVideo();
    expect(host.querySelector<HTMLInputElement>('[name="source_type"][value="live"]')!.checked).toBe(true);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(display.getTracks().every((track) => track.stop.mock.calls.length === 0)).toBe(true);
    expect(host.textContent).toContain("映像は保存しません");
    await submit();
    expect(stagePendingLiveCapture).toHaveBeenCalledWith("m", display, true, audioContexts[0]);
  });

  it("blocks audio-only creation without shared sound and permits switching back to video", async () => {
    getDisplayMedia.mockResolvedValueOnce(new Stream([new Track("video")]));
    await selectMethod("live"); await chooseDisplay(); await toggleVideo(); await submit();
    expect(meetingsApi.create).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("音声共有を有効にしてください");
    await toggleVideo();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await submit();
    expect(meetingsApi.create).toHaveBeenCalledWith("議事録", "live", expect.any(Object));
  });

  it("locks capture type after creation and reuses the saved meeting on AI-setting retry", async () => {
    vi.mocked(meetingsApi.selectAI).mockRejectedValueOnce(new Error("AI設定の保存に失敗"));
    await selectMethod("live"); await chooseDisplay(); await toggleVideo(); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("AI設定の保存に失敗");
    expect(videoSwitch().disabled).toBe(true);
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('[name="source_type"]')).every((input) => input.disabled)).toBe(true);
    await toggleVideo();
    expect(videoSwitch().checked).toBe(false);
    await submit();
    expect(meetingsApi.create).toHaveBeenCalledOnce();
    expect(meetingsApi.update).toHaveBeenCalledWith("m", expect.objectContaining({ title: "議事録" }));
    expect(stagePendingLiveCapture).toHaveBeenCalledOnce();
  });

  it("restores video ON when a new dialog is opened", async () => {
    await selectMethod("live"); await toggleVideo();
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "キャンセル")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "新しい会議")!.click());
    await selectMethod("live");
    expect(videoSwitch().checked).toBe(true);
  });
});
