import { isZip, usableFilesInZip } from './zip';

export const CARTRIDGE_EXTENSIONS = ['.gb', '.gbc', '.cgb', '.sgb', '.bin'];
export const STATE_EXTENSION = '.gbstate';
export const BATTERY_EXTENSION = '.sav';
/** The biggest cartridges are 8M (MBC5's limit). */
const MAX_IMAGE_SIZE = 0x800000;

export type Media =
  | { kind: 'cartridge'; image: Uint8Array; name: string }
  | { kind: 'state'; bytes: Uint8Array; name: string }
  | { kind: 'battery'; bytes: Uint8Array; name: string };

/** gzip files start with $1F $8B; save states are gzipped. */
export function looksLikeSaveState(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A display name from a file name: no extension, underscores as spaces. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
}

/** Works out what a file is: a cartridge image, a save state, or a battery save. */
export async function readMedia(file: File): Promise<Media> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(STATE_EXTENSION) || looksLikeSaveState(bytes)) return { kind: 'state', bytes, name: file.name };
  if (name.endsWith(BATTERY_EXTENSION) || name.endsWith('.srm')) return { kind: 'battery', bytes, name: file.name };
  if (bytes.length === 0) throw new Error(`${file.name} is empty.`);
  if (bytes.length > MAX_IMAGE_SIZE) throw new Error(`${file.name} is too big to be a Game Boy cartridge.`);
  if (!CARTRIDGE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw new Error(`${file.name} isn't a cartridge image. Try a .gb or .gbc file.`);
  }
  return { kind: 'cartridge', image: bytes, name: file.name };
}

/** The usable files in a dropped file: itself, or the cartridge images and states inside a zip. */
export async function filesFrom(file: File): Promise<File[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZip(head) && !file.name.toLowerCase().endsWith('.zip')) return [file];
  const files = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
  if (files.length === 0) throw new Error(`${file.name} has no Game Boy cartridge images in it.`);
  return files;
}
