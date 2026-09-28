// SPDX-License-Identifier: Apache-2.0
// Small helpers both sides use: the buffers of a message (to transfer instead of copy), a content hash
// for configs (settings requests name cached configs by it), and protocol negotiation.
import { PROTOCOL } from './envelope.ts';
import type { Config } from './data.ts';
import type { HelloResult } from './ops.ts';

/**
 * The ArrayBuffers of every typed array (and ArrayBuffer) in `value`, each once: the transfer list for
 * postMessage, so the buffers move instead of being copied. Walks plain objects and arrays. A
 * SharedArrayBuffer is never listed (it cannot be transferred, and the protocol never carries one).
 * After a transfer the sender's arrays are empty: send copies of arrays you still need.
 */
export function transferablesOf(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || depth > 64) return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
      return;
    }
    if (v instanceof ArrayBuffer) {
      buffers.add(v);
      return;
    }
    if (Array.isArray(v)) {
      // Arrays of strings (configs, key lists) are common and hold nothing to transfer.
      for (const item of v) if (item !== null && typeof item === 'object') walk(item, depth + 1);
      return;
    }
    for (const key in v) {
      const item = (v as Record<string, unknown>)[key];
      if (item !== null && typeof item === 'object') walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return [...buffers];
}

// ---------------------------------------------------------------------------------------------
// Config hashes
// ---------------------------------------------------------------------------------------------

const hashes = new WeakMap<object, string>();

/**
 * A content hash of a config (64-bit FNV-1a over its keys in sorted order and their values), as hex:
 * what ConfigRef.hash names a cached config by. Cached per object, so hashing the same config object
 * again is free (treat configs as immutable).
 */
export function configHash(config: Config): string {
  const known = hashes.get(config);
  if (known) return known;
  // Two 32-bit FNV-1a lanes with different offsets: 64 bits, no BigInt.
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
    }
    a = Math.imul(a ^ 0xff, 0x01000193);
    b = Math.imul(b ^ 0xfe, 0x01000193) ^ (b >>> 15);
  };
  for (const key of Object.keys(config).sort()) {
    feed(key);
    const value = config[key];
    if (Array.isArray(value)) {
      feed('[');
      for (const item of value) feed(String(item));
      feed(']');
    } else {
      feed(String(value));
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const hash = `fnv:${hex(a)}${hex(b)}:${Object.keys(config).length}`;
  hashes.set(config, hash);
  return hash;
}

// ---------------------------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------------------------

export type Negotiation = { ok: true; minor: number } | { ok: false; reason: string; missing: string[] };

/**
 * Whether a host's `hello` answer serves a client that speaks protocol `major` (default this package's),
 * needs at least minor `minMinor` and the capabilities `required`.
 */
export function negotiate(hello: HelloResult, want: { major?: number; minMinor?: number; required?: readonly string[] } = {}): Negotiation {
  const major = want.major ?? PROTOCOL.major;
  const missing = (want.required ?? []).filter((c) => !hello.capabilities.includes(c));
  if (hello.protocol.major !== major) {
    return { ok: false, reason: `the engine speaks protocol ${hello.protocol.major}, this client ${major}`, missing };
  }
  if (hello.protocol.minor < (want.minMinor ?? 0)) {
    return { ok: false, reason: `the engine speaks protocol ${major}.${hello.protocol.minor}; this client needs ${major}.${want.minMinor}`, missing };
  }
  if (missing.length > 0) return { ok: false, reason: `the engine lacks ${missing.join(', ')}`, missing };
  return { ok: true, minor: hello.protocol.minor };
}
