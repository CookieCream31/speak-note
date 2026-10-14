import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveTranscriptStore, getLiveTranscriptStore } from "./live-transcript-store";
import {
  publishLiveTranscriptEvent, subscribeLiveTranscriptEvent, type LiveTranscriptUpsertDetail,
} from "./live-transcript-events";

afterEach(() => { vi.unstubAllGlobals(); });

function result(overrides: Partial<LiveTranscriptUpsertDetail> = {}): LiveTranscriptUpsertDetail {
  return {
    type: "upsert", meetingId: "meeting", resultId: "phrase-1",
    startMs: 0, endMs: 1_000, text: "最初の文", confidence: null,
    speakerLabel: "SPEAKER_00", isFinal: false, ...overrides,
  };
}

describe("live transcript snapshots", () => {
  it("retains confirmed word times before the persistence ACK and never replaces them with late drafts", () => {
    const store = createLiveTranscriptStore();
    const words = [{ text: "最初", start_ms: 100, end_ms: 250, confidence: 0.9 }, { text: " 次", start_ms: 800, end_ms: 900, confidence: null }];
    store.accept(result({ text: "最初 次", words, isFinal: true }));
    expect(store.getHistory()[0].words).toEqual(words.map((word, sequence) => ({ ...word, sequence, speaker_id: null, id: `phrase-1:word:${sequence}` })));
    const savedWords = store.getHistory()[0].words;
    store.accept(result({ text: "遅れた途中結果" }));
    store.accept({ type: "persisted", meetingId: "meeting", resultId: "phrase-1", segmentId: "db-1" });
    expect(store.getHistory()[0].words).toBe(savedWords);
  });
  it("replaces all speaker drafts atomically, including corrections, withdrawal and empty snapshots", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ resultId: "saved", isFinal: true }));
    const history = store.getHistory();
    const listener = vi.fn();
    store.subscribe(listener);
    store.accept({ type: "replace-interims", meetingId: "meeting", results: [
      result({ resultId: "a", text: "話者1の途中" }), result({ resultId: "b", text: "話者2の途中", speakerLabel: "SPEAKER_01" }),
    ] });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot().interims.map((row) => row.text)).toEqual(["話者1の途中", "話者2の途中"]);
    store.accept({ type: "replace-interims", meetingId: "meeting", results: [result({ resultId: "a", text: "短い訂正", speakerLabel: "SPEAKER_02" })] });
    expect(store.getInterims()).toEqual([expect.objectContaining({ id: "a", text: "短い訂正", provisional_speaker_label: "SPEAKER_02", isFinal: false })]);
    store.accept({ type: "replace-interims", meetingId: "meeting", results: [] });
    expect(store.getInterims()).toEqual([]);
    expect(store.getHistory()).toBe(history);
    expect(listener).toHaveBeenCalledTimes(3);
  });
  it("finalizes one draft without dropping other speakers and ignores late drafts for saved IDs", () => {
    const store = createLiveTranscriptStore();
    store.accept({ type: "replace-interims", meetingId: "meeting", results: [result(), result({ resultId: "next", text: "次の話者" })] });
    store.accept(result({ isFinal: true }));
    expect(store.getInterims().map((row) => row.id)).toEqual(["next"]);
    store.accept({ type: "persisted", meetingId: "meeting", resultId: "phrase-1", segmentId: "db-1" });
    store.accept({ type: "replace-interims", meetingId: "meeting", results: [result({ text: "古い途中" }), result({ resultId: "next", text: "次の訂正" })] });
    expect(store.getInterims().map((row) => row.text)).toEqual(["次の訂正"]);
    expect(store.getHistory()).toEqual([expect.objectContaining({ text: "最初の文", persistedId: "db-1" })]);
    store.accept({ type: "reset", meetingId: "meeting" });
    expect(store.getSnapshot()).toEqual({ history: [], interims: [] });
  });
  it("publishes to the store before DOM listeners and retains events before the panel mounts", () => {
    vi.stubGlobal("window", new EventTarget());
    const store = getLiveTranscriptStore("event-meeting");
    const unsubscribe = subscribeLiveTranscriptEvent((detail) => {
      if (detail.type === "upsert") expect(store.getInterims()[0]?.text).toBe(detail.text);
    });
    publishLiveTranscriptEvent(result({ meetingId: "event-meeting", text: "Mount前の発話" }));
    unsubscribe();
    expect(store.getInterims()[0]?.text).toBe("Mount前の発話");
    publishLiveTranscriptEvent(result({ meetingId: "event-meeting", isFinal: true }));
    expect(store.getHistory()).toHaveLength(1);
    expect(store.getInterims()).toEqual([]);
  });

  it("updates only the draft for hundreds of changing hypotheses", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ resultId: "earlier", isFinal: true }));
    const history = store.getHistory();
    const historyListener = vi.fn();
    const interimListener = vi.fn();
    store.subscribeHistory(historyListener);
    store.subscribeInterim(interimListener);
    for (let i = 0; i < 500; i += 1) {
      store.accept(result({ text: "修正された文" + i, speakerLabel: "SPEAKER_" + (i % 3) }));
    }
    expect(historyListener).not.toHaveBeenCalled();
    expect(interimListener).toHaveBeenCalledTimes(500);
    expect(store.getHistory()).toBe(history);
    expect(store.getInterims()[0]?.text).toBe("修正された文499");
  });

  it("replaces hypotheses including shorter revisions, without concatenating them", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ text: "仮の長い文章です" }));
    store.accept(result({ text: "短い訂正" }));
    store.accept(result({ text: "" }));
    expect(store.getInterims()[0]?.text).toBe("短い訂正");
    expect(store.getHistory()).toHaveLength(0);
  });

  it("commits history and clears the draft atomically; late partials cannot undo it", () => {
    const store = createLiveTranscriptStore();
    store.accept(result());
    const check = vi.fn(() => {
      expect(store.getHistory()).toHaveLength(1);
      expect(store.getHistory()[0].text).toBe("確定した文。");
      expect(store.getInterims()).toEqual([]);
    });
    store.subscribeHistory(check);
    store.subscribeInterim(check);
    store.accept(result({ text: "確定した文。", isFinal: true }));
    const history = store.getHistory();
    store.accept(result({ text: "遅延した仮説" }));
    store.accept(result({ text: "確定した文。", isFinal: true }));
    expect(store.getHistory()).toBe(history);
    expect(store.getInterims()).toEqual([]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("preserves the next draft when an earlier final arrives", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ resultId: "second", text: "次の発話" }));
    store.accept(result({ resultId: "first", isFinal: true }));
    expect(store.getInterims()[0]?.id).toBe("second");
    expect(store.getHistory()).toHaveLength(1);
  });

  it("handles save acknowledgements before and after finalization", () => {
    const store = createLiveTranscriptStore();
    store.accept({ type: "persisted", meetingId: "meeting", resultId: "phrase-1", segmentId: "db-1" });
    store.accept(result({ isFinal: true }));
    expect(store.getHistory()[0].persistedId).toBe("db-1");
    store.accept(result({ resultId: "phrase-2", isFinal: true }));
    store.accept({ type: "persisted", meetingId: "meeting", resultId: "phrase-2", segmentId: "db-2" });
    expect(store.getHistory()[1].persistedId).toBe("db-2");
  });

  it("retains speech across subscriptions and keeps meetings isolated", () => {
    const store = getLiveTranscriptStore("retained-meeting");
    const listener = vi.fn();
    const unsubscribe = store.subscribeInterim(listener);
    store.accept(result());
    unsubscribe();
    store.accept(result({ text: "切替後も残す" }));
    expect(listener).toHaveBeenCalledOnce();
    expect(getLiveTranscriptStore("retained-meeting").getInterims()[0]?.text).toBe("切替後も残す");
    expect(getLiveTranscriptStore("different-meeting").getInterims()).toEqual([]);
    store.accept(result({ isFinal: true }));
    store.accept({ type: "reset", meetingId: "retained-meeting" });
    expect(store.getHistory()).toHaveLength(0);
    expect(store.getInterims()).toEqual([]);
    store.accept(result());
    expect(store.getInterims()[0]?.id).toBe("phrase-1");
  });

  it("keeps 100 alternating speaker phrases in order without duplicated hypotheses", () => {
    const store = createLiveTranscriptStore();
    for (let phrase = 0; phrase < 100; phrase += 1) {
      for (let revision = 0; revision < 20; revision += 1) {
        store.accept(result({
          resultId: "p" + phrase, text: "仮説" + revision,
          speakerLabel: "SPEAKER_" + (revision % 2),
        }));
      }
      store.accept(result({
        resultId: "p" + phrase, text: "発言" + phrase,
        speakerLabel: "SPEAKER_" + (phrase % 2), isFinal: true,
      }));
    }
    expect(store.getHistory().map((segment) => segment.text)).toEqual(
      Array.from({ length: 100 }, (_, i) => "発言" + i),
    );
    expect(store.getInterims()).toEqual([]);
  });

  it("clears a withdrawn Soniox draft without removing a newer draft or saved history", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ resultId: "saved", isFinal: true }));
    store.accept(result({ resultId: "old" }));
    store.accept({ type: "clear-interim", meetingId: "meeting", resultId: "old" });
    expect(store.getInterims()).toEqual([]);
    store.accept(result({ resultId: "new" }));
    store.accept({ type: "clear-interim", meetingId: "meeting", resultId: "old" });
    expect(store.getInterims()[0]?.id).toBe("new");
    expect(store.getHistory()).toHaveLength(1);
  });
});
