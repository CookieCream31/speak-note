import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSonioxResponse, SonioxTranscriptAccumulator, startSonioxSpeechStream } from "./soniox-speech-stream";
import { createPcmAudioInput } from "./pcm-audio-input";

const pcm = vi.hoisted(() => ({ callback: null as ((buffer: ArrayBuffer, capturedStartMs: number) => void) | null, start: vi.fn(), close: vi.fn() }));
vi.mock("./pcm-audio-input", () => ({ createPcmAudioInput: vi.fn(async (_: MediaStream, callback: (buffer: ArrayBuffer, capturedStartMs: number) => void) => { pcm.callback = callback; return { start: pcm.start, close: pcm.close }; }) }));

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
  it("preserves nonuniform token times and text while excluding drafts, translations and boundary whitespace", () => {
    const accumulator = new SonioxTranscriptAccumulator("timed", 1250);
    const at = (text: string, start_ms: number, end_ms: number, is_final = true) => ({ ...token(text, is_final), start_ms, end_ms });
    const draft = accumulator.accept({ tokens: [at("Hel", 100, 250), at("lo?", 300, 450, false)] });
    expect(draft.interims[0].words).toBeUndefined();
    const saved = accumulator.accept({ tokens: [
      at("lo", 300, 450), at("", 500, 500), at("  world.", 2000, 2200),
      { ...at("はい", 2800, 3000), confidence: undefined }, at(" ", 3050, 3050),
      { ...at("訳文", 3100, 3200), translation_status: "translation" },
    ], finished: true }).finals[0];
    expect(saved.text).toBe("Hello  world.はい");
    expect(saved.words).toEqual([
      { text: "Hel", start_ms: 1350, end_ms: 1500, confidence: 0.9 },
      { text: "lo", start_ms: 1550, end_ms: 1700, confidence: 0.9 },
      { text: "  world.", start_ms: 3250, end_ms: 3450, confidence: 0.9 },
      { text: "はい", start_ms: 4050, end_ms: 4250, confidence: null },
    ]);
    expect(saved.words?.map((word) => word.text).join("")).toBe(saved.text);
    expect(accumulator.flush()).toEqual([]);
  });
  it("keeps word timing inside each confirmed speaker and save boundary", () => {
    const accumulator = new SonioxTranscriptAccumulator("boundaries", 0);
    const response = accumulator.accept({ tokens: [
      { ...token(" First"), start_ms: 0, end_ms: 1000 },
      { ...token(" next"), start_ms: 10_100, end_ms: 10_200 },
      { ...token("別の話者", true, "2"), start_ms: 10_300, end_ms: 10_500 },
      token("保存しない途中", false, "3"),
    ], finished: true });
    expect(response.finals.map((row) => row.words)).toEqual([
      [{ text: "First", start_ms: 0, end_ms: 1000, confidence: 0.9 }],
      [{ text: "next", start_ms: 10_100, end_ms: 10_200, confidence: 0.9 }],
      [{ text: "別の話者", start_ms: 10_300, end_ms: 10_500, confidence: 0.9 }],
    ]);
  });
  it("replaces hypotheses, appends final subwords once, and keeps milliseconds", () => {
    const accumulator = new SonioxTranscriptAccumulator("stream", 2000);
    expect(accumulator.accept({ tokens: [token("Hel", false)] }).interims[0]?.text).toBe("Hel");
    expect(accumulator.accept({ tokens: [token("Hello", false)] }).interims[0]?.text).toBe("Hello");
    expect(accumulator.accept({ tokens: [token("Hel"), token("lo", false)] }).interims[0]?.text).toBe("Hello");
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
  it("splits every provisional speaker turn without saving hypotheses or reserving IDs", () => {
    const accumulator = new SonioxTranscriptAccumulator("drafts", 2000);
    const response = accumulator.accept({ tokens: [
      token("Hello", false), token(" there", false),
      token("こんにちは", false, "2"), token(" Again", false),
    ] });
    expect(response.interims.map((row) => [row.resultId, row.text, row.speakerLabel])).toEqual([
      ["drafts:0", "Hello there", "SONIOX_drafts_1"],
      ["drafts:1", "こんにちは", "SONIOX_drafts_2"],
      ["drafts:2", "Again", "SONIOX_drafts_1"],
    ]);
    expect(response.interims[0].startMs).toBe(2100);
    expect(response.finals).toEqual([]);
    expect(response.sourceResultIds.size).toBe(0);
    expect(accumulator.resultId).toBe("drafts:0");
    expect(accumulator.flush()).toEqual([]);
  });
  it("replaces speaker assignments and withdrawn words instead of accumulating stale draft blocks", () => {
    const accumulator = new SonioxTranscriptAccumulator("revisions", 0);
    accumulator.accept({ tokens: [token("Long initial phrase", false), token(" Second speaker", false, "2")] });
    const corrected = accumulator.accept({ tokens: [token("Short", false, "3"), token(" revision", false, "3")] });
    expect(corrected.interims).toEqual([expect.objectContaining({ resultId: "revisions:0", text: "Short revision", speakerLabel: "SONIOX_revisions_3" })]);
    expect(accumulator.accept({ tokens: [] }).interims).toEqual([]);
    expect(accumulator.flush()).toEqual([]);
  });
  it("keeps confirmed pending text separate from a new provisional speaker and preserves final IDs", () => {
    const accumulator = new SonioxTranscriptAccumulator("mixed", 0);
    const first = token("Hello");
    const mixed = accumulator.accept({ tokens: [first, token(" there", false), token("こんにちは", false, "2")] });
    expect(mixed.interims.map((row) => [row.resultId, row.text])).toEqual([["mixed:0", "Hello there"], ["mixed:1", "こんにちは"]]);
    expect(mixed.finals).toEqual([]);
    expect(mixed.sourceResultIds.get(first)).toBe("mixed:0");
    const second = token("こんにちは", true, "2");
    const finalized = accumulator.accept({ tokens: [token(" there"), second], finished: true });
    expect(finalized.finals.map((row) => [row.resultId, row.text])).toEqual([["mixed:0", "Hello there"], ["mixed:1", "こんにちは"]]);
    expect(finalized.sourceResultIds.get(second)).toBe("mixed:1");
    expect(finalized.interims).toEqual([]);
    expect(accumulator.flush()).toEqual([]);
  });
  it("keeps unknown speakers and translation/control tokens out of other speakers' drafts", () => {
    const accumulator = new SonioxTranscriptAccumulator("unknown", 0);
    const result = accumulator.accept({ tokens: [
      { ...token("不明", false), speaker: undefined }, token("既知", false, "2"),
      { ...token("訳文", false), translation_status: "translation" }, { text: "<end>", is_final: false },
    ] });
    expect(result.interims.map((row) => [row.text, row.speakerLabel])).toEqual([["不明", "SPEAKER_UNKNOWN"], ["既知", "SONIOX_unknown_2"]]);
    expect(result.finals).toEqual([]);
  });
  it("discards all provisional speakers on finished and saves only previously confirmed tokens", () => {
    const accumulator = new SonioxTranscriptAccumulator("finished", 0);
    accumulator.accept({ tokens: [token("保存する"), token("保存しない", false, "2"), token("別の途中", false, "3")] });
    const result = accumulator.accept({ tokens: [token("終了時も未確定", false, "2")], finished: true });
    expect(result.finals.map((row) => row.text)).toEqual(["保存する"]);
    expect(result.interims).toEqual([]);
    expect(accumulator.flush()).toEqual([]);
  });
  it.each([
    ["Capac", "itance"],
    ["I", "'m"],
    ["5", "nF"],
    ["café", "s"],
    ["при", "вет"],
    ["안녕", "하세요"],
    ["Hello", "."],
    ["Hello", ","],
  ])("keeps the word/punctuation %s + %s together across the ten-second save boundary", (head, tail) => {
    const accumulator = new SonioxTranscriptAccumulator("words", 2000);
    accumulator.accept({ tokens: [{ ...token(head), start_ms: 0, end_ms: 500 }] });
    const continuation = { ...token(tail), start_ms: 10_001, end_ms: 10_500 };
    const middle = accumulator.accept({ tokens: [continuation] });
    expect(middle.finals).toEqual([]);
    expect(middle.interims[0]?.text).toBe(head + tail);
    expect(middle.sourceResultIds.get(continuation)).toBe("words:0");
    const next = { ...token(" Next word."), start_ms: 11_000, end_ms: 11_500 };
    const split = accumulator.accept({ tokens: [next] });
    expect(split.finals).toEqual([expect.objectContaining({ resultId: "words:0", text: head + tail, startMs: 2000, endMs: 12_500 })]);
    expect(split.interims[0]?.text).toBe("Next word.");
    expect(split.sourceResultIds.get(next)).toBe("words:1");
    expect(accumulator.flush().map((result) => result.text)).toEqual(["Next word."]);
    expect(accumulator.flush()).toEqual([]);
  });
  it("still separates final speakers and stop results when a word boundary is unavailable", () => {
    const accumulator = new SonioxTranscriptAccumulator("speakers", 0);
    accumulator.accept({ tokens: [{ ...token("Capac"), start_ms: 0, end_ms: 500 }] });
    const split = accumulator.accept({ tokens: [{ ...token("itance", true, "2"), start_ms: 10_001, end_ms: 10_500 }] });
    expect(split.finals[0]).toMatchObject({ text: "Capac", speakerLabel: "SONIOX_speakers_1" });
    expect(accumulator.flush()[0]).toMatchObject({ text: "itance", speakerLabel: "SONIOX_speakers_2" });
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
    pcm.callback = null; pcm.start.mockReset(); pcm.close.mockReset();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ api_key: "temporary-key", model: "stt-rt-v5", language: "ja" }) })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function start() {
    const onResult = vi.fn(), onInterims = vi.fn(), onError = vi.fn(), onTranslation = vi.fn();
    const promise = startSonioxSpeechStream({ tokenUrl: "/soniox-token", audioStream: {} as MediaStream, getTimelinePositionMs: () => 3000, onResult, onInterims, onError, onTranslation });
    await tick();
    const socket = FakeSocket.instances[0]; socket.open(); await tick();
    const controller = await promise;
    return { socket, controller, onResult, onInterims, onError, onTranslation };
  }
  it("streams originals and translations independently and retains the saved translation config after reconnect", async () => {
    const translation = { type: "one_way", target_language: "ja" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ api_key: "temporary", model: "stt-rt-v5", language: "en", translation }) })));
    const { socket, controller, onResult, onTranslation } = await start();
    expect(JSON.parse(socket.sent[0] as string).translation).toEqual(translation);
    socket.receive({ tokens: [token("Hello"), { text: "こんにちは", is_final: true, translation_status: "translation", language: "ja", source_language: "en", speaker: "1" }] });
    socket.close();
    expect(onResult.mock.calls[0][0].text).toBe("Hello");
    expect(onTranslation.mock.calls[0][0]).toMatchObject({ text: "こんにちは", speakerLabel: "SPEAKER_UNKNOWN" });
    expect(onTranslation.mock.calls[1][0].speakerLabel).toBe(onResult.mock.calls[0][0].speakerLabel);
    expect(onTranslation.mock.calls[0][0].sourceResultId).toBe(onResult.mock.calls[0][0].resultId);
    expect(onTranslation.mock.calls[0][0]).not.toHaveProperty("startMs");
    await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    expect(JSON.parse(next.sent[0] as string).translation).toEqual(translation);
    await controller.stop();
    expect(onTranslation).toHaveBeenCalledTimes(2);
    expect(onTranslation.mock.calls.map((call) => call[1])).toEqual([false, true]);
  });
  it("authenticates with a temporary protocol key, streams PCM, and drains with empty TEXT", async () => {
    const { socket, controller, onResult } = await start();
    expect(socket.url).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(socket.protocols).toEqual(["soniox-api-key", "temporary-key"]);
    const config = JSON.parse(socket.sent[0] as string);
    expect(config).toMatchObject({ audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, enable_speaker_diarization: true, enable_endpoint_detection: false });
    expect(config.api_key).toBeUndefined();
    const buffer = new ArrayBuffer(3200); pcm.callback?.(buffer, 3000);
    expect(socket.sent[1]).toBe(buffer);
    socket.receive({ tokens: [token("確定する発言")] });
    await controller.stop();
    expect(socket.sent.at(-1)).toBe("");
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].startMs).toBe(3100);
    expect(onResult.mock.calls[0][0].speakerLabel).toBe("話者 1");
    expect(pcm.close).toHaveBeenCalledOnce();
    await controller.stop();
    expect(onResult).toHaveBeenCalledOnce();
  });
  it("uses capture timestamps instead of message receipt time or an assumed 100ms frame, including reconnect", async () => {
    const { socket, controller, onResult } = await start();
    pcm.callback?.(new ArrayBuffer(320), 1250);
    await vi.advanceTimersByTimeAsync(5000);
    socket.receive({ tokens: [token("最初の発言")], finished: true });
    expect(onResult.mock.calls[0][0]).toMatchObject({ startMs: 1350, endMs: 1750 });
    expect(onResult.mock.calls[0][0].words[0]).toMatchObject({ start_ms: 1350, end_ms: 1750 });
    await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    pcm.callback?.(new ArrayBuffer(3200), 25_000);
    next.receive({ tokens: [token("再接続後の発言")], finished: true });
    expect(onResult.mock.calls[1][0]).toMatchObject({ startMs: 25_100, endMs: 25_500 });
    expect(onResult.mock.calls[1][0].words[0]).toMatchObject({ start_ms: 25_100, end_ms: 25_500 });
    await controller.stop();
  });
  it("prepares deferred PCM without starting it until recording is activated", async () => {
    const getTimelinePositionMs = vi.fn(() => 0);
    const promise = startSonioxSpeechStream({ tokenUrl: "/soniox-token", audioStream: {} as MediaStream,
      deferAudioStart: true, getTimelinePositionMs, onResult: vi.fn(), onError: vi.fn() });
    await tick(); FakeSocket.instances[0].open(); await tick();
    const controller = await promise;
    expect(createPcmAudioInput).toHaveBeenLastCalledWith(expect.anything(), expect.any(Function), { deferStart: true, getTimelinePositionMs });
    expect(pcm.start).not.toHaveBeenCalled();
    controller.startAudio();
    expect(pcm.start).toHaveBeenCalledOnce();
    await controller.stop();
    controller.startAudio();
    expect(pcm.start).toHaveBeenCalledOnce();
  });
  it("reconnects with a fresh single-use key and does not duplicate finalized text", async () => {
    const { socket, controller, onResult } = await start();
    socket.receive({ tokens: [token("残す発言")] }); socket.close();
    expect(onResult).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    expect(JSON.parse(next.sent[0] as string).enable_endpoint_detection).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    next.receive({ tokens: [token("次の発言"), { text: "<end>", is_final: true }] });
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[0][0].resultId).not.toBe(onResult.mock.calls[1][0].resultId);
    expect(onResult.mock.calls[1][0].speakerLabel).toBe("話者 2");
    await controller.stop();
  });
  it("does not allocate speakers from changing hypotheses and reuses only previously confirmed labels", async () => {
    const { socket, controller, onResult, onInterims } = await start();
    socket.receive({ tokens: [token("途中", false, "1")] });
    socket.receive({ tokens: [token("別の途中", false, "9")] });
    expect(onInterims.mock.calls.map((call) => call[0][0].speakerLabel)).toEqual(["SPEAKER_UNKNOWN", "SPEAKER_UNKNOWN"]);
    socket.receive({ tokens: [token("最初の確定", true, "2")], finished: true });
    expect(onResult.mock.calls[0][0].speakerLabel).toBe("話者 1");
    await controller.stop();
  });
  it("publishes complete speaker draft snapshots and clears withdrawn blocks without saving them", async () => {
    const { socket, controller, onResult, onInterims } = await start();
    socket.receive({ tokens: [token("最初の確定"), { text: "<end>", is_final: true }] });
    socket.receive({ tokens: [token("話者1の途中", false), token("新しい話者の途中", false, "9")] });
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([
      expect.objectContaining({ text: "話者1の途中", speakerLabel: "話者 1" }),
      expect.objectContaining({ text: "新しい話者の途中", speakerLabel: "SPEAKER_UNKNOWN" }),
    ]);
    socket.receive({ tokens: [token("訂正された途中", false, "2")] });
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([expect.objectContaining({ text: "訂正された途中", speakerLabel: "SPEAKER_UNKNOWN" })]);
    socket.receive({ tokens: [] });
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([]);
    expect(onResult).toHaveBeenCalledOnce();
    socket.receive({ tokens: [token("次の確定", true, "2")], finished: true });
    expect(onResult.mock.calls[1][0].speakerLabel).toBe("話者 2");
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([]);
    await controller.stop();
    expect(onResult).toHaveBeenCalledTimes(2);
  });
  it("clears all provisional speakers on disconnect, ignores stale responses and scopes new drafts to reconnect", async () => {
    const { socket, controller, onResult, onInterims } = await start();
    socket.receive({ tokens: [token("古い途中", false), token("別の途中", false, "2")] });
    const oldId = onInterims.mock.calls.at(-1)![0][0].resultId;
    socket.close();
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    next.receive({ tokens: [token("新しい途中", false)] });
    expect(onInterims.mock.calls.at(-1)![0][0].resultId).not.toBe(oldId);
    const calls = onInterims.mock.calls.length;
    socket.receive({ tokens: [token("遅れて届いた古い結果")], finished: true });
    socket.close();
    expect(onInterims).toHaveBeenCalledTimes(calls);
    await controller.stop();
    expect(onInterims.mock.calls.at(-1)![0]).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
  });
  it("shares confirmed original and translation labels without counting provisional translation speakers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ api_key: "temporary", model: "stt-rt-v5", language: "en", translation: { type: "one_way", target_language: "ja" } }) })));
    const { socket, controller, onResult, onInterims, onTranslation } = await start();
    const translated = (text: string, is_final: boolean, speaker: string) => ({ text, is_final, speaker, translation_status: "translation", language: "ja", source_language: "en" });
    socket.receive({ tokens: [translated("変わる話者", false, "99")] });
    expect(onTranslation.mock.calls[0][0].speakerLabel).toBe("SPEAKER_UNKNOWN");
    socket.receive({ tokens: [token("Hello", true, "2"), token("Next", true, "3"), translated("こんにちは", false, "2")] });
    expect(onResult.mock.calls[0][0].speakerLabel).toBe("話者 1");
    expect(onTranslation.mock.calls.at(-1)![0].speakerLabel).toBe("話者 1");
    socket.receive({ tokens: [token("続きの途中", false, "3")] });
    expect(onInterims.mock.calls.at(-1)![0][0].speakerLabel).toBe("SPEAKER_UNKNOWN");
    socket.receive({ tokens: [translated("次の話者", true, "3")], finished: true });
    expect(onResult.mock.calls[1][0].speakerLabel).toBe("話者 2");
    expect(onTranslation.mock.calls.at(-1)![0].speakerLabel).toBe("話者 2");
    await controller.stop();
  });
  it("keeps naturally finalized speech and drafts flowing without endpoints or forced finalize requests", async () => {
    const { socket, controller, onResult, onInterims } = await start();
    socket.receive({ tokens: [token("未確定", false)] });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(onResult).not.toHaveBeenCalled();
    expect(onInterims.mock.calls[0][0][0].text).toBe("未確定");
    const confirmed = { ...token("確定部分"), start_ms: 0, end_ms: 500 };
    socket.receive({ tokens: [confirmed, token(" 途中", false)] });
    socket.receive({ tokens: [{ ...token("続き"), start_ms: 10_001, end_ms: 10_500 }, token(" 最後の途中", false)] });
    expect(onResult.mock.calls[0][0]).toMatchObject({ text: "確定部分", speakerLabel: "話者 1" });
    expect(onInterims.mock.calls.at(-1)![0][0].text).toBe("続き 最後の途中");
    await controller.stop();
    expect(onResult.mock.calls.map((call) => call[0].text)).toEqual(["確定部分", "続き"]);
    expect(socket.sent.filter((value) => typeof value === "string" && value !== "").map((value) => JSON.parse(value as string).type)).not.toContain("finalize");
  });
  it.each([
    { hints: ["ja", "en"], strict: true },
    { hints: [], strict: false },
  ])("uses session language options on every connection: $hints", async ({ hints, strict }) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ api_key: "temporary", model: "stt-rt-v5", language: "auto", language_hints: hints, language_hints_strict: strict }) })));
    const { socket, controller } = await start();
    const first = JSON.parse(socket.sent[0] as string);
    expect(first.language_hints).toEqual(hints.length ? hints : undefined);
    expect(first.language_hints_strict).toBe(strict);
    socket.close(); await vi.advanceTimersByTimeAsync(1000); await tick();
    const next = FakeSocket.instances[1]; next.open(); await tick();
    expect(JSON.parse(next.sent[0] as string)).toMatchObject({ language_hints_strict: strict });
    expect(JSON.parse(next.sent[0] as string).language_hints).toEqual(hints.length ? hints : undefined);
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
  it("reports unsupported language options before connecting or sending audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ detail: "選択したSonioxモデルはStrict language hintsに対応していません" }) })));
    await expect(startSonioxSpeechStream({ tokenUrl: "/soniox-token", audioStream: {} as MediaStream, onResult: vi.fn(), onError: vi.fn() })).rejects.toThrow("Strict language hintsに対応していません");
    expect(FakeSocket.instances).toHaveLength(0);
    expect(pcm.callback).toBeNull();
  });
});
