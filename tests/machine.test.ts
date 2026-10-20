import { describe, expect, it } from 'vitest';
import { CLOCK_HZ } from '../src/gameboy';
import { bootRomModel, looksLikeBootRom } from '../src/storage/boot-rom-store';
import { machineWithRom, romWith, runTo } from './helpers/rom';

/** A program that loops at $0150 forever. */
const idleLoop = { 0x100: [0x00, 0xc3, 0x50, 0x01], 0x150: [0x18, 0xfe] };

describe('the console', () => {
  it('starts a game as the boot ROM leaves it, at $0100', () => {
    const machine = machineWithRom(romWith({ code: idleLoop }));
    expect(machine.cpu.pc).toBe(0x100);
    expect([machine.cpu.a, machine.cpu.sp]).toEqual([0x01, 0xfffe]);
    expect(machine.ppu.lcdc).toBe(0x91);
    expect(machine.peek(0xff00)).toBe(0xcf);
    expect(machine.peek(0xff26)).toBe(0xf1);
  });

  it('runs a Color game in the Color mode and an older one in its compatibility mode', () => {
    const colour = machineWithRom(romWith({ cgbFlag: 0x80, code: idleLoop }), 'cgb');
    expect([colour.cgbMode, colour.cpu.a]).toEqual([true, 0x11]);
    const older = machineWithRom(romWith({ code: idleLoop }), 'cgb');
    expect(older.cgbMode).toBe(false);
    expect(older.ppu.bgPaletteRam[0]).toBe(0xff);
  });

  it('runs at 4 MHz: about 59.7 pictures a second', () => {
    const machine = machineWithRom(romWith({ code: idleLoop }));
    machine.run(CLOCK_HZ);
    expect(machine.ppu.frames).toBeGreaterThanOrEqual(59);
    expect(machine.ppu.frames).toBeLessThanOrEqual(60);
  });

  it('banks the work RAM and doubles its speed on the Color', () => {
    // LD A,2; LDH ($70),A; LD A,$5A; LD ($D000),A; LD A,1; LDH ($4D),A; STOP
    const code = [0x3e, 0x02, 0xe0, 0x70, 0x3e, 0x5a, 0xea, 0x00, 0xd0, 0x3e, 0x01, 0xe0, 0x4d, 0x10, 0x00, 0x18, 0xfe];
    const machine = machineWithRom(romWith({ cgbFlag: 0x80, code: { 0x100: code } }), 'cgb');
    runTo(machine, 0x10f);
    expect(machine.wram[0x2000]).toBe(0x5a);
    expect(machine.doubleSpeed).toBe(true);
    expect(machine.peek(0xff4d)).toBe(0xfe);
  });

  it('copies OAM with DMA', () => {
    // LD A,$C0; LDH ($46),A; then wait.
    const code = [0x3e, 0xc0, 0xe0, 0x46, 0x18, 0xfe];
    const machine = machineWithRom(romWith({ code: { 0x100: code } }));
    machine.wram.set([1, 2, 3, 4], 0);
    machine.run(4 * 200);
    expect([...machine.ppu.oam.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
  });
});

describe('boot ROMs', () => {
  /** A boot ROM that writes $11 to $C000 and unmaps itself, the last instruction ending at $0100. */
  const dmgBoot = () => {
    const boot = new Uint8Array(0x100);
    boot.set([0x3e, 0x11, 0xea, 0x00, 0xc0, 0x3e, 0x01], 0xf5);
    boot.set([0xe0, 0x50], 0xfe);
    return boot;
  };

  it('starts in the boot ROM, which hands over to the cartridge', () => {
    const machine = machineWithRom(romWith({ code: { 0x100: [0x18, 0xfe] } }));
    machine.bootRoms = { dmg: dmgBoot() };
    machine.powerOn();
    expect(machine.bootRomMapped).toBe(true);
    machine.cpu.pc = 0xf5;
    runTo(machine, 0x100);
    expect(machine.bootRomMapped).toBe(false);
    expect(machine.wram[0]).toBe(0x11);
    expect(machine.peek(0x100)).toBe(0x18);
  });

  it("puts the Color in its compatibility mode when its boot ROM sets KEY0", () => {
    const boot = new Uint8Array(0x900);
    boot.set([0x3e, 0x04, 0xe0, 0x4c, 0x3e, 0x01], 0xf8); // LD A,4; LDH ($4C),A; LD A,1
    boot.set([0xe0, 0x50], 0xfe);
    const machine = machineWithRom(romWith({ code: { 0x100: [0x18, 0xfe] } }), 'cgb');
    machine.bootRoms = { cgb: boot };
    machine.powerOn();
    expect(machine.cgbMode).toBe(true);
    machine.cpu.pc = 0xf8;
    runTo(machine, 0x100);
    expect(machine.cgbMode).toBe(false);
  });

  it('are recognised by size and name', () => {
    expect(bootRomModel(new Uint8Array(256))).toBe('dmg');
    expect(bootRomModel(new Uint8Array(2304))).toBe('cgb');
    expect(() => bootRomModel(new Uint8Array(512))).toThrow(/256 bytes/);
    expect(looksLikeBootRom('dmg_boot.bin')).toBe(true);
    expect(looksLikeBootRom('cgb_boot.bin')).toBe(true);
    expect(looksLikeBootRom('Tetris (World).gb')).toBe(false);
  });
});
