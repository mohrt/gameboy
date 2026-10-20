import { describe, expect, it } from 'vitest';
import { Interrupt, Interrupts } from '../src/interrupts';
import { CGB_RGBA, shadeTable } from '../src/ppu/palettes';
import { DOTS_PER_FRAME, DOTS_PER_LINE, Ppu } from '../src/ppu/ppu';

function ppuWith(lcdc = 0x91, cgb = false): { ppu: Ppu; interrupts: Interrupts } {
  const interrupts = new Interrupts();
  const ppu = new Ppu(interrupts);
  ppu.reset(cgb, cgb);
  ppu.writeLcdc(lcdc);
  // The first picture after switching the LCD on would be blank.
  ppu.blankFrame = false;
  return { ppu, interrupts };
}

const run = (ppu: Ppu, dots: number) => {
  for (let i = 0; i < dots; i += 4) ppu.tick(4);
};

/** Tile 1 as a solid block of colour 3. */
function solidTile(ppu: Ppu): void {
  ppu.vram.fill(0xff, 16, 32);
}

describe('PPU timing', () => {
  it('runs 154 lines of 456 dots, raising VBlank at line 144', () => {
    const { ppu, interrupts } = ppuWith();
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.ly).toBe(144);
    expect(interrupts.flags & Interrupt.VBlank).toBeTruthy();
    expect(ppu.frames).toBe(1);
    run(ppu, DOTS_PER_FRAME);
    expect(ppu.frames).toBe(2);
  });

  it('goes through modes 2, 3 and 0 on a visible line', () => {
    const { ppu } = ppuWith();
    const modes = new Set<number>();
    for (let dot = 0; dot < DOTS_PER_LINE; dot += 4) {
      ppu.tick(4);
      modes.add(ppu.readStat() & 3);
    }
    expect([...modes]).toEqual([2, 3, 0]);
  });

  it('raises the STAT interrupt when LY reaches LYC, once', () => {
    const { ppu, interrupts } = ppuWith();
    ppu.writeStat(0x40);
    ppu.writeLyc(10);
    interrupts.flags = 0;
    run(ppu, DOTS_PER_LINE * 10 + 8);
    expect(interrupts.flags & Interrupt.Stat).toBeTruthy();
    expect(ppu.readStat() & 0x04).toBe(0x04);
    interrupts.flags = 0;
    run(ppu, DOTS_PER_LINE / 2);
    expect(interrupts.flags & Interrupt.Stat).toBe(0);
  });

  it('locks VRAM during drawing and OAM during the search too', () => {
    const { ppu } = ppuWith();
    ppu.vram[0] = 0x12;
    ppu.oam[0] = 0x34;
    run(ppu, 8);
    expect(ppu.readOam(0xfe00)).toBe(0xff);
    expect(ppu.readVram(0x8000)).toBe(0x12);
    run(ppu, 100);
    expect(ppu.readVram(0x8000)).toBe(0xff);
    run(ppu, 200);
    expect(ppu.readVram(0x8000)).toBe(0x12);
    expect(ppu.readOam(0xfe00)).toBe(0x34);
  });

  it('shows a blank screen and keeps making pictures with the LCD off', () => {
    const { ppu } = ppuWith(0x11);
    run(ppu, DOTS_PER_FRAME);
    expect(ppu.frames).toBe(1);
    expect(ppu.ly).toBe(0);
    expect(ppu.readStat() & 3).toBe(0);
  });
});

describe('PPU drawing', () => {
  it('draws background tiles through BGP', () => {
    const { ppu } = ppuWith();
    ppu.screenColors = shadeTable('pocket');
    solidTile(ppu);
    ppu.vram[0x1800] = 1;
    ppu.bgp = 0xe4;
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.framebuffer[0]).toBe(ppu.screenColors[3]);
    expect(ppu.framebuffer[8]).toBe(ppu.screenColors[0]);
  });

  it('scrolls by SCX, and a write part way along a line takes effect part way along it', () => {
    const { ppu } = ppuWith();
    solidTile(ppu);
    ppu.vram[0x1800] = 1;
    ppu.bgp = 0xe4;
    ppu.writeDisplay('scx', 4);
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.framebuffer[3]).toBe(ppu.screenColors[3]);
    expect(ppu.framebuffer[4]).toBe(ppu.screenColors[0]);

    // Halfway through drawing line 10, across a row of solid tiles, BGP maps every colour to white.
    ppu.vram.fill(1, 0x1800 + 32, 0x1800 + 64);
    run(ppu, DOTS_PER_LINE * 20 + 80 + 12 + 80);
    expect(ppu.ly).toBe(10);
    ppu.writeDisplay('bgp', 0x00);
    run(ppu, DOTS_PER_LINE);
    const row = 10 * 160;
    expect(ppu.framebuffer[row + 8]).toBe(ppu.screenColors[3]);
    expect(ppu.framebuffer[row + 150]).toBe(ppu.screenColors[0]);
  });

  it('draws objects over the background, behind it with their priority bit', () => {
    const { ppu } = ppuWith(0x93);
    solidTile(ppu);
    ppu.obp0 = 0xe4;
    ppu.bgp = 0xe4;
    ppu.oam.set([16, 8, 1, 0x00, 16, 40, 1, 0x80]);
    ppu.vram[0x1800 + 5] = 1;
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.framebuffer[0]).toBe(ppu.screenColors[4 + 3]);
    expect(ppu.framebuffer[32]).toBe(ppu.screenColors[4 + 3]);
    // The second object is behind the background tile at x 40.
    expect(ppu.framebuffer[40]).toBe(ppu.screenColors[3]);
  });

  it('shows only ten objects on a line', () => {
    const { ppu } = ppuWith(0x93);
    solidTile(ppu);
    ppu.obp0 = 0xe4;
    for (let i = 0; i < 12; i++) ppu.oam.set([16, 8 + i * 8, 1, 0], i * 4);
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.framebuffer[9 * 8]).toBe(ppu.screenColors[4 + 3]);
    expect(ppu.framebuffer[10 * 8]).toBe(ppu.screenColors[0]);
  });

  it("uses the Color's palettes and tile attributes", () => {
    const { ppu } = ppuWith(0x91, true);
    solidTile(ppu);
    ppu.vram[0x1800] = 1;
    ppu.vram[0x3800] = 0x02; // palette 2
    ppu.bcps = 0x80 | (2 * 8 + 6);
    ppu.writePaletteData(false, 0x1f); // colour 3 of palette 2: red
    ppu.writePaletteData(false, 0x00);
    expect(ppu.bcps).toBe(0x80 | (2 * 8 + 8));
    run(ppu, DOTS_PER_LINE * 144);
    expect(ppu.framebuffer[0]).toBe(CGB_RGBA[0x001f]);
  });
});
