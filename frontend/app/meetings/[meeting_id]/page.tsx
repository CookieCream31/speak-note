import Link from "next/link";
import { notFound } from "next/navigation";

import { updateSegmentAction } from "@/app/actions";
import { ChevronDown, Download, Plus, Settings } from "lucide-react";

import { ChunkedMediaUploader } from "@/components/chunked-media-uploader";
import { LiveMeetingRecorder } from "@/components/live-meeting-recorder";
import { AnswerAssistPanel } from "@/components/answer-assist-panel";
import { MeetingAISelector } from "@/components/meeting-ai-selector";
import { MeetingTitleEditor } from "@/components/meeting-title-editor";
import { MeetingProjectSelector } from "@/components/meeting-project-selector";
import { MeetingQuestionPanel } from "@/components/meeting-question-panel";
import { MeetingReviewPanel } from "@/components/meeting-review-panel";
import { MeetingTranscriptionSettings } from "@/components/meeting-transcription-settings";
import { LiveTranscriptStream, RealtimeAnalysisPanel } from "@/components/realtime-analysis-panel";
import { MeetingToolsPanel } from "@/components/meeting-tools-panel";
import { MeetingWorkspace } from "@/components/meeting-workspace";
import { AppStatusPage } from "@/components/app-status-page";
import { SummaryRegenerationButton, type SummaryRegenerationProps } from "@/components/final-transcript-button";
import type {
  PlaybackChapter,
  PlaybackTurn,
  PlaybackWord,
} from "@/components/transcript-player";
import type {
  AIProfile,
  AnalysisVersion,
  AnalysisVersionSummary,
  Bookmark,
  Job,
  Media,
  Meeting,
  MeetingTemplate,
  MeetingQuestion,
  RealtimeAnalysis,
  LiveSession,
  Speaker,
  TimelineMarker,
  TranscriptSegment,
  TranscriptVersion,
} from "@/lib/api";
import { formatDate, sourceLabels, statusLabels } from "@/lib/format";
import {
  isCompletedLiveMeetingNotes,
  REALTIME_ANALYSIS_HISTORY_ID,
  realtimeAnalysisToHistoryVersion,
} from "@/lib/realtime-analysis-history";
import { resolvePlaybackChapters } from "@/lib/playback-chapters";

import { JobStatusPanel } from "./job-status-panel";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";

interface TranscriptTurn {
  speakerKey: string;
  speakerName: string;
  startMs: number;
  endMs: number;
  segments: TranscriptSegment[];
}

async function load<T>(path: string, allowNotFound = false): Promise<T | null> {
  const response = await fetch(`${backendInternalUrl}/api/v1${path}`, { cache: "no-store" });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
  return (await response.json()) as T;
}

