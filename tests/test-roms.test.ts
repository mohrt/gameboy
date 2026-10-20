import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Model } from '../src/gameboy';
import { TEST_ROMS, haveTestRoms, machineFor, mooneyeResult, runSeconds, runUntil } from './helpers/machine';
import { differingPixels } from './helpers/png';

// c-sp's collection of test ROMs, downloaded by `npm run fetch:test-roms` (they skip without it).

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.gbc?$/.test(name) ? [path] : [];
    });
}

describe.skipIf(!haveTestRoms)("blargg's tests (results printed through the serial port)", () => {
  const roms: [string, Model, number][] = [
    ['cpu_instrs/cpu_instrs.gb', 'dmg', 60],
    ['instr_timing/instr_timing.gb', 'dmg', 5],
    ['mem_timing/mem_timing.gb', 'dmg', 5],
    ['cpu_instrs/cpu_instrs.gb', 'cgb', 40],
  ];
  it.each(roms)('%s (%s)', (rom, model, seconds) => {
    const machine = machineFor(join(TEST_ROMS, 'blargg', rom), model);
    runUntil(machine, seconds, () => /Passed|Failed/.test(machine.serial.output));
    expect(machine.serial.output).toContain('Passed');
  }, 120_000);
});

describe.skipIf(!haveTestRoms)('screens matching their expected screenshots', () => {
  const cases: [string, Model, string, number][] = [
    ['dmg-acid2/dmg-acid2.gb', 'dmg', 'dmg-acid2/dmg-acid2-dmg.png', 2],
    ['dmg-acid2/dmg-acid2.gb', 'cgb', 'dmg-acid2/dmg-acid2-cgb.png', 2],
    ['cgb-acid2/cgb-acid2.gbc', 'cgb', 'cgb-acid2/cgb-acid2.png', 2],
    ['blargg/mem_timing-2/mem_timing.gb', 'dmg', 'blargg/mem_timing-2/mem_timing-dmg-cgb.png', 5],
    ['blargg/halt_bug.gb', 'dmg', 'blargg/halt_bug-dmg-cgb.png', 3],
    ['blargg/interrupt_time/interrupt_time.gb', 'cgb', 'blargg/interrupt_time/interrupt_time-cgb.png', 3],
    ['blargg/cgb_sound/cgb_sound.gb', 'cgb', 'blargg/cgb_sound/cgb_sound-cgb.png', 38],
  ];
  it.each(cases)('%s (%s)', (rom, model, reference, seconds) => {
    const machine = machineFor(join(TEST_ROMS, rom), model);
    runSeconds(machine, seconds);
    machine.runFrame();
    expect(differingPixels(machine, new Uint8Array(readFileSync(join(TEST_ROMS, reference))))).toBe(0);
  }, 120_000);
});

describe.skipIf(!haveTestRoms)('the Mooneye Test Suite on the original Game Boy', () => {
  const root = join(TEST_ROMS, 'mooneye-test-suite');
  /** Tests for other models (DMG0, Pocket, Super Game Boy, ...). */
  const otherModel = /-(S|dmg0|mgb|sgb|sgb2|A|C|cgb)\.gb$/;
  /** Finer PPU and serial timing than is emulated. */
  const knownFailures = new Set([
    'acceptance/ppu/intr_2_mode0_timing_sprites.gb',
    'acceptance/ppu/lcdon_timing-GS.gb',
    'acceptance/ppu/lcdon_write_timing-GS.gb',
    'acceptance/ppu/stat_lyc_onoff.gb',
    'acceptance/serial/boot_sclk_align-dmgABCmgb.gb',
  ]);
  const tests = [...walk(join(root, 'acceptance')), ...walk(join(root, 'emulator-only'))]
    .map((path) => relative(root, path))
    .filter((name) => !otherModel.test(name) && !knownFailures.has(name));
  it.each(tests)('%s', (name) => {
    const machine = machineFor(join(root, name), 'dmg');
    runUntil(machine, 20, () => mooneyeResult(machine) !== 'running');
    expect(mooneyeResult(machine)).toBe('pass');
  }, 60_000);
});
