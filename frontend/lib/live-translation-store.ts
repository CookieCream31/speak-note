import type { LiveTranslation } from "./api";
import type { LiveTranslationResult } from "./soniox-translation";

const EMPTY = { history: [] as LiveTranslation[], interim: null as LiveTranslation | null };
export function createLiveTranslationStore() {
  let snapshot = EMPTY;
  const finalized = new Set<string>();
  const saved = new Set<string>();
  const listeners = new Set<() => void>();
  const update = (next: typeof EMPTY) => { snapshot = next; listeners.forEach((listener) => listener()); };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() { finalized.clear(); saved.clear(); update(EMPTY); },
    accept(result: LiveTranslationResult, isFinal: boolean) {
      if (!result.text.trim() || finalized.has(result.resultId)) return;
      const row: LiveTranslation = { id: result.resultId, result_id: result.resultId, sequence: snapshot.history.length,
        text: result.text, source_language: result.sourceLanguage, target_language: result.targetLanguage,
        speaker_label: result.speakerLabel, isFinal, saved: saved.has(result.resultId) };
      if (isFinal) {
        finalized.add(result.resultId);
        update({ history: [...snapshot.history, row], interim: snapshot.interim?.result_id === result.resultId ? null : snapshot.interim });
      } else update({ ...snapshot, interim: row });
    },
    clearInterim(resultId: string) {
      if (snapshot.interim?.result_id === resultId) update({ ...snapshot, interim: null });
    },
    markSaved(resultId: string) {
      saved.add(resultId);
      if (snapshot.history.some((row) => row.result_id === resultId && !row.saved)) update({ ...snapshot, history: snapshot.history.map((row) => row.result_id === resultId ? { ...row, saved: true, error: undefined } : row) });
    },
    markFailed(resultId: string, error: string) {
      if (snapshot.history.some((row) => row.result_id === resultId)) update({ ...snapshot, history: snapshot.history.map((row) => row.result_id === resultId ? { ...row, saved: false, error } : row) });
    },
  };
}
const stores = new Map<string, ReturnType<typeof createLiveTranslationStore>>();
export function getLiveTranslationStore(meetingId: string) {
  let store = stores.get(meetingId);
  if (!store) { store = createLiveTranslationStore(); stores.set(meetingId, store); }
  return store;
}
