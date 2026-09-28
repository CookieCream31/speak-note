import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

export interface AzureSpeechResult {
  resultId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  speakerLabel: string;
}

interface AzureSpeechToken {
  token: string;
  region: string;
  language: string;
  expires_in_seconds: number;
}

export interface AzureSpeechDiagnostic {
  event: "interim" | "final" | "fallback" | "reconnect" | "started" | "stopped";
  generation: number;
  atMs: number;
  startMs?: number;
  endMs?: number;
  rawSpeakerId?: string;
  speakerLabel?: string;
  characters?: number;
  resultId?: string;
}

interface StartAzureSpeechStreamOptions {
  tokenUrl: string;
  audioStream: MediaStream;
  getTimelinePositionMs?: () => number;
  onInterim?: (result: AzureSpeechResult) => void;
  onDiagnostic?: (event: AzureSpeechDiagnostic) => void;
  onResult: (result: AzureSpeechResult) => void;
  onError: (message: string) => void;
}

export interface AzureSpeechStreamController {
  stop: () => Promise<void>;
}

const AZURE_SPEECH_INTERIM_UI_INTERVAL_MS = 80;
const AZURE_SPEECH_STABLE_PARTIAL_RESULT_THRESHOLD = 3;
const AZURE_SPEECH_WATCHDOG_INTERVAL_MS = 2_000;
const AZURE_SPEECH_AUDIO_STALL_TIMEOUT_MS = 5_000;
const AZURE_SPEECH_AUDIBLE_RESULT_TIMEOUT_MS = 15_000;
const AZURE_SPEECH_PCM_SAMPLE_RATE = 16_000;
const AZURE_SPEECH_PCM_BUFFER_SIZE = 4_096;
const AZURE_SPEECH_WORKLET_URL = "/azure-speech-pcm-worklet.js?v=stateful-pcm-v1";

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

interface AzureSpeechAudioInput {
  stream: MediaStream | SpeechSDK.AudioInputStream;
  close: () => void;
  health: {
    lastFrameAtMs: number;
    lastAudibleFrameAtMs: number;
    bytesWritten: number;
  } | null;
}

interface AzureSpeechPcmMessage {
  type: "pcm";
  buffer: ArrayBuffer;
  level: number;
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext
    ?? (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
    ?? null;
}

export function resampleToPcm16Mono(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = AZURE_SPEECH_PCM_SAMPLE_RATE,
): ArrayBuffer {
  if (input.length === 0 || inputSampleRate <= 0 || outputSampleRate <= 0) {
    return new ArrayBuffer(0);
  }
  const outputLength = Math.max(1, Math.round(
    input.length * outputSampleRate / inputSampleRate,
  ));
  const output = new ArrayBuffer(outputLength * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(output);
  const sourceStep = inputSampleRate / outputSampleRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = Math.min(input.length - 1, index * sourceStep);
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const sample = input[leftIndex] + (input[rightIndex] - input[leftIndex]) * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcmValue = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, Math.round(pcmValue), true);
  }
  return output;
}

