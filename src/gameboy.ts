import type { Cartridge } from './cart/cartridge';
import { Sm83, type Sm83Bus } from './cpu/sm83';
import { Interrupts } from './interrupts';
import { Joypad } from './io/controllers';
import { compatibilityPalettes } from './ppu/palettes';
import { Ppu } from './ppu/ppu';
import { Serial } from './serial';
import { Apu } from './sound/apu';
import { AudioMixer } from './sound/mixer';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Timer } from './timer';

export type Model = 'dmg' | 'cgb';

/** The console's clock: 4 MHz (2^22 Hz), which is also the dot clock; the CPU does an M-cycle every four. */
export const CLOCK_HZ = 4_194_304;
/** OAM DMA copies 160 bytes, one an M-cycle, a cycle after it is started. */
const OAM_DMA_LENGTH = 0xa0;
/** The Color's HDMA copies 16 bytes a block, stopping the CPU for 8 M-cycles (16 at double speed). */
const HDMA_BLOCK = 0x10;
const HDMA_BLOCK_CYCLES = 8;
/** Switching speed stops the CPU for about 2050 M-cycles. */
const SPEED_SWITCH_CYCLES = 2050;
/** Boot ROM sizes: the original Game Boy's covers $0000-$00FF, the Color's also $0200-$08FF. */
export const BOOT_ROM_SIZES: Record<Model, number> = { dmg: 0x100, cgb: 0x900 };
/** Where the boot ROMs leave the system counter at $0100 (DIV $AB on the original Game Boy). */
const BOOT_COUNTER: Record<Model, number> = { dmg: 0xabcc, cgb: 0x1ea0 };

/**
 * The whole console: the SM83 CPU, the PPU, the sound chip, the timer, the
 * joypad and serial port, 8K of work RAM (32K in eight banks on the Color),
 * 127 bytes of high RAM, and a cartridge. Every M-cycle the CPU spends runs
 * the rest of the hardware for the same time, so the machine is exact to the
 * M-cycle.
 *
 * The Game Boy Color (model 'cgb') adds a second VRAM bank, colour palettes,
 * HDMA and double speed. Running a game made for the original Game Boy, it
 * switches those off and colours the game through its first palettes.
 */
export class GameBoy implements Sm83Bus {
  readonly interrupts = new Interrupts();
  readonly timer = new Timer(this.interrupts);
  readonly serial = new Serial(this.interrupts);
  readonly joypad = new Joypad(this.interrupts);
  readonly ppu = new Ppu(this.interrupts);
  readonly mixer = new AudioMixer();
  readonly apu = new Apu(this.mixer);
  readonly cpu = new Sm83(this);
  readonly wram = new Uint8Array(0x8000);
  readonly hram = new Uint8Array(0x7f);
  cartridge: Cartridge | null = null;
  /** The player's boot ROMs, if they have given them. */
  bootRoms: Partial<Record<Model, Uint8Array>> = {};
  model: Model = 'dmg';
  /** The Color is running in its own mode (rather than its mode for original Game Boy games). */
  cgbMode = false;
  bootRomMapped = false;
  /** 4 MHz clocks run since power on. */
  clock = 0;
  /** M-cycles the CPU is held for (by HDMA or a speed switch). */
  stall = 0;

  wramBank = 1;
  /** KEY0: set by the Color's boot ROM to $04 for original Game Boy games. */
  key0 = 0;
  /** KEY1 bit 0: a speed switch is armed for the next STOP. */
  speedSwitchArmed = false;
  doubleSpeed = false;
  /** RP, the infrared port (nothing ever shines in). */
  infrared = 0;
  /** $FF72-$FF75, the Color's undocumented registers. */
  readonly undocumented = new Uint8Array(4);

  dmaRegister = 0xff;
  dmaActive = false;
  dmaSource = 0;
  dmaIndex = 0;
  /** M-cycles until a requested OAM DMA starts (0 for none). */
  dmaStartIn = 0;
  dmaNextSource = 0;

  hdmaSource = 0;
  hdmaDestination = 0;
  /** Blocks left in the HBlank DMA under way (0 for none). */
  hdmaBlocks = 0;
  hdmaActive = false;
  /** FF55 as read when no HBlank DMA is running: $FF once one has finished, or its blocks left if stopped. */
  hdmaStatus = 0xff;

  /** Called with each finished picture. */
  onFrame: (framebuffer: Uint32Array) => void = () => {};

  constructor() {
    this.timer.onDivTick = () => this.apu.frameSequencerTick();
    this.ppu.onFrame = (framebuffer) => this.onFrame(framebuffer);
    this.ppu.onHBlank = () => this.hblankDma();
    this.powerOn();
  }

