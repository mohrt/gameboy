import { Interrupt, type Interrupts } from '../interrupts';

/** The Game Boy's buttons: the low four are the D-pad, the high four the buttons, as P1 reads them. */
export const Button = {
  Right: 0x01,
  Left: 0x02,
  Up: 0x04,
  Down: 0x08,
  A: 0x10,
  B: 0x20,
  Select: 0x40,
  Start: 0x80,
} as const;

export interface PadState {
  /** Held buttons (Button bits). */
  buttons: number;
}

const idle = (): PadState => ({ buttons: 0 });

/**
 * The console's buttons, pressed by several input sources (keyboard, gamepad,
 * on-screen pad) at once. A press stays seen until the console has run, so a
 * tap shorter than a frame still reaches the game.
 */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();
  private latched = 0;
  /** The frame the console had reached when it first ran with the latched presses (-1 until then). */
  private latchFrame = -1;

  set(source: string, state: Partial<PadState>): void {
    const next = { ...idle(), ...state };
    this.latched |= next.buttons;
    this.sources.set(source, next);
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  get state(): PadState {
    const merged = { buttons: this.latched };
    for (const state of this.sources.values()) merged.buttons |= state.buttons;
    return merged;
  }

  /** The console has run up to picture `frame`: once a whole frame has seen the latched presses, only held buttons count. */
  releaseLatched(frame: number): void {
    if (this.latched === 0) return;
    if (this.latchFrame < 0) {
      this.latchFrame = frame;
    } else if (frame > this.latchFrame) {
      this.latched = 0;
      this.latchFrame = -1;
    }
  }
}

/** A D-pad can't press opposite directions together; some games misbehave if they see it. */
function withoutOpposites(buttons: number): number {
  if ((buttons & (Button.Up | Button.Down)) === (Button.Up | Button.Down)) buttons &= ~(Button.Up | Button.Down);
  if ((buttons & (Button.Left | Button.Right)) === (Button.Left | Button.Right)) buttons &= ~(Button.Left | Button.Right);
  return buttons;
}

/**
 * P1 ($FF00): the program pulls bit 4 low to read the D-pad and bit 5 low to
 * read the buttons; pressed ones read 0. A line going low raises the joypad
 * interrupt.
 */
export class Joypad {
  readonly input = new ControllerInput();
  select = 0;
  /** The four lines as last seen (1 = released), to catch presses. */
  lines = 0x0f;

  constructor(private readonly interrupts: Interrupts) {}

  reset(): void {
    this.select = 0;
    this.lines = 0x0f;
  }

  private currentLines(): number {
    const held = withoutOpposites(this.input.state.buttons);
    let lines = 0x0f;
    if (!(this.select & 0x10)) lines &= ~held & 0x0f;
    if (!(this.select & 0x20)) lines &= ~(held >> 4) & 0x0f;
    return lines;
  }

  read(): number {
    return 0xc0 | this.select | this.currentLines();
  }

  write(value: number): void {
    this.select = value & 0x30;
    this.update();
  }

  /** Looks for newly pressed buttons (called once a line, and when the selection changes). */
  update(): void {
    const lines = this.currentLines();
    if (this.lines & ~lines) this.interrupts.request(Interrupt.Joypad);
    this.lines = lines;
  }
}
