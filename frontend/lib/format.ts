import type { MeetingSourceType, MeetingStatus } from "./api";

export const sourceLabels: Record<MeetingSourceType, string> = {
  live: "画面共有",
  audio_recording: "録音",
  media_upload: "ファイル",
  video_upload: "動画",
  audio_upload: "音声",
};

export const statusLabels: Record<MeetingStatus, string> = {
  created: "準備中",
  recording: "録画中",
  uploading: "アップロード中",
  preprocessing: "前処理中",
  queued: "待機中",
  transcribing: "文字起こし中",
  analyzing: "AI解析中",
  completed: "完了",
  failed: "失敗",
};

export function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(new Date(isoDate));
}

