/** The sound chip mixes to about ±1 on each side; this leaves headroom. */
const GAIN = 0.5;
/** A gentle high-pass that takes away the DACs' DC offset, as the console's capacitor does. */
const DC_BLOCK = 0.995;

/**
 * Resamples the sound chip's output to the audio device's rate, averaging
 * the levels over each sample's span of clocks. Output is stereo,
 * interleaved (left, right).
 */
export class AudioMixer {
  private clocksPerSample = 1;
  private position = 0;
  private sumLeft = 0;
  private sumRight = 0;
  private count = 0;
  private readonly lastIn = [0, 0];
  private readonly lastOut = [0, 0];
  private buffer = new Float32Array(8192);
  private length = 0;

  setRates(clockHz: number, sampleRate: number): void {
    this.clocksPerSample = clockHz / sampleRate;
  }

  /** Adds `clocks` clocks of the given levels. */
  add(left: number, right: number, clocks: number): void {
    this.sumLeft += left * clocks;
    this.sumRight += right * clocks;
    this.count += clocks;
    this.position += clocks;
    if (this.position < this.clocksPerSample) return;
    this.position -= this.clocksPerSample;
    this.emit(this.sumLeft / this.count, this.sumRight / this.count);
    this.sumLeft = this.sumRight = this.count = 0;
  }

  private filter(channel: number, value: number): number {
    const out = value - this.lastIn[channel] + DC_BLOCK * this.lastOut[channel];
    this.lastIn[channel] = value;
    this.lastOut[channel] = out;
    return out;
  }

  private emit(left: number, right: number): void {
    if (this.length + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = this.filter(0, left) * GAIN;
    this.buffer[this.length++] = this.filter(1, right) * GAIN;
  }

  /** The samples made since the last call, interleaved left and right. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
