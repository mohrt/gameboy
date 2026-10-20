import type { Sm83Bus } from '../../src/cpu/sm83';

/** 64K of plain RAM with interrupt flags, counting M-cycles, for testing the CPU in isolation. */
export class FlatBus implements Sm83Bus {
  readonly memory = new Uint8Array(0x10000);
  cycles = 0;
  interruptFlags = 0;
  interruptEnable = 0;
  stopped = false;

  read(address: number): number {
    this.cycles++;
    return this.memory[address];
  }

  write(address: number, value: number): void {
    this.cycles++;
    this.memory[address] = value;
  }

  idle(): void {
    this.cycles++;
  }

  pendingInterrupts(): number {
    return this.interruptFlags & this.interruptEnable & 0x1f;
  }

  acknowledgeInterrupt(bit: number): void {
    this.interruptFlags &= ~(1 << bit);
  }

  stop(): boolean {
    this.stopped = true;
    return false;
  }

  load(address: number, bytes: ArrayLike<number>): void {
    this.memory.set(bytes, address);
  }
}
