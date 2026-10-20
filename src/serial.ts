import { Interrupt, type Interrupts } from './interrupts';

/** On the internal clock a bit goes every 512 clocks (8192 Hz), or 32 times faster with the Color's fast clock. */
const CLOCKS_PER_BIT = 512;
const FAST_CLOCKS_PER_BIT = 16;

/**
 * The link port with no cable in: a transfer on the console's own clock
 * shifts out SB's eight bits and shifts in 1s, then raises the interrupt. On
 * the other console's clock nothing ever arrives. Bytes sent are kept in
 * `output` (test ROMs print their results this way).
 */
export class Serial {
  data = 0;
  control = 0;
  /** Clocks left until the transfer in progress finishes (0 when none is). */
  remaining = 0;
  output = '';
  /** Whether the Color's fast clock (SC bit 1) can be chosen. */
  cgb = false;

  constructor(private readonly interrupts: Interrupts) {}

  reset(): void {
    this.data = this.control = this.remaining = 0;
  }

  read(): number {
    return this.control | (this.cgb ? 0x7c : 0x7e);
  }

  write(value: number): void {
    this.control = value & (this.cgb ? 0x83 : 0x81);
    if ((value & 0x81) !== 0x81) {
      this.remaining = 0;
      return;
    }
    if (this.output.length < 0x10000) this.output += String.fromCharCode(this.data);
    this.remaining = 8 * (this.cgb && value & 0x02 ? FAST_CLOCKS_PER_BIT : CLOCKS_PER_BIT);
  }

  /** Advances by `clocks` CPU clocks. */
  tick(clocks: number): void {
    if (this.remaining === 0) return;
    this.remaining -= clocks;
    if (this.remaining > 0) return;
    this.remaining = 0;
    this.data = 0xff;
    this.control &= 0x7f;
    this.interrupts.request(Interrupt.Serial);
  }
}
