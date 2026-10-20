/** The five interrupt sources, as their bits in IF ($FF0F) and IE ($FFFF), highest priority first. */
export const Interrupt = {
  VBlank: 0x01,
  Stat: 0x02,
  Timer: 0x04,
  Serial: 0x08,
  Joypad: 0x10,
} as const;

/** IF, the requests the chips make, and IE, the ones the program lets through. */
export class Interrupts {
  flags = 0;
  enable = 0;

  request(interrupt: number): void {
    this.flags |= interrupt;
  }

  get pending(): number {
    return this.flags & this.enable & 0x1f;
  }

  reset(): void {
    this.flags = this.enable = 0;
  }
}
