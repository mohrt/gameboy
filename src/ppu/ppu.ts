import { Interrupt, type Interrupts } from '../interrupts';
import { CGB_RGBA, shadeTable } from './palettes';

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const DOTS_PER_LINE = 456;
export const LINES_PER_FRAME = 154;
export const DOTS_PER_FRAME = DOTS_PER_LINE * LINES_PER_FRAME;
const OAM_SCAN_DOTS = 80;
/** The shortest drawing mode; the first 12 dots fetch the first tiles before any pixel comes out. */
const MODE3_DOTS = 172;
const MODE3_WARMUP_DOTS = 12;
const MAX_OBJECTS_PER_LINE = 10;

export const enum Mode {
  HBlank = 0,
  VBlank = 1,
  OamScan = 2,
  Drawing = 3,
}

/**
 * The picture processing unit: a 160 x 144 picture of 8 x 8 tiles, a
 * background and a window from two 32 x 32 tile maps, and 40 objects (10 to
 * a line). A line is 456 dots: the object search (mode 2), drawing (mode 3,
 * longer with fine scroll and objects), then HBlank (mode 0); lines 144-153
 * are VBlank (mode 1). Pixels are drawn as the drawing mode reaches them, so
 * register writes part way along a line take effect part way along it.
 *
 * On a Game Boy Color it has a second VRAM bank, tile attributes (palette,
 * bank, flips, priority) and eight background and eight object palettes of
 * 15-bit colours; running an original Game Boy game, it maps BGP, OBP0 and
 * OBP1 through the first of those palettes instead.
 */
export class Ppu {
  readonly vram = new Uint8Array(0x4000);
  readonly oam = new Uint8Array(0xa0);
  readonly bgPaletteRam = new Uint8Array(64);
  readonly objPaletteRam = new Uint8Array(64);
  /** The finished picture as canvas pixels. */
  readonly framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** The original Game Boy's shades as canvas pixels: background, OBP0, OBP1. */
  screenColors = shadeTable('pocket');

  lcdc = 0;
  /** STAT's interrupt enables (bits 3-6). */
  statEnable = 0;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;
  bgp = 0;
  obp0 = 0;
  obp1 = 0;
  wy = 0;
  wx = 0;
  vramBank = 0;
  bcps = 0;
  ocps = 0;
  /** OPRI: 1 for the original Game Boy's object priority (by X), 0 for the Color's (by OAM order). */
  opri = 0;
  /** The console is a Game Boy Color. */
  cgb = false;
  /** Running in the Color's own mode (not its mode for original Game Boy games). */
  cgbMode = false;

  mode: Mode = Mode.OamScan;
  /**
   * The mode as the CPU sees it, which follows the PPU's own a cycle late:
   * the STAT interrupts are raised an M-cycle before STAT's mode bits and the
   * VRAM and OAM locks show the change (LY changes on time).
   */
  visibleMode: Mode = Mode.OamScan;
  /** The line being worked on (LY reads 0 for most of line 153). */
  line = 0;
  /** Dots into the line. */
  dot = 0;
  /** How long this line's drawing mode lasts. */
  mode3Dots = MODE3_DOTS;
  /** Pixels of this line drawn so far. */
  drawnX = 0;
  /** The STAT interrupt line: an interrupt is raised when it goes high. */
  statLine = false;
  /** LY has matched WY this frame, so the window can show. */
  windowTriggered = false;
  /** The window's own line counter: it only counts lines it was drawn on. */
  windowLine = 0;
  windowOnLine = false;
  /** Dots run with the LCD off, so pictures (blank ones) keep coming. */
  offDots = 0;
  /** The first picture after switching the LCD on isn't shown. */
  blankFrame = false;
  frames = 0;

  /** This line's object pixels: colour 1-3, or 0 for none. */
  private readonly objColor = new Uint8Array(SCREEN_WIDTH);
  /** Their palette (bits 0-2) and behind-background flag (bit 7). */
  private readonly objFlags = new Uint8Array(SCREEN_WIDTH);
  private readonly lineObjects: number[] = [];

  /** Called at the start of VBlank with the finished picture. */
  onFrame: (framebuffer: Uint32Array) => void = () => {};
  /** Called at the start of each visible line's HBlank (the Color's HBlank DMA). */
  onHBlank: () => void = () => {};

  constructor(private readonly interrupts: Interrupts) {}

  get lcdOn(): boolean {
    return (this.lcdc & 0x80) !== 0;
  }

