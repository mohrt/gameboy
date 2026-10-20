import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { colorSupport, readHeader } from '../src/cart/header';
import { romWith } from './helpers/rom';

const cartridge = (options: Parameters<typeof romWith>[0]) => {
  const rom = romWith(options);
  return new Cartridge(rom, readHeader(rom));
};

describe('the cartridge header', () => {
  it('reads the title, type, RAM size, Color support and checksum', () => {
    const info = readHeader(romWith({ type: 0x1b, ramCode: 3, cgbFlag: 0x80, title: 'HELLO' }));
    expect(info).toMatchObject({ title: 'HELLO', mbc: 'mbc5', ramSize: 0x8000, hasBattery: true, headerChecksumOk: true });
    expect(colorSupport(info)).toBe('enhanced');
    expect(colorSupport(readHeader(romWith({ cgbFlag: 0xc0 })))).toBe('only');
  });

  it('gives MBC2 its built-in 512 half-bytes of RAM, and the MBC3 its clock', () => {
    expect(readHeader(romWith({ type: 0x06 })).ramSize).toBe(0x200);
    expect(readHeader(romWith({ type: 0x10, ramCode: 3 }))).toMatchObject({ mbc: 'mbc3', hasRtc: true, hasBattery: true });
  });

  it('refuses images too small or with controllers that are not emulated', () => {
    expect(() => readHeader(new Uint8Array(0x100))).toThrow(/too small/);
    expect(() => readHeader(romWith({ type: 0xfc }))).toThrow(/Game Boy Camera/);
  });
});

describe('bank switching', () => {
  it('MBC1 maps bank 1 for 0, and the upper bits by mode', () => {
    const cart = cartridge({ type: 0x01, size: 0x100000 });
    const bankAt = (address: number) => cart.readRom(address | 0x3fff);
    cart.writeRom(0x2000, 0);
    expect(bankAt(0x4000)).toBe(1);
    cart.writeRom(0x2000, 0x05);
    cart.writeRom(0x4000, 0x01);
    expect(bankAt(0x4000)).toBe(0x25);
    expect(bankAt(0x0000)).toBe(0);
    cart.writeRom(0x6000, 1);
    expect(bankAt(0x0000)).toBe(0x20);
  });

  it('MBC1 only lets the game at its RAM once enabled', () => {
    const cart = cartridge({ type: 0x03, ramCode: 2 });
    cart.writeRam(0xa000, 0x42);
    expect(cart.readRam(0xa000)).toBe(0xff);
    cart.writeRom(0x0000, 0x0a);
    cart.writeRam(0xa000, 0x42);
    expect(cart.readRam(0xa000)).toBe(0x42);
    expect(cart.batteryDirty).toBe(true);
  });

  it('MBC2 stores half-bytes, repeated through $A000-$BFFF', () => {
    const cart = cartridge({ type: 0x06, size: 0x40000 });
    cart.writeRom(0x0000, 0x0a);
    cart.writeRam(0xa003, 0xab);
    expect(cart.readRam(0xa003)).toBe(0xfb);
    expect(cart.readRam(0xa203)).toBe(0xfb);
    cart.writeRom(0x0100, 0x03);
    expect(cart.readRom(0x7fff)).toBe(3);
  });

  it('MBC5 has a 9-bit ROM bank, and bank 0 can be mapped high', () => {
    const cart = cartridge({ type: 0x19, size: 0x800000 });
    cart.writeRom(0x2000, 0x00);
    expect(cart.readRom(0x7fff)).toBe(0);
    cart.writeRom(0x2000, 0x23);
    cart.writeRom(0x3000, 0x01);
    expect(cart.readRom(0x7fff)).toBe(0x23);
    expect(cart.readRom(0x4000 + 0x3ffe)).toBe(0);
  });
});

describe("the MBC3's clock", () => {
  afterEach(() => vi.useRealTimers());

  const clockCart = () => {
    const cart = cartridge({ type: 0x10, ramCode: 2 });
    cart.writeRom(0x0000, 0x0a);
    return cart;
  };
  const latch = (cart: Cartridge) => {
    cart.writeRom(0x6000, 0);
    cart.writeRom(0x6000, 1);
  };
  const read = (cart: Cartridge, register: number) => {
    cart.writeRom(0x4000, register);
    return cart.readRam(0xa000);
  };

  it('counts seconds into minutes, and is read through its latch', () => {
    const cart = clockCart();
    cart.writeRom(0x4000, 0x08);
    cart.writeRam(0xa000, 59);
    cart.advanceClock(4_194_304);
    expect(read(cart, 0x08)).toBe(0);
    latch(cart);
    expect(read(cart, 0x08)).toBe(0);
    expect(read(cart, 0x09)).toBe(1);
  });

  it('stops while halted', () => {
    const cart = clockCart();
    cart.writeRom(0x4000, 0x0c);
    cart.writeRam(0xa000, 0x40);
    cart.advanceClock(4_194_304 * 5);
    latch(cart);
    expect(read(cart, 0x08)).toBe(0);
  });

  it('saves after the RAM and moves on by the time away when loaded', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const cart = clockCart();
    cart.writeRom(0x4000, 0x0a);
    cart.writeRam(0xa000, 23);
    const save = cart.saveData!;
    expect(save.length).toBe(0x2000 + 48);
    vi.setSystemTime(new Date('2026-01-01T02:00:30Z'));
    const later = clockCart();
    later.loadSaveData(save);
    latch(later);
    expect([read(later, 0x08), read(later, 0x0a), read(later, 0x0b)]).toEqual([30, 1, 1]);
  });
});
