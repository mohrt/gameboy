import type { AudioMixer } from './mixer';

/** The square channels' four waveforms (12.5%, 25%, 50% and 75%), eight steps each. */
const DUTY_WAVES = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];
/** Bits that always read 1, for $FF10-$FF2F. */
const READ_MASKS = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff, 0xff, 0x00, 0x00, 0xbf,
  0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];
const NR52 = 0x16;

/** What the square, wave and noise channels share: on/off, the DAC, and the length counter. */
class Channel {
  enabled = false;
  dacOn = false;
  length = 0;
  lengthEnabled = false;
  /** Clocks until the waveform's next step. */
  timer = 0;

  constructor(readonly maxLength: number) {}

  clockLength(): void {
    if (this.lengthEnabled && this.length > 0 && --this.length === 0) this.enabled = false;
  }
}

class Envelope {
  initial = 0;
  up = false;
  period = 0;
  volume = 0;
  timer = 0;

  load(value: number): void {
    this.initial = value >> 4;
    this.up = (value & 0x08) !== 0;
    this.period = value & 0x07;
  }

  trigger(): void {
    this.volume = this.initial;
    this.timer = this.period || 8;
  }

  clock(): void {
    if (this.period === 0 || --this.timer > 0) return;
    this.timer = this.period;
    if (this.up && this.volume < 15) this.volume++;
    else if (!this.up && this.volume > 0) this.volume--;
  }
}

class Square extends Channel {
  readonly envelope = new Envelope();
  duty = 0;
  step = 0;
  frequency = 0;
  // Channel 1's frequency sweep.
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepTimer = 0;
  sweepOn = false;
  shadow = 0;
  /** A sweep calculation subtracted since the last trigger; clearing negate then switches the channel off. */
  negated = false;

  constructor() {
    super(64);
  }

  get period(): number {
    return (2048 - this.frequency) * 4;
  }

  run(clocks: number): void {
    this.timer -= clocks;
    while (this.timer <= 0) {
      this.timer += this.period;
      this.step = (this.step + 1) & 7;
    }
  }

  get output(): number {
    return this.enabled && DUTY_WAVES[this.duty][this.step] ? this.envelope.volume : 0;
  }

  sweepNext(): number {
    const delta = this.shadow >> this.sweepShift;
    const next = this.sweepNegate ? this.shadow - delta : this.shadow + delta;
    if (this.sweepNegate) this.negated = true;
    if (next > 2047) this.enabled = false;
    return next;
  }

  clockSweep(): void {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepOn || this.sweepPeriod === 0) return;
    const next = this.sweepNext();
    if (next <= 2047 && this.sweepShift !== 0) {
      this.shadow = this.frequency = next;
      this.sweepNext();
    }
  }

  trigger(): void {
    this.timer = this.period;
    this.envelope.trigger();
    this.shadow = this.frequency;
    this.sweepTimer = this.sweepPeriod || 8;
    this.sweepOn = this.sweepPeriod !== 0 || this.sweepShift !== 0;
    this.negated = false;
    if (this.sweepShift !== 0) this.sweepNext();
  }
}

class Wave extends Channel {
  readonly ram = new Uint8Array(16);
  frequency = 0;
  /** NR32's output level: 0 mutes, 1-3 shift the samples right by 0-2. */
  level = 0;
  position = 0;
  sample = 0;

  constructor() {
    super(256);
  }

  run(clocks: number): void {
    this.timer -= clocks;
    while (this.timer <= 0) {
      this.timer += (2048 - this.frequency) * 2;
      this.position = (this.position + 1) & 31;
      const byte = this.ram[this.position >> 1];
      this.sample = this.position & 1 ? byte & 0x0f : byte >> 4;
    }
  }

  get output(): number {
    return this.enabled && this.level ? this.sample >> (this.level - 1) : 0;
  }

  trigger(): void {
    this.position = 0;
    // The first sample is read a little after the trigger.
    this.timer = (2048 - this.frequency) * 2 + 6;
  }
}

class Noise extends Channel {
  readonly envelope = new Envelope();
  shift = 0;
  narrow = false;
  divisor = 0;
  lfsr = 0x7fff;

  constructor() {
    super(64);
  }

  get period(): number {
    return NOISE_DIVISORS[this.divisor] << this.shift;
  }

