"use client";

import { type ReactNode, useEffect, useState } from "react";

import {
  SPEAKER_RENAMED_EVENT,
  speakerRenamedDetail,
} from "@/lib/speaker-events";

import {
  TranscriptDocument,
  TranscriptMediaPlayer,
  TranscriptRuntime,
  type TranscriptPlayerProps,
} from "./transcript-player";
import styles from "./meeting-workspace.module.css";

type WorkspaceView = "transcript" | "notes" | "questions" | "tools";

interface MeetingWorkspaceProps {
  meetingId: string;
  playback: TranscriptPlayerProps;
  notes: ReactNode;
  questions: ReactNode;
  transcriptHeader: ReactNode;
  transcriptFooter: ReactNode;
  tools: ReactNode;
}

const labels: Record<WorkspaceView, string> = {
  notes: "要約",
  questions: "質問",
  transcript: "文字起こし",
  tools: "検索・設定",
};

export function MeetingWorkspace({
  meetingId,
  playback,
  notes,
  questions,
  transcriptHeader,
  transcriptFooter,
  tools,
}: MeetingWorkspaceProps) {
  const [activeView, setActiveView] = useState<WorkspaceView>("notes");
  const [renamedSpeakers, setRenamedSpeakers] = useState<Record<string, string>>({});
  const visiblePlayback = {
    ...playback,
    turns: playback.turns.map((turn) => turn.speakerId && renamedSpeakers[turn.speakerId]
      ? { ...turn, speakerName: renamedSpeakers[turn.speakerId] }
      : turn),
  };

  useEffect(() => {
    const openTranscript = () => setActiveView("transcript");
    const renameSpeaker = (event: Event) => {
      const detail = speakerRenamedDetail(event);
      if (!detail) return;
      setRenamedSpeakers((current) => ({
        ...current,
        [detail.speakerId]: detail.speakerName,
      }));
    };
    window.addEventListener("speak-note:open-transcript", openTranscript);
    window.addEventListener(SPEAKER_RENAMED_EVENT, renameSpeaker);
    return () => {
      window.removeEventListener("speak-note:open-transcript", openTranscript);
      window.removeEventListener(SPEAKER_RENAMED_EVENT, renameSpeaker);
    };
  }, []);

  return (
    <section
      className={styles.shell}
      data-active-view={activeView}
      data-transcript-player
      data-media-kind={visiblePlayback.mediaKind}
      data-media-available={Boolean(visiblePlayback.mediaUrl)}
      data-media-duration-ms={visiblePlayback.durationMs ?? undefined}
    >
      <div className={styles.playerPane}>
        <TranscriptMediaPlayer {...visiblePlayback} />
      </div>
      <nav className={styles.viewTabs} aria-label="会議ノートの表示切り替え" role="tablist">
        {(Object.keys(labels) as WorkspaceView[]).map((view) => (
          <button
            type="button"
            key={view}
            id={`meeting-view-tab-${view}`}
            role="tab"
            aria-selected={activeView === view}
            aria-controls={`meeting-view-panel-${view}`}
            onClick={() => setActiveView(view)}
          >
            {labels[view]}
          </button>
        ))}
      </nav>
      <div className={styles.workspace}>
        <div
          className={styles.notesPane}
          id="meeting-view-panel-notes"
          role="tabpanel"
          aria-labelledby="meeting-view-tab-notes"
          hidden={activeView !== "notes"}
        >
          {notes}
        </div>
        <div
          className={styles.questionsPane}
          id="meeting-view-panel-questions"
          role="tabpanel"
          aria-labelledby="meeting-view-tab-questions"
          hidden={activeView !== "questions"}
        >
          {questions}
        </div>
        <div
          className={styles.transcriptPane}
          id="meeting-view-panel-transcript"
          role="tabpanel"
          aria-labelledby="meeting-view-tab-transcript"
          hidden={activeView !== "transcript"}
        >
          {transcriptHeader}
          <TranscriptDocument
            meetingId={meetingId}
            mediaUrl={visiblePlayback.mediaUrl}
            turns={visiblePlayback.turns}
          />
          {transcriptFooter}
        </div>
        <div
          className={styles.toolsPane}
          id="meeting-view-panel-tools"
          role="tabpanel"
          aria-labelledby="meeting-view-tab-tools"
          hidden={activeView !== "tools"}
        >
          {tools}
        </div>
      </div>
      <TranscriptRuntime turns={visiblePlayback.turns} />
    </section>
  );
}
