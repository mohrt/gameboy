/** Canvas pixels (little-endian RGBA) from 0xRRGGBB. */
export function rgba(rgb: number): number {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
}

/** The Color's 15-bit colours (red in the low 5 bits) as canvas pixels, each channel widened as (x << 3) | (x >> 2). */
export const CGB_RGBA = Uint32Array.from({ length: 0x8000 }, (_, color) => {
  const widen = (x: number) => (x << 3) | (x >> 2);
  return (0xff000000 | (widen((color >> 10) & 31) << 16) | (widen((color >> 5) & 31) << 8) | widen(color & 31)) >>> 0;
});

export type ScreenPalette = 'green' | 'pocket' | 'color';

/** The four shades (lightest first) of the background and the two object palettes. */
export interface ShadeSet {
  name: string;
  bg: readonly number[];
  obj0: readonly number[];
  obj1: readonly number[];
}

const COLOR_BG = [0xffffff, 0x7bff31, 0x0063c6, 0x000000];
const COLOR_OBJ = [0xffffff, 0xff8484, 0x943939, 0x000000];

/** How the original Game Boy's four shades are shown. */
export const SCREEN_PALETTES: Record<ScreenPalette, ShadeSet> = {
  green: { name: 'Green (Game Boy)', bg: [0xc4cfa1, 0x8b956d, 0x4d533c, 0x1f1f1f], obj0: [], obj1: [] },
  pocket: { name: 'Grey (Game Boy Pocket)', bg: [0xffffff, 0xaaaaaa, 0x555555, 0x000000], obj0: [], obj1: [] },
  color: { name: 'Colour (as a Game Boy Color shows it)', bg: COLOR_BG, obj0: COLOR_OBJ, obj1: COLOR_OBJ },
};

/** Twelve canvas pixels: the background's four shades, then each object palette's. */
export function shadeTable(palette: ScreenPalette): Uint32Array {
  const set = SCREEN_PALETTES[palette];
  const bg = set.bg;
  const obj0 = set.obj0.length ? set.obj0 : bg;
  const obj1 = set.obj1.length ? set.obj1 : bg;
  return Uint32Array.from([...bg, ...obj0, ...obj1].map(rgba));
}

/** The Color's 15-bit form of a 0xRRGGBB colour (whose channels are already 5-bit values widened). */
export function rgb15(rgb: number): number {
  return ((rgb >> 19) & 31) | (((rgb >> 11) & 31) << 5) | (((rgb >> 3) & 31) << 10);
}

/**
 * The palettes a Game Boy Color's boot ROM gives an original Game Boy game
 * it doesn't recognise: background palette 0, then object palettes 0 and 1,
 * as palette memory (15-bit colours, low byte first).
 */
export function compatibilityPalettes(): { bg: Uint8Array; obj: Uint8Array } {
  const bytes = (colors: number[]) => colors.flatMap((rgb) => [rgb15(rgb) & 0xff, rgb15(rgb) >> 8]);
  return {
    bg: Uint8Array.from(bytes(COLOR_BG)),
    obj: Uint8Array.from([...bytes(COLOR_OBJ), ...bytes(COLOR_OBJ)]),
  };
}
