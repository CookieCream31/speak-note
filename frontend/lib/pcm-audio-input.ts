// Uses the same stateful resampler as Azure, without loading its Speech SDK.
export async function createPcmAudioInput(
  stream: MediaStream,
  onPcm: (buffer: ArrayBuffer) => void,
): Promise<{ close: () => Promise<void> }> {
  const AudioContextClass = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass || typeof AudioWorkletNode === "undefined") {
    throw new Error("このブラウザはSonioxの音声ストリーミングに対応していません");
  }
  // Let the device choose its native rate; the stateful worklet emits 16kHz PCM.
  const context = new AudioContextClass({ latencyHint: "interactive" });
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let closed = false;
  let flushed: (() => void) | null = null;
  try {
    await context.audioWorklet.addModule("/azure-speech-pcm-worklet.js?v=stateful-pcm-v1");
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "azure-speech-pcm-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit",
      processorOptions: { targetSampleRate: 16_000, chunkSamples: 1600 },
    });
    worklet.port.onmessage = (event: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
      if (event.data.type === "flushed") { flushed?.(); return; }
      if (!closed && event.data.type === "pcm") onPcm(event.data.buffer);
    };
    source.connect(worklet);
    worklet.connect(context.destination);
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") throw new Error("Soniox用の音声処理を開始できませんでした");
  } catch (error) {
    source?.disconnect();
    worklet?.disconnect();
    await context.close().catch(() => undefined);
    throw error;
  }
  return { close: async () => {
    if (closed) return;
    source?.disconnect();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 150);
      flushed = () => { clearTimeout(timeout); resolve(); };
      worklet?.port.postMessage({ type: "flush" });
    });
    closed = true;
    if (worklet) worklet.port.onmessage = null;
    worklet?.disconnect();
    await context.close().catch(() => undefined);
    // MediaRecorder owns the original tracks; leave them running.
  } };
}
