import type { TranscriptSegment } from "./api";
import type { LiveTranscriptEventDetail } from "./live-transcript-events";

export interface StreamingTranscriptSegment extends TranscriptSegment {
  persistedId?: string;
  isFinal?: boolean;
}

const EMPTY_HISTORY: StreamingTranscriptSegment[] = [];
const EMPTY_SNAPSHOT = { history: EMPTY_HISTORY, interim: null as StreamingTranscriptSegment | null };

/** Hypotheses replace one draft; they never mutate the transcript history. */
export function createLiveTranscriptStore() {
  let history = EMPTY_HISTORY;
  let interim: StreamingTranscriptSegment | null = null;
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  const finalizedIds = new Set<string>();
  const persistedIds = new Map<string, string>();
  const historyListeners = new Set<() => void>();
  const interimListeners = new Set<() => void>();

  const subscribe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    getHistory: () => history,
    getInterim: () => interim,
    getServerHistory: () => EMPTY_HISTORY,
    getServerInterim: () => null,
    subscribeHistory: (listener: () => void) => subscribe(historyListeners, listener),
    subscribeInterim: (listener: () => void) => subscribe(interimListeners, listener),
    accept(detail: LiveTranscriptEventDetail) {
      const previousHistory = history;
      const previousInterim = interim;
      if (detail.type === "reset") {
        history = EMPTY_HISTORY;
        interim = null;
        finalizedIds.clear();
        persistedIds.clear();
      } else if (detail.type === "persisted") {
        persistedIds.set(detail.resultId, detail.segmentId);
        const index = history.findIndex((segment) => segment.id === detail.resultId);
        if (index >= 0 && history[index].persistedId !== detail.segmentId) {
          history = history.map((segment, position) => position === index
            ? { ...segment, persistedId: detail.segmentId }
            : segment);
        }
      } else {
        if (!detail.text.trim() || finalizedIds.has(detail.resultId)) return;
        const segment: StreamingTranscriptSegment = {
          id: detail.resultId,
          start_ms: detail.startMs,
          end_ms: detail.endMs,
          text: detail.text,
          confidence: detail.confidence,
          sequence: history.length,
          speaker: null,
          provisional_speaker_label: detail.speakerLabel,
          words: [],
          isFinal: detail.isFinal,
          persistedId: persistedIds.get(detail.resultId),
        };
        if (detail.isFinal) {
          finalizedIds.add(detail.resultId);
          history = [...history, segment];
          if (interim?.id === detail.resultId) interim = null;
        } else {
          // Azure returns the entire current hypothesis, not a text delta.
          interim = segment;
        }
      }
      // Both snapshots are committed before either notification. History already
      // contains the replacement when the draft is removed from the screen.
      if (history !== previousHistory || interim !== previousInterim) {
        snapshot = { history, interim };
        listeners.forEach((listener) => listener());
      }
      if (history !== previousHistory) historyListeners.forEach((listener) => listener());
      if (interim !== previousInterim) interimListeners.forEach((listener) => listener());
    },
  };
}

const stores = new Map<string, ReturnType<typeof createLiveTranscriptStore>>();

export function getLiveTranscriptStore(meetingId: string) {
  let store = stores.get(meetingId);
  if (!store) {
    store = createLiveTranscriptStore();
    stores.set(meetingId, store);
  }
  return store;
}