  run(clocks: number): void {
    if (this.shift >= 14) return;
    this.timer -= clocks;
    while (this.timer <= 0) {
      this.timer += this.period;
      const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 14);
      if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
    }
  }

  get output(): number {
    return this.enabled && !(this.lfsr & 1) ? this.envelope.volume : 0;
  }

  trigger(): void {
    this.timer = this.period;
    this.lfsr = 0x7fff;
    this.envelope.trigger();
  }
}

/**
 * The sound chip: two square channels (the first with a frequency sweep), a
 * channel playing 32 4-bit samples from wave RAM, and a noise channel, each
 * through its own DAC, panned left and right by NR51 and scaled by NR50. The
 * frame sequencer, stepped at 512 Hz by DIV, clocks the length counters,
 * the sweep and the volume envelopes.
 */
export class Apu {
  readonly square1 = new Square();
  readonly square2 = new Square();
  readonly wave = new Wave();
  readonly noise = new Noise();
  /** $FF10-$FF2F as last written. */
  readonly registers = new Uint8Array(0x20);
  powered = false;
  /** The frame sequencer step to run next (0-7). */
  frameStep = 0;
  /** The console is a Game Boy Color (whose length counters can't be written while the chip is off). */
  cgb = false;

  constructor(private readonly mixer: AudioMixer) {}

  reset(cgb: boolean): void {
    this.cgb = cgb;
    this.powerOff();
    this.wave.ram.fill(0);
    for (const channel of [this.square1, this.square2, this.wave, this.noise]) channel.length = 0;
  }

  /** Switching the chip off clears its registers; the original Game Boy's length counters survive. */
  private powerOff(): void {
    const channels = [this.square1, this.square2, this.wave, this.noise];
    const lengths = channels.map((channel) => channel.length);
    for (let i = 0; i < NR52; i++) this.writeRegister(0xff10 + i, 0);
    this.powered = false;
    channels.forEach((channel, i) => {
      channel.enabled = false;
      channel.dacOn = false;
      channel.lengthEnabled = false;
      channel.length = this.cgb ? 0 : lengths[i];
    });
  }

  /** Advances the channels by `clocks` 4 MHz clocks and sends their mix to the mixer. */
  tick(clocks: number): void {
    const { square1, square2, wave, noise } = this;
    if (!this.powered) {
      this.mixer.add(0, 0, clocks);
      return;
    }
    square1.run(clocks);
    square2.run(clocks);
    if (wave.enabled) wave.run(clocks);
    noise.run(clocks);
    const panning = this.registers[0x15];
    const out1 = this.analog(square1);
    const out2 = this.analog(square2);
    const out3 = this.analog(wave);
    const out4 = this.analog(noise);
    const left =
      (panning & 0x10 ? out1 : 0) + (panning & 0x20 ? out2 : 0) + (panning & 0x40 ? out3 : 0) + (panning & 0x80 ? out4 : 0);
    const right =
      (panning & 0x01 ? out1 : 0) + (panning & 0x02 ? out2 : 0) + (panning & 0x04 ? out3 : 0) + (panning & 0x08 ? out4 : 0);
    const volumes = this.registers[0x14];
    this.mixer.add((left * (((volumes >> 4) & 7) + 1)) / 32, (right * ((volumes & 7) + 1)) / 32, clocks);
  }

  /** A channel's DAC output, -1 to 1 (0 when its DAC is off). */
  private analog(channel: Square | Wave | Noise): number {
    return channel.dacOn ? channel.output / 7.5 - 1 : 0;
  }

  /** One step of the frame sequencer (from DIV). */
  frameSequencerTick(): void {
    if (!this.powered) return;
    const step = this.frameStep;
    this.frameStep = (step + 1) & 7;
    if ((step & 1) === 0) {
      for (const channel of [this.square1, this.square2, this.wave, this.noise]) channel.clockLength();
    }
    if (step === 2 || step === 6) this.square1.clockSweep();
    if (step === 7) {
      this.square1.envelope.clock();
      this.square2.envelope.clock();
      this.noise.envelope.clock();
    }
  }

  read(address: number): number {
    if (address >= 0xff30) return this.readWave(address);
    const index = address - 0xff10;
    if (index === NR52) {
      const channels = [this.square1, this.square2, this.wave, this.noise];
      return 0x70 | (this.powered ? 0x80 : 0) | channels.reduce((bits, channel, i) => bits | (channel.enabled ? 1 << i : 0), 0);
    }
    return this.registers[index] | READ_MASKS[index];
  }

  /** PCM12 and PCM34 (on the Color): the channels' current levels, two to a byte. */
  readPcm(high: boolean): number {
    return high ? this.wave.output | (this.noise.output << 4) : this.square1.output | (this.square2.output << 4);
  }

