import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPcmAudioInput } from "./pcm-audio-input";

describe("shared PCM worklet", () => {
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
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: disconnectSource });
      close = closeContext;
    }
    class Worklet {
      port = {
        onmessage: null as ((event: { data: object }) => void) | null,
        postMessage: (_: unknown) => {
          this.port.onmessage?.({ data: { type: "pcm", buffer: tail } });
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
    expect(receive).toHaveBeenCalledWith(tail);
    expect(closeContext).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce(); expect(disconnectWorklet).toHaveBeenCalledOnce();
    expect(stopTrack).not.toHaveBeenCalled();
  });
});
