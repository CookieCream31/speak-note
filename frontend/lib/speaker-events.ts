export const SPEAKER_RENAMED_EVENT = "speak-note:speaker-renamed";
export const LIVE_SPEAKER_RENAMED_EVENT = "speak-note:live-speaker-renamed";

export interface LiveSpeakerRenamedDetail {
  segmentIds: string[];
  speakerName: string;
}

export function dispatchLiveSpeakerRenamed(detail: LiveSpeakerRenamedDetail): void {
  window.dispatchEvent(new CustomEvent<LiveSpeakerRenamedDetail>(LIVE_SPEAKER_RENAMED_EVENT, {
    detail,
  }));
}

export function liveSpeakerRenamedDetail(event: Event): LiveSpeakerRenamedDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<LiveSpeakerRenamedDetail> | undefined;
  if (!detail || typeof detail.speakerName !== "string"
    || !Array.isArray(detail.segmentIds) || !detail.segmentIds.every((id) => typeof id === "string")) {
    return null;
  }
  return detail as LiveSpeakerRenamedDetail;
}

export interface SpeakerRenamedDetail {
  speakerId: string;
  displayName: string | null;
  speakerName: string;
}

export function dispatchSpeakerRenamed(detail: SpeakerRenamedDetail): void {
  window.dispatchEvent(new CustomEvent<SpeakerRenamedDetail>(SPEAKER_RENAMED_EVENT, {
    detail,
  }));
}

export function speakerRenamedDetail(event: Event): SpeakerRenamedDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<SpeakerRenamedDetail> | undefined;
  if (
    !detail
    || typeof detail.speakerId !== "string"
    || typeof detail.speakerName !== "string"
    || !(typeof detail.displayName === "string" || detail.displayName === null)
  ) {
    return null;
  }
  return detail as SpeakerRenamedDetail;
}
