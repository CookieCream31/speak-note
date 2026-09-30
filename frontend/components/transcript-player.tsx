"use client";

import { ArrowDown, Download, Maximize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import Script from "next/script";

import { InlineSpeakerName } from "./inline-speaker-name";
import { VideoSettings } from "./video-settings";

import styles from "./transcript-player.module.css";

export interface PlaybackWord {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  exact: boolean;
}

export interface PlaybackTurn {
  id: string;
  startMs: number;
  speakerId: string | null;
  speakerName: string;
  words: PlaybackWord[];
}

export interface PlaybackChapter {
  id: string;
  title: string;
  startMs: number;
  endMs: number | null;
}

export interface TranscriptPlayerProps {
  mediaUrl?: string;
  downloadUrl?: string;
  originalUrl?: string;
  mediaKind: "audio" | "video";
  turns: PlaybackTurn[];
  chapters?: PlaybackChapter[];
  durationMs?: number | null;
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

interface SubtitlePart {
  startMs: number;
  endMs: number;
  text: string;
}

interface SubtitleCue extends SubtitlePart {
  id: string;
  speakerId: string | null;
  speakerName: string;
}

const SUBTITLE_MAX_CHARACTERS = 34;
const SUBTITLE_MAX_DURATION_MS = 6_000;
const SUBTITLE_MAX_GAP_MS = 1_200;
const PLAYBACK_RATES = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5] as const;

function PlaybackRateControl({ video = false }: { video?: boolean }) {
  return (
    <label
      className={`${styles.playbackRate} ${video ? styles.videoPlaybackRate : ""}`}
      title="再生速度"
    >
      <span className={styles.visuallyHidden}>再生速度</span>
      {video && (
        <span
          className={styles.playbackRateValue}
          data-playback-rate-value
          aria-hidden="true"
        >
          1×
        </span>
      )}
      <select defaultValue="1" data-playback-rate aria-label="再生速度">
        {PLAYBACK_RATES.map((rate) => (
          <option key={rate} value={rate}>{rate}×</option>
        ))}
      </select>
    </label>
  );
}

function VideoVolumeControl() {
  return (
    <div className={styles.videoVolumeControl}>
      <button
        type="button"
        className={`${styles.controlButton} ${styles.videoVolumeButton}`}
        data-volume-toggle
        data-muted="false"
        aria-label="ミュート"
      >
        <span
          className={styles.videoVolumeIcon}
          data-volume-icon
          data-vector-volume-icon
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
            <path
              data-volume-waves
              d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
            />
            <path
              data-volume-slash
              d="M4 4 20 20"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
            />
          </svg>
        </span>
      </button>
      <input
        className={styles.videoVolumeSlider}
        type="range"
        min="0"
        max="1"
        step="0.05"
        defaultValue="1"
        data-volume-slider
        aria-label="音量"
        aria-valuetext="100%"
      />
    </div>
  );
}

export const OPEN_CHAPTERS_EVENT = "speak-note:open-chapters";

function openChapterList() {
  window.dispatchEvent(new Event(OPEN_CHAPTERS_EVENT));
}

function splitSubtitleWord(word: PlaybackWord): SubtitlePart[] {
  const characters = Array.from(word.text);
  if (characters.length <= SUBTITLE_MAX_CHARACTERS) {
    return [{ startMs: word.startMs, endMs: word.endMs, text: word.text }];
  }

  const durationMs = Math.max(1, word.endMs - word.startMs);
  const parts: SubtitlePart[] = [];
  for (let offset = 0; offset < characters.length; offset += SUBTITLE_MAX_CHARACTERS) {
    const endOffset = Math.min(characters.length, offset + SUBTITLE_MAX_CHARACTERS);
    parts.push({
      startMs: Math.round(word.startMs + (durationMs * offset) / characters.length),
      endMs: Math.round(word.startMs + (durationMs * endOffset) / characters.length),
      text: characters.slice(offset, endOffset).join(""),
    });
  }
  return parts;
}

function buildSubtitleCues(turns: PlaybackTurn[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const turn of turns) {
    let parts: SubtitlePart[] = [];
    let characterCount = 0;

    const flush = () => {
      const first = parts[0];
      const last = parts.at(-1);
      const text = parts.map((part) => part.text).join("").trim();
      if (first && last && text) {
        cues.push({
          id: `${turn.id}-subtitle-${cues.length}`,
          speakerId: turn.speakerId,
          speakerName: turn.speakerName,
          startMs: Math.max(0, first.startMs),
          endMs: Math.max(first.startMs + 1, last.endMs),
          text,
        });
      }
      parts = [];
      characterCount = 0;
    };

    for (const word of turn.words) {
      if (!word.text || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) continue;
      for (const part of splitSubtitleWord(word)) {
        const partLength = Array.from(part.text).length;
        const first = parts[0];
        const previous = parts.at(-1);
        const exceedsLength = parts.length > 0
          && characterCount + partLength > SUBTITLE_MAX_CHARACTERS;
        const exceedsDuration = first
          ? part.endMs - first.startMs > SUBTITLE_MAX_DURATION_MS
          : false;
        const followsLongGap = previous
          ? part.startMs - previous.endMs > SUBTITLE_MAX_GAP_MS
          : false;
        if (exceedsLength || exceedsDuration || followsLongGap) flush();

        parts.push(part);
        characterCount += partLength;
        if (/[。！？!?]$/u.test(part.text)) flush();
      }
    }
    flush();
  }
  return cues;
}

interface ChapterTrackProps {
  chapters: PlaybackChapter[];
  durationMs: number | null;
}

function ChapterTrack({ chapters, durationMs }: ChapterTrackProps) {
  const seekChapters = chapters.length > 0
    ? chapters
    : [{ id: "meeting-full-track", title: "会議全体", startMs: 0, endMs: durationMs }];

  return (
    <div
      className={styles.chapterTrack}
      data-chapter-track
      data-chapter-count={seekChapters.length}
      role="group"
      aria-label="チャプター付き再生位置"
    >
      {seekChapters.map((chapter) => (
        <button
          type="button"
          className={styles.chapterSegment}
          key={chapter.id}
          data-chapter-segment
          data-chapter-title={chapter.title}
          data-chapter-start-ms={chapter.startMs}
          data-chapter-end-ms={chapter.endMs ?? undefined}
          aria-label={`${chapter.title} ${formatTimestamp(chapter.startMs)}から`}
        >
          <span data-chapter-progress />
          <span className={styles.chapterTooltip} aria-hidden="true">
            <strong>{chapter.title}</strong>
            <small>{formatTimestamp(chapter.startMs)}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function TranscriptMediaPlayer({
  mediaUrl,
  downloadUrl,
  originalUrl,
  mediaKind,
  turns,
  chapters = [],
  durationMs = null,
}: TranscriptPlayerProps) {
  if (!mediaUrl) return null;

  const isVideo = mediaKind === "video";
  const subtitleCues = isVideo ? buildSubtitleCues(turns) : [];
  const orderedChapters = chapters
    .filter((chapter) => chapter.title.trim() && chapter.startMs >= 0)
    .sort((left, right) => left.startMs - right.startMs);
  const chapterTrack = (
    <ChapterTrack chapters={orderedChapters} durationMs={durationMs} />
  );

  return (
    <section
      className={`${styles.player} ${isVideo ? styles.videoPlayer : styles.audioPlayer}`}
      data-meeting-player
      data-subtitles-enabled={isVideo && subtitleCues.length > 0 ? "true" : "false"}
      aria-keyshortcuts={isVideo
        ? "Space K J L ArrowLeft ArrowRight F M C Shift+Period Shift+Comma"
        : "Space K J L ArrowLeft ArrowRight M Shift+Period Shift+Comma"}
      aria-label={isVideo ? "会議動画プレイヤー" : "会議音声プレイヤー"}
    >
      {/* Empty cell keeps the download button in the right-hand column. */}
      {isVideo && <div className={styles.playerHeading} data-player-heading />}
      {isVideo && downloadUrl && (
        <a
          className={styles.mediaDownloadButton}
          href={downloadUrl}
          download
          aria-label="この動画をダウンロード"
        >
          <span aria-hidden="true"><Download size={16} /></span>
          動画をダウンロード
        </a>
      )}
      {isVideo ? (
        <div className={styles.videoStage} data-media-stage>
          <video controls playsInline preload="metadata" src={mediaUrl} data-meeting-media>
            お使いのブラウザは動画再生に対応していません。
          </video>
          {subtitleCues.length > 0 && (
            <>
              <div
                className={styles.subtitleOverlay}
                data-subtitle-overlay
                aria-hidden="true"
                hidden
              >
                <span className={styles.subtitleSpeaker} data-subtitle-speaker />
                <p data-subtitle-text />
              </div>
              <div data-subtitle-cues aria-hidden="true" hidden>
                {subtitleCues.map((cue) => (
                  <span
                    key={cue.id}
                    data-subtitle-cue
                    data-subtitle-start-ms={cue.startMs}
                    data-subtitle-end-ms={cue.endMs}
                    data-subtitle-speaker-id={cue.speakerId ?? undefined}
                    data-subtitle-speaker-name={cue.speakerName}
                  >
                    {cue.text}
                  </span>
                ))}
              </div>
            </>
          )}
          <div className={styles.videoControls} data-custom-media-controls>
            {chapterTrack}
            <div className={styles.controlRow}>
              <div className={styles.primaryControls}>
                <button type="button" className={styles.controlButton} data-play-toggle>
                  <span data-play-icon data-vector-play-icon aria-hidden="true">
                    <Play size={18} data-play-glyph />
                    <Pause size={18} data-pause-glyph />
                  </span>
                  <span className={styles.visuallyHidden} data-play-label>再生</span>
                </button>
                <VideoVolumeControl />
                <output className={styles.mediaTime} data-media-time>0:00 / --:--</output>
                {orderedChapters.length > 0 && (
                  <button
                    type="button"
                    className={styles.videoChapterStatus}
                    data-open-chapters
                    title="チャプター一覧を表示"
                    onClick={openChapterList}
                  >
                    <output data-current-chapter aria-live="polite">
                      {orderedChapters[0].title}
                    </output>
                  </button>
                )}
              </div>
              <div className={styles.secondaryControls}>
                <PlaybackRateControl video />
                <div className={styles.secondaryButtonGroup} data-secondary-button-group>
                  <button
                    type="button"
                    className={`${styles.controlButton} ${styles.subtitleToggle}`}
                    data-subtitle-toggle
                    aria-keyshortcuts="C"
                    title="字幕の表示切替 (C)"
                    aria-label={subtitleCues.length > 0 ? "字幕を非表示" : "利用できる字幕がありません"}
                    aria-pressed={subtitleCues.length > 0}
                    disabled={subtitleCues.length === 0}
                  >
                    <span aria-hidden="true">CC</span>
                  </button>
                  <VideoSettings playbackUrl={mediaUrl} originalUrl={originalUrl} />
                  <button
                    type="button"
                    className={styles.controlButton}
                    data-fullscreen-toggle
                    aria-label="全画面表示"
                  >
                    <span aria-hidden="true"><Maximize size={18} /></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <audio preload="metadata" src={mediaUrl} data-meeting-media>
            お使いのブラウザは音声再生に対応していません。
          </audio>
          <div className={styles.audioControls} data-custom-media-controls>
            {chapterTrack}
            <div className={styles.audioTimeRow}>
              <output className={styles.mediaTime} data-media-time>0:00 / --:--</output>
              <output className={styles.audioStatus} data-player-status aria-live="polite">
                音声を準備中
              </output>
              {orderedChapters.length > 0 && (
                <button
                  type="button"
                  className={styles.audioChapterStatus}
                  data-open-chapters
                  title="チャプター一覧を表示"
                  onClick={openChapterList}
                >
                  <output data-current-chapter aria-live="polite">
                    {orderedChapters[0].title}
                  </output>
                </button>
              )}
            </div>
            <div className={styles.audioControlRow}>
              <PlaybackRateControl />
              <button
                type="button"
                className={styles.audioUtilityButton}
                data-skip-seconds="-10"
                aria-label="10秒戻る"
              >
                <RotateCcw size={16} aria-hidden="true" /> <span>10</span>
              </button>
              <button type="button" className={styles.audioPlayButton} data-play-toggle>
                <span data-play-icon data-vector-play-icon aria-hidden="true">
                  <Play size={20} data-play-glyph />
                  <Pause size={20} data-pause-glyph />
                </span>
                <span data-play-label>再生</span>
              </button>
              <button
                type="button"
                className={styles.audioUtilityButton}
                data-skip-seconds="10"
                aria-label="10秒進む"
              >
                <RotateCw size={16} aria-hidden="true" /> <span>10</span>
              </button>
              <button
                type="button"
                className={styles.audioUtilityButton}
                data-volume-toggle
                aria-label="ミュート"
              >
                <span data-volume-icon data-vector-volume-icon aria-hidden="true">
                  <Volume2 size={18} data-volume-on />
                  <VolumeX size={18} data-volume-off />
                </span>
              </button>
              {downloadUrl && (
                <a
                  className={`${styles.audioUtilityButton} ${styles.audioDownloadButton}`}
                  href={downloadUrl}
                  download
                  title="この音声をダウンロード"
                  aria-label="この音声をダウンロード"
                >
                  <span aria-hidden="true"><Download size={16} /></span>
                  <span className={styles.visuallyHidden}>音声をダウンロード</span>
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function TranscriptDocument({
  meetingId,
  mediaUrl,
  turns,
}: Pick<TranscriptPlayerProps, "mediaUrl" | "turns"> & { meetingId: string }) {
  if (turns.length === 0) return null;

  return (
    <div className={styles.transcriptBody}>
      <div className={styles.documentControls}>
        <span className={styles.followStatus} aria-live="polite">
          <i aria-hidden="true" />
          <span data-follow-status>再生位置を自動追従します</span>
        </span>
        <button type="button" className={styles.resumeFollowButton} data-follow-resume hidden>
          <ArrowDown size={14} aria-hidden="true" /> 自動スクロールを再開
        </button>
      </div>
      <div className={styles.document} data-transcript-document aria-label="文字起こし本文">
        {turns.map((turn, index) => (
          <article
            className={styles.turn}
            id={`transcript-turn-${index}`}
            key={turn.id}
            data-transcript-turn
          >
            <div className={styles.meta}>
              <button
                type="button"
                className={styles.timestamp}
                data-seek-ms={turn.startMs}
                disabled={!mediaUrl}
                aria-label={`${formatTimestamp(turn.startMs)}から再生`}
              >
                {formatTimestamp(turn.startMs)}
              </button>
              {turn.speakerId ? (
                <InlineSpeakerName
                  key={turn.speakerId + ":" + turn.speakerName}
                  meetingId={meetingId}
                  speakerId={turn.speakerId}
                  speakerName={turn.speakerName}
                />
              ) : (
                <strong>{turn.speakerName}</strong>
              )}
            </div>
            <button
              type="button"
              className={styles.transcriptText}
              data-transcript-text
              data-turn-index={index}
              data-seek-ms={turn.startMs}
              disabled={!mediaUrl}
              title="クリックした単語・文字の位置から再生"
            >
              <span data-karaoke-before />
              <span className={styles.karaokeHighlight} data-karaoke-highlight />
              <span data-karaoke-after>
                {turn.words.map((word) => word.text).join("")}
              </span>
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

export function TranscriptRuntime({ turns }: Pick<TranscriptPlayerProps, "turns">) {
  const compactTimeline = JSON.stringify(
    turns.map((turn) =>
      turn.words.map((word) => [word.startMs, word.endMs, Array.from(word.text).length]),
    ),
  );

  return (
    <>
      <script
        type="application/json"
        data-transcript-timeline
        dangerouslySetInnerHTML={{ __html: compactTimeline }}
      />
      <Script src="/transcript-player.js?v=20260930-3" strategy="afterInteractive" />
    </>
  );
}
