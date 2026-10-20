import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../ppu/ppu';

/** Copies finished pictures (already canvas pixels) to the canvas. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private hasNewFrame = false;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    this.image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  capture(frame: Uint32Array): void {
    this.pixels.set(frame);
    this.hasNewFrame = true;
  }

  /** A dark screen with a faint scanline pattern, shown while no cartridge is in. */
  showIdle(): void {
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / SCREEN_WIDTH) & 1 ? 0xff141414 : 0xff1c1c1c;
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