  reset(cgb: boolean, cgbMode: boolean): void {
    this.cgb = cgb;
    this.cgbMode = cgbMode;
    this.vram.fill(0);
    this.oam.fill(0);
    this.bgPaletteRam.fill(0xff);
    this.objPaletteRam.fill(0xff);
    this.lcdc = this.statEnable = this.scy = this.scx = this.ly = this.lyc = 0;
    this.bgp = this.obp0 = this.obp1 = this.wy = this.wx = 0;
    this.vramBank = this.bcps = this.ocps = 0;
    this.opri = cgbMode ? 0 : 1;
    this.mode = this.visibleMode = Mode.HBlank;
    this.line = this.dot = this.drawnX = this.windowLine = this.offDots = 0;
    this.statLine = this.windowTriggered = this.windowOnLine = this.blankFrame = false;
    this.framebuffer.fill(this.white);
  }

  private get white(): number {
    return this.cgb ? 0xffffffff : this.screenColors[0];
  }

  // --- Timing ---------------------------------------------------------------------

  /** Advances by `dots` dots (four per M-cycle, two at double speed). */
  tick(dots: number): void {
    if (!this.lcdOn) {
      this.offDots += dots;
      if (this.offDots >= DOTS_PER_FRAME) {
        this.offDots -= DOTS_PER_FRAME;
        this.framebuffer.fill(this.white);
        this.finishFrame();
      }
      return;
    }
    this.visibleMode = this.mode;
    this.dot += dots;
    for (;;) {
      if (this.mode === Mode.OamScan && this.dot >= OAM_SCAN_DOTS) {
        this.startDrawing();
      } else if (this.mode === Mode.Drawing && this.dot >= OAM_SCAN_DOTS + this.mode3Dots) {
        this.drawTo(SCREEN_WIDTH);
        if (this.windowOnLine) this.windowLine++;
        this.mode = Mode.HBlank;
        this.updateStat();
        this.onHBlank();
      } else if (this.line === 153 && this.ly !== 0 && this.dot >= 4) {
        this.ly = 0;
        this.updateStat();
      } else if (this.dot >= DOTS_PER_LINE) {
        this.dot -= DOTS_PER_LINE;
        this.nextLine();
      } else {
        return;
      }
    }
  }

  private nextLine(): void {
    this.line++;
    if (this.line === LINES_PER_FRAME) {
      this.line = 0;
      this.windowTriggered = false;
      this.windowLine = 0;
    }
    this.ly = this.line;
    if (this.line < SCREEN_HEIGHT) {
      this.startLine();
    } else if (this.line === SCREEN_HEIGHT) {
      this.mode = Mode.VBlank;
      this.interrupts.request(Interrupt.VBlank);
      // The mode 2 interrupt also fires as VBlank starts.
      if (this.statEnable & 0x20) {
        if (!this.statLine) this.interrupts.request(Interrupt.Stat);
        this.statLine = true;
      }
      if (this.blankFrame) {
        this.blankFrame = false;
        this.framebuffer.fill(this.white);
      }
      this.finishFrame();
    }
    this.updateStat();
  }

  private startLine(): void {
    this.mode = Mode.OamScan;
    if (this.ly === this.wy) this.windowTriggered = true;
  }

  private finishFrame(): void {
    this.frames++;
    this.onFrame(this.framebuffer);
  }

  private startDrawing(): void {
    this.mode = Mode.Drawing;
    this.drawnX = 0;
    this.windowOnLine = false;
    this.mode3Dots = MODE3_DOTS + (this.scx & 7) + this.prepareObjects();
    this.updateStat();
  }

  /** The STAT line is the OR of its enabled conditions; the interrupt fires as it rises. */
  updateStat(): void {
    const enable = this.statEnable;
    const line =
      this.lcdOn &&
      ((enable & 0x40 && this.ly === this.lyc) ||
        (enable & 0x08 && this.mode === Mode.HBlank) ||
        (enable & 0x10 && this.mode === Mode.VBlank) ||
        (enable & 0x20 && this.mode === Mode.OamScan));
    if (line && !this.statLine) this.interrupts.request(Interrupt.Stat);
    this.statLine = !!line;
  }

  // --- Registers ------------------------------------------------------------------

  readStat(): number {
    if (!this.lcdOn) return 0x80 | this.statEnable;
    return 0x80 | this.statEnable | (this.ly === this.lyc ? 0x04 : 0) | this.visibleMode;
  }

  writeStat(value: number): void {
    if (!this.cgb && this.lcdOn && this.mode !== Mode.Drawing) {
      // The original Game Boy briefly sees every source enabled while STAT is written.
      const saved = value & 0x78;
      this.statEnable = 0x78;
      this.updateStat();
      this.statEnable = saved;
    }
    this.statEnable = value & 0x78;
    this.updateStat();
  }

