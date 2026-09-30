import Link from "next/link";
import { notFound } from "next/navigation";

import { updateSegmentAction } from "@/app/actions";
import { ChevronDown, Download, Sparkles } from "lucide-react";

import { ChunkedMediaUploader } from "@/components/chunked-media-uploader";
import { LiveMeetingRecorder } from "@/components/live-meeting-recorder";
import { AnswerAssistPanel } from "@/components/answer-assist-panel";
import { MeetingAISelector } from "@/components/meeting-ai-selector";
import { MeetingProjectSelector } from "@/components/meeting-project-selector";
import { MeetingQuestionPanel } from "@/components/meeting-question-panel";
import { MeetingReviewPanel } from "@/components/meeting-review-panel";
import { MeetingTranscriptionSettings } from "@/components/meeting-transcription-settings";
import { RealtimeAnalysisPanel } from "@/components/realtime-analysis-panel";
import { MeetingToolsPanel } from "@/components/meeting-tools-panel";
import { MeetingWorkspace } from "@/components/meeting-workspace";
import { ThemeSelector } from "@/components/theme-selector";
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
  return segment.speaker?.display_name ?? segment.speaker?.internal_name ?? segment.provisional_speaker_label ?? "話者不明";
}

function groupIntoTurns(segments: TranscriptSegment[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const segment of segments) {
    const speakerKey = segment.speaker?.id ?? segment.provisional_speaker_label ?? "unknown";
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
    || meeting.source_type === "audio_recording";

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
  const finalTranscript = transcript?.kind === "final" ? transcript : null;
  const useRealtime = selectedAnalysisId === REALTIME_ANALYSIS_HISTORY_ID
    || (!selectedAnalysisId && (selectedTranscriptKind === "live"
      || (selectedTranscriptKind !== "final" && (!finalTranscript || !analysis || analysis.status !== "completed"))));
  if (archivedLiveMeeting && useRealtime && liveTranscript) transcript = liveTranscript;
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
    speakerId: turn.speakerKey === "unknown" ? null : turn.speakerKey,
    speakerName: turn.speakerName,
    words: buildPlaybackWords(turn.segments),
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

  const regeneration: SummaryRegenerationProps = {
    meetingId: meeting.id,
    ready: Boolean(finalTranscript) || (archivedLiveMeeting && Boolean(meeting.source_type === "audio_recording" ? originalAudio : transcriptionAudio)),
    processing: jobs.some((job) => ["preprocess_media", "transcribe", "analyze"].includes(job.type) && ["queued", "running"].includes(job.status))
      || liveSession?.status === "recording" || liveSession?.status === "finalizing",
    profiles: aiProfiles,
    templates,
    currentProfileId: meeting.ai_profile_id,
    currentTemplate: meeting.template_snapshot,
    aiDisabled: meeting.ai_disabled,
    hasFinal: Boolean(finalTranscript),
  };
  const regenerationKey = jobs.filter((job) => ["preprocess_media", "transcribe", "analyze"].includes(job.type)).map((job) => `${job.id}:${job.status}:${job.attempts}`).join("|");
  const showCapturePanel = !archivedLiveMeeting && (isRealtimeCapture || !uploadedOriginal);

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
        <ThemeSelector />
        <Link className={styles.headerButton} href="/settings/ai">
          <Sparkles size={16} aria-hidden="true" />
          AI設定
        </Link>
      </header>

      <section className={styles.titleBlock}>
        <div className={styles.titleMain}>
          <h1>{meeting.title}</h1>
          <div className={styles.meta}>
            <span className={styles.statusPill} data-status={meeting.status}>
              {meeting.source_type === "audio_recording" && meeting.status === "recording"
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
                <span>話者数</span>
                <strong>{speakerCountLabel(meeting.min_speakers, meeting.max_speakers)}</strong>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className={styles.chipPopover}>
                <MeetingTranscriptionSettings
                  meetingId={meeting.id}
                  minSpeakers={meeting.min_speakers}
                  maxSpeakers={meeting.max_speakers}
                  disabled={[
                    "recording",
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

      {showCapturePanel && (
        <section className={styles.uploadPanel}>
          <h2>
            {meeting.source_type === "live"
              ? "画面共有を録画"
              : meeting.source_type === "audio_recording"
                ? "マイク音声を録音"
                : "音声・動画ファイルを取り込む"}
          </h2>
          {isRealtimeCapture ? (
            <LiveMeetingRecorder
              meetingId={meeting.id}
              captureMode={meeting.source_type === "audio_recording" ? "microphone" : "display"}
              existingRecording={
                meeting.source_type === "audio_recording"
                  ? Boolean(originalAudio)
                  : Boolean(originalVideo)
              }
              transcriptionReady={
                meeting.source_type === "audio_recording"
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
                meeting.source_type === "live"
                && startRecording === "1"
                && !originalVideo
              }
            />
          ) : (
            <ChunkedMediaUploader meetingId={meeting.id} />
          )}
        </section>
      )}

      {isRealtimeCapture && !archivedLiveMeeting && (
        <>
          <AnswerAssistPanel meetingId={meeting.id} />
          <RealtimeAnalysisPanel meetingId={meeting.id} templateSnapshot={meeting.template_snapshot} />
        </>
      )}

      <section className={styles.transcriptSection}>
        <div className={styles.sectionTitle}>
          <div><h2>会議ノート</h2></div>
          <span>要約・質問・文字起こし・検索を切り替えて確認できます</span>
        </div>

        <MeetingWorkspace
          meetingId={meeting.id}
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
                  {archivedLiveMeeting && liveTranscript && <Link href={`/meetings/${meeting.id}?analysis_id=realtime&transcript_kind=live`}>リアルタイム版</Link>}
                  {archivedLiveMeeting && finalTranscript && <Link href={`/meetings/${meeting.id}?transcript_kind=final`}>高精度版</Link>}
                </div>
              )}
              {!transcript ? (
                <div className={styles.transcriptEmpty}>
                  <span>◌</span>
                  <p>
                    {meeting.status === "failed"
                      ? "文字起こしに失敗しました。処理状況から再試行できます。"
                      : meeting.source_type === "live" && transcriptionAudio
                        ? "録画カードのボタンから確定版の文字起こしを開始できます。"
                      : "文字起こしの完了後、ここに発言が表示されます。"}
                  </p>
                </div>
              ) : null}
            </>
          )}
          transcriptFooter={transcript?.kind === "final" ? (
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
