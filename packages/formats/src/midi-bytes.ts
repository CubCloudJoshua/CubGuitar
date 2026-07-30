/**
 * Standard MIDI File byte plumbing, shared by the writer and the reader.
 *
 * Kept separate from both so the pair cannot disagree about the format's own
 * rules. A variable-length quantity written one way and read another is the
 * classic way a MIDI round trip appears to work on small files and falls apart on
 * the first delta over 127 ticks, and the only real defence is one implementation
 * of each primitive with tests on the boundaries.
 */

/** Grows as needed; MIDI track lengths are not known until the track is written. */
export class ByteWriter {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }

  u32(value: number): this {
    return this.u8(value >> 24).u8(value >> 16).u8(value >> 8).u8(value);
  }

  /**
   * A variable-length quantity: seven bits per byte, high bit set on every byte
   * but the last. Delta times and meta-event lengths both use it, and the format
   * caps it at four bytes (0x0FFFFFFF).
   */
  vlq(value: number): this {
    const clamped = Math.max(0, Math.min(0x0fffffff, Math.round(value)));
    const parts = [clamped & 0x7f];
    let rest = clamped >> 7;
    while (rest > 0) {
      parts.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    for (const part of parts) this.u8(part);
    return this;
  }

  ascii(text: string): this {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      // MIDI text events are bytes, not Unicode. Anything outside ASCII is
      // replaced rather than truncated mid-character, which would leave a length
      // prefix that disagrees with the bytes after it.
      this.u8(code < 0x80 ? code : 0x3f);
    }
    return this;
  }

  raw(other: ByteWriter | Uint8Array): this {
    const source = other instanceof ByteWriter ? other.bytes : Array.from(other);
    for (const byte of source) this.u8(byte);
    return this;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export class ByteReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.at;
  }

  get remaining(): number {
    return this.bytes.length - this.at;
  }

  u8(): number {
    if (this.at >= this.bytes.length) throw new Error("midi: unexpected end of data");
    return this.bytes[this.at++]!;
  }

  /**
   * The next byte without consuming it.
   *
   * Needed for running status: whether the next byte is a status byte or the first
   * data byte of a repeated message is decided by its high bit, and that has to be
   * inspected before deciding to consume it.
   */
  peek(): number {
    if (this.at >= this.bytes.length) throw new Error("midi: unexpected end of data");
    return this.bytes[this.at]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    // Shifting past bit 31 turns negative in JS, so build it with arithmetic.
    return this.u8() * 0x1000000 + this.u8() * 0x10000 + this.u8() * 0x100 + this.u8();
  }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("midi: variable-length quantity longer than four bytes");
  }

  ascii(length: number): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(this.u8());
    return out;
  }

  skip(length: number): void {
    if (length < 0 || this.at + length > this.bytes.length) {
      throw new Error("midi: chunk claims more data than the file holds");
    }
    this.at += length;
  }

  /** A view of the next `length` bytes, without copying. */
  slice(length: number): Uint8Array {
    if (length < 0 || this.at + length > this.bytes.length) {
      throw new Error("midi: chunk claims more data than the file holds");
    }
    const view = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return view;
  }
}

/** Status bytes we write and read. Channel is the low nibble. */
export const NOTE_OFF = 0x80;
export const NOTE_ON = 0x90;
export const CONTROL_CHANGE = 0xb0;
export const PROGRAM_CHANGE = 0xc0;
export const PITCH_BEND = 0xe0;
export const META = 0xff;
export const SYSEX = 0xf0;
export const SYSEX_ESCAPE = 0xf7;

export const META_TRACK_NAME = 0x03;
export const META_TEMPO = 0x51;
export const META_TIME_SIGNATURE = 0x58;
export const META_KEY_SIGNATURE = 0x59;
export const META_END_OF_TRACK = 0x2f;

/**
 * Bytes carried by a channel message *after* its status byte. Needed by the
 * reader, because running status means the status byte is often absent and the
 * only way to know how much to consume is to know the message.
 */
export function channelDataLength(status: number): number {
  return (status & 0xf0) === PROGRAM_CHANGE || (status & 0xf0) === 0xd0 ? 1 : 2;
}

/** MIDI's percussion channel, zero-based. Reserved by the specification. */
export const DRUM_CHANNEL = 9;
/** Channels available to pitched parts: all sixteen except the drum one. */
export const PITCHED_CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter(
  (c) => c !== DRUM_CHANNEL,
);