  writeLcdc(value: number): void {
    this.catchUp();
    const wasOn = this.lcdOn;
    this.lcdc = value;
    if (wasOn && !this.lcdOn) {
      this.line = this.ly = this.dot = this.offDots = 0;
      this.mode = this.visibleMode = Mode.HBlank;
      this.statLine = false;
      this.framebuffer.fill(this.white);
    } else if (!wasOn && this.lcdOn) {
      this.line = this.ly = this.dot = 0;
      this.windowTriggered = false;
      this.windowLine = 0;
      this.blankFrame = true;
      this.startLine();
      this.visibleMode = this.mode;
      this.updateStat();
    }
  }

  writeLyc(value: number): void {
    this.lyc = value;
    this.updateStat();
  }

  /** Writes a register that changes how pixels are drawn, after drawing the pixels before it. */
  writeDisplay(register: 'scy' | 'scx' | 'bgp' | 'obp0' | 'obp1' | 'wy' | 'wx', value: number): void {
    this.catchUp();
    this[register] = value;
  }

  private get vramLocked(): boolean {
    return this.lcdOn && this.visibleMode === Mode.Drawing;
  }

  private get oamLocked(): boolean {
    return this.lcdOn && (this.visibleMode === Mode.OamScan || this.visibleMode === Mode.Drawing);
  }

  readVram(address: number): number {
    return this.vramLocked ? 0xff : this.vram[(this.vramBank << 13) | (address & 0x1fff)];
  }

  writeVram(address: number, value: number): void {
    if (!this.vramLocked) this.vram[(this.vramBank << 13) | (address & 0x1fff)] = value;
  }

  readOam(address: number): number {
    return this.oamLocked ? 0xff : this.oam[address & 0xff];
  }

  writeOam(address: number, value: number): void {
    if (!this.oamLocked) this.oam[address & 0xff] = value;
  }

  readPaletteData(objects: boolean): number {
    if (this.vramLocked) return 0xff;
    return objects ? this.objPaletteRam[this.ocps & 0x3f] : this.bgPaletteRam[this.bcps & 0x3f];
  }

  /** BCPD / OCPD: writes to palette memory at BCPS / OCPS, which step on when their bit 7 is set. */
  writePaletteData(objects: boolean, value: number): void {
    const spec = objects ? this.ocps : this.bcps;
    if (!this.vramLocked) {
      this.catchUp();
      (objects ? this.objPaletteRam : this.bgPaletteRam)[spec & 0x3f] = value;
    }
    if (spec & 0x80) {
      const next = (spec & 0x80) | ((spec + 1) & 0x3f);
      if (objects) this.ocps = next;
      else this.bcps = next;
    }
  }

  // --- Drawing --------------------------------------------------------------------

  /** Draws the line up to where the drawing mode has got to. */
  private catchUp(): void {
    if (!this.lcdOn || this.mode !== Mode.Drawing) return;
    const span = this.mode3Dots - MODE3_WARMUP_DOTS;
    const x = Math.floor(((this.dot - OAM_SCAN_DOTS - MODE3_WARMUP_DOTS) * SCREEN_WIDTH) / span);
    this.drawTo(Math.max(0, Math.min(SCREEN_WIDTH, x)));
  }

