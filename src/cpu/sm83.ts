/** The flag bits of F (its low four bits always read 0). */
export const FLAG_Z = 0x80;
export const FLAG_N = 0x40;
export const FLAG_H = 0x20;
export const FLAG_C = 0x10;

/**
 * What the CPU sees of the console. Every read and write takes one M-cycle
 * (four clocks) and `idle` is an M-cycle with no memory access, so the rest of
 * the hardware runs in step with each access.
 */
export interface Sm83Bus {
  read(address: number): number;
  write(address: number, value: number): void;
  idle(): void;
  /** Interrupts both requested (IF) and enabled (IE), as bits 0-4. */
  pendingInterrupts(): number;
  /** Clears an interrupt's request, as the CPU starts servicing it. */
  acknowledgeInterrupt(bit: number): void;
  /** The STOP instruction: true if it switched the CPU's speed (on a Game Boy Color) rather than stopping. */
  stop(): boolean;
}

/** Instructions the CPU doesn't have; running one locks it up until the console is switched off. */
const UNUSED_OPCODES = new Set([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]);

/**
 * The Sharp SM83, the Game Boy's CPU: a Z80-like core with the 8080's
 * registers, its own flags (Z, N, H, C) and a handful of its own instructions
 * (the $FF00 page loads, LD (HL+) and SWAP). Timed to the M-cycle: memory
 * accesses happen in the order and on the cycles the real one makes them.
 */
export class Sm83 {
  a = 0;
  f = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0;
  pc = 0;
  /** The interrupt master enable. */
  ime = false;
  /** EI takes effect after the instruction that follows it: steps left until then. */
  imeDelay = 0;
  halted = false;
  /** HALT with interrupts off and one already pending: the next opcode byte is read twice. */
  haltBug = false;
  /** Ran an unused opcode: the real CPU stops until the console is switched off. */
  locked = false;

  constructor(private readonly bus: Sm83Bus) {}

  get bc(): number {
    return (this.b << 8) | this.c;
  }
  get de(): number {
    return (this.d << 8) | this.e;
  }
  get hl(): number {
    return (this.h << 8) | this.l;
  }
  get af(): number {
    return (this.a << 8) | this.f;
  }
  private setBc(value: number): void {
    this.b = (value >> 8) & 0xff;
    this.c = value & 0xff;
  }
  private setDe(value: number): void {
    this.d = (value >> 8) & 0xff;
    this.e = value & 0xff;
  }
  private setHl(value: number): void {
    this.h = (value >> 8) & 0xff;
    this.l = value & 0xff;
  }

  reset(): void {
    this.a = this.f = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.sp = this.pc = 0;
    this.ime = this.halted = this.haltBug = this.locked = false;
    this.imeDelay = 0;
  }

  /** Runs one instruction, services one interrupt, or waits one M-cycle while halted. */
  step(): void {
    const { bus } = this;
    if (this.imeDelay > 0 && --this.imeDelay === 0) this.ime = true;
    if (this.halted || this.locked) {
      bus.idle();
      if (!this.locked && bus.pendingInterrupts() !== 0) this.halted = false;
      return;
    }
    if (this.ime && bus.pendingInterrupts() !== 0) {
      this.serviceInterrupt();
      return;
    }
    const op = bus.read(this.pc);
    if (this.haltBug) this.haltBug = false;
    else this.pc = (this.pc + 1) & 0xffff;
    this.execute(op);
  }

