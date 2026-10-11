import type { AzureSpeechResult, AzureSpeechStreamController } from "./azure-speech-stream";
import { createPcmAudioInput } from "./pcm-audio-input";

interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final: boolean;
  confidence?: number;
  speaker?: string;
  translation_status?: string;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
}

interface StreamOptions {
  tokenUrl: string;
  audioStream: MediaStream;
  getTimelinePositionMs?: () => number;
  onInterim?: (result: AzureSpeechResult) => void;
  onInterimCleared?: (resultId: string) => void;
  onResult: (result: AzureSpeechResult) => void;
  onError: (message: string) => void;
}

export class SonioxTranscriptAccumulator {
  private pending: SonioxToken[] = [];
  private sequence = 0;
  constructor(private prefix: string, private offsetMs: number) {}
  get resultId() { return `${this.prefix}:${this.sequence}`; }

  private result(tokens: SonioxToken[]): AzureSpeechResult | null {
    const text = tokens.map((token) => token.text).join("").trim();
    const timed = tokens.filter((token) => Number.isFinite(token.start_ms) && Number.isFinite(token.end_ms));
    if (!text || !timed.length) return null;
    const confidences = tokens.flatMap((token) => typeof token.confidence === "number" ? [token.confidence] : []);
    return {
      resultId: this.resultId,
      startMs: this.offsetMs + Math.max(0, Math.round(timed[0].start_ms!)),
      endMs: this.offsetMs + Math.max(Math.round(timed[0].start_ms!) + 1, Math.round(timed.at(-1)!.end_ms!)),
      text, confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      speakerLabel: tokens[0]?.speaker ? `SONIOX_${this.prefix}_${tokens[0].speaker}` : "SPEAKER_UNKNOWN",
    };
  }

  accept(response: SonioxResponse): { finals: AzureSpeechResult[]; interim: AzureSpeechResult | null } {
    const finals: AzureSpeechResult[] = [];
    const drafts: SonioxToken[] = [];
    const flush = () => {
      const result = this.result(this.pending);
      if (result) { finals.push(result); this.sequence += 1; }
      this.pending = [];
    };
    for (const token of response.tokens ?? []) {
      if (token.translation_status === "translation") continue;
      if (token.text === "<end>" || token.text === "<fin>") {
        if (token.is_final) flush();
        continue;
      }
      if (!token.is_final) { drafts.push(token); continue; }
      const previous = this.pending.at(-1);
      if (previous && (previous.speaker !== token.speaker
          || (token.start_ms ?? 0) - (this.pending[0].start_ms ?? 0) >= 10_000)) flush();
      this.pending.push(token);
    }
    if (response.finished) flush();
    // Non-final tokens replace the hypothesis on each response.
    return { finals, interim: this.result([...this.pending, ...drafts]) };
  }

  flush(): AzureSpeechResult[] { return this.accept({ finished: true }).finals; }
}

export function parseSonioxResponse(value: unknown): SonioxResponse {
  if (!value || typeof value !== "object") throw new Error("Sonioxの応答形式が不正です");
  const response = value as SonioxResponse;
  if (response.tokens !== undefined && !Array.isArray(response.tokens)) throw new Error("Sonioxの応答形式が不正です");
  for (const token of response.tokens ?? []) {
    if (!token || typeof token.text !== "string" || typeof token.is_final !== "boolean") throw new Error("Sonioxの認識結果が不正です");
    if (token.text === "<end>" || token.text === "<fin>" || token.translation_status === "translation") continue;
    if (typeof token.start_ms !== "number" || !Number.isFinite(token.start_ms) || token.start_ms < 0
        || typeof token.end_ms !== "number" || !Number.isFinite(token.end_ms) || token.end_ms < token.start_ms
        || (token.speaker !== undefined && typeof token.speaker !== "string")
        || (token.confidence !== undefined && (!Number.isFinite(token.confidence) || token.confidence < 0 || token.confidence > 1))) {
      throw new Error("Sonioxの認識結果が不正です");
    }
  }
  return response;
}

