import { Button, type ControllerInput } from './controllers';

const BUTTON_KEYS: Record<string, number> = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
  KeyX: Button.A,
  KeyK: Button.A,
  KeyZ: Button.B,
  KeyJ: Button.B,
  Enter: Button.Start,
  ShiftLeft: Button.Select,
  ShiftRight: Button.Select,
  Backspace: Button.Select,
};
const PAUSE_KEYS = new Set(['Pause', 'KeyP']);
const FAST_FORWARD_KEYS = new Set(['Tab', 'Space']);

export interface KeyboardCallbacks {
  onPause(): void;
  /** The fast-forward key went down (true) or up (false). */
  onFastForward(held: boolean): void;
}

/** True when a key press belongs to a form field rather than the game. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * The console's buttons on the keyboard: arrows for the D-pad, X (or K) for
 * A, Z (or J) for B, Enter for Start and Shift (or Backspace) for Select. P
 * pauses the emulator; holding Tab or Space runs it fast.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor(
    private readonly controller: ControllerInput,
    private readonly callbacks: KeyboardCallbacks,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => {
      this.held.clear();
      this.update();
      this.callbacks.onFastForward(false);
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (down && (event.ctrlKey || event.metaKey || event.altKey || typingInField(event))) return;
    const code = event.code;
    if (PAUSE_KEYS.has(code)) {
      if (down && !event.repeat) this.callbacks.onPause();
      event.preventDefault();
      return;
    }
    if (FAST_FORWARD_KEYS.has(code)) {
      if (!event.repeat) this.callbacks.onFastForward(down);
      event.preventDefault();
      return;
    }
    if (!(code in BUTTON_KEYS)) return;
    event.preventDefault();
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.update();
  }

  private update(): void {
    let buttons = 0;
    for (const code of this.held) buttons |= BUTTON_KEYS[code] ?? 0;
    this.controller.set('keyboard', { buttons });
  }
}
