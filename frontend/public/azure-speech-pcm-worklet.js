class AzureSpeechPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const processorOptions = options?.processorOptions ?? {};
    this.targetSampleRate = processorOptions.targetSampleRate ?? 16000;
    this.chunkSamples = processorOptions.chunkSamples ?? 1600;
    this.sourceStep = sampleRate / this.targetSampleRate;
    this.nextOutputPosition = 0;
    this.inputPosition = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
    this.pcm = new Int16Array(this.chunkSamples);
    this.pcmLength = 0;
    this.sumSquares = 0;
  }

  appendSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.pcm[this.pcmLength] = Math.round(
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
    );
    this.pcmLength += 1;
    this.sumSquares += clamped * clamped;
    if (this.pcmLength < this.chunkSamples) return;

    const buffer = this.pcm.buffer;
    const level = Math.sqrt(this.sumSquares / this.pcmLength);
    this.port.postMessage({ type: "pcm", buffer, level }, [buffer]);
    this.pcm = new Int16Array(this.chunkSamples);
    this.pcmLength = 0;
    this.sumSquares = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0] ?? [];
    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].fill(0);
    }

    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    for (let index = 0; index < channel.length; index += 1) {
      const currentSample = channel[index];
      if (!this.hasPreviousSample) {
        this.previousSample = currentSample;
        this.hasPreviousSample = true;
        this.appendSample(currentSample);
        this.nextOutputPosition += this.sourceStep;
        this.inputPosition += 1;
        continue;
      }

      const intervalStart = this.inputPosition - 1;
      while (this.nextOutputPosition <= this.inputPosition) {
        const fraction = Math.max(0, Math.min(1, this.nextOutputPosition - intervalStart));
        this.appendSample(
          this.previousSample + (currentSample - this.previousSample) * fraction,
        );
        this.nextOutputPosition += this.sourceStep;
      }
      this.previousSample = currentSample;
      this.inputPosition += 1;
    }
    return true;
  }
}

registerProcessor("azure-speech-pcm-processor", AzureSpeechPcmProcessor);
