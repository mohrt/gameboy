import type { CartridgeInfo } from './header';

const ROM_BANK = 0x4000;
const RAM_BANK = 0x2000;
/** The MBC3's clock runs from its own 32768 Hz crystal; time here is counted in the console's 4 MHz clocks. */
const CLOCKS_PER_SECOND = 4_194_304;
/** The clock's part of a .sav file: ten 32-bit registers (current, then latched) and a 64-bit Unix time. */
const RTC_SAVE_SIZE = 48;
const RTC_SAVE_SIZE_SHORT = 44;

/** The MBC3's clock registers: seconds, minutes, hours, and a 9-bit day count with halt and carry flags. */
export interface ClockRegisters {
  seconds: number;
  minutes: number;
  hours: number;
  days: number;
  halt: boolean;
  carry: boolean;
}

const zeroClock = (): ClockRegisters => ({ seconds: 0, minutes: 0, hours: 0, days: 0, halt: false, carry: false });

/** Rounds a ROM up to a whole number of banks, a power of two of them, filling with $FF. */
function padRom(rom: Uint8Array): Uint8Array {
  let size = ROM_BANK * 2;
  while (size < rom.length) size *= 2;
  if (size === rom.length) return rom;
  const padded = new Uint8Array(size).fill(0xff);
  padded.set(rom);
  return padded;
}

/**
 * A cartridge: ROM at $0000-$7FFF (bank 0, then a switchable bank) and
 * optional RAM at $A000-$BFFF, switched by its memory bank controller:
 *
 * - MBC1: a 5-bit ROM bank and a 2-bit register that, by the mode, picks
 *   either the ROM's upper banks or the RAM bank. Multicarts wire the 5-bit
 *   register as 4 bits.
 * - MBC2: a 4-bit ROM bank and 512 half-bytes of RAM, chosen by address bit 8.
 * - MBC3: a 7-bit ROM bank, four RAM banks, and a real-time clock, read
 *   through a latched copy.
 * - MBC5: a 9-bit ROM bank and 16 RAM banks (8 with a rumble motor).
 */
export class Cartridge {
  readonly rom: Uint8Array;
  readonly ram: Uint8Array;
  ramEnabled = false;
  /** MBC1's 5-bit register, MBC2's 4-bit one, MBC3's 7-bit one, MBC5's 9-bit one. */
  romBank = 1;
  /** MBC1's 2-bit register; the MBC3's and MBC5's RAM bank (or clock register, $08-$0C on the MBC3). */
  ramBank = 0;
  /** MBC1's banking mode. */
  mode = 0;
  romOffsetLow = 0;
  romOffsetHigh = ROM_BANK;
  ramOffset = 0;
  clock = zeroClock();
  latchedClock = zeroClock();
  /** Clocks since the clock's last second. */
  clockClocks = 0;
  /** The last value written to the latch register (latching takes $00 then $01). */
  lastLatchWrite = 0xff;
  /** RAM (or the clock) changed since the game's save was last kept. */
  batteryDirty = false;
  private readonly romMask: number;

  constructor(
    rom: Uint8Array,
    readonly info: CartridgeInfo,
  ) {
    this.rom = padRom(rom);
    this.romMask = this.rom.length / ROM_BANK - 1;
    this.ram = new Uint8Array(info.ramSize).fill(0xff);
    this.reset();
  }

  /** The bank controller's registers go back to their power-on state (RAM keeps its contents). */
  reset(): void {
    this.ramEnabled = false;
    this.romBank = 1;
    this.ramBank = this.mode = 0;
    this.lastLatchWrite = 0xff;
    this.updateOffsets();
  }

