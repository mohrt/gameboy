import { describe, expect, it } from 'vitest';
import { Apu } from '../src/sound/apu';
import { AudioMixer } from '../src/sound/mixer';

function apuOn(): { apu: Apu; mixer: AudioMixer } {
  const mixer = new AudioMixer();
  mixer.setRates(4_194_304, 48_000);
  const apu = new Apu(mixer);
  apu.reset(false);
  apu.write(0xff26, 0x80);
  return { apu, mixer };
}

const run = (apu: Apu, clocks: number) => {
  for (let i = 0; i < clocks; i += 4) apu.tick(4);
};

/** Steps the frame sequencer as DIV would. */
const sequencer = (apu: Apu, steps: number) => {
  for (let i = 0; i < steps; i++) apu.frameSequencerTick();
};

describe('sound registers', () => {
  it('read back with their unused bits set', () => {
    const { apu } = apuOn();
    expect(apu.read(0xff10)).toBe(0x80);
    expect(apu.read(0xff11)).toBe(0x3f);
    expect(apu.read(0xff13)).toBe(0xff);
    expect(apu.read(0xff1a)).toBe(0x7f);
    expect(apu.read(0xff26)).toBe(0xf0);
    expect(apu.read(0xff27)).toBe(0xff);
  });

  it('switching the chip off clears its registers and ignores writes', () => {
    const { apu } = apuOn();
    apu.write(0xff24, 0x77);
    apu.write(0xff26, 0x00);
    expect(apu.read(0xff24)).toBe(0x00);
    apu.write(0xff24, 0x77);
    expect(apu.read(0xff24)).toBe(0x00);
    expect(apu.read(0xff26)).toBe(0x70);
  });
});

describe('sound channels', () => {
  it('a triggered square channel plays and shows in NR52', () => {
    const { apu, mixer } = apuOn();
    apu.write(0xff24, 0x77);
    apu.write(0xff25, 0x11);
    apu.write(0xff11, 0x80);
    apu.write(0xff12, 0xf0);
    apu.write(0xff13, 0x00);
    apu.write(0xff14, 0x87);
    expect(apu.read(0xff26) & 0x01).toBe(1);
    mixer.takeSamples();
    run(apu, 4_194_304 / 50);
    const samples = mixer.takeSamples();
    expect(samples.length).toBeGreaterThan(1500);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.2);
  });

  it('the length counter switches a channel off', () => {
    const { apu } = apuOn();
    apu.write(0xff12, 0xf0);
    apu.write(0xff11, 0x3e); // length 2
    apu.write(0xff14, 0xc0);
    expect(apu.read(0xff26) & 1).toBe(1);
    sequencer(apu, 4);
    expect(apu.read(0xff26) & 1).toBe(0);
  });

  it('a channel with its DAC off cannot be triggered', () => {
    const { apu } = apuOn();
    apu.write(0xff12, 0x00);
    apu.write(0xff14, 0x80);
    expect(apu.read(0xff26) & 1).toBe(0);
  });

  it('the sweep switches channel 1 off when the frequency overflows', () => {
    const { apu } = apuOn();
    apu.write(0xff12, 0xf0);
    apu.write(0xff10, 0x11); // period 1, shift 1, up
    apu.write(0xff13, 0x00);
    apu.write(0xff14, 0x85); // frequency $500: one sweep step to $780, then the next overflows
    expect(apu.read(0xff26) & 1).toBe(1);
    sequencer(apu, 8);
    expect(apu.read(0xff26) & 1).toBe(0);
  });

  it('the wave channel reads its samples from wave RAM', () => {
    const { apu } = apuOn();
    for (let i = 0; i < 16; i++) apu.write(0xff30 + i, i * 0x11);
    expect(apu.read(0xff35)).toBe(0x55);
    apu.write(0xff1a, 0x80);
    apu.write(0xff1c, 0x20);
    apu.write(0xff1e, 0x87);
    run(apu, 2000);
    expect(apu.readPcm(true) & 0x0f).toBeGreaterThan(0);
  });
});
