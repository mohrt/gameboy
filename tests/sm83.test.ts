import { describe, expect, it } from 'vitest';
import { FLAG_C, FLAG_H, FLAG_N, FLAG_Z, Sm83 } from '../src/cpu/sm83';
import { FlatBus } from './helpers/flat-bus';

function cpuWith(code: number[], at = 0x100): { cpu: Sm83; bus: FlatBus } {
  const bus = new FlatBus();
  bus.load(at, code);
  const cpu = new Sm83(bus);
  cpu.pc = at;
  cpu.sp = 0xfffe;
  return { cpu, bus };
}

/** M-cycles one instruction takes. */
function cyclesOf(code: number[], setup: (cpu: Sm83) => void = () => {}): number {
  const { cpu, bus } = cpuWith(code);
  setup(cpu);
  cpu.step();
  return bus.cycles;
}

describe('SM83 instructions', () => {
  it('adds with half carry and carry', () => {
    const { cpu } = cpuWith([0x3e, 0x8f, 0xc6, 0x81]); // LD A,$8F; ADD A,$81
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x10);
    expect(cpu.f).toBe(FLAG_H | FLAG_C);
  });

  it('subtracts, setting N, and compares without changing A', () => {
    const { cpu } = cpuWith([0x3e, 0x10, 0xd6, 0x01, 0xfe, 0x0f]); // LD A,$10; SUB $01; CP $0F
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x0f);
    expect(cpu.f).toBe(FLAG_N | FLAG_H);
    cpu.step();
    expect(cpu.a).toBe(0x0f);
    expect(cpu.f).toBe(FLAG_Z | FLAG_N);
  });

  it('adjusts BCD after an addition with DAA', () => {
    const { cpu } = cpuWith([0x3e, 0x45, 0xc6, 0x38, 0x27]); // LD A,$45; ADD A,$38; DAA
    for (let i = 0; i < 3; i++) cpu.step();
    expect(cpu.a).toBe(0x83);
  });

  it('keeps the low four bits of F clear through POP AF', () => {
    const { cpu, bus } = cpuWith([0xf1]);
    bus.load(0xfffc, [0xff, 0x12]);
    cpu.sp = 0xfffc;
    cpu.step();
    expect(cpu.a).toBe(0x12);
    expect(cpu.f).toBe(0xf0);
  });

  it('SWAPs nibbles and tests bits', () => {
    const { cpu } = cpuWith([0x06, 0xa5, 0xcb, 0x30, 0xcb, 0x78]); // LD B,$A5; SWAP B; BIT 7,B
    for (let i = 0; i < 3; i++) cpu.step();
    expect(cpu.b).toBe(0x5a);
    expect(cpu.f).toBe(FLAG_Z | FLAG_H);
  });

  it('takes the documented number of M-cycles', () => {
    expect(cyclesOf([0x00])).toBe(1); // NOP
    expect(cyclesOf([0x01, 0x34, 0x12])).toBe(3); // LD BC,nn
    expect(cyclesOf([0x34])).toBe(3); // INC (HL)
    expect(cyclesOf([0xcd, 0x00, 0x20])).toBe(6); // CALL nn
    expect(cyclesOf([0xc4, 0x00, 0x20], (cpu) => (cpu.f = FLAG_Z))).toBe(3); // CALL NZ not taken
    expect(cyclesOf([0xc9])).toBe(4); // RET
    expect(cyclesOf([0xc0])).toBe(5); // RET NZ taken
    expect(cyclesOf([0xe8, 0x02])).toBe(4); // ADD SP,e
    expect(cyclesOf([0xcb, 0x46])).toBe(3); // BIT 0,(HL)
    expect(cyclesOf([0xcb, 0xc6])).toBe(4); // SET 0,(HL)
    expect(cyclesOf([0x08, 0x00, 0xc0])).toBe(5); // LD (nn),SP
  });
});

describe('SM83 interrupts', () => {
  it('services the highest-priority interrupt in five M-cycles, pushing PC', () => {
    const { cpu, bus } = cpuWith([0x00]);
    cpu.ime = true;
    bus.interruptEnable = 0x1f;
    bus.interruptFlags = 0x06; // STAT and timer
    cpu.step();
    expect(bus.cycles).toBe(5);
    expect(cpu.pc).toBe(0x48);
    expect(cpu.ime).toBe(false);
    expect(bus.interruptFlags).toBe(0x04);
    expect(bus.memory[0xfffd] << 8 | bus.memory[0xfffc]).toBe(0x100);
  });

  it('enables interrupts only after the instruction following EI', () => {
    const { cpu, bus } = cpuWith([0xfb, 0x00, 0x00]);
    bus.interruptEnable = bus.interruptFlags = 0x01;
    cpu.step(); // EI
    cpu.step(); // NOP, still not interruptible
    expect(cpu.pc).toBe(0x102);
    cpu.step();
    expect(cpu.pc).toBe(0x40);
  });

  it('halts until an interrupt, and wakes without servicing it when IME is off', () => {
    const { cpu, bus } = cpuWith([0x76, 0x3c]); // HALT; INC A
    bus.interruptEnable = 0x01;
    cpu.step();
    expect(cpu.halted).toBe(true);
    cpu.step();
    expect(cpu.halted).toBe(true);
    bus.interruptFlags = 0x01;
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(1);
    expect(cpu.pc).toBe(0x102);
  });

  it('reads the byte after HALT twice when an interrupt is already pending with IME off (the HALT bug)', () => {
    const { cpu, bus } = cpuWith([0x76, 0x3c, 0x00]); // HALT; INC A
    bus.interruptEnable = bus.interruptFlags = 0x01;
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(2);
  });

  it('returns to the HALT after EI; HALT with an interrupt waiting', () => {
    const { cpu, bus } = cpuWith([0xfb, 0x76, 0x00]);
    bus.interruptEnable = bus.interruptFlags = 0x01;
    cpu.step(); // EI
    cpu.step(); // HALT, with the HALT bug
    cpu.step(); // the interrupt
    expect(cpu.pc).toBe(0x40);
    expect(bus.memory[0xfffd] << 8 | bus.memory[0xfffc]).toBe(0x101);
  });

  it('locks up on an unused opcode', () => {
    const { cpu } = cpuWith([0xd3, 0x3c]);
    cpu.step();
    cpu.step();
    expect(cpu.locked).toBe(true);
    expect(cpu.a).toBe(0);
  });
});