async function createAzureSpeechAudioInput(
  audioStream: MediaStream,
): Promise<AzureSpeechAudioInput> {
  const AudioContextClass = getAudioContextConstructor();
  if (!AudioContextClass) {
    return { stream: audioStream, close: () => undefined, health: null };
  }

  const format = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(
    AZURE_SPEECH_PCM_SAMPLE_RATE,
    16,
    1,
  );
  const pushStream = SpeechSDK.AudioInputStream.createPushStream(format);
  const context = new AudioContextClass({
    latencyHint: "interactive",
    sampleRate: AZURE_SPEECH_PCM_SAMPLE_RATE,
  });
  const source = context.createMediaStreamSource(audioStream);
  let audioNode: AudioNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let closed = false;
  const health = {
    lastFrameAtMs: Date.now(),
    lastAudibleFrameAtMs: 0,
    bytesWritten: 0,
  };

  const writePcm = (pcm: ArrayBuffer, level: number) => {
    if (closed || pcm.byteLength === 0) return;
    pushStream.write(pcm);
    health.lastFrameAtMs = Date.now();
    health.bytesWritten += pcm.byteLength;
    if (level >= 0.01) health.lastAudibleFrameAtMs = health.lastFrameAtMs;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (processor) processor.onaudioprocess = null;
    if (worklet) worklet.port.onmessage = null;
    source.disconnect();
    audioNode?.disconnect();
    pushStream.close();
    format.close();
    void context.close().catch(() => undefined);
  };

  try {
    if (typeof AudioWorkletNode !== "undefined") {
      try {
        await context.audioWorklet.addModule(AZURE_SPEECH_WORKLET_URL);
        worklet = new AudioWorkletNode(context, "azure-speech-pcm-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: {
            targetSampleRate: AZURE_SPEECH_PCM_SAMPLE_RATE,
            chunkSamples: AZURE_SPEECH_PCM_SAMPLE_RATE / 10,
          },
        });
        worklet.port.onmessage = (event: MessageEvent<AzureSpeechPcmMessage>) => {
          if (event.data?.type !== "pcm") return;
          writePcm(event.data.buffer, event.data.level);
        };
        audioNode = worklet;
      } catch {
        worklet = null;
      }
    }
    if (!audioNode) {
      processor = context.createScriptProcessor(AZURE_SPEECH_PCM_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (const sample of samples) sumSquares += sample * sample;
        writePcm(
          resampleToPcm16Mono(samples, event.inputBuffer.sampleRate),
          Math.sqrt(sumSquares / Math.max(1, samples.length)),
        );
        for (let index = 0; index < event.outputBuffer.numberOfChannels; index += 1) {
          event.outputBuffer.getChannelData(index).fill(0);
        }
      };
      audioNode = processor;
    }
    source.connect(audioNode);
    audioNode.connect(context.destination);
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      throw new Error("Azure AI Speech用の音声処理を開始できませんでした");
    }
  } catch (error) {
    close();
    throw error;
  }

  return { stream: pushStream, close, health };
}

export function azureTicksToMilliseconds(ticks: number): number {
  if (!Number.isFinite(ticks) || ticks < 0) return 0;
  return Math.round(ticks / 10_000);
}

export function azureRecognitionConfidence(json: string | undefined): number | null {
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as { NBest?: Array<{ Confidence?: unknown }> };
    const value = payload.NBest?.[0]?.Confidence;
    return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
  } catch {
    return null;
  }
}

async function requestToken(tokenUrl: string): Promise<AzureSpeechToken> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = "Azure AI Speechの認証トークンを取得できませんでした";
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the user-facing fallback when the response is not JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<AzureSpeechToken>;
}

