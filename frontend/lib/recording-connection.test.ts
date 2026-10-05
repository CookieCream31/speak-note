import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RecordingConnection,
  type ConnectionStatus,
  type RecordingSocket,
  type ServerMessage,
} from "@/lib/recording-connection";

class FakeSocket implements RecordingSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .filter((message) => message.type !== "ping");
  }

  binaries(): string[] {
    return this.sent
      .filter((item): item is ArrayBuffer => typeof item !== "string")
      .map((item) => new TextDecoder().decode(item));
  }
}

const startPayload = { type: "start", capture_mode: "audio", mime_type: "audio/webm" };

function chunk(sequence: number): Record<string, unknown> {
  return { type: "chunk", sequence, start_ms: sequence * 15_000, end_ms: (sequence + 1) * 15_000 };
}

async function flush(): Promise<void> {
  // Blob.arrayBuffer() resolves outside the fake timer queue.
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
}

async function startedConnection(options: Partial<ConstructorParameters<typeof RecordingConnection>[0]> = {}) {
  const statuses: ConnectionStatus[] = [];
  const messages: ServerMessage[] = [];
  const connection = new RecordingConnection({
    url: "ws://test/live/ws",
    createSocket: (url) => new FakeSocket(url),
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  const started = connection.start(startPayload);
  const socket = latestSocket();
  socket.open();
  expect(socket.messages()).toEqual([startPayload]);
  socket.receive({ type: "started", session_id: "session-1", chunk_ms: 15_000 });
  await expect(started).resolves.toMatchObject({ type: "started", session_id: "session-1" });
  return { connection, socket, statuses, messages };
}

describe("RecordingConnection", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the JSON header followed by its binary chunk", async () => {
    const { connection, socket } = await startedConnection();
    connection.send(chunk(0), new Blob(["first"]));
    await flush();
    expect(socket.messages()).toEqual([startPayload, chunk(0)]);
    expect(socket.binaries()).toEqual(["first"]);
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("keeps recording data while disconnected and replays unacknowledged data after resuming", async () => {
    const { connection, socket, statuses } = await startedConnection();
    connection.send(chunk(0), new Blob(["first"]));
    connection.send(chunk(1), new Blob(["second"]));
    await flush();
    socket.receive({ type: "chunk_saved", sequence: 0, end_ms: 15_000 });

    socket.drop();
    connection.send(chunk(2), new Blob(["third"]));
    expect(statuses).toEqual([{ state: "reconnecting", attempt: 1 }]);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    const resumedSocket = latestSocket();
    expect(resumedSocket).not.toBe(socket);
    resumedSocket.open();
    expect(resumedSocket.messages()).toEqual([{ type: "resume", session_id: "session-1" }]);
    resumedSocket.receive({ type: "resumed", session_id: "session-1" });
    await flush();

    // Chunk 0 was acknowledged; chunk 1's acknowledgement may have been lost.
    expect(resumedSocket.messages().slice(1)).toEqual([chunk(1), chunk(2)]);
    expect(resumedSocket.binaries()).toEqual(["second", "third"]);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
    resumedSocket.receive({ type: "chunk_saved", sequence: 1, end_ms: 30_000 });
    resumedSocket.receive({ type: "chunk_saved", sequence: 2, end_ms: 45_000 });
    expect(connection.pendingCount).toBe(0);
  });

  it("sends stop only after the replayed queue when stopping during an outage", async () => {
    const { connection, socket, messages } = await startedConnection();
    connection.send(chunk(0), new Blob(["first"]));
    await flush();
    socket.drop();
    connection.stop();

    await vi.advanceTimersByTimeAsync(1_000);
    const resumedSocket = latestSocket();
    resumedSocket.open();
    resumedSocket.receive({ type: "resumed", session_id: "session-1" });
    await flush();
    expect(resumedSocket.messages().slice(1)).toEqual([chunk(0), { type: "stop" }]);

    resumedSocket.receive({ type: "chunk_saved", sequence: 0, end_ms: 15_000 });
    resumedSocket.receive({ type: "finalized", duration_ms: 15_000 });
    resumedSocket.drop(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages.map((message) => message.type)).toEqual(["chunk_saved", "finalized"]);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("backs off between attempts and fails after the reconnect window", async () => {
    const { socket, statuses } = await startedConnection({ reconnectWindowMs: 10_000 });
    socket.drop();
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      latestSocket().drop();
    }
    await vi.advanceTimersByTimeAsync(8_000);
    latestSocket().drop();

    expect(statuses.filter((status) => status.state === "reconnecting")).toHaveLength(4);
    expect(statuses.at(-1)).toEqual({
      state: "failed",
      message: "Backendとの接続を復旧できませんでした。",
    });
    const socketCount = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(socketCount);
  });

  it("does not reconnect after the backend rejects the recording", async () => {
    const { socket, statuses, messages } = await startedConnection();
    socket.receive({ type: "error", message: "録音は1MB以下にしてください" });
    socket.drop(1008);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(statuses).toEqual([{ state: "failed", message: "録音は1MB以下にしてください" }]);
    expect(messages).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("replaces a stalled connection that stops answering keepalive pings", async () => {
    const { socket, statuses } = await startedConnection({ keepaliveMs: 1_000, stallTimeoutMs: 3_000 });
    socket.receive({ type: "pong" });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(socket.closedWith).toBe(4001);
    expect(statuses).toEqual([{ state: "reconnecting", attempt: 1 }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("closes intentionally with a normal close code and never reconnects", async () => {
    const { connection, socket, statuses } = await startedConnection();
    connection.close();
    socket.drop(1000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(socket.closedWith).toBe(1000);
    expect(statuses).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("fails instead of growing memory without bound while disconnected", async () => {
    const { connection, socket, statuses } = await startedConnection({ maxPendingBytes: 10 });
    socket.drop();
    connection.send(chunk(0), new Blob(["123456"]));
    connection.send(chunk(1), new Blob(["789012"]));

    expect(statuses.at(-1)?.state).toBe("failed");
    expect(() => connection.stop()).toThrow();
  });

  it("rejects start when the backend refuses the session", async () => {
    const connection = new RecordingConnection({
      url: "ws://test/live/ws",
      createSocket: (url) => new FakeSocket(url),
      onMessage: () => undefined,
      onStatus: () => undefined,
    });
    const started = connection.start(startPayload);
    latestSocket().open();
    latestSocket().receive({ type: "error", message: "録音または画面共有はすでに開始されています" });

    await expect(started).rejects.toThrow("録音または画面共有はすでに開始されています");
  });
});
