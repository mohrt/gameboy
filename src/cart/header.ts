/** The memory bank controller on the cartridge: how it switches ROM and RAM banks. */
export type MbcKind = 'none' | 'mbc1' | 'mbc1m' | 'mbc2' | 'mbc3' | 'mbc5';

export const MBC_NAMES: Record<MbcKind, string> = {
  none: 'no MBC',
  mbc1: 'MBC1',
  mbc1m: 'MBC1 multicart',
  mbc2: 'MBC2',
  mbc3: 'MBC3',
  mbc5: 'MBC5',
};

export interface CartridgeInfo {
  title: string;
  /** Header byte $0143: bit 7 set for games that use the Color's features, $C0 for games that need them. */
  cgbFlag: number;
  /** The cartridge type byte ($0147). */
  type: number;
  mbc: MbcKind;
  ramSize: number;
  hasBattery: boolean;
  hasRtc: boolean;
  hasRumble: boolean;
  /** The header checksum ($014D) is right (the original Game Boy's boot ROM refuses the game otherwise). */
  headerChecksumOk: boolean;
}

/** RAM sizes by header byte $0149. */
const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];
/** MBC2 has 512 half-bytes of RAM built in. */
export const MBC2_RAM_SIZE = 0x200;
const HEADER_END = 0x150;

interface TypeEntry {
  mbc: MbcKind;
  ram?: boolean;
  battery?: boolean;
  rtc?: boolean;
  rumble?: boolean;
}

const TYPES: Record<number, TypeEntry> = {
  0x00: { mbc: 'none' },
  0x01: { mbc: 'mbc1' },
  0x02: { mbc: 'mbc1', ram: true },
  0x03: { mbc: 'mbc1', ram: true, battery: true },
  0x05: { mbc: 'mbc2' },
  0x06: { mbc: 'mbc2', battery: true },
  0x08: { mbc: 'none', ram: true },
  0x09: { mbc: 'none', ram: true, battery: true },
  0x0f: { mbc: 'mbc3', battery: true, rtc: true },
  0x10: { mbc: 'mbc3', ram: true, battery: true, rtc: true },
  0x11: { mbc: 'mbc3' },
  0x12: { mbc: 'mbc3', ram: true },
  0x13: { mbc: 'mbc3', ram: true, battery: true },
  0x19: { mbc: 'mbc5' },
  0x1a: { mbc: 'mbc5', ram: true },
  0x1b: { mbc: 'mbc5', ram: true, battery: true },
  0x1c: { mbc: 'mbc5', rumble: true },
  0x1d: { mbc: 'mbc5', ram: true, rumble: true },
  0x1e: { mbc: 'mbc5', ram: true, battery: true, rumble: true },
  // Hudson's HuC1 switches banks like an MBC1 (its infrared port isn't emulated).
  0xff: { mbc: 'mbc1', ram: true, battery: true },
};

const UNSUPPORTED: Record<number, string> = {
  0x0b: 'MMM01',
  0x0c: 'MMM01',
  0x0d: 'MMM01',
  0x20: 'MBC6',
  0x22: 'MBC7 (tilt sensor)',
  0xfc: 'Game Boy Camera',
  0xfd: 'Bandai TAMA5',
  0xfe: 'Hudson HuC3',
};

/** MBC1 multicarts are 1M, with a second game's header (Nintendo logo and all) at the start of bank $10. */
function isMbc1Multicart(rom: Uint8Array): boolean {
  if (rom.length !== 0x100000) return false;
  const logo = rom.subarray(0x104, 0x134);
  if (logo.every((byte) => byte === logo[0])) return false;
  for (let i = 0x104; i < 0x134; i++) if (rom[i] !== rom[0x40000 + i]) return false;
  return true;
}

function headerChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  return sum;
}

/** The title: up to 16 characters, fewer on Color games, which use the last bytes for other things. */
function readTitle(rom: Uint8Array, cgbFlag: number): string {
  const end = cgbFlag & 0x80 ? 0x143 : 0x144;
  let title = '';
  for (let i = 0x134; i < end && rom[i] !== 0; i++) title += rom[i] >= 0x20 && rom[i] < 0x7f ? String.fromCharCode(rom[i]) : '';
  return title.trim();
}

/** Reads a cartridge image's header; throws for images that can't be one, or need hardware that isn't emulated. */
export function readHeader(rom: Uint8Array): CartridgeInfo {
  if (rom.length < HEADER_END) throw new Error('That file is too small to be a Game Boy cartridge.');
  const type = rom[0x147];
  if (type in UNSUPPORTED) throw new Error(`That cartridge uses the ${UNSUPPORTED[type]}, which this emulator doesn't support.`);
  const entry = TYPES[type];
  if (!entry) throw new Error(`That cartridge's type ($${type.toString(16).padStart(2, '0')}) isn't one this emulator knows.`);
  const cgbFlag = rom[0x143];
  let mbc = entry.mbc;
  if (mbc === 'mbc1' && isMbc1Multicart(rom)) mbc = 'mbc1m';
  let ramSize = 0;
  if (mbc === 'mbc2') ramSize = MBC2_RAM_SIZE;
  else if (entry.ram) ramSize = RAM_SIZES[rom[0x149]] ?? 0;
  return {
    title: readTitle(rom, cgbFlag),
    cgbFlag,
    type,
    mbc,
    ramSize,
    hasBattery: entry.battery ?? false,
    hasRtc: entry.rtc ?? false,
    hasRumble: entry.rumble ?? false,
    headerChecksumOk: headerChecksum(rom) === rom[0x14d],
  };
}

/** Whether a game needs (or at least uses) the Game Boy Color. */
export function colorSupport(info: CartridgeInfo): 'none' | 'enhanced' | 'only' {
  if ((info.cgbFlag & 0x80) === 0) return 'none';
  return info.cgbFlag & 0x40 ? 'only' : 'enhanced';
}