function fallbackResultId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function startAzureSpeechStream(
  options: StartAzureSpeechStreamOptions,
): Promise<AzureSpeechStreamController> {
  let currentToken = await requestToken(options.tokenUrl);
  let stopped = false;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let refreshTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let watchdogTimer: number | null = null;
  let reconnectAttempts = 0;
  let lastServiceActivityAtMs = Date.now();
  let latestInterimResult: AzureSpeechResult | null = null;
  let recognizer: SpeechSDK.ConversationTranscriber | null = null;
  let audioInputCleanup: (() => void) | null = null;
  let audioInputHealth: AzureSpeechAudioInput["health"] = null;
  let recognizerGeneration = 0;
  let nextSpeakerIndex = 0;
  const trace = (event: AzureSpeechDiagnostic["event"], result?: AzureSpeechResult, rawSpeakerId?: string) => {
    // Metadata only: never record audio, transcript text, keys, or tokens.
    try {
      options.onDiagnostic?.({
        event, generation: recognizerGeneration,
        atMs: Math.max(0, options.getTimelinePositionMs?.() ?? 0),
        ...(result && {
          startMs: result.startMs, endMs: result.endMs, characters: result.text.length,
          resultId: result.resultId, speakerLabel: result.speakerLabel,
        }),
        ...(rawSpeakerId && { rawSpeakerId }),
      });
    } catch {
      // Diagnostics must never interrupt audio recognition.
    }
  };
  let interimPublishTimer: number | null = null;
  let pendingInterimResult: AzureSpeechResult | null = null;
  let lastInterimPublishedAtMs: number | null = null;
  let displayedInterimResult: AzureSpeechResult | null = null;

  const cancelPendingInterim = () => {
    if (interimPublishTimer !== null) window.clearTimeout(interimPublishTimer);
    interimPublishTimer = null;
    pendingInterimResult = null;
  };

  const publishInterim = (result: AzureSpeechResult) => {
    if (!options.onInterim) return;
    const samePhrase = displayedInterimResult?.resultId === result.resultId;
    if (samePhrase && result.text === displayedInterimResult?.text) {
      cancelPendingInterim();
      return;
    }
    const correction = samePhrase && !result.text.startsWith(displayedInterimResult!.text);
    const elapsedMs = lastInterimPublishedAtMs === null
      ? AZURE_SPEECH_INTERIM_UI_INTERVAL_MS
      : Date.now() - lastInterimPublishedAtMs;
    if (!correction && elapsedMs >= AZURE_SPEECH_INTERIM_UI_INTERVAL_MS) {
      cancelPendingInterim();
      displayedInterimResult = result;
      lastInterimPublishedAtMs = Date.now();
      options.onInterim(result);
      return;
    }
    pendingInterimResult = result;
    if (interimPublishTimer !== null) return;
    // Hold brief retractions for 250ms; keep updating the pending hypothesis
    // without resetting the timer, so genuine corrections cannot be starved.
    interimPublishTimer = window.setTimeout(() => {
      interimPublishTimer = null;
      const pending = pendingInterimResult;
      pendingInterimResult = null;
      if (!pending || stopped) return;
      displayedInterimResult = pending;
      lastInterimPublishedAtMs = Date.now();
      options.onInterim?.(pending);
    }, correction ? 250 : Math.max(0, AZURE_SPEECH_INTERIM_UI_INTERVAL_MS - elapsedMs));
  };

  const publishFinal = (result: AzureSpeechResult) => {
    if (displayedInterimResult?.resultId === result.resultId) displayedInterimResult = null;
    if (!pendingInterimResult || pendingInterimResult.resultId === result.resultId) {
      cancelPendingInterim();
      lastInterimPublishedAtMs = null;
    }
    options.onResult(result);
  };

  const stopRecognizerInstance = (
    target: SpeechSDK.ConversationTranscriber,
  ): Promise<void> => new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, 2_000);
    try {
      target.stopTranscribingAsync(finish, finish);
    } catch {
      finish();
    }
  });

  const closeRecognizerInstance = async (
    target: SpeechSDK.ConversationTranscriber | null,
    cleanupAudioInput: (() => void) | null,
    alreadyStopped = false,
  ): Promise<void> => {
    if (target) {
      if (!alreadyStopped) await stopRecognizerInstance(target);
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        try {
          target.close(finish, finish);
        } catch {
          finish();
        }
      });
    }
    cleanupAudioInput?.();
  };

  const closeRecognizer = (alreadyStopped = false): Promise<void> => {
    const previousRecognizer = recognizer;
    const previousAudioInputCleanup = audioInputCleanup;
    recognizer = null;
    audioInputCleanup = null;
    audioInputHealth = null;
    return closeRecognizerInstance(previousRecognizer, previousAudioInputCleanup, alreadyStopped);
  };

  const scheduleReconnect = (message: string, generation: number) => {
    if (
      stopped
      || stopping
      || generation !== recognizerGeneration
      || reconnectTimer !== null
    ) return;
    trace("reconnect");
    // Invalidate the old callbacks before stopping it. The SDK may still emit a
    // final or hypothesis while stopTranscribingAsync is draining the connection.
    recognizerGeneration += 1;
    if (latestInterimResult) {
      trace("fallback", latestInterimResult);
      publishFinal(latestInterimResult);
      latestInterimResult = null;
    }
    options.onError(`${message}。自動的に再接続します`);
    reconnectTimer = -1;
    const delayMs = reconnectAttempts === 0
      ? 750
      : Math.min(8_000, 1_000 * 2 ** (reconnectAttempts - 1));
    reconnectAttempts += 1;
    void closeRecognizer().finally(() => {
      if (stopped || stopping) {
        reconnectTimer = null;
        return;
      }
      reconnectTimer = window.setTimeout(async () => {
        reconnectTimer = null;
        if (stopped || stopping) return;
        try {
          await startRecognizer(Math.max(0, options.getTimelinePositionMs?.() ?? 0));
        } catch (error) {
          scheduleReconnect(
            error instanceof Error
              ? error.message
              : "Azure AI Speechへ再接続できませんでした",
            recognizerGeneration,
          );
        }
      }, delayMs);
    });
  };

  const startRecognizer = async (timelineOffsetMs: number): Promise<void> => {
    latestInterimResult = null;
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
      currentToken.token,
      currentToken.region,
    );
    speechConfig.speechRecognitionLanguage = currentToken.language;
    speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceResponse_DiarizeIntermediateResults,
      "true",
    );
    // Azure hypotheses can retract and then re-add words, which looks like the
    // live transcript is disappearing. Requiring a word to survive three
    // partial results keeps the UI responsive while filtering brief revisions.
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceResponse_StablePartialResultThreshold,
      String(AZURE_SPEECH_STABLE_PARTIAL_RESULT_THRESHOLD),
    );
    // Keep Azure's default phrase segmentation. Forcing the `Time` strategy with
    // its minimum 20-second maximum caused some browser sessions to stop
    // producing recognition events immediately after the first forced result.
    // Continuous recognition already emits a final result at each natural phrase
    // boundary and stays active until stopTranscribingAsync is called.
    const nextAudioInput = await createAzureSpeechAudioInput(options.audioStream);
    const nextAudioConfig = SpeechSDK.AudioConfig.fromStreamInput(nextAudioInput.stream);
    const nextRecognizer = new SpeechSDK.ConversationTranscriber(speechConfig, nextAudioConfig);
    const generation = ++recognizerGeneration;
    recognizer = nextRecognizer;
    audioInputCleanup = nextAudioInput.close;
    audioInputHealth = nextAudioInput.health;

    const markServiceActivity = () => {
      if (generation !== recognizerGeneration) return;
      lastServiceActivityAtMs = Date.now();
    };
    // The JavaScript Speech SDK exposes the recognition request ID as
    // SpeechRecognitionResult.resultId. During continuous recognition that ID
    // is shared by every phrase in the same session, so it cannot be used as a
    // phrase key. Generate one application ID per phrase and keep it only from
    // that phrase's interim events through its final event.
    let activePhraseId: string | null = null;
    const speakerLabels = new Map<string, string>();

    const speakerLabelFor = (speakerId: string | undefined): string => {
      const normalized = speakerId?.trim();
      if (!normalized || normalized.toLowerCase() === "unknown") {
        return "SPEAKER_UNKNOWN";
      }
      const existing = speakerLabels.get(normalized);
      if (existing) return existing;
      const label = "SPEAKER_" + String(nextSpeakerIndex).padStart(2, "0");
      nextSpeakerIndex += 1;
      speakerLabels.set(normalized, label);
      return label;
    };

    const normalizedResult = (
      result: SpeechSDK.ConversationTranscriptionResult,
      resultId: string,
      speakerLabel: string,
    ): AzureSpeechResult => {
      const relativeStartMs = azureTicksToMilliseconds(result.offset);
      const durationMs = azureTicksToMilliseconds(result.duration);
      const startMs = timelineOffsetMs + relativeStartMs;
      return {
        resultId,
        startMs,
        endMs: Math.max(startMs + 1, startMs + durationMs),
        text: (result.text ?? "").trim(),
        confidence: azureRecognitionConfidence(result.json),
        speakerLabel,
      };
    };

    const finalizeLatestInterim = () => {
      if (latestInterimResult) {
        trace("fallback", latestInterimResult);
        publishFinal(latestInterimResult);
      }
      activePhraseId = null;
      latestInterimResult = null;
    };

    nextRecognizer.transcribing = (_sender, event) => {
      if (stopped || generation !== recognizerGeneration) return;
      const result = event.result;
      const text = (result.text ?? "").trim();
      // Even an empty hypothesis proves the service is alive.
      markServiceActivity();
      if (result.reason !== SpeechSDK.ResultReason.RecognizingSpeech || !text) return;
      // Azure can revise a partial result offset while the same utterance is in
      // progress. Only final/NoMatch events close a phrase; offset never does.
      activePhraseId ??= fallbackResultId();
      // Azure can revise the speaker ID repeatedly while the phrase is still
      // being recognized. Do not let those transient IDs consume permanent
      // SPEAKER_nn labels; only a final result establishes a speaker label.
      const nextInterimResult = normalizedResult(
        result,
        activePhraseId,
        "SPEAKER_UNKNOWN",
      );
      latestInterimResult = nextInterimResult;
      trace("interim", nextInterimResult, result.speakerId);
      publishInterim(latestInterimResult);
    };
    nextRecognizer.transcribed = (_sender, event) => {
      if (stopped || generation !== recognizerGeneration) return;
      const result = event.result;
      const text = (result.text ?? "").trim();
      markServiceActivity();
      const finalResult = normalizedResult(
        result, fallbackResultId(), "SPEAKER_UNKNOWN",
      );
      // A delayed final for an earlier interval must not consume the ID or
      // pending UI update of the next phrase already being recognized.
      const isEarlierResult = latestInterimResult !== null
        && finalResult.startMs < latestInterimResult.startMs
        && finalResult.endMs <= latestInterimResult.startMs;
      if (result.reason !== SpeechSDK.ResultReason.RecognizedSpeech || !text) {
        if (!isEarlierResult) finalizeLatestInterim();
        return;
      }
      reconnectAttempts = 0;
      finalResult.speakerLabel = speakerLabelFor(result.speakerId);
      if (!isEarlierResult) {
        finalResult.resultId = activePhraseId ?? finalResult.resultId;
        activePhraseId = null;
        latestInterimResult = null;
      }
      trace("final", finalResult, result.speakerId);
      publishFinal(finalResult);
    };
    nextRecognizer.sessionStopped = () => {
      scheduleReconnect("Azure AI Speechの認識セッションが停止しました", generation);
    };
    nextRecognizer.sessionStarted = () => {
      markServiceActivity();
      trace("started");
    };
    nextRecognizer.canceled = (_sender, event) => {
      if (event.reason !== SpeechSDK.CancellationReason.Error) return;
      const errorCode = "errorCode" in event
        ? " (code: " + String(event.errorCode) + ")"
        : "";
      const detail = event.errorDetails || "Azure AI Speechの連続認識が停止しました";
      scheduleReconnect(
        detail + errorCode,
        generation,
      );
    };

    try {
      await new Promise<void>((resolve, reject) => {
        nextRecognizer.startTranscribingAsync(resolve, reject);
      });
      markServiceActivity();
    } catch (error) {
      if (generation === recognizerGeneration) await closeRecognizer();
      throw error;
    }
  };

  const scheduleTokenRefresh = (expiresInSeconds: number) => {
    const refreshAfterMs = Math.max(
      30_000,
      Math.min(8 * 60_000, (expiresInSeconds - 120) * 1_000),
    );
    refreshTimer = window.setTimeout(async () => {
      if (stopped) return;
      try {
        const nextToken = await requestToken(options.tokenUrl);
        currentToken = nextToken;
        if (recognizer) recognizer.authorizationToken = nextToken.token;
        scheduleTokenRefresh(nextToken.expires_in_seconds);
      } catch (error) {
        options.onError(
          error instanceof Error ? error.message : "Azure AI Speechの認証更新に失敗しました",
        );
        scheduleTokenRefresh(150);
      }
    }, refreshAfterMs);
  };

  await startRecognizer(0);
  scheduleTokenRefresh(currentToken.expires_in_seconds);
  watchdogTimer = window.setInterval(() => {
    if (stopped || reconnectTimer !== null || !audioInputHealth) return;
    const now = Date.now();
    if (now - audioInputHealth.lastFrameAtMs >= AZURE_SPEECH_AUDIO_STALL_TIMEOUT_MS) {
      scheduleReconnect(
        "Azure AI Speechへの音声入力が停止したため認識を再開します",
        recognizerGeneration,
      );
      return;
    }
    const audibleAudioContinues = (
      audioInputHealth.lastAudibleFrameAtMs > lastServiceActivityAtMs
      && now - audioInputHealth.lastAudibleFrameAtMs <= AZURE_SPEECH_WATCHDOG_INTERVAL_MS * 2
    );
    if (
      audibleAudioContinues
      && now - lastServiceActivityAtMs >= AZURE_SPEECH_AUDIBLE_RESULT_TIMEOUT_MS
    ) {
      scheduleReconnect(
        "音声入力は継続していますがAzure AI Speechの応答が停止したため認識を再開します",
        recognizerGeneration,
      );
    }
  }, AZURE_SPEECH_WATCHDOG_INTERVAL_MS);

  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
      stopPromise = (async () => {
        // Drain the final result (including speaker ID) before disabling callbacks.
        if (recognizer) await stopRecognizerInstance(recognizer);
        if (latestInterimResult) {
          trace("fallback", latestInterimResult);
          publishFinal(latestInterimResult);
          latestInterimResult = null;
        } else {
          cancelPendingInterim();
        }
        stopped = true;
        trace("stopped");
        await closeRecognizer(true);
      })();
      return stopPromise;
    },
  };
}