  get cgb(): boolean {
    return this.model === 'cgb';
  }

  /** A console without a cartridge just shows a blank screen. */
  get canRun(): boolean {
    return this.cartridge !== null;
  }

  get hasBootRom(): boolean {
    return this.bootRoms[this.model] !== undefined;
  }

  setModel(model: Model): void {
    this.model = model;
  }

  /** Changing cartridges means switching off first. */
  insertCartridge(cartridge: Cartridge | null): void {
    this.cartridge = cartridge;
    this.powerOn();
  }

  /** Power on: everything back to its initial state. With a boot ROM it starts there; without, the game starts as the boot ROM would leave it. */
  powerOn(): void {
    const cgb = this.cgb;
    this.wram.fill(0);
    this.hram.fill(0);
    this.undocumented.fill(0);
    this.interrupts.reset();
    this.timer.reset();
    this.serial.reset();
    this.serial.cgb = cgb;
    this.joypad.reset();
    this.apu.reset(cgb);
    this.cpu.reset();
    this.cartridge?.reset();
    this.wramBank = 1;
    this.key0 = 0;
    this.speedSwitchArmed = this.doubleSpeed = false;
    this.infrared = 0;
    this.clock = this.stall = 0;
    this.dmaRegister = 0xff;
    this.dmaActive = false;
    this.dmaStartIn = this.dmaIndex = 0;
    this.hdmaActive = false;
    this.hdmaBlocks = 0;
    this.hdmaStatus = 0xff;
    this.hdmaSource = this.hdmaDestination = 0;
    this.bootRomMapped = this.hasBootRom;
    this.cgbMode = cgb && (this.bootRomMapped || ((this.cartridge?.info.cgbFlag ?? 0) & 0x80) !== 0);
    this.ppu.reset(cgb, this.cgbMode);
    if (!this.bootRomMapped) this.skipBootRom();
  }

  /** The state the boot ROMs leave the console in at $0100. */
  private skipBootRom(): void {
    const { cpu, ppu, apu } = this;
    if (!this.cgb) {
      const checksumNonZero = (this.cartridge?.rom[0x14d] ?? 0) !== 0;
      Object.assign(cpu, { a: 0x01, f: checksumNonZero ? 0xb0 : 0x80, b: 0x00, c: 0x13, d: 0x00, e: 0xd8, h: 0x01, l: 0x4d });
    } else if (this.cgbMode) {
      Object.assign(cpu, { a: 0x11, f: 0x80, b: 0x00, c: 0x00, d: 0xff, e: 0x56, h: 0x00, l: 0x0d });
    } else {
      Object.assign(cpu, { a: 0x11, f: 0x80, b: 0x00, c: 0x00, d: 0x00, e: 0x08, h: 0x00, l: 0x7c });
      this.key0 = 0x04;
      const palettes = compatibilityPalettes();
      ppu.bgPaletteRam.set(palettes.bg);
      ppu.objPaletteRam.set(palettes.obj);
    }
    cpu.sp = 0xfffe;
    cpu.pc = 0x0100;
    this.timer.counter = BOOT_COUNTER[this.model];
    this.interrupts.flags = 0x01;
    const sound = [0x80, 0xbf, 0xf3, 0xff, 0x3f, 0xff, 0x3f, 0x00, 0xff, 0x3f, 0x7f, 0xff, 0x9f, 0xff, 0x3f, 0xff, 0xff, 0x00, 0x00, 0x3f, 0x77, 0xf3];
    apu.write(0xff26, 0x80);
    sound.forEach((value, i) => apu.write(0xff10 + i, value));
    // The boot chime has faded out, but channel 1 is still on.
    apu.square1.enabled = true;
    apu.square1.envelope.volume = 0;
    ppu.bgp = 0xfc;
    ppu.obp0 = ppu.obp1 = 0xff;
    ppu.writeLcdc(0x91);
    ppu.blankFrame = false;
  }

  // --- Running --------------------------------------------------------------------

  /** One M-cycle of everything but the CPU. */
  private tickHardware(timerToo = true): void {
    const dots = this.doubleSpeed ? 2 : 4;
    this.clock += dots;
    if (timerToo) this.timer.tick();
    if (this.dmaActive || this.dmaStartIn > 0) this.stepOamDma();
    this.ppu.tick(dots);
    this.apu.tick(dots);
    this.serial.tick(4);
  }

  /** One CPU step, or one M-cycle of the CPU held by DMA. */
  step(): void {
    if (this.stall > 0) {
      this.stall--;
      this.tickHardware();
    } else {
      this.cpu.step();
    }
  }

