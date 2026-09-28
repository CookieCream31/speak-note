import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discardPendingLiveCapture,
  stagePendingLiveCapture,
  takePendingLiveCapture,
} from "./pending-live-capture";

function fakeStream() {
  const stop = vi.fn();
  const videoTrack = { readyState: "live", stop };
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
  } as unknown as MediaStream;
  return { stream, stop };
}

describe("pending live capture", () => {
  afterEach(() => discardPendingLiveCapture());

  it("hands the selected display and microphone setting to the matching meeting", () => {
    const capture = fakeStream();
    stagePendingLiveCapture("meeting-1", capture.stream, false);

    expect(takePendingLiveCapture("meeting-2")).toBeNull();
    expect(takePendingLiveCapture("meeting-1")).toEqual({
      meetingId: "meeting-1",
      stream: capture.stream,
      includeMicrophone: false,
      audioContext: null,
    });
    expect(capture.stop).not.toHaveBeenCalled();
    expect(takePendingLiveCapture("meeting-1")).toBeNull();
  });

  it("stops staged media and closes its audio context when discarded", () => {
    const capture = fakeStream();
    const close = vi.fn().mockResolvedValue(undefined);
    const audioContext = { state: "running", close } as unknown as AudioContext;
    stagePendingLiveCapture("meeting-1", capture.stream, true, audioContext);

    discardPendingLiveCapture();

    expect(capture.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
