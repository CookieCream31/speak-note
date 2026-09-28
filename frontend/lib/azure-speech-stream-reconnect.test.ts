import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const speechSdkMock = vi.hoisted(() => {
  class MockRecognizer {
    authorizationToken = "";
    transcribed: ((sender: unknown, event: Record<string, unknown>) => void) | undefined;
    transcribing: ((sender: unknown, event: Record<string, unknown>) => void) | undefined;
    canceled: ((sender: unknown, event: Record<string, unknown>) => void) | undefined;
    sessionStarted: ((sender: unknown, event: Record<string, unknown>) => void) | undefined;
    sessionStopped: ((sender: unknown, event: Record<string, unknown>) => void) | undefined;
    startTranscribingAsync = vi.fn((success?: () => void) => success?.());
    stopTranscribingAsync = vi.fn((success?: () => void) => success?.());
    close = vi.fn((success?: () => void) => success?.());
  }

  const recognizers: MockRecognizer[] = [];
  const speechConfigs: Array<{ setProperty: ReturnType<typeof vi.fn> }> = [];
  const audioConfigs: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const audioInputs: unknown[] = [];
  const pushStreams: Array<{ write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const formats: Array<{ close: ReturnType<typeof vi.fn> }> = [];

  return {
    MockRecognizer,
    recognizers,
    speechConfigs,
    audioConfigs,
    audioInputs,
    pushStreams,
    formats,
  };
});

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  AudioInputStream: {
    createPushStream: vi.fn(() => {
      const stream = { write: vi.fn(), close: vi.fn() };
      speechSdkMock.pushStreams.push(stream);
      return stream;
    }),
  },
  AudioStreamFormat: {
    getWaveFormatPCM: vi.fn(() => {
      const format = { close: vi.fn() };
      speechSdkMock.formats.push(format);
      return format;
    }),
  },
  AudioConfig: {
    fromStreamInput: vi.fn((input: unknown) => {
      speechSdkMock.audioInputs.push(input);
      const audioConfig = {
        close: vi.fn(() => {
          throw new TypeError("Cannot read properties of undefined (reading then)");
        }),
      };
      speechSdkMock.audioConfigs.push(audioConfig);
      return audioConfig;
    }),
  },
  CancellationReason: { Error: 1 },
  OutputFormat: { Detailed: 1 },
  PropertyId: {
    Speech_SegmentationStrategy: 33,
    Speech_SegmentationSilenceTimeoutMs: 31,
    Speech_SegmentationMaximumTimeMs: 32,
    SpeechServiceResponse_StablePartialResultThreshold: 42,
    SpeechServiceResponse_DiarizeIntermediateResults: 48,
  },
  ResultReason: { RecognizedSpeech: 1, RecognizingSpeech: 2 },
  SpeechConfig: {
    fromAuthorizationToken: vi.fn(() => {
      const config = {
        speechRecognitionLanguage: "",
        outputFormat: 0,
        setProperty: vi.fn(),
      };
      speechSdkMock.speechConfigs.push(config);
      return config;
    }),
  },
  ConversationTranscriber: class extends speechSdkMock.MockRecognizer {
    constructor() {
      super();
      speechSdkMock.recognizers.push(this);
    }
  },
}));

import {
  startAzureSpeechStream,
  type AzureSpeechResult,
  type AzureSpeechDiagnostic,
} from "./azure-speech-stream";

type MockPcmMessage = { type: "pcm"; buffer: ArrayBuffer; level: number };

