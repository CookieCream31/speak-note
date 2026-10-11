import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSonioxResponse, SonioxTranscriptAccumulator, startSonioxSpeechStream } from "./soniox-speech-stream";

const pcm = vi.hoisted(() => ({ callback: null as ((buffer: ArrayBuffer) => void) | null, close: vi.fn() }));
vi.mock("./pcm-audio-input", () => ({ createPcmAudioInput: vi.fn(async (_: MediaStream, callback: (buffer: ArrayBuffer) => void) => { pcm.callback = callback; return { close: pcm.close }; }) }));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (data === "") queueMicrotask(() => this.receive({ finished: true, tokens: [] }));
  }
}
const token = (text: string, is_final = true, speaker = "1") => ({ text, is_final, start_ms: 100, end_ms: 500, speaker, confidence: 0.9 });
async function tick() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }

describe("Soniox token assembly", () => {
  it("replaces hypotheses, appends final subwords once, and keeps milliseconds", () => {
    const accumulator = new SonioxTranscriptAccumulator("stream", 2000);
    expect(accumulator.accept({ tokens: [token("Hel", false)] }).interim?.text).toBe("Hel");
    expect(accumulator.accept({ tokens: [token("Hello", false)] }).interim?.text).toBe("Hello");
    expect(accumulator.accept({ tokens: [token("Hel"), token("lo", false)] }).interim?.text).toBe("Hello");
    const result = accumulator.accept({ tokens: [token("lo"), token(" world."), { text: "<end>", is_final: true }] });
    expect(result.finals[0]).toMatchObject({ resultId: "stream:0", text: "Hello world.", startMs: 2100, endMs: 2500 });
    expect(accumulator.flush()).toEqual([]);
  });
  it("splits speakers and scopes speaker IDs to the connection", () => {
    const accumulator = new SonioxTranscriptAccumulator("connection-2", 0);
    const result = accumulator.accept({ tokens: [token("はい"), token("了解", true, "2")], finished: true });
    expect(result.finals.map((item) => item.text)).toEqual(["はい", "了解"]);
    expect(result.finals.map((item) => item.speakerLabel)).toEqual(["SONIOX_connection-2_1", "SONIOX_connection-2_2"]);
    expect(new SonioxTranscriptAccumulator("connection-3", 0).accept({ tokens: [token("はい")], finished: true }).finals[0].speakerLabel).not.toBe(result.finals[0].speakerLabel);
  });
  it("excludes translation/control tokens and rejects invalid responses", () => {
    const accumulator = new SonioxTranscriptAccumulator("a", 0);
    expect(accumulator.accept({ tokens: [{ ...token("translated"), translation_status: "translation" }, { text: "<fin>", is_final: true }], finished: true }).finals).toEqual([]);
    expect(() => parseSonioxResponse(null)).toThrow();
    expect(() => parseSonioxResponse({ tokens: "oops" })).toThrow();
    expect(() => parseSonioxResponse({ tokens: [{ ...token("bad"), start_ms: -1 }] })).toThrow();
    expect(() => parseSonioxResponse({ tokens: [{ ...token("bad"), confidence: 2 }] })).toThrow();
  });
});

describe("Soniox streaming lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    pcm.callback = null; pcm.close.mockReset();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ api_key: "temporary-key", model: "stt-rt-v5", language: "ja" }) })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function start() {
    const onResult = vi.fn(), onInterim = vi.fn(), onError = vi.fn(), onInterimCleared = vi.fn();
    const promise = startSonioxSpeechStream({ tokenUrl: "/soniox-token", audioStream: {} as MediaStream, getTimelinePositionMs: () => 3000, onResult, onInterim, onError, onInterimCleared });
    await tick();
    const socket = FakeSocket.instances[0]; socket.open(); await tick();
    const controller = await promise;
    return { socket, controller, onResult, onInterim, onError, onInterimCleared };
  }
  it("authenticates with a temporary protocol key, streams PCM, and drains with empty TEXT", async () => {
    const { socket, controller, onResult } = await start();
    expect(socket.url).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(socket.protocols).toEqual(["soniox-api-key", "temporary-key"]);
    const config = JSON.parse(socket.sent[0] as string);
    expect(config).toMatchObject({ audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, enable_endpoint_detection: true });
    expect(config.api_key).toBeUndefined();
    const buffer = new ArrayBuffer(3200); pcm.callback?.(buffer);
    expect(socket.sent[1]).toBe(buffer);
    socket.receive({ tokens: [token("確定する発言")] });
    await controller.stop();
    expect(socket.sent.at(-1)).toBe("");
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].startMs).toBe(3000);
    expect(onResult.mock.calls[0][0].speakerLabel).toBe("話者 1");
    expect(pcm.close).toHaveBeenCalledOnce();
    await controller.stop();
    expect(onResult).toHaveBeenCalledOnce();
  });
  it("reconnects with a fresh single-use key and does not duplicate finalized text", async () => {
    const { socket, controller, onResult } = await start();
    socket.receive({ tokens: [token("残す発言")] }); socket.close();
    expect(onResult).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    next.receive({ tokens: [token("次の発言"), { text: "<end>", is_final: true }] });
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[0][0].resultId).not.toBe(onResult.mock.calls[1][0].resultId);
    expect(onResult.mock.calls[1][0].speakerLabel).toBe("話者 2");
    await controller.stop();
  });
  it("shows authentication errors and does not reconnect indefinitely", async () => {
    const { socket, controller, onError } = await start();
    socket.receive({ error_code: 401, error_message: "private secret" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(onError.mock.calls.flat().join("")).not.toContain("private secret");
    expect(onError).toHaveBeenCalled(); await controller.stop();
  });
});
