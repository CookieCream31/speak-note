"use client";

import { MicrophoneStartToggle } from "./microphone-start-toggle";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  startAzureSpeechStream,
  type AzureSpeechStreamController,
  type AzureSpeechDiagnostic,
} from "@/lib/azure-speech-stream";
import {
  detectDisplayCaptureSupport,
  detectMicrophoneCaptureSupport,
  displayCaptureSupportMessage,
  microphoneCaptureSupportMessage,
  type DisplayCaptureSupport,
} from "@/lib/display-capture";
import {
  formatElapsedTime,
  LiveCaptureMixer,
  microphoneSpeechConstraints,
  screenRecordingBitrate,
} from "@/lib/live-capture";
import { publishLiveTranscriptEvent } from "@/lib/live-transcript-events";
import { takePendingLiveCapture } from "@/lib/pending-live-capture";

import styles from "./live-meeting-recorder.module.css";

type RecorderPhase = "idle" | "connecting" | "recording" | "stopping" | "finalized" | "error";

interface LiveMeetingRecorderProps {
  meetingId: string;
  captureMode?: "display" | "microphone";
  existingRecording: boolean;
  transcriptionReady: boolean;
  hasFinalTranscript: boolean;
  finalProcessing: boolean;
  aiDisabled: boolean;
  initialDisplayStream?: MediaStream | null;
  initialIncludeMicrophone?: boolean;
  autoStart?: boolean;
  resumePendingCapture?: boolean;
  onFinalized?: () => void;
  onRecordingStateChange?: (active: boolean) => void;
}

