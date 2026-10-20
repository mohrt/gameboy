import { Interrupt, type Interrupts } from './interrupts';

/** The bit of the system counter each TAC setting watches: 4096, 262144, 65536 and 16384 Hz. */
const TAC_BITS = [9, 3, 5, 7];

/**
 * DIV and the programmable timer, both driven by one 16-bit counter that
 * counts CPU clocks (DIV is its top byte). TIMA counts falling edges of the
 * counter bit TAC picks, so writing DIV or TAC can bump it, as on the real
 * chip. When TIMA overflows it reads 0 for one M-cycle before TMA is loaded
 * and the interrupt raised; writing TIMA in that cycle cancels the reload.
 */
export class Timer {
  counter = 0;
  tima = 0;
  tma = 0;
  tac = 0;
  /** TIMA overflowed last M-cycle: the reload happens this one. */
  overflowed = false;
  /** TIMA is being reloaded this M-cycle (writes to TIMA are ignored, writes to TMA go through). */
  reloading = false;
  /** Called on each falling edge of DIV's bit 4 (bit 5 at double speed): the sound chip's frame sequencer. */
  onDivTick: () => void = () => {};
  doubleSpeed = false;

  constructor(private readonly interrupts: Interrupts) {}

  reset(): void {
    this.counter = this.tima = this.tma = this.tac = 0;
    this.overflowed = this.reloading = false;
    this.doubleSpeed = false;
  }

  private get signal(): boolean {
    return (this.tac & 0x04) !== 0 && ((this.counter >> TAC_BITS[this.tac & 3]) & 1) !== 0;
  }

  private get divBit(): number {
    return this.doubleSpeed ? 13 : 12;
  }

  private incrementTima(): void {
    if (this.tima === 0xff) {
      this.tima = 0;
      this.overflowed = true;
    } else {
      this.tima++;
    }
  }

  /** One M-cycle: four clocks of the counter. */
  tick(): void {
    this.reloading = false;
    if (this.overflowed) {
      this.overflowed = false;
      this.tima = this.tma;
      this.reloading = true;
      this.interrupts.request(Interrupt.Timer);
    }
    const before = this.counter;
    const wasHigh = this.signal;
    this.counter = (before + 4) & 0xffff;
    if (wasHigh && !this.signal) this.incrementTima();
    const bit = this.divBit;
    if ((before >> bit) & 1 && !((this.counter >> bit) & 1)) this.onDivTick();
  }

  get div(): number {
    return this.counter >> 8;
  }

  writeDiv(): void {
    const wasHigh = this.signal;
    const divWasHigh = (this.counter >> this.divBit) & 1;
    this.counter = 0;
    if (wasHigh) this.incrementTima();
    if (divWasHigh) this.onDivTick();
  }

  writeTima(value: number): void {
    if (this.reloading) return;
    this.tima = value;
    this.overflowed = false;
  }

  writeTma(value: number): void {
    this.tma = value;
    if (this.reloading) this.tima = value;
  }

  writeTac(value: number): void {
    const wasHigh = this.signal;
    this.tac = value & 0x07;
    if (wasHigh && !this.signal) this.incrementTima();
  }
}
