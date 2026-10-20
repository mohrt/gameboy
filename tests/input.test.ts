import { describe, expect, it } from 'vitest';
import { Interrupt, Interrupts } from '../src/interrupts';
import { Button, Joypad } from '../src/io/controllers';
import { gamepadFastForward, hatDirections, readGamepad, type GamepadLike } from '../src/io/gamepad-input';

const pad = (pressed: number[], axes: number[] = [0, 0], mapping = 'standard'): GamepadLike => ({
  id: 'Test pad',
  index: 0,
  mapping,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

describe('the joypad register', () => {
  it('reads the selected group, pressed buttons as 0', () => {
    const joypad = new Joypad(new Interrupts());
    joypad.input.set('test', { buttons: Button.Right | Button.Start });
    joypad.write(0x20); // D-pad
    expect(joypad.read()).toBe(0xee);
    joypad.write(0x10); // buttons
    expect(joypad.read()).toBe(0xd7);
    joypad.write(0x30);
    expect(joypad.read()).toBe(0xff);
  });

  it('raises the joypad interrupt when a selected button is pressed', () => {
    const interrupts = new Interrupts();
    const joypad = new Joypad(interrupts);
    joypad.write(0x10);
    joypad.update();
    joypad.input.set('test', { buttons: Button.A });
    joypad.update();
    expect(interrupts.flags & Interrupt.Joypad).toBeTruthy();
  });

  it('never shows opposite directions together', () => {
    const joypad = new Joypad(new Interrupts());
    joypad.input.set('test', { buttons: Button.Left | Button.Right | Button.Up });
    joypad.write(0x20);
    expect(joypad.read() & 0x0f).toBe(0x0b);
  });

  it('keeps a tap shorter than a frame until a whole frame has seen it', () => {
    const joypad = new Joypad(new Interrupts());
    joypad.input.set('key', { buttons: Button.Start });
    joypad.input.set('key', { buttons: 0 });
    joypad.write(0x10);
    expect(joypad.read() & 0x08).toBe(0);
    joypad.input.releaseLatched(5);
    expect(joypad.read() & 0x08).toBe(0);
    joypad.input.releaseLatched(6);
    expect(joypad.read() & 0x08).toBe(0x08);
  });
});

describe('gamepads', () => {
  it('map the face buttons by position, Select and Start, and the stick', () => {
    expect(readGamepad(pad([0])).buttons).toBe(Button.B);
    expect(readGamepad(pad([1])).buttons).toBe(Button.A);
    expect(readGamepad(pad([8, 9])).buttons).toBe(Button.Select | Button.Start);
    expect(readGamepad(pad([], [0.9, -0.9])).buttons).toBe(Button.Right | Button.Up);
    expect(readGamepad(pad([14])).buttons).toBe(Button.Left);
  });

  it('read hat switches on pads without a standard mapping', () => {
    expect(hatDirections(-1)).toBe(Button.Up);
    expect(hatDirections(1.28)).toBe(0);
  });

  it('fast-forward on the shoulder buttons', () => {
    expect(gamepadFastForward(pad([5]))).toBe(true);
    expect(gamepadFastForward(pad([0]))).toBe(false);
  });
});