  /** Runs for `clocks` 4 MHz clocks (or a little over, to finish the instruction). */
  run(clocks: number): void {
    const start = this.clock;
    const target = start + clocks;
    this.joypad.update();
    while (this.clock < target) this.step();
    this.cartridge?.advanceClock(this.clock - start);
    this.joypad.input.releaseLatched(this.ppu.frames);
  }

  /** Runs until the next picture is complete. */
  runFrame(): void {
    const start = this.clock;
    const frame = this.ppu.frames;
    this.joypad.update();
    while (this.ppu.frames === frame) this.step();
    this.cartridge?.advanceClock(this.clock - start);
    this.joypad.input.releaseLatched(this.ppu.frames);
  }

  // --- The CPU's bus --------------------------------------------------------------

  read(address: number): number {
    this.tickHardware(false);
    const value = this.peek(address);
    this.timer.tick();
    return value;
  }

  write(address: number, value: number): void {
    this.tickHardware(false);
    this.poke(address, value);
    this.timer.tick();
  }

  idle(): void {
    this.tickHardware();
  }

  pendingInterrupts(): number {
    return this.interrupts.pending;
  }

  acknowledgeInterrupt(bit: number): void {
    this.interrupts.flags &= ~(1 << bit);
  }

  stop(): boolean {
    this.timer.counter = 0;
    if (!this.cgbMode || !this.speedSwitchArmed) return false;
    this.speedSwitchArmed = false;
    this.doubleSpeed = !this.doubleSpeed;
    this.timer.doubleSpeed = this.doubleSpeed;
    this.stall += SPEED_SWITCH_CYCLES;
    return true;
  }

  // --- Memory map -----------------------------------------------------------------

  private bootRomByte(address: number): number | undefined {
    const bootRom = this.bootRoms[this.model];
    if (!this.bootRomMapped || !bootRom) return undefined;
    if (address < 0x100 || (this.cgb && address >= 0x200 && address < bootRom.length)) return bootRom[address];
    return undefined;
  }

  private readWram(address: number): number {
    return address & 0x1000 ? this.wram[(this.wramBank << 12) | (address & 0x0fff)] : this.wram[address & 0x0fff];
  }

  /** Reads memory as the CPU sees it. */
  peek(address: number): number {
    if (address < 0x8000) return this.bootRomByte(address) ?? this.cartridge?.readRom(address) ?? 0xff;
    if (address < 0xa000) return this.ppu.readVram(address);
    if (address < 0xc000) return this.cartridge?.readRam(address) ?? 0xff;
    if (address < 0xfe00) return this.readWram(address);
    if (address < 0xfea0) return this.dmaActive ? 0xff : this.ppu.readOam(address);
    if (address < 0xff00) return 0x00;
    if (address < 0xff80) return this.readIo(address);
    if (address < 0xffff) return this.hram[address - 0xff80];
    return this.interrupts.enable;
  }

  poke(address: number, value: number): void {
    if (address < 0x8000) this.cartridge?.writeRom(address, value);
    else if (address < 0xa000) this.ppu.writeVram(address, value);
    else if (address < 0xc000) this.cartridge?.writeRam(address, value);
    else if (address < 0xfe00) {
      if (address & 0x1000) this.wram[(this.wramBank << 12) | (address & 0x0fff)] = value;
      else this.wram[address & 0x0fff] = value;
    } else if (address < 0xfea0) {
      if (!this.dmaActive) this.ppu.writeOam(address, value);
    } else if (address < 0xff00) {
      // Unusable.
    } else if (address < 0xff80) this.writeIo(address, value);
    else if (address < 0xffff) this.hram[address - 0xff80] = value;
    else this.interrupts.enable = value;
  }

  /** Reads for the DMA engines, which see memory without the PPU's locks. */
  private dmaRead(address: number): number {
    if (address < 0x8000) return this.cartridge?.readRom(address) ?? 0xff;
    if (address < 0xa000) return this.ppu.vram[(this.ppu.vramBank << 13) | (address & 0x1fff)];
    if (address < 0xc000) return this.cartridge?.readRam(address) ?? 0xff;
    return this.readWram(address);
  }