  private readWave(address: number): number {
    // While the channel plays, wave RAM reads give the byte it is playing.
    if (this.wave.enabled) return this.wave.ram[this.wave.position >> 1];
    return this.wave.ram[address & 0x0f];
  }

  write(address: number, value: number): void {
    if (address >= 0xff30) {
      if (this.wave.enabled) this.wave.ram[this.wave.position >> 1] = value;
      else this.wave.ram[address & 0x0f] = value;
      return;
    }
    const index = address - 0xff10;
    if (index === NR52) {
      if (!(value & 0x80) && this.powered) this.powerOff();
      else if (value & 0x80 && !this.powered) {
        this.powered = true;
        this.frameStep = 0;
        this.square1.step = this.square2.step = 0;
        this.wave.sample = 0;
      }
      return;
    }
    if (!this.powered) {
      // With the chip off, only the original Game Boy's length counters can be written.
      if (!this.cgb && (index === 0x01 || index === 0x06 || index === 0x0b || index === 0x10)) {
        this.writeRegister(address, index === 0x0b ? value : value & 0x3f);
      }
      return;
    }
    this.writeRegister(address, value);
  }

  /** Whether the frame sequencer's next step leaves the length counters alone (which bends the length rules). */
  private get lengthHalf(): boolean {
    return (this.frameStep & 1) === 1;
  }

  /** NRx4: the length enable (with its extra clock) and the trigger. */
  private writeControl(channel: Square | Wave | Noise, value: number): void {
    const wasEnabled = channel.lengthEnabled;
    channel.lengthEnabled = (value & 0x40) !== 0;
    if (this.lengthHalf && !wasEnabled && channel.lengthEnabled && channel.length > 0) {
      if (--channel.length === 0 && !(value & 0x80)) channel.enabled = false;
    }
    if (!(value & 0x80)) return;
    channel.enabled = channel.dacOn;
    if (channel.length === 0) {
      channel.length = channel.maxLength;
      if (channel.lengthEnabled && this.lengthHalf) channel.length--;
    }
    channel.trigger();
  }

  private writeRegister(address: number, value: number): void {
    const index = address - 0xff10;
    this.registers[index] = value;
    const { square1, square2, wave, noise } = this;
    switch (index) {
      case 0x00: {
        const wasNegate = square1.sweepNegate;
        square1.sweepPeriod = (value >> 4) & 7;
        square1.sweepNegate = (value & 0x08) !== 0;
        square1.sweepShift = value & 7;
        if (wasNegate && !square1.sweepNegate && square1.negated) square1.enabled = false;
        break;
      }
      case 0x01:
      case 0x06: {
        const square = index === 0x01 ? square1 : square2;
        square.duty = value >> 6;
        square.length = 64 - (value & 0x3f);
        break;
      }
      case 0x02:
      case 0x07:
      case 0x11: {
        const channel = index === 0x02 ? square1 : index === 0x07 ? square2 : noise;
        channel.envelope.load(value);
        channel.dacOn = (value & 0xf8) !== 0;
        if (!channel.dacOn) channel.enabled = false;
        break;
      }
      case 0x03:
      case 0x08: {
        const square = index === 0x03 ? square1 : square2;
        square.frequency = (square.frequency & 0x700) | value;
        break;
      }
      case 0x04:
      case 0x09: {
        const square = index === 0x04 ? square1 : square2;
        square.frequency = (square.frequency & 0xff) | ((value & 7) << 8);
        this.writeControl(square, value);
        break;
      }
      case 0x0a:
        wave.dacOn = (value & 0x80) !== 0;
        if (!wave.dacOn) wave.enabled = false;
        break;
      case 0x0b:
        wave.length = 256 - value;
        break;
      case 0x0c:
        wave.level = (value >> 5) & 3;
        break;
      case 0x0d:
        wave.frequency = (wave.frequency & 0x700) | value;
        break;
      case 0x0e:
        wave.frequency = (wave.frequency & 0xff) | ((value & 7) << 8);
        this.writeControl(wave, value);
        break;
      case 0x10:
        noise.length = 64 - (value & 0x3f);
        break;
      case 0x12:
        noise.shift = value >> 4;
        noise.narrow = (value & 0x08) !== 0;
        noise.divisor = value & 7;
        break;
      case 0x13:
        this.writeControl(noise, value);
        break;
    }
  }
}