export async function startSonioxSpeechStream(options: StreamOptions): Promise<AzureSpeechStreamController> {
  let socket: WebSocket | null = null;
  let stopping = false;
  let attempts = 0;
  let generation = 0;
  let generationPrefix = "";
  let accumulator: SonioxTranscriptAccumulator | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let finishStop: (() => void) | null = null;
  let permanentError = false;
  let input: Awaited<ReturnType<typeof createPcmAudioInput>> | null = null;
  let audioStarted = false;
  let acceptingAudio = true;
  const speakerLabels = new Map<string, string>();
  const present = (result: AzureSpeechResult): AzureSpeechResult => {
    if (result.speakerLabel === "SPEAKER_UNKNOWN") return result;
    let label = speakerLabels.get(result.speakerLabel);
    if (!label) {
      label = `話者 ${speakerLabels.size + 1}`;
      speakerLabels.set(result.speakerLabel, label);
    }
    return { ...result, speakerLabel: label };
  };
  const publishFinal = (result: AzureSpeechResult) => options.onResult(present(result));
  const publish = (response: SonioxResponse) => {
    const previousId = accumulator?.resultId;
    const results = accumulator?.accept(response);
    results?.finals.forEach(publishFinal);
    if (results?.interim) options.onInterim?.(present(results.interim));
    else if (previousId) options.onInterimCleared?.(previousId);
  };
  const connect = async () => {
    const response = await fetch(options.tokenUrl, { method: "POST", cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { detail?: unknown };
      throw new Error(typeof failure.detail === "string" ? failure.detail : `Sonioxの一時キーを取得できません (${response.status})`);
    }
    const token = await response.json() as {
      api_key: string; model: string; language: string;
      language_hints?: string[]; language_hints_strict?: boolean;
    };
    if (stopping) return;
    const next = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket", ["soniox-api-key", token.api_key]);
    socket = next;
    const prefix = `snx-${crypto.randomUUID().slice(0, 8)}-${++generation}`;
    generationPrefix = prefix;
    audioStarted = false;
    accumulator = new SonioxTranscriptAccumulator(prefix, Math.round(options.getTimelinePositionMs?.() ?? 0));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { next.close(); reject(new Error("Sonioxへの接続がタイムアウトしました")); }, 10_000);
      next.onopen = () => {
        clearTimeout(timeout);
        next.send(JSON.stringify({ model: token.model, audio_format: "pcm_s16le",
          sample_rate: 16_000, num_channels: 1,
          ...((token.language_hints ?? [token.language]).length ? { language_hints: token.language_hints ?? [token.language] } : {}),
          language_hints_strict: token.language_hints_strict ?? false,
          enable_speaker_diarization: true, enable_language_identification: true,
          enable_endpoint_detection: true }));
        resolve();
      };
      next.onerror = () => { clearTimeout(timeout); reject(new Error("Sonioxへの接続に失敗しました")); };
    });
    next.onmessage = (event) => {
      if (socket !== next) return;
      let message: SonioxResponse;
      try { message = parseSonioxResponse(JSON.parse(String(event.data))); }
      catch { options.onError("Sonioxの応答形式が不正です"); next.close(); return; }
      if (message.error_code) {
        permanentError = [400, 401, 402, 403].includes(message.error_code);
        options.onError(`Soniox APIエラー (${message.error_code})。設定・権限・残高を確認してください`);
        next.close();
        return;
      }
      publish(message);
      if (message.finished) { finishStop?.(); next.close(); }
    };
    next.onclose = () => {
      if (socket !== next) return;
      const draftId = accumulator?.resultId;
      accumulator?.flush().forEach(publishFinal);
      if (draftId) options.onInterimCleared?.(draftId);
      socket = null;
      if (stopping) { finishStop?.(); return; }
      scheduleReconnect();
    };
  };
  const scheduleReconnect = () => {
    if (stopping || retryTimer) return;
    if (permanentError || attempts >= 3) { options.onError("Sonioxの文字起こしを停止しました。保存音声から確定版を作成できます"); return; }
    options.onError("Sonioxへ再接続しています。切断中の音声は確定版で処理できます");
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempts += 1;
      void connect().catch((error) => { options.onError(error instanceof Error ? error.message : "Sonioxへの再接続に失敗しました"); scheduleReconnect(); });
    }, 1000 * attempts + 1000);
  };
  try {
    await connect();
    input = await createPcmAudioInput(options.audioStream, (buffer) => {
      if (socket?.readyState !== WebSocket.OPEN || !acceptingAudio) return;
      if (socket.bufferedAmount >= 512_000) {
        options.onError("Sonioxへの音声送信が遅延しています。再接続します");
        socket.close();
        return;
      }
      if (!audioStarted) {
        const firstFramePosition = Math.max(0, Math.round(options.getTimelinePositionMs?.() ?? 0) - 100);
        accumulator = new SonioxTranscriptAccumulator(generationPrefix, firstFramePosition);
        audioStarted = true;
      }
      socket.send(buffer);
    });
  } catch (error) {
    stopping = true;
    (socket as WebSocket | null)?.close();
    if (retryTimer) clearTimeout(retryTimer);
    throw error;
  }
  const keepalive = setInterval(() => {
    if (!stopping && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "keepalive" }));
  }, 20_000);
  let stopPromise: Promise<void> | null = null;
  return { stop: () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(keepalive);
    if (retryTimer) clearTimeout(retryTimer);
    stopPromise = (async () => {
      await input?.close();
      acceptingAudio = false;
      if (socket?.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { options.onError("Sonioxの最後の応答を待機できませんでした。保存音声から確定版を作成できます"); resolve(); }, 8000);
          finishStop = () => { clearTimeout(timer); resolve(); };
          socket!.send(""); // Empty TEXT frame is the documented end-of-stream signal.
        });
      }
      accumulator?.flush().forEach(publishFinal);
      socket?.close();
      socket = null;
    })();
    return stopPromise;
  } };
}
