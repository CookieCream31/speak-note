import type { AnalysisVersion, TimelineMarker } from "@/lib/api";

export interface PlaybackChapterData {
  id: string;
  title: string;
  startMs: number;
  endMs: number | null;
}

function validTitle(title: string): boolean {
  return title.trim().length > 0;
}

function ordered(chapters: PlaybackChapterData[]): PlaybackChapterData[] {
  return chapters.sort((left, right) => left.startMs - right.startMs);
}

export function resolvePlaybackChapters(
  displayedAnalysis: AnalysisVersion | null,
  timeline: TimelineMarker[],
): PlaybackChapterData[] {
  const selectedChapters = (displayedAnalysis?.items ?? [])
    .filter(
      (item) => item.kind === "chapter"
        && item.start_ms !== null
        && Number.isFinite(item.start_ms)
        && item.start_ms >= 0
        && validTitle(item.content),
    )
    .map((item) => ({
      id: item.id,
      title: item.content,
      startMs: item.start_ms as number,
      endMs: item.end_ms,
    }));

  if (displayedAnalysis !== null) return ordered(selectedChapters);

  return ordered(
    timeline
      .filter(
        (item) => item.kind === "chapter"
          && Number.isFinite(item.timestamp_ms)
          && item.timestamp_ms >= 0
          && validTitle(item.title),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        startMs: item.timestamp_ms,
        endMs: item.end_ms,
      })),
  );
}
