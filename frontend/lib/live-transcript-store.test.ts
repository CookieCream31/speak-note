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
  it("publishes to the store before DOM listeners and retains events before the panel mounts", () => {
    vi.stubGlobal("window", new EventTarget());
    const store = getLiveTranscriptStore("event-meeting");
    const unsubscribe = subscribeLiveTranscriptEvent((detail) => {
      if (detail.type === "upsert") expect(store.getInterim()?.text).toBe(detail.text);
    });
    publishLiveTranscriptEvent(result({ meetingId: "event-meeting", text: "Mount前の発話" }));
    unsubscribe();
    expect(store.getInterim()?.text).toBe("Mount前の発話");
    publishLiveTranscriptEvent(result({ meetingId: "event-meeting", isFinal: true }));
    expect(store.getHistory()).toHaveLength(1);
    expect(store.getInterim()).toBeNull();
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
    expect(store.getInterim()?.text).toBe("修正された文499");
  });

  it("replaces hypotheses including shorter revisions, without concatenating them", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ text: "仮の長い文章です" }));
    store.accept(result({ text: "短い訂正" }));
    store.accept(result({ text: "" }));
    expect(store.getInterim()?.text).toBe("短い訂正");
    expect(store.getHistory()).toHaveLength(0);
  });

  it("commits history and clears the draft atomically; late partials cannot undo it", () => {
    const store = createLiveTranscriptStore();
    store.accept(result());
    const check = vi.fn(() => {
      expect(store.getHistory()).toHaveLength(1);
      expect(store.getHistory()[0].text).toBe("確定した文。");
      expect(store.getInterim()).toBeNull();
    });
    store.subscribeHistory(check);
    store.subscribeInterim(check);
    store.accept(result({ text: "確定した文。", isFinal: true }));
    const history = store.getHistory();
    store.accept(result({ text: "遅延した仮説" }));
    store.accept(result({ text: "確定した文。", isFinal: true }));
    expect(store.getHistory()).toBe(history);
    expect(store.getInterim()).toBeNull();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("preserves the next draft when an earlier final arrives", () => {
    const store = createLiveTranscriptStore();
    store.accept(result({ resultId: "second", text: "次の発話" }));
    store.accept(result({ resultId: "first", isFinal: true }));
    expect(store.getInterim()?.id).toBe("second");
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
    expect(getLiveTranscriptStore("retained-meeting").getInterim()?.text).toBe("切替後も残す");
    expect(getLiveTranscriptStore("different-meeting").getInterim()).toBeNull();
    store.accept(result({ isFinal: true }));
    store.accept({ type: "reset", meetingId: "retained-meeting" });
    expect(store.getHistory()).toHaveLength(0);
    expect(store.getInterim()).toBeNull();
    store.accept(result());
    expect(store.getInterim()?.id).toBe("phrase-1");
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
    expect(store.getInterim()).toBeNull();
  });
});