  /**
   * Five M-cycles: two waits, the return address pushed, then the jump. The
   * interrupt is chosen between the two pushes, so a push that lands on IE
   * ($FFFF) can change or cancel it (cancelled, it jumps to $0000).
   */
  private serviceInterrupt(): void {
    const { bus } = this;
    this.ime = false;
    // After EI then HALT with an interrupt waiting, the HALT bug leaves PC on the HALT, so the handler returns to it.
    if (this.haltBug) {
      this.haltBug = false;
      this.pc = (this.pc - 1) & 0xffff;
    }
    bus.idle();
    bus.idle();
    this.sp = (this.sp - 1) & 0xffff;
    bus.write(this.sp, this.pc >> 8);
    const pending = bus.pendingInterrupts();
    this.sp = (this.sp - 1) & 0xffff;
    bus.write(this.sp, this.pc & 0xff);
    if (pending === 0) {
      this.pc = 0;
    } else {
      const bit = 31 - Math.clz32(pending & -pending);
      bus.acknowledgeInterrupt(bit);
      this.pc = 0x40 + bit * 8;
    }
    bus.idle();
  }

  // --- Operands -------------------------------------------------------------------

  private imm8(): number {
    const value = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private imm16(): number {
    const low = this.imm8();
    return low | (this.imm8() << 8);
  }

  private push(value: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, value >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.write(this.sp, value & 0xff);
  }

  private pop(): number {
    const low = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.bus.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  /** Register by its 3-bit code: B, C, D, E, H, L, (HL), A. */
  private getR(index: number): number {
    switch (index) {
      case 0:
        return this.b;
      case 1:
        return this.c;
      case 2:
        return this.d;
      case 3:
        return this.e;
      case 4:
        return this.h;
      case 5:
        return this.l;
      case 6:
        return this.bus.read(this.hl);
      default:
        return this.a;
    }
  }

  private setR(index: number, value: number): void {
    switch (index) {
      case 0:
        this.b = value;
        break;
      case 1:
        this.c = value;
        break;
      case 2:
        this.d = value;
        break;
      case 3:
        this.e = value;
        break;
      case 4:
        this.h = value;
        break;
      case 5:
        this.l = value;
        break;
      case 6:
        this.bus.write(this.hl, value);
        break;
      default:
        this.a = value;
    }
  }

  /** Register pair by its 2-bit code: BC, DE, HL, SP. */
  private getRR(index: number): number {
    return index === 0 ? this.bc : index === 1 ? this.de : index === 2 ? this.hl : this.sp;
  }

  private setRR(index: number, value: number): void {
    value &= 0xffff;
    if (index === 0) this.setBc(value);
    else if (index === 1) this.setDe(value);
    else if (index === 2) this.setHl(value);
    else this.sp = value;
  }

  /** Condition by its 2-bit code: NZ, Z, NC, C. */
  private condition(index: number): boolean {
    switch (index) {
      case 0:
        return (this.f & FLAG_Z) === 0;
      case 1:
        return (this.f & FLAG_Z) !== 0;
      case 2:
        return (this.f & FLAG_C) === 0;
      default:
        return (this.f & FLAG_C) !== 0;
    }
  }

  // --- Arithmetic -----------------------------------------------------------------

  /** ADD, ADC, SUB, SBC, AND, XOR, OR or CP of A with `value`, by its 3-bit code. */
  private alu(operation: number, value: number): void {
    const a = this.a;
    const carry = (this.f & FLAG_C) !== 0 ? 1 : 0;
    let result: number;
    switch (operation) {
      case 0: // ADD
      case 1: {
        // ADC
        const c = operation === 1 ? carry : 0;
        result = a + value + c;
        this.f =
          ((result & 0xff) === 0 ? FLAG_Z : 0) |
          ((a & 0x0f) + (value & 0x0f) + c > 0x0f ? FLAG_H : 0) |
          (result > 0xff ? FLAG_C : 0);
        this.a = result & 0xff;
        return;
      }
      case 2: // SUB
      case 3: // SBC
      case 7: {
        // CP
        const c = operation === 3 ? carry : 0;
        result = a - value - c;
        this.f =
          ((result & 0xff) === 0 ? FLAG_Z : 0) |
          FLAG_N |
          ((a & 0x0f) - (value & 0x0f) - c < 0 ? FLAG_H : 0) |
          (result < 0 ? FLAG_C : 0);
        if (operation !== 7) this.a = result & 0xff;
        return;
      }
      case 4:
        this.a = a & value;
        this.f = (this.a === 0 ? FLAG_Z : 0) | FLAG_H;
        return;
      case 5:
        this.a = a ^ value;
        this.f = this.a === 0 ? FLAG_Z : 0;
        return;
      default:
        this.a = a | value;
        this.f = this.a === 0 ? FLAG_Z : 0;
    }
  }

  private inc8(value: number): number {
    const result = (value + 1) & 0xff;
    this.f = (this.f & FLAG_C) | (result === 0 ? FLAG_Z : 0) | ((value & 0x0f) === 0x0f ? FLAG_H : 0);
    return result;
  }

  private dec8(value: number): number {
    const result = (value - 1) & 0xff;
    this.f = (this.f & FLAG_C) | (result === 0 ? FLAG_Z : 0) | FLAG_N | ((value & 0x0f) === 0 ? FLAG_H : 0);
    return result;
  }

  private addHl(value: number): void {
    const hl = this.hl;
    const result = hl + value;
    this.f = (this.f & FLAG_Z) | ((hl & 0x0fff) + (value & 0x0fff) > 0x0fff ? FLAG_H : 0) | (result > 0xffff ? FLAG_C : 0);
    this.setHl(result & 0xffff);
  }

  /** SP plus a signed byte, for ADD SP,e and LD HL,SP+e: the flags come from adding the low bytes. */
  private spPlusOffset(): number {
    const offset = this.imm8();
    const sp = this.sp;
    this.f = ((sp & 0x0f) + (offset & 0x0f) > 0x0f ? FLAG_H : 0) | ((sp & 0xff) + offset > 0xff ? FLAG_C : 0);
    return (sp + ((offset << 24) >> 24)) & 0xffff;
  }

  private daa(): void {
    let a = this.a;
    let carry = this.f & FLAG_C;
    if (this.f & FLAG_N) {
      if (this.f & FLAG_H) a -= 0x06;
      if (carry) a -= 0x60;
    } else {
      if (this.f & FLAG_H || (a & 0x0f) > 0x09) a += 0x06;
      if (carry || this.a > 0x99) {
        a += 0x60;
        carry = FLAG_C;
      }
    }
    a &= 0xff;
    this.a = a;
    this.f = (a === 0 ? FLAG_Z : 0) | (this.f & FLAG_N) | carry;
  }

  /** The CB-prefixed rotates, shifts and SWAP, by their 3-bit code; sets the flags. */
  private shift(operation: number, value: number): number {
    const carryIn = (this.f & FLAG_C) !== 0 ? 1 : 0;
    let result: number;
    let carryOut: number;
    switch (operation) {
      case 0: // RLC
        carryOut = value >> 7;
        result = ((value << 1) | carryOut) & 0xff;
        break;
      case 1: // RRC
        carryOut = value & 1;
        result = (value >> 1) | (carryOut << 7);
        break;
      case 2: // RL
        carryOut = value >> 7;
        result = ((value << 1) | carryIn) & 0xff;
        break;
      case 3: // RR
        carryOut = value & 1;
        result = (value >> 1) | (carryIn << 7);
        break;
      case 4: // SLA
        carryOut = value >> 7;
        result = (value << 1) & 0xff;
        break;
      case 5: // SRA
        carryOut = value & 1;
        result = (value >> 1) | (value & 0x80);
        break;
      case 6: // SWAP
        carryOut = 0;
        result = ((value << 4) | (value >> 4)) & 0xff;
        break;
      default: // SRL
        carryOut = value & 1;
        result = value >> 1;
    }
    this.f = (result === 0 ? FLAG_Z : 0) | (carryOut ? FLAG_C : 0);
    return result;
  }

  private executeCb(): void {
    const op = this.imm8();
    const index = op & 7;
    const bit = (op >> 3) & 7;
    const value = this.getR(index);
    switch (op >> 6) {
      case 0:
        this.setR(index, this.shift(bit, value));
        return;
      case 1: // BIT
        this.f = (this.f & FLAG_C) | FLAG_H | ((value >> bit) & 1 ? 0 : FLAG_Z);
        return;
      case 2: // RES
        this.setR(index, value & ~(1 << bit));
        return;
      default: // SET
        this.setR(index, value | (1 << bit));
    }
  }

  // --- Instructions ---------------------------------------------------------------

  private jumpRelative(taken: boolean): void {
    const offset = this.imm8();
    if (!taken) return;
    this.bus.idle();
    this.pc = (this.pc + ((offset << 24) >> 24)) & 0xffff;
  }

  private jump(taken: boolean): void {
    const target = this.imm16();
    if (!taken) return;
    this.bus.idle();
    this.pc = target;
  }

  private call(taken: boolean): void {
    const target = this.imm16();
    if (!taken) return;
    this.bus.idle();
    this.push(this.pc);
    this.pc = target;
  }

  private ret(): void {
    this.pc = this.pop();
    this.bus.idle();
  }

  private halt(): void {
    if (this.bus.pendingInterrupts() === 0) this.halted = true;
    else if (!this.ime) this.haltBug = true;
  }

  private execute(op: number): void {
    const { bus } = this;
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) this.halt();
      else this.setR((op >> 3) & 7, this.getR(op & 7));
      return;
    }
    if (op >= 0x80 && op < 0xc0) {
      this.alu((op >> 3) & 7, this.getR(op & 7));
      return;
    }
    switch (op) {
      case 0x00:
        return;
      case 0x01:
      case 0x11:
      case 0x21:
      case 0x31:
        this.setRR(op >> 4, this.imm16());
        return;
      case 0x02:
        bus.write(this.bc, this.a);
        return;
      case 0x12:
        bus.write(this.de, this.a);
        return;
      case 0x22:
        bus.write(this.hl, this.a);
        this.setHl((this.hl + 1) & 0xffff);
        return;
      case 0x32:
        bus.write(this.hl, this.a);
        this.setHl((this.hl - 1) & 0xffff);
        return;
      case 0x0a:
        this.a = bus.read(this.bc);
        return;
      case 0x1a:
        this.a = bus.read(this.de);
        return;
      case 0x2a:
        this.a = bus.read(this.hl);
        this.setHl((this.hl + 1) & 0xffff);
        return;
      case 0x3a:
        this.a = bus.read(this.hl);
        this.setHl((this.hl - 1) & 0xffff);
        return;
      case 0x03:
      case 0x13:
      case 0x23:
      case 0x33:
        bus.idle();
        this.setRR(op >> 4, this.getRR(op >> 4) + 1);
        return;
      case 0x0b:
      case 0x1b:
      case 0x2b:
      case 0x3b:
        bus.idle();
        this.setRR(op >> 4, this.getRR(op >> 4) - 1);
        return;
      case 0x04:
      case 0x0c:
      case 0x14:
      case 0x1c:
      case 0x24:
      case 0x2c:
      case 0x34:
      case 0x3c: {
        const index = (op >> 3) & 7;
        this.setR(index, this.inc8(this.getR(index)));
        return;
      }
      case 0x05:
      case 0x0d:
      case 0x15:
      case 0x1d:
      case 0x25:
      case 0x2d:
      case 0x35:
      case 0x3d: {
        const index = (op >> 3) & 7;
        this.setR(index, this.dec8(this.getR(index)));
        return;
      }
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
      case 0x26:
      case 0x2e:
      case 0x36:
      case 0x3e:
        this.setR((op >> 3) & 7, this.imm8());
        return;
      case 0x07: // RLCA
      case 0x0f: // RRCA
      case 0x17: // RLA
      case 0x1f: // RRA
        this.a = this.shift(op >> 3, this.a);
        this.f &= FLAG_C;
        return;
      case 0x08: {
        const address = this.imm16();
        bus.write(address, this.sp & 0xff);
        bus.write((address + 1) & 0xffff, this.sp >> 8);
        return;
      }
      case 0x09:
      case 0x19:
      case 0x29:
      case 0x39:
        bus.idle();
        this.addHl(this.getRR(op >> 4));
        return;
      case 0x10: // STOP: two bytes long
        this.imm8();
        if (!bus.stop()) this.halted = true;
        return;
      case 0x18:
        this.jumpRelative(true);
        return;
      case 0x20:
      case 0x28:
      case 0x30:
      case 0x38:
        this.jumpRelative(this.condition((op >> 3) & 3));
        return;
      case 0x27:
        this.daa();
        return;
      case 0x2f:
        this.a ^= 0xff;
        this.f |= FLAG_N | FLAG_H;
        return;
      case 0x37:
        this.f = (this.f & FLAG_Z) | FLAG_C;
        return;
      case 0x3f:
        this.f = (this.f & FLAG_Z) | ((this.f & FLAG_C) ^ FLAG_C);
        return;

      case 0xc0:
      case 0xc8:
      case 0xd0:
      case 0xd8:
        bus.idle();
        if (this.condition((op >> 3) & 3)) this.ret();
        return;
      case 0xc1:
        this.setBc(this.pop());
        return;
      case 0xd1:
        this.setDe(this.pop());
        return;
      case 0xe1:
        this.setHl(this.pop());
        return;
      case 0xf1: {
        const value = this.pop();
        this.a = value >> 8;
        this.f = value & 0xf0;
        return;
      }
      case 0xc2:
      case 0xca:
      case 0xd2:
      case 0xda:
        this.jump(this.condition((op >> 3) & 3));
        return;
      case 0xc3:
        this.jump(true);
        return;
      case 0xc4:
      case 0xcc:
      case 0xd4:
      case 0xdc:
        this.call(this.condition((op >> 3) & 3));
        return;
      case 0xc5:
      case 0xd5:
      case 0xe5:
      case 0xf5:
        bus.idle();
        this.push(op === 0xf5 ? this.af : this.getRR((op >> 4) & 3));
        return;
      case 0xc6:
      case 0xce:
      case 0xd6:
      case 0xde:
      case 0xe6:
      case 0xee:
      case 0xf6:
      case 0xfe:
        this.alu((op >> 3) & 7, this.imm8());
        return;
      case 0xc7:
      case 0xcf:
      case 0xd7:
      case 0xdf:
      case 0xe7:
      case 0xef:
      case 0xf7:
      case 0xff:
        bus.idle();
        this.push(this.pc);
        this.pc = op & 0x38;
        return;
      case 0xc9:
        this.ret();
        return;
      case 0xd9:
        this.ret();
        this.ime = true;
        this.imeDelay = 0;
        return;
      case 0xcb:
        this.executeCb();
        return;
      case 0xcd:
        this.call(true);
        return;
      case 0xe0:
        bus.write(0xff00 | this.imm8(), this.a);
        return;
      case 0xf0:
        this.a = bus.read(0xff00 | this.imm8());
        return;
      case 0xe2:
        bus.write(0xff00 | this.c, this.a);
        return;
      case 0xf2:
        this.a = bus.read(0xff00 | this.c);
        return;
      case 0xe8: {
        const result = this.spPlusOffset();
        bus.idle();
        bus.idle();
        this.sp = result;
        return;
      }
      case 0xf8: {
        const result = this.spPlusOffset();
        bus.idle();
        this.setHl(result);
        return;
      }
      case 0xf9:
        bus.idle();
        this.sp = this.hl;
        return;
      case 0xe9:
        this.pc = this.hl;
        return;
      case 0xea:
        bus.write(this.imm16(), this.a);
        return;
      case 0xfa:
        this.a = bus.read(this.imm16());
        return;
      case 0xf3:
        this.ime = false;
        this.imeDelay = 0;
        return;
      case 0xfb:
        if (!this.ime && this.imeDelay === 0) this.imeDelay = 2;
        return;
      default:
        if (UNUSED_OPCODES.has(op)) this.locked = true;
    }
  }
}