function websocketUrl(meetingId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/meetings/${meetingId}/live/ws`;
}

function videoRecorderMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function audioRecorderMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

const MAX_WEBSOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_WEBSOCKET_WAIT_MS = 30_000;
const WEBSOCKET_KEEPALIVE_MS = 20_000;
const recorderStopPromises = new WeakMap<MediaRecorder, Promise<void>>();

function observeMediaRecorderStop(recorder: MediaRecorder): Promise<void> {
  const existing = recorderStopPromises.get(recorder);
  if (existing) return existing;
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorderStopPromises.set(recorder, stopped);
  return stopped;
}

async function waitForSocketCapacity(websocket: WebSocket): Promise<void> {
  const startedAt = performance.now();
  while (websocket.bufferedAmount > MAX_WEBSOCKET_BUFFER_BYTES) {
    if (websocket.readyState !== WebSocket.OPEN) {
      throw new Error("録画データの送信中に接続が切れました");
    }
    if (performance.now() - startedAt > MAX_WEBSOCKET_WAIT_MS) {
      throw new Error("録画データの送信が追いついていません。通信状態を確認してください");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

async function stopMediaRecorder(recorder: MediaRecorder | null): Promise<void> {
  if (!recorder) return;
  const stopped = observeMediaRecorderStop(recorder);
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
}

function ChangeDisplayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="m15 8 2-2 2 2M17 6v5" />
    </svg>
  );
}

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      {muted && <path className={styles.muteSlash} d="M3 3l18 18" />}
    </svg>
  );
}

function StopRecordingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LiveMeetingRecorder({
  meetingId,
  captureMode = "display",
  existingRecording,
  transcriptionReady,
  finalProcessing,
  aiDisabled,
  initialDisplayStream = null,
  initialIncludeMicrophone = false,
  autoStart = false,
  resumePendingCapture = false,
  onFinalized,
  onRecordingStateChange,
}: LiveMeetingRecorderProps) {
  const router = useRouter();
  const isMicrophoneOnly = captureMode === "microphone";
  const [phase, setPhase] = useState<RecorderPhase>(existingRecording ? "finalized" : "idle");
  const [includeMicrophone, setIncludeMicrophone] = useState(initialIncludeMicrophone);
  const [microphoneMuted, setMicrophoneMuted] = useState(!initialIncludeMicrophone);
  const [microphoneChanging, setMicrophoneChanging] = useState(false);
  const [displayInterrupted, setDisplayInterrupted] = useState(false);
  const [switchingDisplay, setSwitchingDisplay] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [hasSystemAudio, setHasSystemAudio] = useState<boolean | null>(null);
  const [displayCaptureSupport, setDisplayCaptureSupport] =
    useState<DisplayCaptureSupport | null>(null);
  const [message, setMessage] = useState<string>(
    existingRecording
      ? isMicrophoneOnly
        ? "録音済みです。"
        : "録画済みです。会議ノートの「要約を再生成」から生成できます。"
      : "",
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const azureSpeechRef = useRef<AzureSpeechStreamController | null>(null);
  const speechDiagnosticsRef = useRef<AzureSpeechDiagnostic[]>([]);
  const [hasSpeechDiagnostics, setHasSpeechDiagnostics] = useState(false);
  const downloadSpeechDiagnostics = () => {
    const url = URL.createObjectURL(new Blob([
      JSON.stringify({ version: 1, events: speechDiagnosticsRef.current }, null, 2),
    ], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "speech-diagnostics.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const streamsRef = useRef<MediaStream[]>([]);
  const captureMixerRef = useRef<LiveCaptureMixer | null>(null);
  const startedAtRef = useRef(0);
  const audioChunkStartRef = useRef(0);
  const audioSequenceRef = useRef(0);
  const videoPartSequenceRef = useRef(0);
  const currentVideoPartRef = useRef<number | null>(null);
  const currentVideoPartStartRef = useRef(0);
  const videoPartCloseRef = useRef<Promise<void>>(Promise.resolve());
  const chunkMsRef = useRef(15_000);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const keepaliveTimerRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const recordingActiveRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDisplayCaptureSupport(
        isMicrophoneOnly
          ? detectMicrophoneCaptureSupport()
          : detectDisplayCaptureSupport(),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMicrophoneOnly]);

  const currentElapsedMs = useCallback(() => (
    startedAtRef.current > 0
      ? Math.max(0, Math.round(performance.now() - startedAtRef.current))
      : 0
  ), []);

  const queuePayload = useCallback((payload: Record<string, unknown>, blob?: Blob) => {
    const websocket = websocketRef.current;
    if (!websocket) throw new Error("Backendへ接続されていません");
    sendQueueRef.current = sendQueueRef.current.then(async () => {
      if (blob) {
        await waitForSocketCapacity(websocket);
      }
      if (websocket.readyState !== WebSocket.OPEN) {
        throw new Error("録画データの送信中に接続が切れました");
      }
      websocket.send(JSON.stringify(payload));
      if (blob) websocket.send(await blob.arrayBuffer());
    });
  }, []);

  const startVideoPart = useCallback((displayStream: MediaStream, startMs: number) => {
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") {
      throw new Error("録画用の映像トラックを取得できませんでした");
    }
    const mimeType = videoRecorderMimeType();
    const recorder = new MediaRecorder(
      new MediaStream([videoTrack]),
      {
        videoBitsPerSecond: screenRecordingBitrate(videoTrack),
        ...(mimeType ? { mimeType } : {}),
      },
    );
    observeMediaRecorderStop(recorder);
    const partSequence = videoPartSequenceRef.current++;
    let chunkSequence = 0;
    currentVideoPartRef.current = partSequence;
    currentVideoPartStartRef.current = startMs;
    queuePayload({
      type: "video_part_start",
      part_sequence: partSequence,
      start_ms: startMs,
      mime_type: recorder.mimeType || "video/webm",
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      queuePayload({
        type: "video_chunk",
        part_sequence: partSequence,
        chunk_sequence: chunkSequence++,
      }, event.data);
    });
    videoRecorderRef.current = recorder;
    // Keep high-bitrate video chunks comfortably below the WebSocket size limit.
    recorder.start(Math.min(chunkMsRef.current, 5_000));
  }, [queuePayload]);

  const stopVideoPart = useCallback(async (endMs: number) => {
    const recorder = videoRecorderRef.current;
    const partSequence = currentVideoPartRef.current;
    if (!recorder || partSequence === null) {
      await videoPartCloseRef.current;
      return;
    }
    videoRecorderRef.current = null;
    currentVideoPartRef.current = null;
    const partStartMs = currentVideoPartStartRef.current;
    const closePart = async () => {
      await stopMediaRecorder(recorder);
      const safeEndMs = Math.max(partStartMs + 1, endMs);
      queuePayload({
        type: "video_part_end",
        part_sequence: partSequence,
        end_ms: safeEndMs,
      });
    };
    videoPartCloseRef.current = closePart();
    await videoPartCloseRef.current;
  }, [queuePayload]);

  const releaseMedia = useCallback(() => {
    if (keepaliveTimerRef.current !== null) {
      window.clearInterval(keepaliveTimerRef.current);
      keepaliveTimerRef.current = null;
    }
    void azureSpeechRef.current?.stop();
    azureSpeechRef.current = null;
    if (audioRecorderRef.current?.state === "recording") audioRecorderRef.current.stop();
    if (videoRecorderRef.current?.state === "recording") videoRecorderRef.current.stop();
    audioRecorderRef.current = null;
    videoRecorderRef.current = null;
    captureMixerRef.current?.stop();
    captureMixerRef.current = null;
    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) track.stop();
    }
    streamsRef.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => {
    websocketRef.current?.close();
    releaseMedia();
  }, [releaseMedia]);

  useEffect(() => {
    if (phase !== "recording") return;
    const updateElapsed = () => {
      setElapsedMs(currentElapsedMs());
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [currentElapsedMs, phase]);

  useEffect(() => {
    onRecordingStateChange?.(
      phase === "connecting" || phase === "recording" || phase === "stopping",
    );
  }, [onRecordingStateChange, phase]);

  const stopRecording = useCallback(async () => {
    if (stoppingRef.current || !recordingActiveRef.current) return;
    recordingActiveRef.current = false;
    stoppingRef.current = true;
    const stoppedAtMs = currentElapsedMs();
    setElapsedMs(stoppedAtMs);
    setPhase("stopping");
    setMessage(isMicrophoneOnly ? "最後の録音データを保存しています…" : "最後の録画データを保存しています…");
    try {
      const azureSpeech = azureSpeechRef.current;
      azureSpeechRef.current = null;
      if (azureSpeech) {
        try {
          await azureSpeech.stop();
        } catch {
          // The recording still needs to be saved if Azure recognition already stopped.
        }
      }
      if (!isMicrophoneOnly) await stopVideoPart(stoppedAtMs);
      await stopMediaRecorder(audioRecorderRef.current);
      audioRecorderRef.current = null;
      await sendQueueRef.current;
      const websocket = websocketRef.current;
      if (websocket?.readyState !== WebSocket.OPEN) {
        throw new Error("接続が切れました。受信済みデータから最終処理を開始します。");
      }
      websocket.send(JSON.stringify({ type: "stop" }));
    } catch (error) {
      setPhase("error");
      setMessage(
        error instanceof Error
          ? error.message
          : isMicrophoneOnly
            ? "録音を保存できませんでした"
            : "録画を保存できませんでした",
      );
      websocketRef.current?.close();
    }
    releaseMedia();
  }, [currentElapsedMs, isMicrophoneOnly, releaseMedia, stopVideoPart]);

  const handleDisplayEnded = useCallback((displayStream: MediaStream) => {
    const captureMixer = captureMixerRef.current;
    if (!captureMixer?.isCurrentDisplay(displayStream)) return;
    const endedAtMs = currentElapsedMs();
    captureMixer.handleDisplayEnded(displayStream);
    void stopVideoPart(endedAtMs).catch((error: unknown) => {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "映像Partを保存できませんでした");
    });
    setDisplayInterrupted(true);
    setHasSystemAudio(false);
    setMessage("画面共有が停止しました。録画セッションは継続しています。左の画面共有ボタンから共有する画面を選び直してください。");
  }, [currentElapsedMs, stopVideoPart]);

  const startRecording = useCallback(async () => {
    const recordingLabel = isMicrophoneOnly ? "録音" : "画面共有";
    setPhase("connecting");
    setMessage(isMicrophoneOnly ? "マイクを準備しています…" : "画面共有を準備しています…");
    setDisplayInterrupted(false);
    stoppingRef.current = false;
    try {
      const support = isMicrophoneOnly
        ? detectMicrophoneCaptureSupport()
        : detectDisplayCaptureSupport();
      setDisplayCaptureSupport(support);
      if (support !== "supported") {
        throw new Error(
          isMicrophoneOnly
            ? microphoneCaptureSupportMessage(support)
            : displayCaptureSupportMessage(support),
        );
      }

      let displayStream: MediaStream | null = null;
      let microphoneStream: MediaStream | null = null;
      let audioCaptureStream: MediaStream;
      let systemAudioTracks: MediaStreamTrack[] = [];
      let shouldIncludeMicrophone = true;

      if (isMicrophoneOnly) {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneSpeechConstraints(),
          video: false,
        });
        streamsRef.current = [microphoneStream];
        for (const track of microphoneStream.getAudioTracks()) track.enabled = !microphoneMuted;
        audioCaptureStream = microphoneStream;
        setIncludeMicrophone(true);
        setHasSystemAudio(null);
      } else {
        const pendingCapture = resumePendingCapture
          ? takePendingLiveCapture(meetingId)
          : null;
        if (pendingCapture) setIncludeMicrophone(pendingCapture.includeMicrophone);
        displayStream = initialDisplayStream ?? pendingCapture?.stream ?? null;
        shouldIncludeMicrophone = pendingCapture?.includeMicrophone ?? !microphoneMuted;
        setMicrophoneMuted(!shouldIncludeMicrophone);
        const preparedAudioContext = pendingCapture?.audioContext ?? null;
        if (
          !displayStream
          || !displayStream.getVideoTracks().some((track) => track.readyState === "live")
        ) {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
        }
        streamsRef.current = [displayStream];
        systemAudioTracks = displayStream.getAudioTracks();
        setHasSystemAudio(systemAudioTracks.length > 0);

        if (shouldIncludeMicrophone) {
          microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: microphoneSpeechConstraints(),
            video: false,
          });
          streamsRef.current.push(microphoneStream);
        }

        if (!videoRef.current) throw new Error("録画プレビューを初期化できませんでした");
        const captureMixer = await LiveCaptureMixer.create(
          displayStream,
          microphoneStream,
          videoRef.current,
          preparedAudioContext,
        );
        captureMixerRef.current = captureMixer;
        const videoTrack = captureMixer.currentVideoTrack();
        if (!videoTrack || videoTrack.readyState !== "live") {
          throw new Error("録画用の映像トラックを作成できませんでした。共有画面を選び直してください");
        }
        audioCaptureStream = captureMixer.audioStream;
      }

      if (!audioCaptureStream.getAudioTracks().some((track) => track.readyState === "live")) {
        throw new Error("録音用の音声トラックを取得できませんでした。マイクの設定を確認してください");
      }

      const audioMimeType = audioRecorderMimeType();
      const audioRecorder = new MediaRecorder(audioCaptureStream, {
        audioBitsPerSecond: 128_000,
        ...(audioMimeType ? { mimeType: audioMimeType } : {}),
      });
      observeMediaRecorderStop(audioRecorder);
      audioRecorderRef.current = audioRecorder;
      const videoMimeType = isMicrophoneOnly ? undefined : videoRecorderMimeType();
      const websocket = new WebSocket(websocketUrl(meetingId));
      websocket.binaryType = "arraybuffer";
      websocketRef.current = websocket;

      const started = await new Promise<{
        chunkMs: number;
        transcriptionProvider: "whisperx" | "azure_speech";
      }>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("Backendへの接続がタイムアウトしました")),
          10_000,
        );
        websocket.addEventListener("open", () => {
          websocket.send(JSON.stringify(
            isMicrophoneOnly
              ? {
                  type: "start",
                  capture_mode: "audio",
                  mime_type: audioRecorder.mimeType || "audio/webm",
                  has_system_audio: false,
                }
              : {
                  type: "start",
                  capture_mode: "split",
                  audio_mime_type: audioRecorder.mimeType || "audio/webm",
                  video_mime_type: videoMimeType || "video/webm",
                  has_system_audio: systemAudioTracks.length > 0,
                },
          ));
        });
        websocket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const payload = JSON.parse(event.data) as {
            type: string;
            chunk_ms?: number;
            transcription_provider?: "whisperx" | "azure_speech";
            message?: string;
          };
          if (payload.type === "started") {
            window.clearTimeout(timeout);
            resolve({
              chunkMs: payload.chunk_ms ?? 15_000,
              transcriptionProvider: payload.transcription_provider ?? "whisperx",
            });
          } else if (payload.type === "error") {
            window.clearTimeout(timeout);
            reject(new Error(payload.message ?? `${recordingLabel}を開始できませんでした`));
          }
        });
        websocket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("Backendへ接続できませんでした"));
        }, { once: true });
      });

      websocket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const payload = JSON.parse(event.data) as {
          type: string;
          message?: string;
          duration_ms?: number;
          result_id?: string;
          segment_id?: string;
        };
        if (
          payload.type === "azure_result_saved"
          && payload.result_id
          && payload.segment_id
        ) {
          publishLiveTranscriptEvent({
            type: "persisted",
            meetingId,
            resultId: payload.result_id,
            segmentId: payload.segment_id,
          });
        } else if (payload.type === "finalized") {
          if (typeof payload.duration_ms === "number") setElapsedMs(payload.duration_ms);
          setPhase("finalized");
          setMessage(
            isMicrophoneOnly
              ? "録音を保存しました。リアルタイム版を会議ノートで確認し、「要約を再生成」から生成できます。"
              : "録画を保存しました。動画変換後、会議ノートの「要約を再生成」から生成できます。",
          );
          router.refresh();
          onFinalized?.();
        } else if (payload.type === "error") {
          recordingActiveRef.current = false;
          releaseMedia();
          setPhase("error");
          setMessage(payload.message ?? `${recordingLabel}処理に失敗しました`);
        }
      });
      websocket.addEventListener("close", () => {
        if (!recordingActiveRef.current) return;
        recordingActiveRef.current = false;
        releaseMedia();
        setPhase("error");
        setMessage("Backendとの接続が切れました。受信済みデータから最終処理を開始します。");
      });

      speechDiagnosticsRef.current = [];
      setHasSpeechDiagnostics(false);
      publishLiveTranscriptEvent({ type: "reset", meetingId });
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      audioChunkStartRef.current = 0;
      audioSequenceRef.current = 0;
      videoPartSequenceRef.current = 0;
      currentVideoPartRef.current = null;
      videoPartCloseRef.current = Promise.resolve();
      chunkMsRef.current = started.chunkMs;
      sendQueueRef.current = Promise.resolve();
      if (started.transcriptionProvider === "azure_speech") {
        azureSpeechRef.current = await startAzureSpeechStream({
          tokenUrl: `/api/v1/meetings/${meetingId}/live/azure-token`,
          audioStream: audioCaptureStream,
          getTimelinePositionMs: currentElapsedMs,
          onDiagnostic: (event) => {
            const events = speechDiagnosticsRef.current;
            // Retain low-frequency finals/reconnects longer than hypotheses.
            if (event.event === "interim" && events.at(-1)?.event === "interim") {
              events[events.length - 1] = event;
            } else {
              events.push(event);
              if (events.length > 300) events.shift();
            }
            setHasSpeechDiagnostics(true);
          },
          onInterim: (result) => {
            publishLiveTranscriptEvent({
              type: "upsert",
              meetingId,
              resultId: result.resultId,
              startMs: result.startMs,
              endMs: result.endMs,
              text: result.text,
              confidence: result.confidence,
              speakerLabel: result.speakerLabel,
              isFinal: false,
            });
          },
          onResult: (result) => {
            publishLiveTranscriptEvent({
              type: "upsert",
              meetingId,
              resultId: result.resultId,
              startMs: result.startMs,
              endMs: result.endMs,
              text: result.text,
              confidence: result.confidence,
              speakerLabel: result.speakerLabel,
              isFinal: true,
            });
            try {
              queuePayload({
                type: "azure_result",
                result_id: result.resultId,
                start_ms: result.startMs,
                end_ms: result.endMs,
                text: result.text,
                confidence: result.confidence,
                speaker_label: result.speakerLabel,
              });
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : "Azure認識結果を保存できませんでした",
              );
            }
          },
          onError: (errorMessage) => {
            setMessage(`Azure AI Speech: ${errorMessage}。録音データの保存は継続しています。`);
          },
        });
      }
      keepaliveTimerRef.current = window.setInterval(() => {
        queuePayload({ type: "ping" });
      }, WEBSOCKET_KEEPALIVE_MS);
      audioRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        const startMs = audioChunkStartRef.current;
        const endMs = Math.max(startMs + 1, currentElapsedMs());
        const sequence = audioSequenceRef.current++;
        audioChunkStartRef.current = endMs;
        queuePayload({
          type: isMicrophoneOnly ? "chunk" : "audio_chunk",
          sequence,
          start_ms: startMs,
          end_ms: endMs,
        }, event.data);
      });
      if (displayStream) {
        displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
          handleDisplayEnded(displayStream);
        });
      }
      recordingActiveRef.current = true;
      audioRecorder.start(started.chunkMs);
      if (displayStream) startVideoPart(displayStream, 0);
      setPhase("recording");
      setMessage(
        started.transcriptionProvider === "azure_speech"
          ? isMicrophoneOnly
            ? "録音中です。Azure AI Speechが発話ごとに文字起こしします。"
            : "録画中です。プレビュー音声だけを消音し、Azure AI Speechが発話ごとに文字起こしします。"
          : isMicrophoneOnly
            ? "録音中です。文字起こしは数十秒遅れて表示されます。"
            : "録画中です。ハウリング防止のためプレビュー音声だけを消音しています。音声は録画に保存され、文字起こしは数十秒遅れて表示されます。",
      );
    } catch (error) {
      recordingActiveRef.current = false;
      releaseMedia();
      websocketRef.current?.close();
      setPhase("error");
      setMessage(error instanceof Error ? error.message : `${recordingLabel}を開始できませんでした`);
    }
  }, [
    currentElapsedMs,
    handleDisplayEnded,
    microphoneMuted,
    initialDisplayStream,
    isMicrophoneOnly,
    meetingId,
    onFinalized,
    queuePayload,
    releaseMedia,
    resumePendingCapture,
    router,
    startVideoPart,
  ]);
  const autoStartAttemptedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartAttemptedRef.current || phase !== "idle") return;
    const timer = window.setTimeout(() => {
      if (autoStartAttemptedRef.current) return;
      autoStartAttemptedRef.current = true;
      void startRecording();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, phase, startRecording]);

  const changeDisplay = useCallback(async () => {
    if (phase !== "recording" || switchingDisplay) return;
    const captureMixer = captureMixerRef.current;
    const support = detectDisplayCaptureSupport();
    setDisplayCaptureSupport(support);
    if (!captureMixer || support !== "supported") {
      if (support !== "supported") setMessage(displayCaptureSupportMessage(support));
      return;
    }
    setSwitchingDisplay(true);
    setMessage("新しい共有画面を選択してください。録画は継続しています…");
    let replacement: MediaStream | null = null;
    let previousVideoTrack: MediaStreamTrack | null = null;
    let previousPartStopped = false;
    try {
      replacement = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streamsRef.current.push(replacement);
      const replacementStream = replacement;
      previousVideoTrack = captureMixer.currentVideoTrack();
      await stopVideoPart(currentElapsedMs());
      previousPartStopped = true;
      const systemAudioAvailable = await captureMixer.replaceDisplay(replacementStream);
      startVideoPart(replacementStream, currentElapsedMs());
      setHasSystemAudio(systemAudioAvailable);
      setDisplayInterrupted(false);
      replacementStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        handleDisplayEnded(replacementStream);
      });
      setMessage("共有画面を再開しました。録画と文字起こしは同じタイムラインで継続しています。");
    } catch (error) {
      if (replacement && !captureMixer.isCurrentDisplay(replacement)) {
        for (const track of replacement.getTracks()) track.stop();
      }
      if (
        previousPartStopped
        && previousVideoTrack?.readyState === "live"
        && currentVideoPartRef.current === null
      ) {
        try {
          startVideoPart(new MediaStream([previousVideoTrack]), currentElapsedMs());
        } catch {
          setDisplayInterrupted(true);
        }
      }
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? displayInterrupted
            ? "共有画面の再選択をキャンセルしました。録画セッションは継続していますが、画面共有は停止中です。"
            : "共有画面の変更をキャンセルしました。録画は継続しています。"
          : error instanceof Error
            ? `共有画面を変更できませんでした: ${error.message}`
            : "共有画面を変更できませんでした。録画は継続しています。",
      );
    } finally {
      setSwitchingDisplay(false);
    }
  }, [
    currentElapsedMs,
    displayInterrupted,
    handleDisplayEnded,
    phase,
    startVideoPart,
    stopVideoPart,
    switchingDisplay,
  ]);

  const toggleMicrophone = useCallback(async () => {
    if (phase !== "recording" || microphoneChanging) return;
    const nextMuted = !microphoneMuted;
    setMicrophoneChanging(true);
    try {
      if (!isMicrophoneOnly && !includeMicrophone && !nextMuted) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneSpeechConstraints(), video: false,
        });
        if (!recordingActiveRef.current || !captureMixerRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        try { captureMixerRef.current.attachMicrophone(stream); }
        catch (caught) { for (const track of stream.getTracks()) track.stop(); throw caught; }
        streamsRef.current.push(stream);
        setIncludeMicrophone(true);
      }
      if (isMicrophoneOnly) {
        for (const stream of streamsRef.current) {
          for (const track of stream.getAudioTracks()) track.enabled = !nextMuted;
        }
      } else { captureMixerRef.current?.setMicrophoneMuted(nextMuted); }
      setMicrophoneMuted(nextMuted);
      setMessage(nextMuted ? "マイクをミュートしました。録音・共有音声は継続しています。" : "マイクのミュートを解除しました。");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "マイクを有効にできません。権限を確認してください。");
    } finally { setMicrophoneChanging(false); }
  }, [includeMicrophone, isMicrophoneOnly, microphoneMuted, microphoneChanging, phase]);


  return (
    <div className={styles.recorder}>
      {(phase === "idle" || phase === "error") && (
        <MicrophoneStartToggle muted={microphoneMuted} disabled={false}
          onChange={(muted) => { setMicrophoneMuted(muted); setIncludeMicrophone(!muted); }} />
      )}
      {!isMicrophoneOnly && includeMicrophone && (
        <p className={styles.microphoneHint}>
          共有音声の回り込みを防ぐため、ヘッドホンの使用を推奨します。
        </p>
      )}
      <div className={styles.previewFrame} data-audio-only={isMicrophoneOnly}>
        {isMicrophoneOnly ? (
          <div className={styles.audioPreview}>
            <span className={styles.audioPreviewIcon} data-muted={microphoneMuted}>
              <MicrophoneIcon muted={microphoneMuted} />
            </span>
            <strong>マイク音声を録音</strong>
            <span>画面共有は行いません</span>
          </div>
        ) : (
          <video ref={videoRef} className={styles.preview} muted playsInline />
        )}
        {(phase === "recording" || phase === "stopping") && (
          <div
            className={styles.elapsed}
            data-stopping={phase === "stopping"}
            data-display-interrupted={!isMicrophoneOnly && displayInterrupted}
            aria-live="off"
          >
            <i aria-hidden="true" />
            <span>
              {phase === "stopping"
                ? "保存中"
                : isMicrophoneOnly
                  ? "録音中"
                  : displayInterrupted
                    ? "録画継続中"
                    : "録画中"}
            </span>
            <time dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}>
              {formatElapsedTime(elapsedMs)}
            </time>
          </div>
        )}
        {!isMicrophoneOnly && displayInterrupted && phase === "recording" && (
          <div className={styles.displayStopped} role="status">
            <span className={styles.displayStoppedIcon} aria-hidden="true">
              <ChangeDisplayIcon />
            </span>
            <strong>画面共有が停止しました</strong>
            <span>
              録画は継続中です。下の青い画面共有ボタンから共有する画面を選び直してください。
            </span>
          </div>
        )}
      </div>
      {existingRecording ? (
        isMicrophoneOnly ? (
          <div className={styles.finalProcessing}>
            <p>
              {finalProcessing
                ? aiDisabled
                  ? "確定版の文字起こしを処理しています。"
                  : "確定版の文字起こしとAI議事録を処理しています。"
                : "録音済みです。下の会議ノートで処理結果を確認できます。"}
            </p>
          </div>
        ) : (
          <div className={styles.finalProcessing}>
            <p>
              {transcriptionReady
                ? "会議ノートの「要約を再生成」からAIとテンプレートを選べます。"
                : "録画を再生・文字起こしできる形式へ変換しています。"}
            </p>
          </div>
        )
      ) : phase !== "recording" && phase !== "stopping" ? (
        <>
          <button
            type="button"
            disabled={
              existingRecording
              || phase === "connecting"
              || displayCaptureSupport !== "supported"
            }
            onClick={() => void startRecording()}
          >
            {phase === "connecting"
              ? "接続中…"
              : displayCaptureSupport === null
                ? "対応状況を確認中…"
                : displayCaptureSupport === "supported"
                  ? isMicrophoneOnly
                    ? "録音を開始"
                    : "画面共有を開始"
                  : isMicrophoneOnly
                    ? "録音を利用できません"
                    : "画面共有を利用できません"}
          </button>
          {displayCaptureSupport && displayCaptureSupport !== "supported" && (
            <p className={styles.compatibility} role="status">
              {isMicrophoneOnly
                ? microphoneCaptureSupportMessage(displayCaptureSupport)
                : displayCaptureSupportMessage(displayCaptureSupport)}
            </p>
          )}
        </>
      ) : phase === "recording" ? (
        <div
          className={styles.recordingControls}
          role="toolbar"
          aria-label={isMicrophoneOnly ? "録音操作" : "録画操作"}
        >
          {!isMicrophoneOnly && (
            <button
              className={`${styles.iconButton} ${styles.displayButton}`}
              data-control="display"
              data-interrupted={displayInterrupted}
              type="button"
              disabled={switchingDisplay}
              aria-label={
                switchingDisplay
                  ? "共有画面を選択中"
                  : displayInterrupted
                    ? "共有画面を選んで再開"
                    : "共有画面を変更"
              }
              title={
                switchingDisplay
                  ? "共有画面を選択中…"
                  : displayInterrupted
                    ? "共有画面を選んで再開"
                    : "共有画面を変更"
              }
              onClick={() => void changeDisplay()}
            >
              <ChangeDisplayIcon />
            </button>
          )}
          <button
            className={`${styles.iconButton} ${styles.microphoneButton} ${microphoneMuted ? styles.mutedButton : ""}`}
            data-control="microphone"
            data-muted={microphoneMuted}
            type="button"
            disabled={microphoneChanging}
            aria-pressed={microphoneMuted}
            aria-label={
              microphoneMuted
                  ? "マイクのミュートを解除"
                  : "マイクをミュート"
            }
            title={
              microphoneMuted
                ? "マイクのミュートを解除"
                : "マイクをミュート"
            }
            onClick={() => void toggleMicrophone()}
          >
            <MicrophoneIcon muted={microphoneMuted} />
          </button>
          <button
            className={`${styles.iconButton} ${styles.stopIconButton}`}
            type="button"
            aria-label={isMicrophoneOnly ? "録音を終了して確定" : "録画を終了して確定"}
            title={isMicrophoneOnly ? "録音を終了して確定" : "録画を終了して確定"}
            onClick={() => void stopRecording()}
          >
            <StopRecordingIcon />
          </button>
        </div>
      ) : (
        <button
          className={styles.stopButton}
          type="button"
          disabled={phase === "stopping"}
          onClick={() => void stopRecording()}
        >
          保存中…
        </button>
      )}
      {!isMicrophoneOnly && hasSystemAudio === false && !displayInterrupted && (
        <p className={styles.warning}>
          共有元のシステム音声を取得できません。
          {includeMicrophone && !microphoneMuted
            ? "現在はマイク音声だけを録音しています。"
            : "現在は音声が録音されていません。"}
        </p>
      )}
      {message && (
        <p className={phase === "error" ? styles.error : styles.message}>{message}</p>
      )}
      {hasSpeechDiagnostics && (
        <details>
          <summary>文字起こしの診断情報</summary>
          <p>接続状況・認識時刻・話者番号を保存します。音声、発言本文、APIキーは含みません。</p>
          <button type="button" onClick={downloadSpeechDiagnostics}>診断情報を保存</button>
        </details>
      )}
    </div>
  );
}
