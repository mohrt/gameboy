import { deflateSync, inflateSync } from 'node:zlib';
import type { GameBoy } from '../../src/gameboy';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../src/ppu/ppu';
import { crc32 } from '../../src/util/crc32';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The machine's last picture as 0xRRGGBB values. */
export function frameRgb(machine: GameBoy): Uint32Array {
  return machine.ppu.framebuffer.map((pixel) => ((pixel & 0xff) << 16) | (pixel & 0xff00) | ((pixel >> 16) & 0xff));
}

/** Encodes the machine's last picture as an RGB PNG, each pixel drawn `scale` x `scale`. */
export function framePng(machine: GameBoy, scale = 2): Uint8Array {
  const rgb = frameRgb(machine);
  const width = SCREEN_WIDTH * scale;
  const height = SCREEN_HEIGHT * scale;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const color = rgb[Math.floor(y / scale) * SCREEN_WIDTH + Math.floor(x / scale)];
      raw.set([color >> 16, (color >> 8) & 0xff, color & 0xff], row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG (greyscale or palette of 1-8 bits, 8-bit RGB or with alpha; not interlaced) to 0xRRGGBB values. */
export function decodePng(png: Uint8Array): { width: number; height: number; pixels: Uint32Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 0;
  let palette = new Uint8Array(0);
  const data: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') palette = body.slice();
    else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (depth !== 8 && channels !== 1) throw new Error('Only 8-bit RGB PNGs are supported');
  const raw = inflateSync(Buffer.concat(data));
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rows[(y - 1) * stride + x - bpp] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      rows[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const sample = (x: number, y: number) => {
    const bit = x * depth;
    return (rows[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const pixels = new Uint32Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    if (colorType === 3) {
      const index = sample(x, y) * 3;
      pixels[i] = (palette[index] << 16) | (palette[index + 1] << 8) | palette[index + 2];
    } else if (colorType === 0) {
      pixels[i] = Math.round((sample(x, y) * 255) / ((1 << depth) - 1)) * 0x010101;
    } else {
      const p = y * stride + x * channels;
      pixels[i] = colorType === 4 ? rows[p] * 0x010101 : (rows[p] << 16) | (rows[p + 1] << 8) | rows[p + 2];
    }
  }
  return { width, height, pixels };
}

/** How many pixels of the machine's picture differ from a reference screenshot. */
export function differingPixels(machine: GameBoy, reference: Uint8Array): number {
  const expected = decodePng(reference);
  if (expected.width !== SCREEN_WIDTH || expected.height !== SCREEN_HEIGHT) throw new Error('Reference is not 160 x 144');
  const actual = frameRgb(machine);
  let differing = 0;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected.pixels[i]) differing++;
  return differing;
}