  private readIo(address: number): number {
    const { ppu, timer, cgb, cgbMode } = this;
    switch (address) {
      case 0xff00:
        return this.joypad.read();
      case 0xff01:
        return this.serial.data;
      case 0xff02:
        return this.serial.read();
      case 0xff04:
        return timer.div;
      case 0xff05:
        return timer.tima;
      case 0xff06:
        return timer.tma;
      case 0xff07:
        return timer.tac | 0xf8;
      case 0xff0f:
        return this.interrupts.flags | 0xe0;
      case 0xff40:
        return ppu.lcdc;
      case 0xff41:
        return ppu.readStat();
      case 0xff42:
        return ppu.scy;
      case 0xff43:
        return ppu.scx;
      case 0xff44:
        return ppu.ly;
      case 0xff45:
        return ppu.lyc;
      case 0xff46:
        return this.dmaRegister;
      case 0xff47:
        return ppu.bgp;
      case 0xff48:
        return ppu.obp0;
      case 0xff49:
        return ppu.obp1;
      case 0xff4a:
        return ppu.wy;
      case 0xff4b:
        return ppu.wx;
    }
    if (address >= 0xff10 && address < 0xff40) return this.apu.read(address);
    if (!cgb) return 0xff;
    switch (address) {
      case 0xff4d:
        return cgbMode ? 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.speedSwitchArmed ? 1 : 0) : 0xff;
      case 0xff4f:
        return cgbMode ? 0xfe | ppu.vramBank : 0xff;
      case 0xff55:
        return this.hdmaActive ? (this.hdmaBlocks - 1) & 0x7f : this.hdmaStatus;
      case 0xff56:
        return cgbMode ? (this.infrared & 0xc1) | 0x3e : 0xff;
      case 0xff68:
        return cgbMode ? ppu.bcps | 0x40 : 0xff;
      case 0xff69:
        return cgbMode ? ppu.readPaletteData(false) : 0xff;
      case 0xff6a:
        return cgbMode ? ppu.ocps | 0x40 : 0xff;
      case 0xff6b:
        return cgbMode ? ppu.readPaletteData(true) : 0xff;
      case 0xff6c:
        return cgbMode ? ppu.opri | 0xfe : 0xff;
      case 0xff70:
        return cgbMode ? this.wramBank | 0xf8 : 0xff;
      case 0xff72:
      case 0xff73:
        return this.undocumented[address - 0xff72];
      case 0xff74:
        return cgbMode ? this.undocumented[2] : 0xff;
      case 0xff75:
        return this.undocumented[3] | 0x8f;
      case 0xff76:
        return this.apu.readPcm(false);
      case 0xff77:
        return this.apu.readPcm(true);
    }
    return 0xff;
  }

  private writeIo(address: number, value: number): void {
    const { ppu, timer, cgb, cgbMode } = this;
    switch (address) {
      case 0xff00:
        this.joypad.write(value);
        return;
      case 0xff01:
        this.serial.data = value;
        return;
      case 0xff02:
        this.serial.write(value);
        return;
      case 0xff04:
        timer.writeDiv();
        return;
      case 0xff05:
        timer.writeTima(value);
        return;
      case 0xff06:
        timer.writeTma(value);
        return;
      case 0xff07:
        timer.writeTac(value);
        return;
      case 0xff0f:
        this.interrupts.flags = value & 0x1f;
        return;
      case 0xff40:
        ppu.writeLcdc(value);
        return;
      case 0xff41:
        ppu.writeStat(value);
        return;
      case 0xff42:
        ppu.writeDisplay('scy', value);
        return;
      case 0xff43:
        ppu.writeDisplay('scx', value);
        return;
      case 0xff45:
        ppu.writeLyc(value);
        return;
      case 0xff46:
        this.startOamDma(value);
        return;
      case 0xff47:
        ppu.writeDisplay('bgp', value);
        return;
      case 0xff48:
        ppu.writeDisplay('obp0', value);
        return;
      case 0xff49:
        ppu.writeDisplay('obp1', value);
        return;
      case 0xff4a:
        ppu.writeDisplay('wy', value);
        return;
      case 0xff4b:
        ppu.writeDisplay('wx', value);
        return;
      case 0xff50:
        if (this.bootRomMapped && value & 1) this.leaveBootRom();
        return;
    }
    if (address >= 0xff10 && address < 0xff40) {
      this.apu.write(address, value);
      return;
    }
    if (!cgb) return;
    switch (address) {
      case 0xff4c:
        if (this.bootRomMapped) this.key0 = value;
        return;
      case 0xff4d:
        if (cgbMode) this.speedSwitchArmed = (value & 1) !== 0;
        return;
      case 0xff4f:
        if (cgbMode) ppu.vramBank = value & 1;
        return;
      case 0xff51:
        this.hdmaSource = (this.hdmaSource & 0x00ff) | (value << 8);
        return;
      case 0xff52:
        this.hdmaSource = (this.hdmaSource & 0xff00) | (value & 0xf0);
        return;
      case 0xff53:
        this.hdmaDestination = (this.hdmaDestination & 0x00ff) | ((value & 0x1f) << 8);
        return;
      case 0xff54:
        this.hdmaDestination = (this.hdmaDestination & 0xff00) | (value & 0xf0);
        return;
      case 0xff55:
        if (cgbMode) this.startHdma(value);
        return;
      case 0xff56:
        if (cgbMode) this.infrared = value;
        return;
      case 0xff68:
        if (cgbMode) ppu.bcps = value & 0xbf;
        return;
      case 0xff69:
        if (cgbMode) ppu.writePaletteData(false, value);
        return;
      case 0xff6a:
        if (cgbMode) ppu.ocps = value & 0xbf;
        return;
      case 0xff6b:
        if (cgbMode) ppu.writePaletteData(true, value);
        return;
      case 0xff6c:
        if (cgbMode) ppu.opri = value & 1;
        return;
      case 0xff70:
        if (cgbMode) this.wramBank = value & 7 || 1;
        return;
      case 0xff72:
      case 0xff73:
        this.undocumented[address - 0xff72] = value;
        return;
      case 0xff74:
        if (cgbMode) this.undocumented[2] = value;
        return;
      case 0xff75:
        this.undocumented[3] = value & 0x70;
        return;
    }
  }

  /** The boot ROM unmaps itself; the Color's has set KEY0 by then, for its mode for original Game Boy games. */
  private leaveBootRom(): void {
    this.bootRomMapped = false;
    if (!this.cgb) return;
    this.cgbMode = (this.key0 & 0x0c) !== 0x04;
    this.ppu.cgbMode = this.cgbMode;
    if (!this.cgbMode) {
      this.ppu.vramBank = 0;
      this.wramBank = 1;
    }
  }

  // --- DMA ------------------------------------------------------------------------

  private startOamDma(value: number): void {
    this.dmaRegister = value;
    // Sources from $E000 up read the work RAM's echo.
    this.dmaNextSource = (value >= 0xe0 ? value - 0x20 : value) << 8;
    this.dmaStartIn = 2;
  }

  private stepOamDma(): void {
    if (this.dmaStartIn > 0 && --this.dmaStartIn === 0) {
      this.dmaActive = true;
      this.dmaIndex = 0;
      this.dmaSource = this.dmaNextSource;
    }
    if (!this.dmaActive) return;
    // OAM stays locked through the cycle that copies the last byte.
    if (this.dmaIndex === OAM_DMA_LENGTH) {
      this.dmaActive = false;
      return;
    }
    this.ppu.oam[this.dmaIndex] = this.dmaRead(this.dmaSource + this.dmaIndex);
    this.dmaIndex++;
  }

  /** FF55: bit 7 set starts an HBlank DMA (a block each HBlank); clear, copies everything now, or stops an HBlank DMA. */
  private startHdma(value: number): void {
    const blocks = (value & 0x7f) + 1;
    if (this.hdmaActive && !(value & 0x80)) {
      this.hdmaActive = false;
      this.hdmaStatus = 0x80 | ((this.hdmaBlocks - 1) & 0x7f);
      return;
    }
    if (value & 0x80) {
      this.hdmaActive = true;
      this.hdmaBlocks = blocks;
      return;
    }
    for (let block = 0; block < blocks; block++) this.copyHdmaBlock();
    this.hdmaStatus = 0xff;
  }

  private copyHdmaBlock(): void {
    const { ppu } = this;
    const bank = ppu.vramBank << 13;
    for (let i = 0; i < HDMA_BLOCK; i++) {
      ppu.vram[bank | ((this.hdmaDestination + i) & 0x1fff)] = this.dmaRead((this.hdmaSource + i) & 0xffff);
    }
    this.hdmaSource = (this.hdmaSource + HDMA_BLOCK) & 0xffff;
    this.hdmaDestination = (this.hdmaDestination + HDMA_BLOCK) & 0x1fff;
    this.stall += HDMA_BLOCK_CYCLES * (this.doubleSpeed ? 2 : 1);
  }

  private hblankDma(): void {
    if (!this.hdmaActive) return;
    this.copyHdmaBlock();
    if (--this.hdmaBlocks === 0) {
      this.hdmaActive = false;
      this.hdmaStatus = 0xff;
    }
  }

  // --- Save states ----------------------------------------------------------------

  /** Everything in the console except the cartridge ROM and boot ROMs (bank registers and cartridge RAM included). */
  saveState(): StateNode {
    return captureState(this);
  }

  /** Restores a saved state; the same cartridge must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
    this.timer.doubleSpeed = this.doubleSpeed;
  }
}
