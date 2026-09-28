// SPDX-License-Identifier: Apache-2.0
// Protocol v2 messages as bytes, for transports that carry bytes rather than structured-cloned values
// (WebSocket, HTTP, a native app's pipe): each message is one frame, a JSON envelope plus its typed arrays
// as binary attachments. docs/PROTOCOL.md ("Byte streams") is the normative description:
//
//   offset 0   "M3SE"                         magic
//          4   u32  frame length (all of it, from offset 0)
//          8   u32  J: length of the JSON text
//         12   u32  N: number of attachments
//         16   N x u32: byte length of each attachment
//              the JSON text (UTF-8), then zero bytes to a multiple of 8
//              each attachment, then zero bytes to a multiple of 8
//
// All integers little-endian. In the JSON text, a typed array (or ArrayBuffer) is replaced by
// {"$bin": <attachment index>, "type": "<Float32Array | Uint8Array | ... | ArrayBuffer>"}; no protocol
// value has a "$bin" key otherwise. Decoding gives every typed array a buffer of its own.

const MAGIC = 0x4553334d; // "M3SE" read as a little-endian u32
const HEADER = 16;
const TYPES = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
} as const;
type TypeName = keyof typeof TYPES | 'ArrayBuffer';

const pad8 = (n: number) => (n + 7) & ~7;

export class FrameError extends Error {}

/** One message as one frame. */
export function encodeFrame(message: unknown): Uint8Array {
  const attachments: Uint8Array[] = [];
  const json = JSON.stringify(message, function (this: unknown, _key, value: unknown) {
    if (value instanceof ArrayBuffer) {
      attachments.push(new Uint8Array(value));
      return { $bin: attachments.length - 1, type: 'ArrayBuffer' };
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const type = value.constructor.name as TypeName;
      if (!(type in TYPES)) throw new FrameError(`a ${type} cannot be sent`);
      attachments.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return { $bin: attachments.length - 1, type };
    }
    return value;
  });
  const text = new TextEncoder().encode(json);
  let size = pad8(HEADER + 4 * attachments.length) + pad8(text.length);
  const offsets = attachments.map((a) => {
    const at = size;
    size += pad8(a.byteLength);
    return at;
  });
  const frame = new Uint8Array(size);
  const view = new DataView(frame.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, size, true);
  view.setUint32(8, text.length, true);
  view.setUint32(12, attachments.length, true);
  attachments.forEach((a, i) => view.setUint32(HEADER + 4 * i, a.byteLength, true));
  const jsonAt = pad8(HEADER + 4 * attachments.length);
  frame.set(text, jsonAt);
  attachments.forEach((a, i) => frame.set(a, offsets[i]));
  return frame;
}

/** The message of one whole frame. Throws FrameError for anything that is not one. */
export function decodeFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < HEADER) throw new FrameError('a frame is at least 16 bytes');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new FrameError('not a protocol frame (no "M3SE")');
  const size = view.getUint32(4, true);
  if (size !== frame.byteLength) throw new FrameError(`the frame says ${size} bytes, it has ${frame.byteLength}`);
  const jsonLength = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  let at = pad8(HEADER + 4 * count);
  if (at + jsonLength > size) throw new FrameError('the JSON text runs past the frame');
  const text = new TextDecoder().decode(frame.subarray(at, at + jsonLength));
  at += pad8(jsonLength);
  const attachments: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(HEADER + 4 * i, true);
    if (at + length > size) throw new FrameError('an attachment runs past the frame');
    attachments.push(frame.slice(at, at + length));
    at += pad8(length);
  }
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && '$bin' in value && 'type' in value) {
      const { $bin, type } = value as { $bin: number; type: TypeName };
      const bytes = attachments[$bin];
      if (!bytes) throw new FrameError(`attachment ${$bin} is missing`);
      // frame.slice() gave each attachment an ArrayBuffer of its own.
      const buffer = bytes.buffer as ArrayBuffer;
      if (type === 'ArrayBuffer') return buffer;
      const Type = TYPES[type];
      if (!Type) throw new FrameError(`unknown attachment type ${type}`);
      if (bytes.byteLength % Type.BYTES_PER_ELEMENT !== 0) throw new FrameError(`attachment ${$bin} is not a whole ${type}`);
      return new Type(buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
    }
    return value;
  });
}

/**
 * Splits a byte stream into frames: push() the bytes as they arrive (in chunks of any size); it returns
 * the messages completed so far, in order.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): unknown[] {
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    const out: unknown[] = [];
    for (;;) {
      if (this.buffered < 8) return out;
      const head = this.peek(8);
      const view = new DataView(head.buffer, head.byteOffset, 8);
      if (view.getUint32(0, true) !== MAGIC) throw new FrameError('not a protocol frame (no "M3SE")');
      const size = view.getUint32(4, true);
      if (size < HEADER) throw new FrameError(`a frame of ${size} bytes`);
      if (this.buffered < size) return out;
      out.push(decodeFrame(this.take(size)));
    }
  }

  private peek(n: number): Uint8Array {
    if (this.chunks[0].byteLength >= n) return this.chunks[0].subarray(0, n);
    const joined = this.take(this.buffered);
    this.chunks = [joined];
    this.buffered = joined.byteLength;
    return joined.subarray(0, n);
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const used = Math.min(head.byteLength, n - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    this.buffered -= n;
    return out;
  }
}