  /**
   * The object search: the first 10 objects in OAM on this line, drawn into
   * the line's object buffers in priority order (by X then OAM order on the
   * original Game Boy, by OAM order alone on the Color). Returns how many dots
   * fetching them adds to the drawing mode.
   */
  private prepareObjects(): number {
    const { oam, objColor, objFlags, lineObjects, vram } = this;
    objColor.fill(0);
    lineObjects.length = 0;
    const height = this.lcdc & 0x04 ? 16 : 8;
    const ly = this.ly;
    for (let i = 0; i < 40 && lineObjects.length < MAX_OBJECTS_PER_LINE; i++) {
      const y = oam[i * 4] - 16;
      if (ly >= y && ly < y + height) lineObjects.push(i);
    }
    if (this.opri & 1) lineObjects.sort((a, b) => oam[a * 4 + 1] - oam[b * 4 + 1] || a - b);
    let penalty = 0;
    for (const i of lineObjects) {
      const x = oam[i * 4 + 1] - 8;
      const attributes = oam[i * 4 + 3];
      penalty += 11 - Math.min(5, (x + this.scx) & 7);
      let row = ly - (oam[i * 4] - 16);
      if (attributes & 0x40) row = height - 1 - row;
      let tile = oam[i * 4 + 2];
      if (height === 16) tile &= 0xfe;
      const address = (this.cgbMode && attributes & 0x08 ? 0x2000 : 0) + tile * 16 + row * 2;
      const low = vram[address];
      const high = vram[address + 1];
      const flags = (this.cgbMode ? attributes & 0x07 : (attributes >> 4) & 1) | (attributes & 0x80);
      for (let px = 0; px < 8; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= SCREEN_WIDTH || objColor[sx] !== 0) continue;
        const bit = attributes & 0x20 ? px : 7 - px;
        const color = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
        if (color === 0) continue;
        objColor[sx] = color;
        objFlags[sx] = flags;
      }
    }
    return penalty;
  }

  /** Draws this line's pixels from `drawnX` up to (not including) `endX`. */
  private drawTo(endX: number): void {
    const { vram, lcdc, cgbMode, framebuffer, objColor, objFlags } = this;
    const ly = this.ly;
    const row = ly * SCREEN_WIDTH;
    // Without the Color's own mode, LCDC bit 0 blanks the background and window.
    const bgOn = cgbMode || (lcdc & 0x01) !== 0;
    const windowX = this.wx - 7;
    const windowOn = bgOn && this.windowTriggered && (lcdc & 0x20) !== 0 && this.wx <= 166;
    const objectsOn = (lcdc & 0x02) !== 0;
    const signedTiles = (lcdc & 0x10) === 0;
    let tileKey = -1;
    let low = 0;
    let high = 0;
    let tileAttributes = 0;
    for (let x = this.drawnX; x < endX; x++) {
      let color = 0;
      let attributes = 0;
      if (bgOn) {
        let mapX: number;
        let mapY: number;
        let map: number;
        if (windowOn && x >= windowX) {
          this.windowOnLine = true;
          mapX = x - windowX;
          mapY = this.windowLine;
          map = lcdc & 0x40 ? 0x1c00 : 0x1800;
        } else {
          mapX = (x + this.scx) & 0xff;
          mapY = (ly + this.scy) & 0xff;
          map = lcdc & 0x08 ? 0x1c00 : 0x1800;
        }
        const mapAddress = map + ((mapY >> 3) << 5) + (mapX >> 3);
        const key = (mapAddress << 3) | (mapY & 7);
        if (key !== tileKey) {
          tileKey = key;
          const tile = vram[mapAddress];
          tileAttributes = cgbMode ? vram[0x2000 + mapAddress] : 0;
          let tileRow = mapY & 7;
          if (tileAttributes & 0x40) tileRow = 7 - tileRow;
          const base = signedTiles ? 0x1000 + ((tile << 24) >> 24) * 16 : tile * 16;
          const address = (tileAttributes & 0x08 ? 0x2000 : 0) + base + tileRow * 2;
          low = vram[address];
          high = vram[address + 1];
        }
        attributes = tileAttributes;
        const bit = attributes & 0x20 ? mapX & 7 : 7 - (mapX & 7);
        color = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
      }

      let pixel: number;
      const obj = objectsOn ? objColor[x] : 0;
      const flags = objFlags[x];
      const objectShows =
        obj !== 0 &&
        (color === 0 || (cgbMode ? (lcdc & 0x01) === 0 || (!(attributes & 0x80) && !(flags & 0x80)) : !(flags & 0x80)));
      if (objectShows) {
        pixel = this.objectPixel(flags & 0x07, obj);
      } else {
        pixel = this.backgroundPixel(attributes & 0x07, color, bgOn);
      }
      framebuffer[row + x] = pixel;
    }
    this.drawnX = Math.max(this.drawnX, endX);
  }

  private paletteColor(ram: Uint8Array, index: number): number {
    return CGB_RGBA[(ram[index * 2] | (ram[index * 2 + 1] << 8)) & 0x7fff];
  }

  private backgroundPixel(palette: number, color: number, bgOn: boolean): number {
    if (this.cgbMode) return this.paletteColor(this.bgPaletteRam, palette * 4 + color);
    const shade = bgOn ? (this.bgp >> (color * 2)) & 3 : 0;
    return this.cgb ? this.paletteColor(this.bgPaletteRam, shade) : this.screenColors[shade];
  }

  private objectPixel(palette: number, color: number): number {
    if (this.cgbMode) return this.paletteColor(this.objPaletteRam, palette * 4 + color);
    const shade = ((palette ? this.obp1 : this.obp0) >> (color * 2)) & 3;
    return this.cgb ? this.paletteColor(this.objPaletteRam, palette * 4 + shade) : this.screenColors[4 + palette * 4 + shade];
  }
}
