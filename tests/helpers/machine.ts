import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cartridge } from '../../src/cart/cartridge';
import { colorSupport, readHeader } from '../../src/cart/header';
import { CLOCK_HZ, GameBoy, type Model } from '../../src/gameboy';

export const TEST_ROMS = join(import.meta.dirname, '..', 'fixtures', 'test-roms');
export const haveTestRoms = existsSync(TEST_ROMS);

/** The model the page's Auto picks: the Color for games that use it. */
export function autoModel(rom: Uint8Array): Model {
  return colorSupport(readHeader(rom)) === 'none' ? 'dmg' : 'cgb';
}

/** A console with a ROM in it, switched on (as the given model, or the one Auto picks). */
export function machineWith(rom: Uint8Array, model: Model = autoModel(rom)): GameBoy {
  const machine = new GameBoy();
  machine.setModel(model);
  machine.insertCartridge(new Cartridge(rom, readHeader(rom)));
  return machine;
}

export function machineFor(path: string, model?: Model): GameBoy {
  return machineWith(new Uint8Array(readFileSync(path)), model);
}

/** Runs for `seconds` of emulated time. */
export function runSeconds(machine: GameBoy, seconds: number): void {
  machine.run(Math.round(seconds * CLOCK_HZ));
}

/** Runs until `done` (checked once a frame) or `seconds` have passed; returns whether it got there. */
export function runUntil(machine: GameBoy, seconds: number, done: () => boolean): boolean {
  const frames = Math.ceil(seconds * 60);
  for (let frame = 0; frame < frames; frame++) {
    machine.runFrame();
    if (done()) return true;
  }
  return false;
}

/** Mooneye's tests end with LD B,B; on success the registers hold the Fibonacci numbers 3, 5, 8, 13, 21, 34. */
export function mooneyeResult(machine: GameBoy): 'pass' | 'fail' | 'running' {
  const { cpu } = machine;
  if (cpu.b === 3 && cpu.c === 5 && cpu.d === 8 && cpu.e === 13 && cpu.h === 21 && cpu.l === 34) return 'pass';
  if (cpu.b === 0x42 && cpu.c === 0x42 && cpu.d === 0x42 && cpu.e === 0x42 && cpu.h === 0x42 && cpu.l === 0x42) return 'fail';
  return 'running';
}
