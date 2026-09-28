"use client";

export interface PendingLiveCapture {
  meetingId: string;
  stream: MediaStream;
  includeMicrophone: boolean;
  audioContext: AudioContext | null;
}

interface StoredCapture extends PendingLiveCapture {
  expiresAt: number;
  expiryTimer: ReturnType<typeof globalThis.setTimeout>;
}

const CAPTURE_TTL_MS = 60_000;
let storedCapture: StoredCapture | null = null;

function stopCapture(capture: StoredCapture): void {
  globalThis.clearTimeout(capture.expiryTimer);
  for (const track of capture.stream.getTracks()) track.stop();
  if (capture.audioContext && capture.audioContext.state !== "closed") {
    void capture.audioContext.close();
  }
}

export function stagePendingLiveCapture(
  meetingId: string,
  stream: MediaStream,
  includeMicrophone: boolean,
  audioContext: AudioContext | null = null,
): void {
  if (storedCapture) stopCapture(storedCapture);
  const expiryTimer = globalThis.setTimeout(() => {
    if (!storedCapture || storedCapture.meetingId !== meetingId) return;
    stopCapture(storedCapture);
    storedCapture = null;
  }, CAPTURE_TTL_MS);
  storedCapture = {
    meetingId,
    stream,
    includeMicrophone,
    audioContext,
    expiresAt: Date.now() + CAPTURE_TTL_MS,
    expiryTimer,
  };
}

export function takePendingLiveCapture(meetingId: string): PendingLiveCapture | null {
  if (!storedCapture || storedCapture.meetingId !== meetingId) return null;
  const capture = storedCapture;
  storedCapture = null;
  globalThis.clearTimeout(capture.expiryTimer);
  if (
    capture.expiresAt <= Date.now()
    || !capture.stream.getVideoTracks().some((track) => track.readyState === "live")
  ) {
    stopCapture(capture);
    return null;
  }
  return {
    meetingId: capture.meetingId,
    stream: capture.stream,
    includeMicrophone: capture.includeMicrophone,
    audioContext: capture.audioContext,
  };
}

export function discardPendingLiveCapture(): void {
  if (!storedCapture) return;
  stopCapture(storedCapture);
  storedCapture = null;
}