  private updateOffsets(): void {
    const { info } = this;
    let low = 0;
    let high = this.romBank;
    let ramBank = 0;
    switch (info.mbc) {
      case 'mbc1':
      case 'mbc1m': {
        const shift = info.mbc === 'mbc1m' ? 4 : 5;
        const bank1 = info.mbc === 'mbc1m' ? this.romBank & 0x0f : this.romBank;
        const upper = this.ramBank << shift;
        high = upper | bank1;
        if (this.mode) {
          low = upper;
          ramBank = this.ramBank;
        }
        break;
      }
      case 'mbc3':
      case 'mbc5':
        ramBank = this.ramBank;
        break;
    }
    this.romOffsetLow = (low & this.romMask) * ROM_BANK;
    this.romOffsetHigh = (high & this.romMask) * ROM_BANK;
    this.ramOffset = this.ram.length > 0 ? (ramBank * RAM_BANK) % this.ram.length : 0;
  }

  readRom(address: number): number {
    return address < ROM_BANK ? this.rom[this.romOffsetLow + address] : this.rom[this.romOffsetHigh + (address & 0x3fff)];
  }

  writeRom(address: number, value: number): void {
    switch (this.info.mbc) {
      case 'none':
        return;
      case 'mbc1':
      case 'mbc1m':
        if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
        else if (address < 0x4000) this.romBank = value & 0x1f || 1;
        else if (address < 0x6000) this.ramBank = value & 0x03;
        else this.mode = value & 0x01;
        break;
      case 'mbc2':
        if (address >= 0x4000) return;
        if (address & 0x100) this.romBank = value & 0x0f || 1;
        else this.ramEnabled = (value & 0x0f) === 0x0a;
        break;
      case 'mbc3':
        if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
        else if (address < 0x4000) this.romBank = (this.rom.length > 0x200000 ? value : value & 0x7f) || 1;
        else if (address < 0x6000) this.ramBank = value & 0x0f;
        else {
          if (this.lastLatchWrite === 0 && value === 1) this.latchedClock = { ...this.clock };
          this.lastLatchWrite = value;
        }
        break;
      case 'mbc5':
        if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
        else if (address < 0x3000) this.romBank = (this.romBank & 0x100) | value;
        else if (address < 0x4000) this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
        else if (address < 0x6000) this.ramBank = value & (this.info.hasRumble ? 0x07 : 0x0f);
        break;
    }
    this.updateOffsets();
  }

  /** The MBC3's clock register mapped in place of RAM, if one is ($08-$0C). */
  private get clockRegister(): number {
    return this.info.hasRtc && this.ramBank >= 0x08 && this.ramBank <= 0x0c ? this.ramBank : 0;
  }

  readRam(address: number): number {
    if (!this.ramEnabled) return 0xff;
    if (this.info.mbc === 'mbc2') return this.ram[address & 0x1ff] | 0xf0;
    const register = this.clockRegister;
    if (register) return readClock(this.latchedClock, register);
    if (this.info.mbc === 'mbc3' && this.ramBank > 0x07) return 0xff;
    if (this.ram.length === 0) return 0xff;
    return this.ram[(this.ramOffset + (address & 0x1fff)) % this.ram.length];
  }

  writeRam(address: number, value: number): void {
    if (!this.ramEnabled) return;
    if (this.info.mbc === 'mbc2') {
      this.ram[address & 0x1ff] = value & 0x0f;
      this.batteryDirty = true;
      return;
    }
    const register = this.clockRegister;
    if (register) {
      writeClock(this.clock, register, value);
      if (register === 0x08) this.clockClocks = 0;
      this.batteryDirty = true;
      return;
    }
    if (this.ram.length === 0 || (this.info.mbc === 'mbc3' && this.ramBank > 0x07)) return;
    this.ram[(this.ramOffset + (address & 0x1fff)) % this.ram.length] = value;
    this.batteryDirty = true;
  }

  /** Runs the MBC3's clock for `clocks` 4 MHz clocks. */
  advanceClock(clocks: number): void {
    if (!this.info.hasRtc || this.clock.halt) return;
    this.clockClocks += clocks;
    while (this.clockClocks >= CLOCKS_PER_SECOND) {
      this.clockClocks -= CLOCKS_PER_SECOND;
      tickSecond(this.clock);
    }
  }

