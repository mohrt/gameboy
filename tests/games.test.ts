import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGameManifest } from '../src/games';
import { Button } from '../src/io/controllers';
import { machineFor } from './helpers/machine';
import { framePng } from './helpers/png';

// Cartridge images are never committed. These run the free games (`npm run fetch:games` puts
// them in public/games/) and any of your own you put in roms/.
const root = join(import.meta.dirname, '..');
const EXTENSIONS = /\.(gb|gbc|cgb)$/i;
const romFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => EXTENSIONS.test(name)).map((name) => join(dir, name)) : [];
const cartridges = [...romFiles(join(root, 'public', 'games')), ...romFiles(join(root, 'roms'))];
/** Set SHOTS=<dir> to save screenshots of the title screen and after pressing buttons. */
const shotsDir = process.env.SHOTS;
const FPS = 60;
const TITLE_SECONDS = 5;
const PLAY_SECONDS = 10;

describe.skipIf(cartridges.length === 0)('cartridges', () => {
  for (const path of cartridges) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(EXTENSIONS, '');
    it(`${name} boots, draws a picture and keeps running`, () => {
      const machine = machineFor(path);
      const shot = (label: string) => {
        if (!shotsDir) return;
        mkdirSync(shotsDir, { recursive: true });
        writeFileSync(join(shotsDir, `${name} - ${label}.png`), framePng(machine));
      };
      for (let frame = 0; frame < TITLE_SECONDS * FPS; frame++) machine.runFrame();
      shot('title');
      // Press Start and A a few times, as a player would, then let it run.
      const pad = machine.joypad.input;
      let colours = 0;
      for (let frame = 0; frame < PLAY_SECONDS * FPS; frame++) {
        const pressing = frame % 60 < 5 && frame < 4 * FPS;
        pad.set('test', { buttons: pressing ? (frame < 2 * FPS ? Button.Start : Button.A) : 0 });
        machine.runFrame();
        if (frame % 30 === 0) colours = Math.max(colours, new Set(machine.ppu.framebuffer).size);
      }
      shot('later');
      expect(colours, 'colours on screen').toBeGreaterThan(1);
      expect(machine.cpu.locked, 'the CPU locked up').toBe(false);
      expect(machine.ppu.frames).toBeGreaterThanOrEqual((TITLE_SECONDS + PLAY_SECONDS) * FPS);
    }, 120_000);
  }
});

describe('the free games list', () => {
  it('keeps well-formed entries, and only safe paths and links', () => {
    const games = parseGameManifest({
      games: [
        { title: 'Good', file: 'good.gb', licenseUrl: 'games/good.gb.license.txt', sourceUrl: 'https://example.com' },
        { title: 'Escapes', file: '../secret.gb' },
        { title: 'Bad link', file: 'bad.gb', sourceUrl: 'javascript:alert(1)' },
        { file: 'untitled.gb' },
      ],
    });
    expect(games).toEqual([
      { title: 'Good', file: 'good.gb', licenseUrl: 'games/good.gb.license.txt', sourceUrl: 'https://example.com' },
      { title: 'Bad link', file: 'bad.gb' },
    ]);
  });

  it.skipIf(!existsSync(join(root, 'public', 'games', 'index.json')))('lists the downloaded games with their licences', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'public', 'games', 'index.json'), 'utf8'));
    const games = parseGameManifest(manifest);
    expect(games.length).toBeGreaterThan(0);
    for (const game of games) {
      expect(existsSync(join(root, 'public', 'games', game.file)), game.file).toBe(true);
      expect(game.license, game.title).toBeTruthy();
    }
  });
});
