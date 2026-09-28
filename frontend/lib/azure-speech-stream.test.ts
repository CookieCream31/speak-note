import { describe, expect, it } from "vitest";

import {
  azureRecognitionConfidence,
  azureTicksToMilliseconds,
  resampleToPcm16Mono,
} from "./azure-speech-stream";

describe("Azure Speech streaming helpers", () => {
  it("converts Azure 100ns ticks to integer milliseconds", () => {
    expect(azureTicksToMilliseconds(12_345_678)).toBe(1235);
    expect(azureTicksToMilliseconds(-1)).toBe(0);
  });

  it("converts browser float audio to 16-bit mono PCM", () => {
    const pcm = resampleToPcm16Mono(new Float32Array([-1, 0, 1]), 16_000);
    const view = new DataView(pcm);

    expect(pcm.byteLength).toBe(6);
    expect(view.getInt16(0, true)).toBe(-32_768);
    expect(view.getInt16(2, true)).toBe(0);
    expect(view.getInt16(4, true)).toBe(32_767);
    expect(resampleToPcm16Mono(new Float32Array(480), 48_000).byteLength).toBe(320);
  });

  it("reads confidence from a detailed recognition result safely", () => {
    expect(azureRecognitionConfidence('{"NBest":[{"Confidence":0.93}]}')).toBe(0.93);
    expect(azureRecognitionConfidence('{"NBest":[{"Confidence":2}]}')).toBeNull();
    expect(azureRecognitionConfidence("invalid-json")).toBeNull();
  });
});
