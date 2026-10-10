export function formatElapsedTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function microphoneSpeechConstraints(): MediaTrackConstraints {
  return {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export async function constrainDisplayTrack(track: MediaStreamTrack): Promise<void> {
  try {
    await track.applyConstraints({
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: { ideal: 30, max: 30 },
    });
  } catch {
    // A browser can reject optional display constraints. Direct capture is
    // still preferable to falling back to a Canvas render loop.
  }
}

export function screenRecordingBitrate(track: MediaStreamTrack): number {
  const { width = 1920, height = 1080 } = track.getSettings();
  const pixels = Math.max(1, width) * Math.max(1, height);
  return Math.round(Math.min(24_000_000, Math.max(5_000_000, pixels * 4)));
}

async function waitForVideoFrame(preview: HTMLVideoElement): Promise<void> {
  if (
    preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && preview.videoWidth > 0
    && preview.videoHeight > 0
  ) return;

  await new Promise<void>((resolve, reject) => {
    let videoFrameCallback: number | null = null;
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      preview.removeEventListener("loadeddata", ready);
      preview.removeEventListener("resize", ready);
      if (videoFrameCallback !== null) preview.cancelVideoFrameCallback(videoFrameCallback);
    };
    const ready = () => {
      if (preview.videoWidth <= 0 || preview.videoHeight <= 0) return;
      cleanup();
      resolve();
    };
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("共有画面の映像フレームを取得できませんでした"));
    }, 5_000);
    preview.addEventListener("loadeddata", ready);
    preview.addEventListener("resize", ready);
    if (typeof preview.requestVideoFrameCallback === "function") {
      videoFrameCallback = preview.requestVideoFrameCallback(() => ready());
    }
    ready();
  });
}

export class LiveCaptureMixer {
  readonly audioStream: MediaStream;

  private readonly preview: HTMLVideoElement | null;
  private readonly audioContext: AudioContext;
  private readonly audioDestination: MediaStreamAudioDestinationNode;
  private microphoneStream: MediaStream | null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private displayStream: MediaStream | null = null;
  private displayAudioSource: MediaStreamAudioSourceNode | null = null;
  private stopped = false;

  private constructor(
    preview: HTMLVideoElement | null,
    microphoneStream: MediaStream | null,
    audioContext: AudioContext | null,
  ) {
    this.preview = preview;
    this.microphoneStream = microphoneStream;
    this.audioContext = audioContext ?? new AudioContext();
    this.audioDestination = this.audioContext.createMediaStreamDestination();
    if (microphoneStream?.getAudioTracks().length) {
      this.microphoneSource = this.audioContext.createMediaStreamSource(microphoneStream);
      this.microphoneSource.connect(this.audioDestination);
    }
    this.audioStream = this.audioDestination.stream;
  }

  static async create(
    displayStream: MediaStream,
    microphoneStream: MediaStream | null,
    preview: HTMLVideoElement | null,
    audioContext: AudioContext | null = null,
  ): Promise<LiveCaptureMixer> {
    const mixer = new LiveCaptureMixer(preview, microphoneStream, audioContext);
    try {
      await mixer.replaceDisplay(displayStream);
      if (mixer.audioContext.state === "suspended") await mixer.audioContext.resume();
      if (mixer.audioContext.state !== "running") {
        throw new Error("録音用の音声処理を開始できませんでした。画面を選び直してください");
      }
      return mixer;
    } catch (error) {
      mixer.stop();
      throw error;
    }
  }

  async replaceDisplay(displayStream: MediaStream): Promise<boolean> {
    if (this.stopped) throw new Error("録画はすでに終了しています");
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") {
      throw new Error("共有画面の映像を取得できませんでした");
    }
    if (this.preview) await constrainDisplayTrack(videoTrack);

    const systemAudioTracks = displayStream.getAudioTracks();
    const nextAudioSource = systemAudioTracks.length
      ? this.audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks))
      : null;
    const previousStream = this.displayStream;
    const previousAudioSource = this.displayAudioSource;

    if (this.preview) {
      this.preview.autoplay = true;
      this.preview.muted = true;
      this.preview.playsInline = true;
      this.preview.srcObject = displayStream;
      try {
        await this.preview.play();
        await waitForVideoFrame(this.preview);
      } catch (error) {
        this.preview.srcObject = previousStream;
        nextAudioSource?.disconnect();
        throw error;
      }
    }

    nextAudioSource?.connect(this.audioDestination);
    this.displayStream = displayStream;
    this.displayAudioSource = nextAudioSource;
    previousAudioSource?.disconnect();
    if (previousStream && previousStream !== displayStream) {
      for (const track of previousStream.getTracks()) track.stop();
    }
    return systemAudioTracks.length > 0;
  }

  currentVideoTrack(): MediaStreamTrack | null {
    return this.displayStream?.getVideoTracks()[0] ?? null;
  }

  isCurrentDisplay(displayStream: MediaStream): boolean {
    return this.displayStream === displayStream;
  }

  handleDisplayEnded(displayStream: MediaStream): boolean {
    if (this.stopped || this.displayStream !== displayStream) return false;
    this.displayAudioSource?.disconnect();
    this.displayAudioSource = null;
    if (this.preview && this.preview.srcObject === displayStream) {
      this.preview.pause();
      this.preview.srcObject = null;
    }
    return true;
  }

  attachMicrophone(stream: MediaStream): void {
    if (this.stopped) throw new Error("録音は終了しています");
    this.microphoneSource?.disconnect();
    for (const track of this.microphoneStream?.getTracks() ?? []) track.stop();
    this.microphoneStream = stream;
    this.microphoneSource = this.audioContext.createMediaStreamSource(stream);
    this.microphoneSource.connect(this.audioDestination);
  }

  setMicrophoneMuted(muted: boolean): void {
    for (const track of this.microphoneStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.displayAudioSource?.disconnect();
    this.microphoneSource?.disconnect();
    for (const track of this.displayStream?.getTracks() ?? []) track.stop();
    for (const track of this.microphoneStream?.getTracks() ?? []) track.stop();
    for (const track of this.audioStream.getTracks()) track.stop();
    void this.audioContext.close();
    if (this.preview) this.preview.srcObject = null;
  }
}
