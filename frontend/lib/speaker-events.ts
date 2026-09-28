export const SPEAKER_RENAMED_EVENT = "speak-note:speaker-renamed";

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
