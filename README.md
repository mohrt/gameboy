# Game Boy in the browser

**Play it at [mohrt.github.io/gameboy](https://mohrt.github.io/gameboy/)**

A Game Boy and Game Boy Color emulator written from scratch in TypeScript: the SM83 CPU timed to the M-cycle, the PPU with its mode timing, mid-line register changes, objects and the window, the Color's second VRAM bank, tile attributes, colour palettes, HDMA and double speed, all four sound channels in stereo, the timer, OAM DMA, and the MBC1 (and its multicarts), MBC2, MBC3 (with its clock) and MBC5. Drop a `.gb` or `.gbc` file (or a `.zip` containing one) onto the page to play it. No boot ROM is needed: games start as the boot ROM would leave them, though you can add your own (see below).

It passes blargg's CPU, instruction timing, memory timing, HALT and Color sound and interrupt tests, dmg-acid2 (on both consoles) and cgb-acid2 pixel for pixel, and the Mooneye Test Suite's timer, interrupt, OAM DMA, memory bank controller and most of its PPU timing tests.

## Controls

- **Keyboard**: arrow keys for the D-pad, X (or K) for A, Z (or J) for B, Enter for Start and Shift (or Backspace) for Select. Hold Tab or Space to fast-forward. P or Pause pauses the emulator.
- **Gamepads** work as soon as you press one of their buttons. The D-pad or left stick is the D-pad; the bottom and left face buttons are B, the right and top ones A, and Select and Start are themselves. The shoulder buttons and triggers fast-forward. Pads without a standard mapping work through their main axes or a hat switch.
- **On-screen controller**: a D-pad you can slide around on, B and A, and Select and Start. It is shown on touch screens, and works with a mouse too.

## Console

The toolbar has pause, power cycle, full screen and the boot ROM panel (see below), and two settings:

- **Console**: the original Game Boy or the Game Boy Color. Auto runs games made for the Color (including those that also run on the original) on a Color, and the rest on an original Game Boy. On a Color, an original Game Boy game is coloured as the Color colours games it doesn't recognise.
- **Screen**: how the original Game Boy's four shades look: the green of its screen, the greys of the Game Boy Pocket, or the colours a Game Boy Color would give the game.

Changing the console switches it off and on. Save states keep the whole console, cartridge included, in the browser. They can be exported and imported as `.gbstate` files.

Games that save to their cartridge save in the browser by themselves, along with the clock of MBC3 cartridges, which keeps time while the page is closed. **Download .sav** gives the save as a file (with the clock after the RAM, in the format most emulators use), and dropping a `.sav` file onto the page while its game is in uses it.

## Boot ROMs

The boot ROMs are Nintendo's and still under copyright, so none is included, and none is needed. If you have your own, the toolbar's **Boot ROM...** button pauses the console and shows the boot ROM panel in place of the screen: **Choose boot ROM file...** (or dropping one onto the page) keeps it in the browser, and the panel shows which you have: the Game Boy's is 256 bytes and the Game Boy Color's 2304. With **Start through the boot ROM** ticked, the console starts in it as the real one does, showing the Nintendo logo before the game; the Color's also chooses the colours for original Game Boy games. **Forget** removes them, and **Back to the console** (or Esc) carries on playing.

## Cartridges

No commercial games are included in this repository. Use images of cartridges you own. `npm run fetch:games` downloads the freely licensed homebrews listed in `scripts/games-catalog.json` (each with its credit, licence, source and checksum) into `public/games/`, where they appear in a "Free games" picker. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.gb" }] }`.

## Development

```sh
npm install
npm run fetch:games       # optional: free games into public/games/
npm run dev               # http://localhost:5173
npm test                  # tests needing downloaded files skip when they're missing
npm run fetch:test-roms   # optional: c-sp's collection of test ROMs (blargg, Mooneye, the acid2 tests)
```

`npm test` also runs the free games and any `.gb` or `.gbc` files you put in `roms/`; `SHOTS=/tmp/shots npm test` saves screenshots of each.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the test ROMs, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
