import { Cartridge } from '../../src/cart/cartridge';
import { readHeader } from '../../src/cart/header';
import { GameBoy, type Model } from '../../src/gameboy';

export interface RomOptions {
  /** Code (or data) placed at given addresses. */
  code?: Record<number, number[]>;
  size?: number;
  /** Header bytes: cartridge type ($0147), RAM size code ($0149) and Color flag ($0143). */
  type?: number;
  ramCode?: number;
  cgbFlag?: number;
  title?: string;
}

/** A ROM with a valid header, where each 16K bank ends with its own number, and code placed at given addresses. */
export function romWith({ code = {}, size = 0x8000, type = 0, ramCode = 0, cgbFlag = 0, title = 'TEST' }: RomOptions = {}): Uint8Array {
  const rom = new Uint8Array(size);
  for (let bank = 0; bank * 0x4000 < size; bank++) rom[bank * 0x4000 + 0x3fff] = bank & 0xff;
  rom.set(new TextEncoder().encode(title), 0x134);
  rom[0x143] = cgbFlag;
  rom[0x147] = type;
  rom[0x148] = Math.log2(size / 0x8000);
  rom[0x149] = ramCode;
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - rom[i] - 1) & 0xff;
  rom[0x14d] = checksum;
  for (const [address, bytes] of Object.entries(code)) rom.set(bytes, Number(address));
  return rom;
}

/** A console with `rom` in it, switched on. */
export function machineWithRom(rom: Uint8Array, model: Model = 'dmg'): GameBoy {
  const machine = new GameBoy();
  machine.setModel(model);
  machine.insertCartridge(new Cartridge(rom, readHeader(rom)));
  return machine;
}

/** Runs instructions until PC reaches `address` (or gives up). */
export function runTo(machine: GameBoy, address: number, maxSteps = 100_000): void {
  for (let i = 0; i < maxSteps && machine.cpu.pc !== address; i++) machine.step();
  if (machine.cpu.pc !== address) throw new Error(`Never reached $${address.toString(16)}`);
}