  /** The game's own save, as a .sav file (RAM, then the clock if it has one), or null if it doesn't save. */
  get saveData(): Uint8Array | null {
    const { info } = this;
    if (!info.hasBattery || (this.ram.length === 0 && !info.hasRtc)) return null;
    if (!info.hasRtc) return this.ram.slice();
    const data = new Uint8Array(this.ram.length + RTC_SAVE_SIZE);
    data.set(this.ram);
    const view = new DataView(data.buffer, this.ram.length);
    [this.clock, this.latchedClock].forEach((clock, i) => {
      for (let register = 0; register < 5; register++) view.setUint32((i * 5 + register) * 4, readClock(clock, 0x08 + register), true);
    });
    view.setBigUint64(40, BigInt(Math.floor(Date.now() / 1000)), true);
    return data;
  }

  /** Uses a .sav file: RAM, and the clock moved on by the time since it was saved. */
  loadSaveData(data: Uint8Array): void {
    this.ram.set(data.subarray(0, this.ram.length));
    if (!this.info.hasRtc) return;
    const extra = data.length - this.ram.length;
    if (extra !== RTC_SAVE_SIZE && extra !== RTC_SAVE_SIZE_SHORT) return;
    const view = new DataView(data.buffer, data.byteOffset + this.ram.length, extra);
    [this.clock, this.latchedClock].forEach((clock, i) => {
      for (let register = 0; register < 5; register++) writeClock(clock, 0x08 + register, view.getUint32((i * 5 + register) * 4, true));
    });
    const saved = extra === RTC_SAVE_SIZE ? Number(view.getBigUint64(40, true)) : view.getUint32(40, true);
    const elapsed = Math.floor(Date.now() / 1000) - saved;
    if (elapsed > 0 && !this.clock.halt) advanceSeconds(this.clock, elapsed);
  }
}

function readClock(clock: ClockRegisters, register: number): number {
  switch (register) {
    case 0x08:
      return clock.seconds;
    case 0x09:
      return clock.minutes;
    case 0x0a:
      return clock.hours;
    case 0x0b:
      return clock.days & 0xff;
    default:
      return ((clock.days >> 8) & 1) | (clock.halt ? 0x40 : 0) | (clock.carry ? 0x80 : 0);
  }
}

function writeClock(clock: ClockRegisters, register: number, value: number): void {
  switch (register) {
    case 0x08:
      clock.seconds = value & 0x3f;
      break;
    case 0x09:
      clock.minutes = value & 0x3f;
      break;
    case 0x0a:
      clock.hours = value & 0x1f;
      break;
    case 0x0b:
      clock.days = (clock.days & 0x100) | (value & 0xff);
      break;
    default:
      clock.days = (clock.days & 0xff) | ((value & 1) << 8);
      clock.halt = (value & 0x40) !== 0;
      clock.carry = (value & 0x80) !== 0;
  }
}

/** One second on: each register rolls over at its limit, though one set past it counts on to its bit width and wraps to 0. */
function tickSecond(clock: ClockRegisters): void {
  clock.seconds = (clock.seconds + 1) & 0x3f;
  if (clock.seconds !== 60) return;
  clock.seconds = 0;
  clock.minutes = (clock.minutes + 1) & 0x3f;
  if (clock.minutes !== 60) return;
  clock.minutes = 0;
  clock.hours = (clock.hours + 1) & 0x1f;
  if (clock.hours !== 24) return;
  clock.hours = 0;
  clock.days++;
  if (clock.days === 512) {
    clock.days = 0;
    clock.carry = true;
  }
}

function advanceSeconds(clock: ClockRegisters, seconds: number): void {
  const valid = clock.seconds < 60 && clock.minutes < 60 && clock.hours < 24;
  if (!valid) {
    for (let i = 0; i < Math.min(seconds, 86400); i++) tickSecond(clock);
    return;
  }
  let total = clock.seconds + clock.minutes * 60 + clock.hours * 3600 + clock.days * 86400 + seconds;
  let days = Math.floor(total / 86400);
  total -= days * 86400;
  if (days >= 512) {
    clock.carry = true;
    days %= 512;
  }
  clock.days = days;
  clock.hours = Math.floor(total / 3600);
  clock.minutes = Math.floor((total % 3600) / 60);
  clock.seconds = total % 60;
}
