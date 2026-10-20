import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '../src/storage/save-states';
import { machineWithRom, romWith } from './helpers/rom';

// Counts in $C000 and copies the count to VRAM while the screen keeps running, with MBC5 RAM banked in.
const counter = {
  0x100: [0x00, 0xc3, 0x50, 0x01],
  0x150: [
    0x3e, 0x0a, 0xea, 0x00, 0x00, // LD A,$0A; LD ($0000),A: enable RAM
    0x21, 0x00, 0xc0, // LD HL,$C000
    0x34, // loop: INC (HL)
    0x7e, // LD A,(HL)
    0xea, 0x00, 0xa0, // LD ($A000),A
    0x18, 0xf9, // JR loop
  ],
};

describe('save states', () => {
  it('carry the whole console, so a restored one runs on exactly as the original', async () => {
    const rom = romWith({ code: counter, type: 0x1b, ramCode: 2, cgbFlag: 0x80 });
    const original = machineWithRom(rom, 'cgb');
    for (let frame = 0; frame < 30; frame++) original.runFrame();
    const session = await decodeSession(
      await encodeSession({ machine: original.saveState(), rom, romName: 'test.gbc', title: 'Test', model: 'cgb' }),
    );
    expect(session.title).toBe('Test');

    const restored = machineWithRom(session.rom, session.model);
    restored.loadState(session.machine);
    expect(restored.wram[0]).toBe(original.wram[0]);
    for (let frame = 0; frame < 30; frame++) {
      original.runFrame();
      restored.runFrame();
    }
    expect(restored.clock).toBe(original.clock);
    expect(restored.cpu.pc).toBe(original.cpu.pc);
    expect(restored.cartridge!.ram[0]).toBe(original.cartridge!.ram[0]);
    expect(restored.ppu.framebuffer).toEqual(original.ppu.framebuffer);
  });

  it('refuse files that are not save states', async () => {
    await expect(decodeSession(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a Game Boy save state/);
  });
});
