"use client";

import { useEffect, useState } from "react";
import { Film, Headphones } from "lucide-react";
import { chapterThumbnailsApi, type ChapterThumbnails } from "@/lib/api";
import type { PlaybackChapter } from "./transcript-player";
import styles from "./meeting-workspace.module.css";

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function ChapterImage({ url, audio }: { url?: string | null; audio: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    const Icon = audio ? Headphones : Film;
    return <Icon className={styles.chapterFallback} size={24} />;
  }
  // Same-origin JPEG content endpoint; Next Image would require an extra server proxy.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.chapterImage} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function ChapterList({
  meetingId, analysisId, chapters, durationMs, mediaKind, jobState,
}: {
  meetingId: string;
  analysisId?: string | null;
  chapters: PlaybackChapter[];
  durationMs?: number | null;
  mediaKind: "audio" | "video";
  jobState?: string;
}) {
  const [manifest, setManifest] = useState<ChapterThumbnails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (mediaKind !== "video" || !analysisId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(ensure: boolean) {
      try {
        let result = await (ensure ? chapterThumbnailsApi.ensure : chapterThumbnailsApi.get)(
          meetingId, analysisId!, controller.signal,
        );
        if (controller.signal.aborted) return;
        // A chapter added while a job ran may need a follow-up job after it finishes.
        if (result.status === "missing") {
          result = await chapterThumbnailsApi.ensure(meetingId, analysisId!, controller.signal);
          if (controller.signal.aborted) return;
        }
        setManifest(result);
        setError(result.status === "failed" ? "サムネイルを作成できませんでした。" : null);
        if (result.status === "queued" || result.status === "running") {
          timer = setTimeout(() => void load(false), 2000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "サムネイルを取得できませんでした。");
        }
      }
    }
    void load(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [meetingId, analysisId, mediaKind, attempt, jobState]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      if (manifest?.status === "failed" && manifest.job) {
        await chapterThumbnailsApi.retry(manifest.job.id);
      }
      setError(null);
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "再試行できませんでした。");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <>
      {(manifest?.status === "queued" || manifest?.status === "running") && (
        <p className={styles.thumbnailStatus} role="status">サムネイルを作成中…</p>
      )}
      {error && (
        <div className={styles.thumbnailStatus} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void retry()} disabled={retrying}>再試行</button>
        </div>
      )}
      <ol className={styles.chapterList}>
        {chapters.map((chapter, index) => {
          const endMs = chapter.endMs ?? chapters[index + 1]?.startMs ?? durationMs ?? null;
          const url = manifest?.thumbnails.find((item) => item.chapter_id === chapter.id && item.start_ms === chapter.startMs)?.url;
          return (
            <li key={chapter.id}>
              <button type="button" className={styles.chapterItem}
                data-seek-ms={chapter.startMs} data-chapter-list-item data-chapter-list-start-ms={chapter.startMs}
                aria-label={`${chapter.title} ${formatClock(chapter.startMs)}から再生`}>
                <span className={styles.chapterThumb} aria-hidden="true">
                  <ChapterImage key={url ?? "placeholder"} url={url} audio={mediaKind === "audio"} />
                  {endMs !== null && endMs > chapter.startMs && (
                    <span className={styles.chapterLength}>{formatClock(endMs - chapter.startMs)}</span>
                  )}
                  <span className={styles.chapterProgress} data-chapter-list-progress />
                </span>
                <span className={styles.chapterText}>
                  <span className={styles.chapterTitle}>{chapter.title}</span>
                  <time className={styles.chapterStart}>{formatClock(chapter.startMs)}</time>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
