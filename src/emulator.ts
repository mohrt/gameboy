import { CLOCK_HZ, GameBoy } from './gameboy';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;

/** Glues the machine to the screen and the speakers, and runs it in step with real time. */
export class Emulator {
  readonly machine = new GameBoy();
  private clockDebt = 0;
  private idleShown = false;

  constructor(private readonly screen: Screen) {
    this.machine.onFrame = (frame) => screen.capture(frame);
    this.setAudioRate(48000);
  }

  get canRun(): boolean {
    return this.machine.canRun;
  }

  setAudioRate(rate: number): void {
    this.machine.mixer.setRates(CLOCK_HZ, rate);
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.clockDebt = 0;
  }

  /** Runs the machine for `elapsedMs` of real time (no more than MAX_CATCH_UP_MS), `speed` times as fast. */
  run(elapsedMs: number, speed = 1): void {
    if (!this.canRun) {
      if (!this.idleShown) this.screen.showIdle();
      this.idleShown = true;
      return;
    }
    this.idleShown = false;
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * CLOCK_HZ * speed) / 1000;
    const clocks = Math.floor(this.clockDebt);
    const start = this.machine.clock;
    this.machine.run(clocks);
    this.clockDebt -= this.machine.clock - start;
  }

  takeAudioSamples(): Float32Array {
    return this.machine.mixer.takeSamples();
  }
}
