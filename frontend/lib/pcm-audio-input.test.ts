import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPcmAudioInput } from "./pcm-audio-input";

describe("shared PCM worklet", () => {
  it.each([16000, 44100, 48000])("preserves first-sample timestamps through %iHz resampling and partial-frame flush", (rate) => {
    const messages: { type: string; buffer?: ArrayBuffer; startTime?: number }[] = [];
    let Processor: new (options: unknown) => {
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => void;
      port: { onmessage: (event: unknown) => void };
    };
    class BaseProcessor {
      port = { postMessage: (message: typeof messages[number]) => messages.push(message) };
    }
    const globals = { AudioWorkletProcessor: BaseProcessor, sampleRate: rate, currentFrame: rate,
      registerProcessor: (_: string, processor: typeof Processor) => { Processor = processor; } };
    runInNewContext(readFileSync(new URL("../public/azure-speech-pcm-worklet.js", import.meta.url), "utf8"), globals);
    const processor = new Processor!({ processorOptions: { targetSampleRate: 16000, chunkSamples: 1600 } });
    const inputSamples = Math.floor(rate * 0.255);
    for (let position = 0; position < inputSamples; position += 128) {
      globals.currentFrame = rate + position;
      processor.process([[new Float32Array(Math.min(128, inputSamples - position)).fill(1)]], [[new Float32Array(128)]]);
    }
    processor.port.onmessage({ data: { type: "flush" } });
    const frames = messages.filter((message) => message.type === "pcm");
    expect(frames).toHaveLength(3);
    frames.forEach((frame, index) => expect(frame.startTime).toBeCloseTo(1 + index * 0.1, 5));
    expect(frames.map((frame) => frame.buffer!.byteLength)).toEqual([3200, 3200, 1760]);
    expect(frames.flatMap((frame) => [...new Int16Array(frame.buffer!)])).toEqual(Array(4080).fill(32767));
  });
  it("flushes the last partial frame without padding, truncation, or duplication", () => {
    const messages: { type: string; buffer?: ArrayBuffer }[] = [];
    let Processor: new (options: unknown) => {
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => void;
      port: { onmessage: (event: unknown) => void };
    };
    class BaseProcessor {
      port = { postMessage: (message: { type: string; buffer?: ArrayBuffer }) => messages.push(message) };
    }
    runInNewContext(readFileSync(new URL("../public/azure-speech-pcm-worklet.js", import.meta.url), "utf8"), {
      AudioWorkletProcessor: BaseProcessor, sampleRate: 16000,
      registerProcessor: (_: string, processor: typeof Processor) => { Processor = processor; },
    });
    const processor = new Processor!({ processorOptions: { targetSampleRate: 16000, chunkSamples: 1600 } });
    const output = new Float32Array([1, 1, 1]);
    processor.process([[new Float32Array([-1, 0, 1])]], [[output]]);
    expect(messages).toEqual([]);
    expect([...output]).toEqual([0, 0, 0]);
    processor.port.onmessage({ data: { type: "flush" } });
    expect(messages.map((message) => message.type)).toEqual(["pcm", "flushed"]);
    expect([...new Int16Array(messages[0].buffer!)]).toEqual([-32768, 0, 32767]);
    processor.port.onmessage({ data: { type: "flush" } });
    expect(messages.filter((message) => message.type === "pcm")).toHaveLength(1);
  });
});

describe("Soniox PCM input ownership", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("waits for the worklet tail before closing and never stops recording tracks", async () => {
    const tail = new ArrayBuffer(6), stopTrack = vi.fn(), receive = vi.fn();
    const disconnectSource = vi.fn(), disconnectWorklet = vi.fn(), closeContext = vi.fn(async () => undefined);
    class Context {
      state = "running";
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: disconnectSource });
      close = closeContext;
    }
    class Worklet {
      port = {
        onmessage: null as ((event: { data: object }) => void) | null,
        postMessage: (_: unknown) => {
          this.port.onmessage?.({ data: { type: "pcm", buffer: tail, startTime: 0 } });
          this.port.onmessage?.({ data: { type: "flushed" } });
        },
      };
      connect = vi.fn();
      disconnect = disconnectWorklet;
    }
    vi.stubGlobal("window", { AudioContext: Context });
    vi.stubGlobal("AudioWorkletNode", Worklet);
    const input = await createPcmAudioInput({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream, receive);
    await input.close(); await input.close();
    expect(receive).toHaveBeenCalledWith(tail, 0);
    expect(closeContext).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce(); expect(disconnectWorklet).toHaveBeenCalledOnce();
    expect(stopTrack).not.toHaveBeenCalled();
  });
  it("anchors activation to AudioContext time and retains capture time through a delayed main-thread message", async () => {
    const receive = vi.fn(), connect = vi.fn();
    let context: Context, worklet: Worklet;
    class Context {
      state = "running"; currentTime = 5; destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      constructor() { context = this; }
      createMediaStreamSource = () => ({ connect, disconnect: vi.fn() });
      close = vi.fn(async () => undefined);
    }
    class Worklet {
      port = { onmessage: null as ((event: { data: object }) => void) | null, postMessage: () => this.port.onmessage?.({ data: { type: "flushed" } }) };
      constructor() { worklet = this; }
      connect = vi.fn(); disconnect = vi.fn();
    }
    vi.stubGlobal("window", { AudioContext: Context });
    vi.stubGlobal("AudioWorkletNode", Worklet);
    const input = await createPcmAudioInput({} as MediaStream, receive, { deferStart: true, getTimelinePositionMs: () => 2000 });
    expect(connect).not.toHaveBeenCalled();
    worklet!.port.onmessage?.({ data: { type: "pcm", buffer: new ArrayBuffer(3200), startTime: 5 } });
    expect(receive).not.toHaveBeenCalled();
    input.start(); input.start();
    expect(connect).toHaveBeenCalledOnce();
    context!.currentTime = 12;
    const full = new ArrayBuffer(3200), tail = new ArrayBuffer(32);
    worklet!.port.onmessage?.({ data: { type: "pcm", buffer: full, startTime: 5.125 } });
    worklet!.port.onmessage?.({ data: { type: "pcm", buffer: tail, startTime: 5.225 } });
    expect(receive.mock.calls).toEqual([[full, 2125], [tail, 2225]]);
    await input.close();
    input.start();
    expect(connect).toHaveBeenCalledOnce();
  });
});
