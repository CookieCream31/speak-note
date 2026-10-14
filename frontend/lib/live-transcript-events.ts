import { getLiveTranscriptStore } from "./live-transcript-store";

export const LIVE_TRANSCRIPT_EVENT = "speak-note:live-transcript";

export interface LiveTranscriptResult {
  resultId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  speakerLabel: string;
}

export interface LiveTranscriptUpsertDetail extends LiveTranscriptResult {
  type: "upsert";
  meetingId: string;
  isFinal: boolean;
}

export interface LiveTranscriptPersistedDetail {
  type: "persisted";
  meetingId: string;
  resultId: string;
  segmentId: string;
}

export type LiveTranscriptEventDetail =
  | LiveTranscriptUpsertDetail
  | LiveTranscriptPersistedDetail
  | { type: "replace-interims"; meetingId: string; results: LiveTranscriptResult[] }
  | { type: "clear-interim"; meetingId: string; resultId: string }
  | { type: "reset"; meetingId: string };

export function publishLiveTranscriptEvent(detail: LiveTranscriptEventDetail): void {
  getLiveTranscriptStore(detail.meetingId).accept(detail);
  window.dispatchEvent(new CustomEvent<LiveTranscriptEventDetail>(
    LIVE_TRANSCRIPT_EVENT,
    { detail },
  ));
}

export function subscribeLiveTranscriptEvent(
  listener: (detail: LiveTranscriptEventDetail) => void,
): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<LiveTranscriptEventDetail>).detail);
  };
  window.addEventListener(LIVE_TRANSCRIPT_EVENT, handleEvent);
  return () => window.removeEventListener(LIVE_TRANSCRIPT_EVENT, handleEvent);
}
