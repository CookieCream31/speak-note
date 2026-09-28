import { describe, expect, it, vi } from "vitest";

import {
  constrainDisplayTrack,
  formatElapsedTime,
  LiveCaptureMixer,
  microphoneSpeechConstraints,
  screenRecordingBitrate,
} from "./live-capture";

describe("microphoneSpeechConstraints", () => {
  it("requests voice processing before mixing microphone and system audio", () => {
    expect(microphoneSpeechConstraints()).toEqual({
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });
});

describe("formatElapsedTime", () => {
  it("formats recording durations below one hour", () => {
    expect(formatElapsedTime(0)).toBe("0:00");
    expect(formatElapsedTime(65_999)).toBe("1:05");
  });

  it("includes hours for long recordings", () => {
    expect(formatElapsedTime(3_661_000)).toBe("1:01:01");
  });
});

describe("constrainDisplayTrack", () => {
  it("requests up to 4K at no more than 30fps without failing capture", async () => {
    const applyConstraints = vi.fn().mockRejectedValue(new Error("unsupported"));

    await expect(constrainDisplayTrack({ applyConstraints } as unknown as MediaStreamTrack))
      .resolves.toBeUndefined();
    expect(applyConstraints).toHaveBeenCalledWith({
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: { ideal: 30, max: 30 },
    });
  });
});


describe("screenRecordingBitrate", () => {
  it.each([
    [1280, 720, 5_000_000],
    [1920, 1080, 8_294_400],
    [3840, 2160, 24_000_000],
  ])("uses a bounded detail-preserving bitrate for %ix%i", (width, height, bitrate) => {
    const track = { getSettings: () => ({ width, height }) } as MediaStreamTrack;
    expect(screenRecordingBitrate(track)).toBe(bitrate);
  });
});

describe("LiveCaptureMixer.handleDisplayEnded", () => {
  it("detaches only the ended display and keeps the recording mixer available", () => {
    const displayStream = {} as MediaStream;
    const pause = vi.fn();
    const disconnect = vi.fn();
    const mixer = Object.create(LiveCaptureMixer.prototype) as LiveCaptureMixer;
    Object.assign(mixer, {
      stopped: false,
      displayStream,
      displayAudioSource: { disconnect },
      preview: {
        srcObject: displayStream,
        pause,
      },
    });

    expect(mixer.handleDisplayEnded(displayStream)).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect((mixer as unknown as { displayStream: MediaStream }).displayStream).toBe(displayStream);
  });

  it("ignores an ended event from a previously replaced display", () => {
    const currentStream = {} as MediaStream;
    const oldStream = {} as MediaStream;
    const mixer = Object.create(LiveCaptureMixer.prototype) as LiveCaptureMixer;
    Object.assign(mixer, { stopped: false, displayStream: currentStream });

    expect(mixer.handleDisplayEnded(oldStream)).toBe(false);
  });
});

describe("LiveCaptureMixer microphone attachment", () => {
  it("adds a microphone to the existing audio destination without replacing the recording stream", () => {
    const connect = vi.fn();
    const createMediaStreamSource = vi.fn().mockReturnValue({ connect });
    const microphoneTrack = { enabled: true, stop: vi.fn() };
    const displayTrack = { enabled: true };
    const microphone = { getAudioTracks: () => [microphoneTrack], getTracks: () => [microphoneTrack] } as unknown as MediaStream;
    const destination = {};
    const audioStream = {};
    const mixer = Object.create(LiveCaptureMixer.prototype) as LiveCaptureMixer;
    Object.assign(mixer, { stopped: false, microphoneStream: null, microphoneSource: null,
      audioContext: { createMediaStreamSource }, audioDestination: destination, audioStream,
      displayStream: { getAudioTracks: () => [displayTrack] },
    });
    mixer.attachMicrophone(microphone);
    expect(createMediaStreamSource).toHaveBeenCalledWith(microphone);
    expect(connect).toHaveBeenCalledWith(destination);
    expect(mixer.audioStream).toBe(audioStream);
    mixer.setMicrophoneMuted(true);
    expect(microphoneTrack.enabled).toBe(false);
    expect(displayTrack.enabled).toBe(true);
    mixer.setMicrophoneMuted(false);
    expect(microphoneTrack.enabled).toBe(true);
    expect(microphoneTrack.stop).not.toHaveBeenCalled();
  });
  it("does not attach microphone input after the mixer is stopped", () => {
    const mixer = Object.create(LiveCaptureMixer.prototype) as LiveCaptureMixer;
    Object.assign(mixer, { stopped: true });
    expect(() => mixer.attachMicrophone({} as MediaStream)).toThrow("録音は終了");
  });
});
