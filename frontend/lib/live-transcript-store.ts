import type { TranscriptSegment } from "./api";
import type { LiveTranscriptEventDetail, LiveTranscriptResult } from "./live-transcript-events";

export interface StreamingTranscriptSegment extends TranscriptSegment {
  persistedId?: string;
  isFinal?: boolean;
}

const EMPTY_HISTORY: StreamingTranscriptSegment[] = [];
const EMPTY_INTERIMS: StreamingTranscriptSegment[] = [];
const EMPTY_SNAPSHOT = { history: EMPTY_HISTORY, interims: EMPTY_INTERIMS };

/** Each hypothesis snapshot replaces all drafts; history is never rewritten. */
export function createLiveTranscriptStore() {
  let history = EMPTY_HISTORY;
  let interims = EMPTY_INTERIMS;
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  const finalizedIds = new Set<string>();
  const persistedIds = new Map<string, string>();
  const historyListeners = new Set<() => void>();
  const interimListeners = new Set<() => void>();

  const segmentFrom = (result: LiveTranscriptResult, isFinal: boolean): StreamingTranscriptSegment => ({
    id: result.resultId,
    start_ms: result.startMs,
    end_ms: result.endMs,
    text: result.text,
    confidence: result.confidence,
    sequence: history.length,
    speaker: null,
    provisional_speaker_label: result.speakerLabel,
    words: (result.words ?? []).map((word, sequence) => ({
      ...word, id: `${result.resultId}:word:${sequence}`, sequence, speaker_id: null,
    })),
    isFinal,
    persistedId: persistedIds.get(result.resultId),
  });

  const subscribe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    getHistory: () => history,
    getInterims: () => interims,
    getServerHistory: () => EMPTY_HISTORY,
    getServerInterims: () => EMPTY_INTERIMS,
    subscribeHistory: (listener: () => void) => subscribe(historyListeners, listener),
    subscribeInterim: (listener: () => void) => subscribe(interimListeners, listener),
    accept(detail: LiveTranscriptEventDetail) {
      const previousHistory = history;
      const previousInterims = interims;
      if (detail.type === "reset") {
        history = EMPTY_HISTORY;
        interims = EMPTY_INTERIMS;
        finalizedIds.clear();
        persistedIds.clear();
      } else if (detail.type === "clear-interim") {
        if (interims.some((segment) => segment.id === detail.resultId)) {
          interims = interims.filter((segment) => segment.id !== detail.resultId);
        }
      } else if (detail.type === "replace-interims") {
        interims = detail.results
          .filter((result) => result.text.trim() && !finalizedIds.has(result.resultId))
          .map((result) => segmentFrom(result, false));
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
        const segment = segmentFrom(detail, detail.isFinal);
        if (detail.isFinal) {
          finalizedIds.add(detail.resultId);
          history = [...history, segment];
          if (interims.some((draft) => draft.id === detail.resultId)) {
            interims = interims.filter((draft) => draft.id !== detail.resultId);
          }
        } else {
          // Azure returns the entire current hypothesis, not a text delta.
          interims = [segment];
        }
      }
      // Both snapshots are committed before either notification. History already
      // contains the replacement when the draft is removed from the screen.
      if (history !== previousHistory || interims !== previousInterims) {
        snapshot = { history, interims };
        listeners.forEach((listener) => listener());
      }
      if (history !== previousHistory) historyListeners.forEach((listener) => listener());
      if (interims !== previousInterims) interimListeners.forEach((listener) => listener());
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
