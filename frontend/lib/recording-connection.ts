// 録音WebSocketの送信キュー。接続が切れても録音データを保持し、再接続後に
// 同じ録音セッションへ未確認のデータを再送する（Backendは重複を無視して確認応答する）。

export interface RecordingSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export type ConnectionStatus =
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number }
  | { state: "failed"; message: string };

export interface RecordingConnectionOptions {
  url: string;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  createSocket?: (url: string) => RecordingSocket;
  /** 再接続を試す時間。Backendの自動確定（既定10分）より短くする。 */
  reconnectWindowMs?: number;
  /** 未送信・未確認データの上限。超えた場合は録音を続けられない。 */
  maxPendingBytes?: number;
  keepaliveMs?: number;
  /** 応答も送信の進捗もない時間がこれを超えたら、接続を張り直す。 */
  stallTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

interface PendingEntry {
  key: string;
  payload: Record<string, unknown>;
  blob?: Blob;
  size: number;
}

const SOCKET_OPEN = 1;
// 送信バッファがこれを超えている間は次のデータを積まない。
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
// ブラウザが意図して閉じたとBackendに扱われない、放棄した接続用のコード。
const ABANDONED_CLOSE_CODE = 4001;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

function pendingKey(payload: Record<string, unknown>): string {
  switch (payload.type) {
    case "chunk":
    case "audio_chunk":
      return `${payload.type}:${String(payload.sequence)}`;
    case "video_part_start":
    case "video_part_end":
      return `${payload.type}:${String(payload.part_sequence)}`;
    case "video_chunk":
      return `video_chunk:${String(payload.part_sequence)}:${String(payload.chunk_sequence)}`;
    case "azure_result":
      return `azure_result:${String(payload.result_id)}`;
    default:
      throw new Error(`再送できないメッセージです: ${String(payload.type)}`);
  }
}

function acknowledgedKey(message: ServerMessage): string | null {
  switch (message.type) {
    case "chunk_saved":
      return `chunk:${String(message.sequence)}`;
    case "audio_chunk_saved":
      return `audio_chunk:${String(message.sequence)}`;
    case "video_part_started":
      return `video_part_start:${String(message.part_sequence)}`;
    case "video_part_finished":
      return `video_part_end:${String(message.part_sequence)}`;
    case "video_chunk_saved":
      return `video_chunk:${String(message.part_sequence)}:${String(message.chunk_sequence)}`;
    case "azure_result_saved":
      return `azure_result:${String(message.result_id)}`;
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type State = "idle" | "starting" | "open" | "reconnecting" | "failed" | "closed";

export class RecordingConnection {
  private readonly options: Required<Omit<RecordingConnectionOptions, "createSocket">>;
  private readonly createSocket: (url: string) => RecordingSocket;
  private socket: RecordingSocket | null = null;
  private state: State = "idle";
  private sessionId: string | null = null;
  private pending: PendingEntry[] = [];
  private pendingBytes = 0;
  // 現在の接続で送信済みの件数。再接続時は0に戻し、未確認分をすべて再送する。
  private sentCount = 0;
  private pumping = false;
  private stopRequested = false;
  private stopSent = false;
  private finalized = false;
  private reconnectStartedAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressAt = 0;
  private lastBufferedAmount = 0;
  private startPromise: {
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(options: RecordingConnectionOptions) {
    // RecordingSocketはWebSocketのうち使う部分だけを抜き出した型（テストで差し替える）。
    this.createSocket = options.createSocket
      ?? ((url) => new WebSocket(url) as unknown as RecordingSocket);
    this.options = {
      url: options.url,
      onMessage: options.onMessage,
      onStatus: options.onStatus,
      reconnectWindowMs: options.reconnectWindowMs ?? 5 * 60_000,
      maxPendingBytes: options.maxPendingBytes ?? 512 * 1024 * 1024,
      keepaliveMs: options.keepaliveMs ?? 15_000,
      stallTimeoutMs: options.stallTimeoutMs ?? 45_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 新しい録音セッションを開始し、Backendの `started` 応答を返す。 */
  start(startPayload: Record<string, unknown>): Promise<ServerMessage> {
    if (this.state !== "idle") return Promise.reject(new Error("録音接続はすでに開始されています"));
    this.state = "starting";
    return new Promise<ServerMessage>((resolve, reject) => {
      this.startPromise = { resolve, reject };
      this.connect(startPayload);
    });
  }

  /** 録音データを送信キューへ積む。切断中も保持し、再接続後に送る。 */
  send(payload: Record<string, unknown>, blob?: Blob): void {
    if (this.state === "failed" || this.state === "closed") return;
    const size = blob?.size ?? 0;
    this.pending.push({ key: pendingKey(payload), payload, blob, size });
    this.pendingBytes += size;
    if (this.pendingBytes > this.options.maxPendingBytes) {
      this.fail("送信待ちの録音データが多すぎるため、録音を続けられません。通信状態を確認してください。");
      return;
    }
    void this.pump();
  }

  /** キューを送り切った後に `stop` を送る。完了は `finalized` メッセージで通知される。 */
  stop(): void {
    if (this.state === "failed" || this.state === "closed") {
      throw new Error("Backendとの接続が終了しているため、録音の停止を送信できません。");
    }
    this.stopRequested = true;
    void this.pump();
  }

  /** 利用者の操作による終了。Backendは受信済みのデータをすぐに保存する。 */
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearTimers();
    this.rejectStart(new Error("録音接続を終了しました"));
    const socket = this.detachSocket();
    socket?.close(1000);
  }

  private connect(startPayload?: Record<string, unknown>): void {
    const socket = this.createSocket(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      socket.send(JSON.stringify(
        startPayload ?? { type: "resume", session_id: this.sessionId },
      ));
    };
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onclose = (event) => this.handleSocketLost(socket, event.code);
    socket.onerror = () => {
      // closeイベントが続いて発生するため、ここでは何もしない。
    };
    this.handshakeTimer = setTimeout(() => {
      if (this.state === "starting") {
        this.rejectStart(new Error("Backendへの接続がタイムアウトしました"));
        this.state = "closed";
        this.detachSocket()?.close(1000);
        return;
      }
      this.handleSocketLost(socket);
    }, this.options.handshakeTimeoutMs);
  }

  private handleMessage(socket: RecordingSocket, data: unknown): void {
    if (socket !== this.socket || typeof data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    this.lastProgressAt = Date.now();
    if (message.type === "started" || message.type === "resumed") {
      this.clearHandshakeTimer();
      const resumed = message.type === "resumed";
      if (!resumed) this.sessionId = String(message.session_id);
      this.state = "open";
      this.sentCount = 0;
      this.stopSent = false;
      this.reconnectAttempt = 0;
      this.startKeepalive();
      if (resumed) this.options.onStatus({ state: "connected" });
      const startPromise = this.startPromise;
      this.startPromise = null;
      startPromise?.resolve(message);
      void this.pump();
      return;
    } else if (message.type === "error") {
      const errorMessage = typeof message.message === "string"
        ? message.message
        : "録音データを保存できませんでした";
      if (this.state === "starting") {
        this.rejectStart(new Error(errorMessage));
        this.state = "closed";
        this.detachSocket();
        return;
      }
      this.fail(errorMessage);
      return;
    } else if (message.type === "finalized") {
      this.finalized = true;
    } else {
      this.acknowledge(message);
    }
    this.options.onMessage(message);
  }

  private acknowledge(message: ServerMessage): void {
    const key = acknowledgedKey(message);
    if (key === null) return;
    const index = this.pending.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    const [entry] = this.pending.splice(index, 1);
    this.pendingBytes -= entry.size;
    if (index < this.sentCount) this.sentCount -= 1;
    if (this.stopRequested) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    const socket = this.socket;
    if (this.state !== "open" || !socket) return;
    this.pumping = true;
    try {
      while (this.state === "open" && this.socket === socket) {
        if (this.sentCount >= this.pending.length) {
          if (this.stopRequested && !this.stopSent) {
            socket.send(JSON.stringify({ type: "stop" }));
            this.stopSent = true;
          }
          break;
        }
        if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
          await sleep(50);
          continue;
        }
        const entry = this.pending[this.sentCount];
        const content = entry.blob ? await entry.blob.arrayBuffer() : null;
        if (this.state !== "open" || this.socket !== socket) break;
        // 確認応答で先頭が除かれていても、送る対象は常にsentCount番目。
        if (this.pending[this.sentCount] !== entry) continue;
        socket.send(JSON.stringify(entry.payload));
        if (content) socket.send(content);
        this.sentCount += 1;
      }
    } catch {
      this.handleSocketLost(socket);
    } finally {
      this.pumping = false;
    }
    if (
      this.state === "open"
      && this.socket === socket
      && (this.sentCount < this.pending.length || (this.stopRequested && !this.stopSent))
    ) {
      void this.pump();
    }
  }

  private handleSocketLost(socket: RecordingSocket, code?: number): void {
    if (socket !== this.socket) return;
    this.detachSocket();
    if (socket.readyState === SOCKET_OPEN) socket.close(ABANDONED_CLOSE_CODE);
    this.stopKeepalive();
    if (this.state === "failed" || this.state === "closed" || this.finalized) return;
    if (this.state === "starting") {
      this.rejectStart(new Error("Backendへ接続できませんでした"));
      this.state = "closed";
      return;
    }
    if (code === POLICY_VIOLATION_CLOSE_CODE) {
      this.fail("Backendが録音データを受け付けませんでした");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const now = Date.now();
    if (this.state !== "reconnecting") {
      this.state = "reconnecting";
      this.reconnectStartedAt = now;
      this.reconnectAttempt = 0;
    }
    if (now - this.reconnectStartedAt >= this.options.reconnectWindowMs) {
      this.fail("Backendとの接続を復旧できませんでした。");
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt += 1;
    this.options.onStatus({ state: "reconnecting", attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === "reconnecting") this.connect();
    }, delay);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastProgressAt = Date.now();
    this.lastBufferedAmount = 0;
    this.keepaliveTimer = setInterval(() => {
      const socket = this.socket;
      if (this.state !== "open" || !socket) return;
      // 大きな録画データの送信中は応答が遅れるため、送信の進捗も生存の印とする。
      if (socket.bufferedAmount < this.lastBufferedAmount) this.lastProgressAt = Date.now();
      this.lastBufferedAmount = socket.bufferedAmount;
      if (Date.now() - this.lastProgressAt > this.options.stallTimeoutMs) {
        this.handleSocketLost(socket);
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.handleSocketLost(socket);
      }
    }, this.options.keepaliveMs);
  }

  private fail(message: string): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    this.clearTimers();
    // 正常終了コードで閉じ、Backendに受信済みのデータをすぐ保存させる。
    this.detachSocket()?.close(1000);
    this.options.onStatus({ state: "failed", message });
  }

  private detachSocket(): RecordingSocket | null {
    const socket = this.socket;
    this.socket = null;
    this.clearHandshakeTimer();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    return socket;
  }

  private rejectStart(error: Error): void {
    const startPromise = this.startPromise;
    this.startPromise = null;
    startPromise?.reject(error);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    this.stopKeepalive();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
