import { BOOT_ROM_SIZES, type Model } from '../gameboy';
import type { KeyValueStore } from './store';

export const BOOT_ROM_NAMES: Record<Model, string> = { dmg: 'Game Boy boot ROM', cgb: 'Game Boy Color boot ROM' };

/** File names that say they are a boot ROM, so a dropped one isn't taken for a game. */
export function looksLikeBootRom(fileName: string): boolean {
  return /\b(boot|bios)\b|(boot|bios)[\s._-]|^(dmg|cgb|mgb)[_-]?(boot|rom)?\.bin$/i.test(fileName);
}

/** Which console a boot ROM is for, by its size: 256 bytes for the Game Boy (and Pocket), 2304 for the Color. */
export function bootRomModel(bytes: Uint8Array): Model {
  const model = (Object.keys(BOOT_ROM_SIZES) as Model[]).find((kind) => BOOT_ROM_SIZES[kind] === bytes.length);
  if (!model) {
    throw new Error(
      `That file (${bytes.length} bytes) isn't a boot ROM: the Game Boy's is 256 bytes and the Game Boy Color's 2304.`,
    );
  }
  return model;
}

/** The player's boot ROMs, kept in browser storage so they only have to be given once. */
export class BootRomStore {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  async load(): Promise<Partial<Record<Model, Uint8Array>>> {
    const images: Partial<Record<Model, Uint8Array>> = {};
    for (const [key, bytes] of await this.store.entries()) {
      if (key === 'dmg' || key === 'cgb') images[key] = bytes;
    }
    return images;
  }

  save(model: Model, bytes: Uint8Array): Promise<void> {
    return this.store.put(model, bytes.slice());
  }

  async forget(): Promise<void> {
    await this.store.delete('dmg');
    await this.store.delete('cgb');
  }
}