async function loadOptional<T>(
  path: string,
  fallback: T,
  allowNotFound = false,
): Promise<T> {
  try {
    return (await load<T>(path, allowNotFound)) ?? fallback;
  } catch (error) {
    console.error("Failed to load optional meeting data from " + path, error);
    return fallback;
  }
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function speakerCountLabel(minimum: number | null, maximum: number | null): string {
  if (minimum === null && maximum === null) return "自動";
  if (minimum !== null && minimum === maximum) return `${minimum}人`;
  if (minimum === null) return `${maximum}人以下`;
  if (maximum === null) return `${minimum}人以上`;
  return `${minimum}〜${maximum}人`;
}

function speakerName(segment: TranscriptSegment): string {
  return segment.speaker?.display_name ?? segment.speaker?.internal_name ?? segment.provisional_speaker_name ?? segment.provisional_speaker_label ?? "話者不明";
}

function groupIntoTurns(segments: TranscriptSegment[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const segment of segments) {
    const label = segment.provisional_speaker_label;
    const speakerKey = segment.speaker?.id ?? JSON.stringify([
      label && label !== "SPEAKER_UNKNOWN" ? label : segment.id,
      segment.provisional_speaker_name ?? null,
    ]);
    const previous = turns.at(-1);
    if (previous?.speakerKey === speakerKey) {
      previous.segments.push(segment);
      previous.endMs = Math.max(previous.endMs, segment.end_ms);
      continue;
    }
    turns.push({
      speakerKey,
      speakerName: speakerName(segment),
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      segments: [segment],
    });
  }
  return turns;
}

function buildPlaybackWords(segments: TranscriptSegment[]): PlaybackWord[] {
  const result: PlaybackWord[] = [];
  for (const segment of segments) {
    const storedWords = segment.words ?? [];
    const segmentWords: PlaybackWord[] = storedWords.length > 0
      ? storedWords.map((word) => ({
          id: word.id,
          startMs: word.start_ms,
          endMs: word.end_ms,
          text: word.text,
          exact: true,
        }))
      : [{
          id: `segment-${segment.id}`,
          startMs: segment.start_ms,
          endMs: segment.end_ms,
          text: segment.text,
          exact: false,
        }];

    const previous = result.at(-1);
    const first = segmentWords[0];
    if (previous && first && !/\s$/u.test(previous.text) && !/^\s/u.test(first.text)) {
      first.text = ` ${first.text}`;
    }
    result.push(...segmentWords);
  }
  return result;
}

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ meeting_id: string }>;
  searchParams: Promise<{ analysis_id?: string; start_recording?: string; microphone_muted?: string; transcript_kind?: string }>;
}) {
  const { meeting_id: meetingId } = await params;
  const { analysis_id: selectedAnalysisId, start_recording: startRecording, microphone_muted: startMicrophoneMuted, transcript_kind: selectedTranscriptKind } = await searchParams;
  let meeting: Meeting;
  let media: Media[];
  let jobs: Job[];
  let transcript: TranscriptVersion | null;
  let aiProfiles: AIProfile[];
  let templates: MeetingTemplate[];
  let analysis: AnalysisVersion | null;
  let analysisVersions: AnalysisVersionSummary[];
  let bookmarks: Bookmark[];
  let timeline: TimelineMarker[];
  let questions: MeetingQuestion[];
  let realtimeAnalysis: RealtimeAnalysis | null;
  let liveSession: LiveSession | null;
  let liveTranscript: TranscriptVersion | null;
  let finalTranscript: TranscriptVersion | null;

  let meetingResult: Meeting | null;
  try {
    meetingResult = await load<Meeting>(`/meetings/${meetingId}`, true);
  } catch {
    return (
      <AppStatusPage
        title="会議データを取得できませんでした"
        description="Backendの状態を確認し、ホームからもう一度開いてください。"
      />
    );
  }
  if (!meetingResult) notFound();
  meeting = meetingResult;
  const isRealtimeCapture = meeting.source_type === "live"
    || meeting.source_type === "audio_recording" || meeting.source_type === "shared_audio";
  const isAudioCapture = meeting.source_type === "audio_recording" || meeting.source_type === "shared_audio";

  [
    media,
    jobs,
    transcript,
    aiProfiles,
    templates,
    analysis,
    analysisVersions,
    bookmarks,
    timeline,
    questions,
    realtimeAnalysis,
    liveSession,
    liveTranscript,
    finalTranscript,
  ] = await Promise.all([
      loadOptional<Media[]>(`/meetings/${meetingId}/media`, []),
      loadOptional<Job[]>(`/meetings/${meetingId}/jobs`, []),
      loadOptional<TranscriptVersion | null>(
        `/meetings/${meetingId}/transcript`,
        null,
        true,
      ),
      loadOptional<AIProfile[]>("/ai/profiles", []),
      loadOptional<MeetingTemplate[]>("/meeting-templates", []),
      loadOptional<AnalysisVersion | null>(
        selectedAnalysisId && selectedAnalysisId !== REALTIME_ANALYSIS_HISTORY_ID
          ? `/meetings/${meetingId}/analyses/${selectedAnalysisId}`
          : `/meetings/${meetingId}/analysis`,
        null,
        true,
      ),
      loadOptional<AnalysisVersionSummary[]>(`/meetings/${meetingId}/analyses`, []),
      loadOptional<Bookmark[]>(`/meetings/${meetingId}/bookmarks`, []),
      loadOptional<TimelineMarker[]>(`/meetings/${meetingId}/timeline`, []),
      loadOptional<MeetingQuestion[]>(`/meetings/${meetingId}/questions`, []),
      isRealtimeCapture
        ? loadOptional<RealtimeAnalysis | null>(
            `/meetings/${meetingId}/live/analysis`,
            null,
            true,
          )
        : Promise.resolve(null),
      isRealtimeCapture ? loadOptional<LiveSession | null>(`/meetings/${meetingId}/live`, null, true) : Promise.resolve(null),
      isRealtimeCapture ? loadOptional<TranscriptVersion | null>(`/meetings/${meetingId}/transcript?kind=live`, null, true) : Promise.resolve(null),
      loadOptional<TranscriptVersion | null>(`/meetings/${meetingId}/transcript?kind=final`, null, true),
    ]);

  const archivedLiveMeeting = isCompletedLiveMeetingNotes(
    meeting.source_type,
    transcript?.kind ?? null,
    analysisVersions,
    liveSession?.status,
  );
  const realtimeHistory = archivedLiveMeeting && realtimeAnalysis
    ? realtimeAnalysisToHistoryVersion(meeting.id, realtimeAnalysis, meeting.template_snapshot)
    : null;
  if (!selectedAnalysisId && selectedTranscriptKind === "final" && analysis?.transcript_kind === "live") {
    analysis = null;
    transcript = finalTranscript;
  }
  const hasCompletedNotes = analysis?.status === "completed"
    && Boolean(analysis.transcript_kind === "live" ? liveTranscript : finalTranscript);
  const useRealtime = selectedAnalysisId === REALTIME_ANALYSIS_HISTORY_ID
    || (!selectedAnalysisId && ((selectedTranscriptKind === "live" && analysis?.transcript_kind !== "live")
      || (selectedTranscriptKind !== "final" && !hasCompletedNotes)));
  if (archivedLiveMeeting && useRealtime && liveTranscript) transcript = liveTranscript;
  else if (analysis?.transcript_version_id && transcript?.id !== analysis.transcript_version_id) {
    transcript = await loadOptional<TranscriptVersion | null>(
      `/meetings/${meetingId}/transcript?version_id=${analysis.transcript_version_id}`, null, true,
    );
  }
  const displayedAnalysis = useRealtime && archivedLiveMeeting ? realtimeHistory : analysis;

  const originalAudio = media.find((item) => item.kind === "original_audio");
  const originalVideo = media.find((item) => item.kind === "original_video");
  const playbackVideo = media.find((item) => item.kind === "playback_video");
  const transcriptionAudio = media.find((item) => item.kind === "transcription_audio");
  const isVideo = meeting.source_type === "video_upload"
    || Boolean(originalVideo || playbackVideo);
  const uploadedOriginal = originalVideo ?? originalAudio;
  const playbackMedia = playbackVideo ?? originalAudio;
  const speakers = new Map<string, Speaker>();
  for (const segment of transcript?.segments ?? []) {
    if (segment.speaker) speakers.set(segment.speaker.id, segment.speaker);
  }
  const transcriptTurns = groupIntoTurns(transcript?.segments ?? []);
  const playbackTurns: PlaybackTurn[] = transcriptTurns.map((turn) => ({
    id: `${turn.segments[0].id}-${turn.segments.at(-1)?.id ?? turn.segments[0].id}`,
    startMs: turn.startMs,
    speakerId: transcript?.kind === "final" ? turn.segments[0].speaker?.id ?? null : null,
    speakerName: turn.speakerName,
    words: buildPlaybackWords(turn.segments),
    subwordTokens: transcript?.model.startsWith("stt-") ?? false,
    sourceSegmentIds: transcript?.kind === "live" ? turn.segments.map((segment) => segment.id) : undefined,
    provisionalSpeakerLabel: turn.segments[0].provisional_speaker_label,
    editableLiveSegmentIds: archivedLiveMeeting && transcript?.kind === "live" && transcript.status === "completed"
      ? turn.segments.map((segment) => segment.id) : undefined,
  }));
  const playbackChapters: PlaybackChapter[] = resolvePlaybackChapters(
    displayedAnalysis,
    timeline,
  );
  const mediaUrl = playbackMedia
    ? `/api/v1/meetings/${meeting.id}/media/${playbackMedia.id}/content`
    : undefined;
  const mediaDownloadUrl = playbackMedia
    ? "/api/v1/meetings/" + meeting.id + "/media/" + playbackMedia.id + "/download"
    : undefined;
  const evidenceSegments = (transcript?.segments ?? []).map((segment) => ({
    id: segment.id,
    startMs: segment.start_ms,
    text: segment.text,
    speakerName: speakerName(segment),
  }));

  const hasSavedLive = Boolean(archivedLiveMeeting && liveTranscript?.status === "completed" && liveTranscript.segments.length > 0);
  const regeneration: SummaryRegenerationProps = {
    meetingId: meeting.id,
    ready: Boolean(finalTranscript) || hasSavedLive,
    processing: jobs.some((job) => ["preprocess_media", "transcribe", "analyze"].includes(job.type) && ["queued", "running"].includes(job.status))
      || liveSession?.status === "recording" || liveSession?.status === "finalizing",
    profiles: aiProfiles,
    templates,
    currentProfileId: meeting.ai_profile_id,
    currentTemplate: meeting.template_snapshot,
    aiDisabled: meeting.ai_disabled,
    hasFinal: Boolean(finalTranscript),
    hasSavedLive,
  };
  const regenerationKey = jobs.filter((job) => ["preprocess_media", "transcribe", "analyze"].includes(job.type)).map((job) => `${job.id}:${job.status}:${job.attempts}`).join("|");
  const showCapturePanel = !isRealtimeCapture && !uploadedOriginal;
  const keepCapturePageOpen = isRealtimeCapture && !archivedLiveMeeting;

  return (
    <main className={styles.page}>
      <header className={styles.topHeader}>
        <Link className={styles.logo} href="/" aria-label="speak-note ホーム">
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
        </Link>
        <nav className={styles.breadcrumb} aria-label="パンくずリスト">
          <Link href="/">会議一覧</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{meeting.title}</span>
        </nav>
        <Link
          className={styles.headerButton}
          href="/settings/ai"
          target={keepCapturePageOpen ? "_blank" : undefined}
          rel={keepCapturePageOpen ? "noopener noreferrer" : undefined}
          aria-label={keepCapturePageOpen ? "設定（別タブで開く）" : "設定"}
          title={keepCapturePageOpen ? "設定（別タブで開く）" : "設定"}
        >
          <Settings size={16} aria-hidden="true" />
          設定
        </Link>
        <Link
          className={`${styles.headerButton} ${styles.newMeetingButton}`}
          href="/?create=1"
          target={keepCapturePageOpen ? "_blank" : undefined}
          rel={keepCapturePageOpen ? "noopener noreferrer" : undefined}
          aria-label={keepCapturePageOpen ? "新しい会議（別タブで開く）" : "新しい会議"}
          title={keepCapturePageOpen ? "新しい会議（別タブで開く）" : "新しい会議"}
        >
          <Plus size={16} aria-hidden="true" />
          新しい会議
        </Link>
      </header>

      <section className={styles.titleBlock}>
        <div className={styles.titleMain}>
          <MeetingTitleEditor meetingId={meeting.id} title={meeting.title} />
          <div className={styles.meta}>
            <span className={styles.statusPill} data-status={meeting.status}>
              {isAudioCapture && meeting.status === "recording"
                ? "録音中"
                : statusLabels[meeting.status]}
            </span>
            <span>{sourceLabels[meeting.source_type]}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={meeting.created_at}>{formatDate(meeting.created_at)}</time>
            {meeting.duration_ms ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={styles.mono}>{formatTimestamp(meeting.duration_ms)}</span>
              </>
            ) : null}
            {uploadedOriginal && (
              <>
                <span aria-hidden="true">·</span>
                <span>{uploadedOriginal.mime_type} · {formatBytes(uploadedOriginal.size_bytes)}</span>
              </>
            )}
            {!isRealtimeCapture && isVideo && uploadedOriginal && !playbackVideo && (
              <>
                <span aria-hidden="true">·</span>
                <span>再生用動画を変換しています</span>
              </>
            )}
          </div>
          <div className={styles.settingsRow}>
            <MeetingProjectSelector meetingId={meeting.id} currentProjectId={meeting.project_id} />
            <MeetingAISelector
              meetingId={meeting.id}
              currentProfileId={meeting.ai_profile_id}
              disabled={meeting.ai_disabled}
              profiles={aiProfiles}
            />
            <details className={styles.settingChip}>
              <summary>
                <span>文字起こし設定</span>
                <strong>{speakerCountLabel(meeting.min_speakers, meeting.max_speakers)}</strong>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className={styles.chipPopover}>
                <MeetingTranscriptionSettings
                  meetingId={meeting.id}
                  minSpeakers={meeting.min_speakers}
                  maxSpeakers={meeting.max_speakers}
                  languageHints={meeting.transcription_language_hints ?? null}
                  languageHintsStrict={meeting.transcription_language_hints_strict ?? false}
                  realtimeTranslation={meeting.realtime_translation ?? null}
                  translationLocked={Boolean(liveSession)}
                  includeRealtime={isRealtimeCapture}
                  languageLocked={Boolean(finalTranscript)}
                  disabled={[
                    "recording",
                    "uploading",
                    "preprocessing",
                    "queued",
                    "transcribing",
                    "analyzing",
                  ].includes(meeting.status)}
                />
              </div>
            </details>
            <span className={styles.chipDivider} aria-hidden="true" />
            <JobStatusPanel
              key={jobs.map((job) => `${job.id}:${job.status}:${job.attempts}`).join("|") || meeting.id}
              meetingId={meeting.id}
              initialJobs={jobs}
            />
          </div>
        </div>
        <div className={styles.titleActions}>
          {(transcript || mediaDownloadUrl) && (
            <details className={styles.downloadMenu}>
              <summary>
                <Download size={16} aria-hidden="true" />
                ダウンロード
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div>
                {transcript && (
                  <a href={`/api/v1/meetings/${meeting.id}/transcript/download?kind=${transcript.kind}`} download>
                    文字起こしテキスト
                  </a>
                )}
                {mediaDownloadUrl && (
                  <a href={mediaDownloadUrl} download>{isVideo ? "動画" : "音声"}</a>
                )}
              </div>
            </details>
          )}
          <div className={styles.regenerate}>
            <SummaryRegenerationButton key={regenerationKey} {...regeneration} />
          </div>
        </div>
      </section>

      {isRealtimeCapture && !archivedLiveMeeting && (
        <section className={styles.liveSection}>
          <RealtimeAnalysisPanel
            meetingId={meeting.id}
            templateSnapshot={meeting.template_snapshot}
            recorder={(
              <div className={styles.uploadPanel}>
                <LiveMeetingRecorder
                  meetingId={meeting.id}
                  captureMode={meeting.source_type === "audio_recording" ? "microphone" : meeting.source_type === "shared_audio" ? "shared_audio" : "display"}
                  existingRecording={
                    isAudioCapture
                      ? Boolean(originalAudio)
                      : Boolean(originalVideo)
                  }
                  transcriptionReady={
                    isAudioCapture
                      ? Boolean(originalAudio)
                      : Boolean(transcriptionAudio)
                  }
                  hasFinalTranscript={transcript?.kind === "final"}
                  finalProcessing={jobs.some(
                    (job) =>
                      (job.type === "transcribe" || job.type === "analyze")
                      && (job.status === "queued" || job.status === "running"),
                  )}
                  aiDisabled={meeting.ai_disabled}
                  initialIncludeMicrophone={startMicrophoneMuted === "0"}
                  autoStart={startRecording === "1" && !uploadedOriginal}
                  resumePendingCapture={
                    (meeting.source_type === "live" || meeting.source_type === "shared_audio")
                    && startRecording === "1"
                    && !uploadedOriginal
                  }
                />
              </div>
            )}
            answerAssist={<AnswerAssistPanel meetingId={meeting.id} />}
          />
        </section>
      )}

      {showCapturePanel && (
        <section className={styles.uploadPanel}>
          <h2>音声・動画ファイルを取り込む</h2>
          <ChunkedMediaUploader meetingId={meeting.id} />
        </section>
      )}

      <section className={styles.transcriptSection}>
        <MeetingWorkspace
          meetingId={meeting.id}
          transcriptTranslations={archivedLiveMeeting && transcript?.kind !== "final" ? liveSession?.translations : []}
          realtimeTranslation={archivedLiveMeeting && transcript?.kind !== "final" ? liveSession?.translation : null}
          playback={{
            mediaUrl,
            downloadUrl: mediaDownloadUrl,
            originalUrl: originalVideo
              ? `/api/v1/meetings/${meeting.id}/media/${originalVideo.id}/content`
              : undefined,
            mediaKind: isVideo ? "video" : "audio",
            turns: playbackTurns,
            chapters: playbackChapters,
            durationMs: playbackMedia?.duration_ms ?? meeting.duration_ms,
          }}
          notes={(
            <MeetingReviewPanel
              key={displayedAnalysis ? `${displayedAnalysis.id}:${displayedAnalysis.status}:${displayedAnalysis.completed_at}` : "no-analysis"}
              meetingId={meeting.id}
              analysis={displayedAnalysis}
              finalTranscription={isRealtimeCapture ? { ready: archivedLiveMeeting && Boolean(isAudioCapture ? originalAudio : transcriptionAudio), processing: regeneration.processing, jobKey: regenerationKey } : undefined}
              versions={analysisVersions}
              realtimeHistory={realtimeHistory}
              evidenceSegments={evidenceSegments}
              playerAvailable={Boolean(mediaUrl)}
              finalTranscriptAvailable={Boolean(finalTranscript)}
            />
          )}
          questions={(
            <MeetingQuestionPanel
              meetingId={meeting.id}
              initialQuestions={questions}
              available={Boolean(finalTranscript) && !meeting.ai_disabled && aiProfiles.length > 0}
            />
          )}
          transcriptHeader={(
            <>
              {transcript && (
                <div className={styles.transcriptToolbar}>
                  <div>
                    <strong>文字起こし</strong>
                    <span>{transcript.kind === "live" ? "リアルタイム版（暫定）" : "高精度版"} · v{transcript.version} · {transcript.model} · {transcript.language}</span>
                  </div>
                  {archivedLiveMeeting && liveTranscript && <Link href={`/meetings/${meeting.id}?${realtimeHistory ? "analysis_id=realtime&" : ""}transcript_kind=live`}>リアルタイム版</Link>}
                  {archivedLiveMeeting && finalTranscript && <Link href={`/meetings/${meeting.id}?transcript_kind=final`}>高精度版</Link>}
                </div>
              )}
              {!transcript ? (
                <div className={styles.transcriptEmpty}>
                  <span>◌</span>
                  <p>
                    {meeting.status === "failed"
                      ? "文字起こしに失敗しました。処理状況から再試行できます。"
                      : archivedLiveMeeting && (transcriptionAudio || originalAudio)
                        ? "要約の「その他」から高精度版の文字起こしを作成できます。"
                      : "文字起こしの完了後、ここに発言が表示されます。"}
                  </p>
                </div>
              ) : null}
            </>
          )}
          transcriptFooter={transcript?.kind === "final" ? (
            <>
              {archivedLiveMeeting && (liveSession?.translation || liveSession?.translations?.length) && (
                <details className={styles.transcriptEditor}>
                  <summary>リアルタイム原文と翻訳</summary>
                  <LiveTranscriptStream
                    meetingId={meeting.id}
                    recording={false}
                    persistedSegments={liveTranscript?.segments ?? []}
                    translation={liveSession?.translation}
                    persistedTranslations={liveSession?.translations}
                  />
                </details>
              )}
              <details key={`transcript-editor-${transcript.id}`} className={styles.transcriptEditor}>
                <summary>文字起こしを修正する</summary>
                <ol className={styles.editorSegments}>
                  {transcript.segments.map((segment) => (
                    <li key={segment.id}>
                      <div className={styles.segmentMeta}>
                        <time>{formatTimestamp(segment.start_ms)}</time>
                        <strong>{speakerName(segment)}</strong>
                      </div>
                      <form action={updateSegmentAction}>
                        <input type="hidden" name="meeting_id" value={meeting.id} />
                        <input type="hidden" name="segment_id" value={segment.id} />
                        <textarea name="text" defaultValue={segment.text} required rows={2} />
                        <button type="submit">修正を保存</button>
                      </form>
                    </li>
                  ))}
                </ol>
              </details>
            </>
          ) : null}
          tools={(
            <MeetingToolsPanel
              meetingId={meeting.id}
              bookmarks={bookmarks}
              timeline={timeline}
              speakers={[...speakers.values()]}
              playerAvailable={Boolean(mediaUrl)}
              durationMs={meeting.duration_ms}
            />
          )}
        />
      </section>
    </main>
  );
}
