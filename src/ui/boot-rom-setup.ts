import type { Model } from '../gameboy';

export interface BootRomSetupCallbacks {
  /** A boot ROM was chosen or dropped (or a zip with one in); resolves to a message about it. */
  onFile(file: File): Promise<string>;
  onForget(): Promise<void>;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Boot ROM setup is missing ${selector}`);
  return element;
}

/** The panel shown in place of the screen to add, check or forget the player's own boot ROMs. */
export class BootRomSetup {
  private readonly message: HTMLElement;
  private readonly forgetButton: HTMLButtonElement;
  private readonly useBootRom: HTMLInputElement;
  private listeners: AbortController | null = null;
  private resolveClosed: () => void = () => {};

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: BootRomSetupCallbacks,
  ) {
    this.message = requireChild(root, '.boot-rom-message');
    this.forgetButton = requireChild(root, '[data-action="forget-boot-roms"]');
    this.useBootRom = requireChild(root, 'input[name="use-boot-rom"]');

    const fileInput = requireChild<HTMLInputElement>(root, 'input[name="boot-rom-file"]');
    requireChild<HTMLButtonElement>(root, '[data-action="choose-boot-rom-file"]').addEventListener('click', () =>
      fileInput.click(),
    );
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) this.addFile(file);
    });
    this.forgetButton.addEventListener('click', () => {
      if (confirm('Forget the boot ROMs? Games will start straight away again.')) this.run(() => this.callbacks.onForget());
    });
    requireChild<HTMLButtonElement>(root, '[data-action="back"]').addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return this.listeners !== null;
  }

  /** Shows the panel until Back (or Esc); a file dropped anywhere on the page meanwhile is taken as a boot ROM. */
  open(): Promise<void> {
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.showMessage('');

    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        this.close();
      },
      { signal },
    );

    // Captured and stopped so the cartridge panel's page-wide drop handling doesn't also see the boot ROM.
    const dragOptions = { signal, capture: true };
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    let depth = 0;
    window.addEventListener(
      'dragenter',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth++;
        this.root.classList.add('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'dragover',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      },
      dragOptions,
    );
    window.addEventListener(
      'dragleave',
      (event) => {
        if (!hasFiles(event)) return;
        event.stopImmediatePropagation();
        depth = Math.max(0, depth - 1);
        if (depth === 0) this.root.classList.remove('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'drop',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth = 0;
        this.root.classList.remove('drag-over');
        const file = event.dataTransfer?.files[0];
        if (file) this.addFile(file);
      },
      dragOptions,
    );

    document.body.classList.add('boot-rom-setup-open');
    this.root.hidden = false;
    this.root.scrollIntoView({ block: 'start' });
    return new Promise((resolve) => (this.resolveClosed = resolve));
  }

  /** Shows which boot ROMs are kept, with the file each came from when it was given on this visit. */
  showBootRoms(bootRoms: Partial<Record<Model, Uint8Array>>, fileNames: Partial<Record<Model, string>>): void {
    for (const model of ['dmg', 'cgb'] as const) {
      const entry = requireChild<HTMLElement>(this.root, `[data-rom="${model}"]`);
      const name = fileNames[model];
      const loaded = name ? `Loaded: ${name}` : 'Loaded, kept in this browser';
      entry.dataset.state = bootRoms[model] ? 'loaded' : 'missing';
      requireChild(entry, '.boot-rom-status').textContent = bootRoms[model] ? loaded : 'Not loaded';
    }
    const none = !bootRoms.dmg && !bootRoms.cgb;
    this.forgetButton.hidden = none;
    this.useBootRom.disabled = none;
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  private addFile(file: File): void {
    this.run(async () => this.showMessage(await this.callbacks.onFile(file), true));
  }

  private close(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.root.hidden = true;
    this.root.classList.remove('drag-over');
    document.body.classList.remove('boot-rom-setup-open');
    this.resolveClosed();
  }

  private run(action: () => Promise<void>): void {
    this.showMessage('');
    action().catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)));
  }
}
