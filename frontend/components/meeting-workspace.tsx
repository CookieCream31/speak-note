"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { LiveTranslation, RealtimeTranslationConfig } from "@/lib/api";

import {
  SPEAKER_RENAMED_EVENT,
  speakerRenamedDetail,
} from "@/lib/speaker-events";

import {
  OPEN_CHAPTERS_EVENT,
  TranscriptDocument,
  TranscriptMediaPlayer,
  TranscriptRuntime,
  type PlaybackChapter,
  type TranscriptPlayerProps,
} from "./transcript-player";
import styles from "./meeting-workspace.module.css";
import { ChapterList } from "./chapter-list";

type NotesView = "notes" | "questions" | "tools";
type MediaView = "chapters" | "transcript";

interface MeetingWorkspaceProps {
  meetingId: string;
  analysisId?: string | null;
  thumbnailJobState?: string;
  playback: TranscriptPlayerProps;
  notes: ReactNode;
  questions: ReactNode;
  transcriptHeader: ReactNode;
  transcriptFooter: ReactNode;
  tools: ReactNode;
  transcriptTranslations?: LiveTranslation[];
  realtimeTranslation?: RealtimeTranslationConfig | null;
}

const notesLabels: Record<NotesView, string> = {
  notes: "要約",
  questions: "質問",
  tools: "検索・ツール",
};

/** Same filter and order as the player's chapter track, so the runtime can match items by start time. */
function orderChapters(chapters: PlaybackChapter[]): PlaybackChapter[] {
  return chapters
    .filter((chapter) => chapter.title.trim() && chapter.startMs >= 0)
    .sort((left, right) => left.startMs - right.startMs);
}

export function MeetingWorkspace({
  meetingId,
  analysisId,
  thumbnailJobState,
  playback,
  notes,
  questions,
  transcriptHeader,
  transcriptFooter,
  tools,
  transcriptTranslations,
  realtimeTranslation,
}: MeetingWorkspaceProps) {
  const chapters = orderChapters(playback.chapters ?? []);
  const [notesView, setNotesView] = useState<NotesView>("notes");
  const [mediaView, setMediaView] = useState<MediaView>(chapters.length > 0 ? "chapters" : "transcript");
  const [renamedSpeakers, setRenamedSpeakers] = useState<Record<string, string>>({});
  const visiblePlayback = {
    ...playback,
    turns: playback.turns.map((turn) => turn.speakerId && renamedSpeakers[turn.speakerId]
      ? { ...turn, speakerName: renamedSpeakers[turn.speakerId] }
      : turn),
  };
  const activeMediaView = chapters.length > 0 ? mediaView : "transcript";

  useEffect(() => {
    const openTranscript = () => setMediaView("transcript");
    const openChapters = () => {
      setMediaView("chapters");
      // After the tab is shown, bring the playing chapter into view.
      window.requestAnimationFrame(() => {
        document
          .querySelector("#meeting-media-panel-chapters [aria-current]")
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    };
    const renameSpeaker = (event: Event) => {
      const detail = speakerRenamedDetail(event);
      if (!detail) return;
      setRenamedSpeakers((current) => ({
        ...current,
        [detail.speakerId]: detail.speakerName,
      }));
    };
    window.addEventListener("speak-note:open-transcript", openTranscript);
    window.addEventListener(OPEN_CHAPTERS_EVENT, openChapters);
    window.addEventListener(SPEAKER_RENAMED_EVENT, renameSpeaker);
    return () => {
      window.removeEventListener("speak-note:open-transcript", openTranscript);
      window.removeEventListener(OPEN_CHAPTERS_EVENT, openChapters);
      window.removeEventListener(SPEAKER_RENAMED_EVENT, renameSpeaker);
    };
  }, []);

  return (
    <section
      className={styles.shell}
      data-active-view={activeMediaView}
      data-transcript-player
      data-media-kind={visiblePlayback.mediaKind}
      data-media-available={Boolean(visiblePlayback.mediaUrl)}
      data-media-duration-ms={visiblePlayback.durationMs ?? undefined}
    >
      <div className={styles.mediaColumn}>
        <div className={styles.playerPane}>
          <TranscriptMediaPlayer {...visiblePlayback} />
        </div>
        <section className={styles.mediaPanel}>
          <div className={styles.mediaTabs} role="tablist" aria-label="動画の関連情報">
            {chapters.length > 0 && (
              <button
                type="button"
                id="meeting-media-tab-chapters"
                role="tab"
                aria-selected={activeMediaView === "chapters"}
                aria-controls="meeting-media-panel-chapters"
                onClick={() => setMediaView("chapters")}
              >
                チャプター
              </button>
            )}
            <button
              type="button"
              id="meeting-view-tab-transcript"
              role="tab"
              aria-selected={activeMediaView === "transcript"}
              aria-controls="meeting-view-panel-transcript"
              onClick={() => setMediaView("transcript")}
            >
              文字起こし
            </button>
          </div>
          {chapters.length > 0 && (
            <div
              className={styles.chaptersPane}
              id="meeting-media-panel-chapters"
              role="tabpanel"
              aria-labelledby="meeting-media-tab-chapters"
              hidden={activeMediaView !== "chapters"}
            >
              <ChapterList
                key={`${analysisId}:${visiblePlayback.mediaUrl}:${chapters.map((chapter) => `${chapter.id}:${chapter.startMs}`).join("|")}`}
                meetingId={meetingId} analysisId={analysisId} chapters={chapters}
                jobState={thumbnailJobState}
                durationMs={visiblePlayback.durationMs} mediaKind={visiblePlayback.mediaKind}
              />
            </div>
          )}
          <div
            className={styles.transcriptPane}
            id="meeting-view-panel-transcript"
            role="tabpanel"
            aria-labelledby="meeting-view-tab-transcript"
            hidden={activeMediaView !== "transcript"}
          >
            {transcriptHeader}
            <TranscriptDocument
              meetingId={meetingId}
              mediaUrl={visiblePlayback.mediaUrl}
              turns={visiblePlayback.turns}
              translations={transcriptTranslations}
              translation={realtimeTranslation}
            />
            {transcriptFooter}
          </div>
        </section>
      </div>
      <section className={styles.notesColumn}>
        <nav className={styles.viewTabs} aria-label="会議ノートの表示切り替え" role="tablist">
          {(Object.keys(notesLabels) as NotesView[]).map((view) => (
            <button
              type="button"
              key={view}
              id={`meeting-view-tab-${view}`}
              role="tab"
              aria-selected={notesView === view}
              aria-controls={`meeting-view-panel-${view}`}
              onClick={() => setNotesView(view)}
            >
              {notesLabels[view]}
            </button>
          ))}
        </nav>
        <div className={styles.workspace}>
          <div
            className={styles.notesPane}
            id="meeting-view-panel-notes"
            role="tabpanel"
            aria-labelledby="meeting-view-tab-notes"
            hidden={notesView !== "notes"}
          >
            {notes}
          </div>
          <div
            className={styles.questionsPane}
            id="meeting-view-panel-questions"
            role="tabpanel"
            aria-labelledby="meeting-view-tab-questions"
            hidden={notesView !== "questions"}
          >
            {questions}
          </div>
          <div
            className={styles.toolsPane}
            id="meeting-view-panel-tools"
            role="tabpanel"
            aria-labelledby="meeting-view-tab-tools"
            hidden={notesView !== "tools"}
          >
            {tools}
          </div>
        </div>
      </section>
      <TranscriptRuntime turns={visiblePlayback.turns} />
    </section>
  );
}