function installAudioWorkletMock() {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const workletNodes: Array<{
    port: { onmessage: ((event: MessageEvent<MockPcmMessage>) => void) | null };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  class MockAudioWorkletNode {
    port = { onmessage: null as ((event: MessageEvent<MockPcmMessage>) => void) | null };
    connect = vi.fn();
    disconnect = vi.fn();

    constructor() {
      workletNodes.push(this);
    }
  }
  class MockAudioContext {
    state: AudioContextState = "running";
    sampleRate = 16_000;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    createMediaStreamSource = vi.fn(() => source);
    createScriptProcessor = vi.fn();
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  }
  Object.assign(window, {
    AudioContext: MockAudioContext as unknown as typeof AudioContext,
  });
  vi.stubGlobal(
    "AudioWorkletNode",
    MockAudioWorkletNode as unknown as typeof AudioWorkletNode,
  );
  return workletNodes;
}

function emitPcm(
  workletNode: ReturnType<typeof installAudioWorkletMock>[number],
  level: number,
) {
  workletNode.port.onmessage?.({
    data: { type: "pcm", buffer: new ArrayBuffer(3_200), level },
  } as MessageEvent<MockPcmMessage>);
}

describe("Azure Speech streaming reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    speechSdkMock.recognizers.length = 0;
    speechSdkMock.speechConfigs.length = 0;
    speechSdkMock.audioConfigs.length = 0;
    speechSdkMock.audioInputs.length = 0;
    speechSdkMock.pushStreams.length = 0;
    speechSdkMock.formats.length = 0;
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "short-lived-token",
        region: "japaneast",
        language: "ja-JP",
        expires_in_seconds: 600,
      }),
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a phrase even when a NoMatch result has undefined text", async () => {
    const results: AzureSpeechResult[] = [];
    const interims: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onResult: (result) => results.push(result),
      onInterim: (result) => interims.push(result),
      onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    recognizer.transcribing?.(recognizer, { result: {
      reason: 2, text: "直前の途中結果", offset: 0, duration: 10_000_000,
    } });
    expect(() => recognizer.transcribed?.(recognizer, { result: {
      reason: 0, text: undefined, offset: 0, duration: 10_000_000,
    } })).not.toThrow();
    recognizer.transcribing?.(recognizer, { result: {
      reason: 2, text: "次の発話", offset: 20_000_000, duration: 10_000_000,
    } });
    recognizer.transcribed?.(recognizer, { result: {
      reason: 1, text: "次の発話。", offset: 20_000_000, duration: 10_000_000,
    } });
    expect(results.map((result) => result.text)).toEqual(["直前の途中結果", "次の発話。"]);
    expect(results[0].resultId).toBe(interims[0].resultId);
    expect(results[1].resultId).not.toBe(results[0].resultId);
    await controller.stop();
  });

  it("ignores late callbacks from a recognizer being reconnected", async () => {
    const results: AzureSpeechResult[] = [];
    const interims: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onResult: (result) => results.push(result),
      onInterim: (result) => interims.push(result),
      onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    recognizer.transcribing?.(recognizer, { result: {
      reason: 2, text: "保存する文", offset: 0, duration: 10_000_000,
    } });
    recognizer.sessionStopped?.(recognizer, {});
    recognizer.transcribed?.(recognizer, { result: {
      reason: 1, text: "古い接続の遅延結果", offset: 0, duration: 10_000_000,
    } });
    recognizer.transcribing?.(recognizer, { result: {
      reason: 2, text: "古い接続の途中結果", offset: 20_000_000, duration: 10_000_000,
    } });
    expect(results.map((result) => result.text)).toEqual(["保存する文"]);
    expect(interims.map((result) => result.text)).toEqual(["保存する文"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(speechSdkMock.recognizers).toHaveLength(2);
    await controller.stop();
  });

  it("falls back to the native MediaStream when Web Audio is unavailable", async () => {
    class MockMediaStream {}
    vi.stubGlobal("MediaStream", MockMediaStream);
    const audioStream = new MockMediaStream() as unknown as MediaStream;

    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream,
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    expect(speechSdkMock.audioInputs[0]).toBe(audioStream);
    expect(speechSdkMock.pushStreams).toHaveLength(0);

    await controller.stop();
    expect(speechSdkMock.recognizers[0].close).toHaveBeenCalledOnce();
  });

  it("feeds AudioWorklet PCM into an Azure push stream", async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const workletNodes: Array<{
      port: { onmessage: ((event: MessageEvent<{ type: "pcm"; buffer: ArrayBuffer; level: number }>) => void) | null };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    class MockAudioWorkletNode {
      port = { onmessage: null as ((event: MessageEvent<{ type: "pcm"; buffer: ArrayBuffer; level: number }>) => void) | null };
      connect = vi.fn();
      disconnect = vi.fn();

      constructor() {
        workletNodes.push(this);
      }
    }
    class MockAudioContext {
      state: AudioContextState = "running";
      sampleRate = 48_000;
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      createMediaStreamSource = vi.fn(() => source);
      createScriptProcessor = vi.fn();
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
    }
    Object.assign(window, {
      AudioContext: MockAudioContext as unknown as typeof AudioContext,
    });
    vi.stubGlobal(
      "AudioWorkletNode",
      MockAudioWorkletNode as unknown as typeof AudioWorkletNode,
    );

    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    expect(speechSdkMock.pushStreams).toHaveLength(1);
    expect(speechSdkMock.audioInputs[0]).toBe(speechSdkMock.pushStreams[0]);
    expect(workletNodes).toHaveLength(1);
    workletNodes[0].port.onmessage?.({
      data: { type: "pcm", buffer: new ArrayBuffer(320), level: 0.02 },
    } as MessageEvent<{ type: "pcm"; buffer: ArrayBuffer; level: number }>);
    expect(speechSdkMock.pushStreams[0].write).toHaveBeenCalledOnce();
    expect((speechSdkMock.pushStreams[0].write.mock.calls[0][0] as ArrayBuffer).byteLength)
      .toBe(320);

    await controller.stop();
    expect(workletNodes[0].disconnect).toHaveBeenCalledOnce();
    expect(speechSdkMock.pushStreams[0].close).toHaveBeenCalledOnce();
    expect(speechSdkMock.formats[0].close).toHaveBeenCalledOnce();
  });

  it("reconnects an unexpectedly stopped session and preserves the meeting timeline", async () => {
    const results: AzureSpeechResult[] = [];
    const errors: string[] = [];
    let timelinePositionMs = 30_000;
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      getTimelinePositionMs: () => timelinePositionMs,
      onResult: (result) => results.push(result),
      onError: (message) => errors.push(message),
    });

    expect(speechSdkMock.recognizers).toHaveLength(1);
    speechSdkMock.recognizers[0].transcribed?.(null, {
      result: {
        reason: 1,
        resultId: "initial-result",
        offset: 10_000_000,
        duration: 20_000_000,
        text: "最初の発言",
        json: '{"NBest":[{"Confidence":0.9}]}',
      },
    });
    expect(results[0]).toMatchObject({ startMs: 1_000, endMs: 3_000 });

    speechSdkMock.recognizers[0].sessionStopped?.(null, {});
    expect(errors[0]).toContain("自動的に再接続します");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(speechSdkMock.recognizers).toHaveLength(2);
    timelinePositionMs = 31_000;
    speechSdkMock.recognizers[1].transcribed?.(null, {
      result: {
        reason: 1,
        resultId: "reconnected-result",
        offset: 20_000_000,
        duration: 10_000_000,
        text: "再接続後の発言",
        json: undefined,
      },
    });
    expect(results[1]).toMatchObject({ startMs: 32_000, endMs: 33_000 });

    await controller.stop();
    expect(speechSdkMock.recognizers[1].close).toHaveBeenCalledOnce();
    expect(speechSdkMock.audioConfigs.every((config) => (
      config.close.mock.calls.length === 0
    ))).toBe(true);
  });

  it("uses one application ID per phrase even when Azure reuses its request ID", async () => {
    const interimResults: AzureSpeechResult[] = [];
    const finalResults: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onInterim: (result) => interimResults.push(result),
      onResult: (result) => finalResults.push(result),
      onError: vi.fn(),
    });

    expect(speechSdkMock.speechConfigs[0].setProperty)
      .toHaveBeenCalledWith(48, "true");
    expect(speechSdkMock.speechConfigs[0].setProperty)
      .toHaveBeenCalledWith(42, "3");

    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2,
        resultId: "shared-azure-request-id",
        offset: 10_000_000,
        duration: 5_000_000,
        text: "話している途中",
        speakerId: "Unknown",
        json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribed?.(null, {
      result: {
        reason: 1,
        resultId: "shared-azure-request-id",
        offset: 10_000_000,
        duration: 20_000_000,
        text: "話している途中の確定結果",
        speakerId: "Guest-1",
        json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2,
        resultId: "shared-azure-request-id",
        offset: 40_000_000,
        duration: 5_000_000,
        text: "次の発話",
        speakerId: "Guest-2",
        json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribed?.(null, {
      result: {
        reason: 1,
        resultId: "shared-azure-request-id",
        offset: 40_000_000,
        duration: 20_000_000,
        text: "次の発話の確定結果",
        speakerId: "Guest-2",
        json: undefined,
      },
    });

    expect(interimResults[0]).toMatchObject({ text: "話している途中" });
    expect(finalResults[0]).toMatchObject({ text: "話している途中の確定結果" });
    expect(interimResults[1]).toMatchObject({ text: "次の発話" });
    expect(finalResults[1]).toMatchObject({ text: "次の発話の確定結果" });
    expect(finalResults[0].resultId).toBe(interimResults[0].resultId);
    expect(finalResults[1].resultId).toBe(interimResults[1].resultId);
    expect(finalResults[1].resultId).not.toBe(finalResults[0].resultId);
    expect(interimResults[0].speakerLabel).toBe("SPEAKER_UNKNOWN");
    expect(finalResults[0].speakerLabel).toBe("SPEAKER_00");
    expect(finalResults[1].speakerLabel).toBe("SPEAKER_01");
    expect(interimResults[0].resultId).not.toBe("shared-azure-request-id");
    expect(speechSdkMock.recognizers).toHaveLength(1);
    expect(speechSdkMock.recognizers[0].stopTranscribingAsync)
      .not.toHaveBeenCalled();

    await controller.stop();
  });

  it("assigns speaker numbers only from final results", async () => {
    const interimResults: AzureSpeechResult[] = [];
    const finalResults: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onInterim: (result) => interimResults.push(result),
      onResult: (result) => finalResults.push(result),
      onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    for (const speakerId of ["Guest-transient-1", "Guest-transient-2"]) {
      recognizer.transcribing?.(null, { result: {
        reason: 2, offset: 0, duration: 10_000_000,
        text: "認識途中", speakerId,
      } });
      await vi.advanceTimersByTimeAsync(100);
    }
    recognizer.transcribed?.(null, { result: {
      reason: 1, offset: 0, duration: 20_000_000,
      text: "最初の確定発話", speakerId: "Guest-1",
    } });

    expect(interimResults.every((result) => (
      result.speakerLabel === "SPEAKER_UNKNOWN"
    ))).toBe(true);
    expect(finalResults[0].speakerLabel).toBe("SPEAKER_00");
    await controller.stop();
  });

  it("preserves the last interim phrase when Azure ends it with NoMatch", async () => {
    const interimResults: AzureSpeechResult[] = [];
    const finalResults: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onInterim: (result) => interimResults.push(result),
      onResult: (result) => finalResults.push(result),
      onError: vi.fn(),
    });

    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2, resultId: "azure-request", offset: 10_000_000,
        duration: 5_000_000, text: "消えてはいけない途中結果", json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2, resultId: "azure-request", offset: 10_000_000,
        duration: 6_000_000, text: "短い", json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribed?.(null, {
      result: {
        reason: 0, resultId: "azure-request", offset: 10_000_000,
        duration: 5_000_000, text: "", json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2, resultId: "azure-request", offset: 20_000_000,
        duration: 5_000_000, text: "次の発話", json: undefined,
      },
    });

    expect(interimResults).toHaveLength(2);
    expect(finalResults[0]).toMatchObject({
      resultId: interimResults[0].resultId,
      text: "短い",
    });
    expect(interimResults[1].resultId).not.toBe(interimResults[0].resultId);
    await vi.advanceTimersByTimeAsync(80);
    expect(interimResults).toHaveLength(2);

    await controller.stop();
  });

  it("throttles changing interim offsets without splitting the phrase", async () => {
    const interimResults: AzureSpeechResult[] = [];
    const finalResults: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onInterim: (result) => interimResults.push(result),
      onResult: (result) => finalResults.push(result),
      onError: vi.fn(),
    });

    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2, resultId: "shared-request", offset: 10_000_000,
        duration: 5_000_000, text: "同じ発話の途中", json: undefined,
      },
    });
    speechSdkMock.recognizers[0].transcribing?.(null, {
      result: {
        reason: 2, resultId: "shared-request", offset: 12_000_000,
        duration: 8_000_000, text: "同じ発話の途中結果", json: undefined,
      },
    });

    expect(finalResults).toEqual([]);
    expect(interimResults).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(interimResults).toHaveLength(2);
    expect(interimResults[1].resultId).toBe(interimResults[0].resultId);
    expect(interimResults[1].text).toBe("同じ発話の途中結果");

    await controller.stop();
  });

  it("keeps a long interim phrase continuous and persists it when stopped", async () => {
    const interimResults: AzureSpeechResult[] = [];
    const finalResults: AzureSpeechResult[] = [];
    const errors: string[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onInterim: (result) => interimResults.push(result),
      onResult: (result) => finalResults.push(result),
      onError: (message) => errors.push(message),
    });

    for (let elapsedMs = 5_000; elapsedMs <= 60_000; elapsedMs += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      speechSdkMock.recognizers[0].transcribing?.(null, {
        result: {
          reason: 2,
          resultId: "long-interim",
          offset: 0,
          duration: elapsedMs * 10_000,
          text: "継続中の発話" + elapsedMs,
          json: undefined,
        },
      });
    }

    expect(speechSdkMock.recognizers).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(finalResults).toEqual([]);

    await controller.stop();

    expect(finalResults).toHaveLength(1);
    expect(finalResults[0]).toMatchObject({
      endMs: 60_000,
      text: "継続中の発話60000",
    });
    expect(finalResults[0].resultId).toBe(interimResults.at(-1)?.resultId);
    expect(finalResults[0].resultId).not.toBe("long-interim");
  });

  it("keeps a silent continuous session open when empty events arrive", async () => {
    const workletNodes = installAudioWorkletMock();
    const errors: string[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      onResult: vi.fn(),
      onError: (message) => errors.push(message),
    });

    for (let elapsed = 0; elapsed < 60_000; elapsed += 2_000) {
      emitPcm(workletNodes[0], 0);
      speechSdkMock.recognizers[0].transcribing?.(null, {
        result: {
          reason: 2, resultId: "empty", offset: 0, duration: 0, text: "", json: undefined,
        },
      });
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(errors).toEqual([]);
    expect(speechSdkMock.recognizers).toHaveLength(1);

    await controller.stop();
  });

  it("reconnects when audible PCM continues without Azure recognition events", async () => {
    const workletNodes = installAudioWorkletMock();
    let timelinePositionMs = 10_000;
    const errors: string[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token",
      audioStream: {} as MediaStream,
      getTimelinePositionMs: () => timelinePositionMs,
      onResult: vi.fn(),
      onError: (message) => errors.push(message),
    });

    expect(speechSdkMock.recognizers).toHaveLength(1);
    for (let elapsed = 0; elapsed < 16_000; elapsed += 2_000) {
      emitPcm(workletNodes[0], 0.02);
      timelinePositionMs += 2_000;
      await vi.advanceTimersByTimeAsync(2_000);
    }
    await vi.advanceTimersByTimeAsync(1_000);

    expect(errors.some((message) => message.includes("音声入力は継続"))).toBe(true);
    expect(speechSdkMock.recognizers).toHaveLength(2);
    expect(speechSdkMock.recognizers[0].stopTranscribingAsync).toHaveBeenCalled();
    expect(speechSdkMock.recognizers[0].close).toHaveBeenCalled();

    await controller.stop();
  });
  it("keeps the speaker ID of a final delivered while stopping", async () => {
    const results: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token", audioStream: {} as MediaStream,
      onResult: (result) => results.push(result), onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    recognizer.transcribing?.(null, { result: {
      reason: 2, offset: 0, duration: 10_000_000, text: "途中", speakerId: "Unknown",
    } });
    recognizer.stopTranscribingAsync.mockImplementation((done) => {
      window.setTimeout(() => {
        recognizer.transcribed?.(null, { result: {
          reason: 1, offset: 0, duration: 20_000_000, text: "最後の確定文。", speakerId: "Guest-1",
        } });
        done?.();
      }, 100);
    });
    const stopping = controller.stop();
    expect(controller.stop()).toBe(stopping);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ text: "最後の確定文。", speakerLabel: "SPEAKER_00" });
    expect(recognizer.stopTranscribingAsync).toHaveBeenCalledOnce();
  });

  it("does not reconnect on audible non-speech while Azure sends empty hypotheses", async () => {
    const nodes = installAudioWorkletMock();
    const errors = vi.fn();
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token", audioStream: {} as MediaStream,
      onResult: vi.fn(), onError: errors,
    });
    const recognizer = speechSdkMock.recognizers[0];
    for (let index = 0; index < 20; index += 1) {
      emitPcm(nodes[0], 0.03);
      recognizer.transcribing?.(null, { result: {
        reason: 2, offset: index * 20_000_000, duration: 0, text: "",
      } });
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(speechSdkMock.recognizers).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("does not discard a queued next hypothesis when an earlier final arrives", async () => {
    const results: AzureSpeechResult[] = [];
    const interims: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token", audioStream: {} as MediaStream,
      onResult: (result) => results.push(result),
      onInterim: (result) => interims.push(result), onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    recognizer.transcribing?.(null, { result: {
      reason: 2, offset: 50_000_000, duration: 10_000_000, text: "次の",
    } });
    recognizer.transcribing?.(null, { result: {
      reason: 2, offset: 50_000_000, duration: 20_000_000, text: "次の発話",
    } });
    recognizer.transcribed?.(null, { result: {
      reason: 1, offset: 0, duration: 40_000_000, text: "前の発話。", speakerId: "Guest-1",
    } });
    await vi.advanceTimersByTimeAsync(80);
    expect(interims.at(-1)?.text).toBe("次の発話");
    expect(results[0].resultId).not.toBe(interims[0].resultId);
    recognizer.transcribed?.(null, { result: {
      reason: 1, offset: 50_000_000, duration: 30_000_000, text: "次の発話。", speakerId: "Guest-2",
    } });
    expect(results[1].resultId).toBe(interims[0].resultId);
    expect(results.map((result) => result.speakerLabel)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    await controller.stop();
  });

  it("reports source and mapped speaker IDs without transcript text or credentials", async () => {
    const events: AzureSpeechDiagnostic[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token", audioStream: {} as MediaStream,
      onResult: vi.fn(), onError: vi.fn(),
      onDiagnostic: (event) => events.push(event),
    });
    speechSdkMock.recognizers[0].transcribed?.(null, { result: {
      reason: 1, offset: 0, duration: 10_000_000, text: "秘密の本文", speakerId: "Guest-1",
    } });
    expect(events[0]).toMatchObject({
      event: "final", rawSpeakerId: "Guest-1", speakerLabel: "SPEAKER_00", characters: 5,
    });
    expect(JSON.stringify(events)).not.toContain("秘密の本文");
    expect(JSON.stringify(events)).not.toContain("short-lived-token");
    await controller.stop();
  });

  it("hides transient retractions but applies genuine corrections within 250ms", async () => {
    const interims: AzureSpeechResult[] = [];
    const finals: AzureSpeechResult[] = [];
    const controller = await startAzureSpeechStream({
      tokenUrl: "/azure-token", audioStream: {} as MediaStream,
      onInterim: (result) => interims.push(result),
      onResult: (result) => finals.push(result), onError: vi.fn(),
    });
    const recognizer = speechSdkMock.recognizers[0];
    const interim = (text: string) => recognizer.transcribing?.(null, { result: {
      reason: 2, text, offset: 0, duration: 10_000_000,
    } });
    interim("長い途中結果");
    await vi.advanceTimersByTimeAsync(500);
    interim("長い");
    await vi.advanceTimersByTimeAsync(100);
    interim("長い途中結果");
    await vi.advanceTimersByTimeAsync(300);
    expect(interims.map((result) => result.text)).toEqual(["長い途中結果"]);
    interim("短い訂正");
    await vi.advanceTimersByTimeAsync(200);
    interim("短い訂正後");
    await vi.advanceTimersByTimeAsync(50);
    expect(interims.at(-1)?.text).toBe("短い訂正後");
    interim("短");
    recognizer.transcribed?.(null, { result: {
      reason: 1, text: "確定。", offset: 0, duration: 20_000_000, speakerId: "Guest-1",
    } });
    await vi.advanceTimersByTimeAsync(500);
    expect(finals[0].text).toBe("確定。");
    expect(interims.at(-1)?.text).toBe("短い訂正後");
    await controller.stop();
  });

});
