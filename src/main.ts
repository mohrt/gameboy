import { trackGameLoaded } from './analytics';
import { AudioOutput } from './audio/audio-output';
import { Cartridge } from './cart/cartridge';
import { MBC_NAMES, colorSupport, readHeader, type CartridgeInfo } from './cart/header';
import { BATTERY_EXTENSION, STATE_EXTENSION, filesFrom, readMedia, titleFromFileName } from './cart/load';
import { Emulator } from './emulator';
import { BOOT_ROM_SIZES, type Model } from './gameboy';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { GamepadManager, gamepadFastForward, padName, readGamepad } from './io/gamepad-input';
import { KeyboardInput } from './io/keyboard-input';
import { shadeTable, type ScreenPalette } from './ppu/palettes';
import { Screen } from './render/screen';
import { BatterySaves, batteryKey } from './storage/battery-saves';
import { BOOT_ROM_NAMES, BootRomStore, bootRomModel, looksLikeBootRom } from './storage/boot-rom-store';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { BootRomSetup } from './ui/boot-rom-setup';
import { CartPanel } from './ui/cart-panel';
import { downloadFile } from './ui/download';
import { Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import { OnScreenPad } from './ui/touch-pad';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['model', 'palette', 'use-boot-rom', 'show-pad', 'sound', 'volume'];

/** Longest gap the loop catches up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_FRAME_MS = 100;
/** How often changed battery saves are written to browser storage. */
const BATTERY_SAVE_INTERVAL_MS = 2000;
/** How much faster fast-forward runs. */
const FAST_FORWARD_SPEED = 4;

const MODEL_NAMES: Record<Model, string> = { dmg: 'Game Boy', cgb: 'Game Boy Color' };
const PALETTES: ScreenPalette[] = ['green', 'pocket', 'color'];

interface CurrentCartridge {
  info: CartridgeInfo;
  rom: Uint8Array;
  fileName: string;
  title: string;
  cartridge: Cartridge;
  batteryKey: string;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gameboy';

const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024}M` : `${bytes / 1024}K`);

/** One line about the cartridge, e.g. "1M · MBC3 with 32K RAM, battery and clock · for the Game Boy Color only". */
function describe(cart: CurrentCartridge): string {
  const { info } = cart;
  const extras = [info.ramSize ? `${sizeLabel(info.ramSize)} RAM` : '', info.hasBattery ? 'battery' : '', info.hasRtc ? 'clock' : ''];
  if (info.hasRumble) extras.push('rumble');
  const kept = extras.filter(Boolean);
  const mbc = MBC_NAMES[info.mbc] + (kept.length ? ` with ${kept.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : '');
  const color = { none: 'Game Boy', enhanced: 'Game Boy Color enhanced', only: 'for the Game Boy Color only' }[colorSupport(info)];
  const parts = [sizeLabel(cart.rom.length), mbc, color];
  if (info.title) parts.push(`"${info.title}"`);
  return parts.join(' · ');
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');

  try {
    const settings = new Settings();
    // The on-screen controller starts out shown on touch screens, until the player chooses.
    const showPad = requireElement<HTMLInputElement>('input[name="show-pad"]');
    showPad.checked = matchMedia('(pointer: coarse)').matches;
    settings.bind(document, REMEMBERED_SETTINGS);

    const screen = new Screen(canvas);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) emulator.setAudioRate(audio.sampleRate);

    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      requireElement<HTMLElement>('.boot-rom-storage-note').textContent =
        "This browser isn't letting the page store files, so boot ROMs will be forgotten when you close it.";
      return memoryStores();
    });
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const batterySaves = new BatterySaves(stores.battery as KeyValueStore<Uint8Array>);
    const bootRomStore = new BootRomStore(stores.bootRoms as KeyValueStore<Uint8Array>);
    let bootRoms: Partial<Record<Model, Uint8Array>> = await bootRomStore.load().catch(() => ({}));

    let current: CurrentCartridge | null = null;
    let bundledGames: BundledGame[] = [];
    let paused = false;
    let keyboardFast = false;
    let gamepadFast = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const parts = [current ? current.title : 'No cartridge', MODEL_NAMES[machine.model]];
      if (machine.cgb && !machine.cgbMode && current) parts.push('in its Game Boy mode');
      if (machine.hasBootRom) parts.push('boot ROM');
      status.textContent = `${parts.join(' · ')} · Arrows, Z, X, Enter and Shift play`;
      screenFrame.classList.toggle('empty', !machine.canRun);
    };

    /** Switches the console off and on, e.g. after its model or boot ROM changed. */
    const powerCycle = () => {
      machine.powerOn();
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Console -----------------------------------------------------------------------
    /** The console a cartridge runs on: the toolbar's choice, or for Auto, the Color for games that use it. */
    const modelFor = (info: CartridgeInfo | null): Model => {
      const choice = toolbar.model;
      if (choice !== 'auto') return choice;
      return info && colorSupport(info) !== 'none' ? 'cgb' : 'dmg';
    };

    const palette = requireElement<HTMLSelectElement>('select[name="palette"]');
    const applyPalette = () => {
      const chosen = PALETTES.find((name) => name === palette.value) ?? 'pocket';
      machine.ppu.screenColors = shadeTable(chosen);
    };
    palette.addEventListener('change', () => {
      applyPalette();
      focusScreen();
    });

    // --- Boot ROMs ---------------------------------------------------------------------
    const useBootRom = requireElement<HTMLInputElement>('input[name="use-boot-rom"]');
    /** The files the boot ROMs given on this visit came from. */
    let bootRomFiles: Partial<Record<Model, string>> = {};
    const applyBootRoms = () => {
      machine.bootRoms = useBootRom.checked ? bootRoms : {};
      bootRomSetup.showBootRoms(bootRoms, bootRomFiles);
    };
    useBootRom.addEventListener('change', () => {
      applyBootRoms();
      powerCycle();
      focusScreen();
    });
    /** Keeps a boot ROM and switches the console off and on to use it; resolves to a message saying so. */
    const useBootRomImage = async (bytes: Uint8Array, fileName: string): Promise<string> => {
      const model = bootRomModel(bytes);
      await bootRomStore.save(model, bytes);
      bootRoms = { ...bootRoms, [model]: bytes };
      bootRomFiles = { ...bootRomFiles, [model]: fileName };
      useBootRom.checked = true;
      useBootRom.dispatchEvent(new Event('change'));
      return `${BOOT_ROM_NAMES[model]} kept in this browser; the console was switched off and on to use it.`;
    };
    const isBootRomSize = (length: number) => Object.values(BOOT_ROM_SIZES).includes(length);
    /** Shows the boot ROM setup in place of the (paused) screen until the player goes back. */
    const openBootRomSetup = async () => {
      if (bootRomSetup.isOpen) return;
      audio?.flush();
      await bootRomSetup.open();
      emulator.resetTiming();
      focusScreen();
    };

    // --- Battery saves ---------------------------------------------------------------
    const saveBattery = async () => {
      const cart = current?.cartridge;
      if (!current || !cart || !cart.batteryDirty) return;
      const data = cart.saveData;
      cart.batteryDirty = false;
      if (data) await batterySaves.save(current.batteryKey, data);
    };
    const saveBatterySoon = () => {
      void saveBattery().catch((error: unknown) => console.warn('Could not keep the game save:', error));
    };
    setInterval(saveBatterySoon, BATTERY_SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // A clock cartridge's time is kept with its save.
        if (current?.info.hasRtc) current.cartridge.batteryDirty = true;
        saveBatterySoon();
      }
    });
    window.addEventListener('pagehide', saveBatterySoon);

    // --- Cartridges ------------------------------------------------------------------
    /** A cartridge with its saved game (if any) loaded. */
    const loadCartridge = async (rom: Uint8Array, fileName: string, knownTitle?: string): Promise<CurrentCartridge> => {
      const info = readHeader(rom);
      const key = batteryKey(rom);
      const cartridge = new Cartridge(rom, info);
      const saved = info.hasBattery ? await batterySaves.load(key).catch(() => undefined) : undefined;
      if (saved) cartridge.loadSaveData(saved);
      const cart: CurrentCartridge = {
        info,
        rom,
        fileName,
        title: knownTitle ?? titleFromFileName(fileName.split(' from ')[0]),
        cartridge,
        batteryKey: key,
      };
      cartPanel.showCartridge(cart.title, fileName, describe(cart), cartridge.saveData !== null);
      return cart;
    };

    const insertImage = async (image: Uint8Array, fileName: string, knownTitle?: string) => {
      const next = await loadCartridge(image, fileName, knownTitle);
      await saveBattery();
      current = next;
      machine.setModel(modelFor(next.info));
      machine.insertCartridge(next.cartridge);
      emulator.resetTiming();
      audio?.flush();
      updateCanSave();
      updateStatus();
      if (colorSupport(next.info) === 'only' && machine.model === 'dmg') {
        cartPanel.showMessage('This game needs a Game Boy Color: choose Console: Auto or Game Boy Color.', true);
      }
    };

    const eject = () => {
      saveBatterySoon();
      machine.insertCartridge(null);
      current = null;
      cartPanel.showEmpty();
      updateCanSave();
      updateStatus();
    };

    const useBatteryFile = async (bytes: Uint8Array) => {
      const cart = current?.cartridge;
      if (!current || !cart) throw new Error('Insert the game first, then drop its .sav file.');
      if (!current.info.hasBattery) throw new Error("This game doesn't save to its cartridge.");
      cart.loadSaveData(bytes);
      cart.batteryDirty = true;
      await saveBattery();
      machine.powerOn();
      audio?.flush();
      cartPanel.showMessage('Game save loaded; the console was switched off and on to use it.', true);
    };

    // --- Save states -----------------------------------------------------------------
    const currentSession = (): Session => {
      if (!current) throw new Error('Insert a cartridge first.');
      return {
        machine: machine.saveState(),
        rom: current.rom,
        romName: current.fileName,
        title: current.title,
        model: machine.model,
      };
    };
    const restoreSession = async (session: Session) => {
      const next = await loadCartridge(session.rom, session.romName, session.title);
      await saveBattery();
      current = next;
      machine.setModel(session.model);
      machine.insertCartridge(next.cartridge);
      machine.loadState(session.machine);
      emulator.resetTiming();
      updateCanSave();
      audio?.flush();
      updateStatus();
    };
    const updateCanSave = () => toolbar.setCanSave(current !== null);

    // --- Panels ----------------------------------------------------------------------
    const cartPanel = new CartPanel(requireElement('#cart-panel'), {
      onFile: async (file) => {
        const files = await filesFrom(file);
        const fromZip = files[0] !== file;
        const chosen = files[0];
        if (fromZip) cartPanel.setZipFiles(files, chosen.name);
        else if (cartPanel.zipContents.includes(file)) cartPanel.setZipFiles(cartPanel.zipContents, file.name);
        else cartPanel.setZipFiles([], null);
        const fileName = fromZip ? `${chosen.name} from ${file.name}` : chosen.name;
        if (isBootRomSize(chosen.size) || (looksLikeBootRom(chosen.name) && chosen.size < 0x1000)) {
          cartPanel.showMessage(await useBootRomImage(new Uint8Array(await chosen.arrayBuffer()), fileName), true);
          return;
        }
        const media = await readMedia(chosen);
        if (media.kind === 'state') {
          await restoreSession(await decodeSession(media.bytes));
          toolbar.showMessage('Save state loaded');
          return;
        }
        if (media.kind === 'battery') {
          await useBatteryFile(media.bytes);
          return;
        }
        const game = bundledGames.find((entry) => entry.file.split('/').pop() === chosen.name);
        await insertImage(media.image, fileName, game?.title);
        trackGameLoaded('gameboy', game?.title);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onEject: eject,
      onExportSave: () => {
        const data = current?.cartridge.saveData;
        if (current && data) downloadFile(data, `${slug(current.title)}${BATTERY_EXTENSION}`);
      },
      focusScreen,
    });

    const bootRomSetup = new BootRomSetup(requireElement('#boot-rom-setup'), {
      onFile: async (file) => {
        const [chosen] = await filesFrom(file);
        const fileName = chosen === file ? file.name : `${chosen.name} from ${file.name}`;
        return useBootRomImage(new Uint8Array(await chosen.arrayBuffer()), fileName);
      },
      onForget: async () => {
        await bootRomStore.forget();
        bootRoms = {};
        bootRomFiles = {};
        applyBootRoms();
        powerCycle();
      },
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onPowerCycle: powerCycle,
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onModel: () => {
        machine.setModel(modelFor(current?.info ?? null));
        powerCycle();
      },
      onSaveState: async () => {
        const session = currentSession();
        await saveStates.add(session.title, session);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const session = currentSession();
        downloadFile(await encodeSession(session), `${slug(session.title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      cartPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    // --- Inputs ----------------------------------------------------------------------
    const buttons = machine.joypad.input;
    new KeyboardInput(buttons, {
      onPause: () => toolbar.setPaused(!toolbar.paused),
      onFastForward: (held) => (keyboardFast = held),
    }).attach(window);
    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const padRoot = requireElement<HTMLElement>('#pad');
    new OnScreenPad(padRoot, buttons, focusScreen);
    const applyPad = () => (padRoot.hidden = !showPad.checked);
    showPad.addEventListener('change', applyPad);
    applyPad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -----------------------------------------------------------------
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      let pressed = 0;
      gamepadFast = false;
      for (const pad of pads) {
        pressed |= readGamepad(pad).buttons;
        gamepadFast ||= gamepadFastForward(pad);
      }
      if (pads.length) buttons.set('gamepad', { buttons: pressed });
      else buttons.clear('gamepad');
      const names = pads.map(padName).join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    let wasFast = false;
    const frame = (now: number) => {
      const elapsed = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      pollGamepads();
      const running = !paused && !bootRomSetup.isOpen;
      const fast = (keyboardFast || gamepadFast) && running;
      if (fast !== wasFast) {
        wasFast = fast;
        screenFrame.classList.toggle('fast', fast);
        audio?.flush();
      }
      if (running) {
        emulator.run(elapsed, fast ? FAST_FORWARD_SPEED : 1);
        const samples = emulator.takeAudioSamples();
        // Fast-forwarded sound would pile up faster than it plays, so it is dropped.
        if (!fast) audio?.play(samples);
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    requireElement<HTMLButtonElement>('#toolbar [data-action="change-boot-rom"]').addEventListener('click', () => {
      void openBootRomSetup();
    });

    applyPalette();
    applyBootRoms();
    machine.setModel(modelFor(null));
    machine.powerOn();
    cartPanel.showEmpty();
    updateCanSave();
    updateStatus();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
