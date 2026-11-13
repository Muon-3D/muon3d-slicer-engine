// SPDX-License-Identifier: Apache-2.0
// The slice field (docs/SLICE_FIELD.md): how a plate will be printed, on a voxel grid, as one file. The
// slicer writes it ('slice.field'); a separate program such as the print-strength simulator reads it. Only
// this file crosses that boundary. The reader and writer here are plain TypeScript with no engine code.

/** The file's first 8 bytes. */
export const SLICE_FIELD_MAGIC = 'MSLFIELD';
export const SLICE_FIELD_FORMAT = 'muon3d.slice-field';
export const SLICE_FIELD_VERSION = 1;
/** layerIndex of a voxel with no material. */
export const SLICE_FIELD_NO_LAYER = 0xffff;
/** rasterDirection of a voxel with no extrusion. */
export const SLICE_FIELD_NO_DIRECTION = -128;
/** infillPattern of a voxel with no sparse infill. */
export const SLICE_FIELD_NO_PATTERN = 0;

export type SliceFieldArrayType = 'u8' | 'i8' | 'u16' | 'f32';

/** The per-voxel arrays, in file order. */
export const SLICE_FIELD_ARRAYS = {
  /** Volume fraction of perimeters (walls, overhang walls, gap fill), 0-255 for 0-1. */
  wallFraction: 'u8',
  /** Volume fraction of solid infill (internal solid, top, bottom, bridges), 0-255 for 0-1. */
  skinFraction: 'u8',
  /** Volume fraction of the sparse-infill region, 0-255 for 0-1. */
  infillFraction: 'u8',
  /** The sparse infill's density in that region, %. 0 where infillFraction is 0. */
  infillDensity: 'u8',
  /** Id in header.infillPatterns of the sparse infill there; 0 (none) where infillFraction is 0. */
  infillPattern: 'u8',
  /** Dominant raster direction in XY, degrees from +X ÷ 2, in [-45, 44] (lines: 0° ≡ 180°); -128 none. */
  rasterDirection: 'i8',
  /** The layer the voxel's centre is printed in; 65535 where the voxel has no material. */
  layerIndex: 'u16',
  /** Optional: mean time the material was laid, seconds from the print's start (volume-weighted); NaN none. */
  depositionTime: 'f32',
} as const satisfies Record<string, SliceFieldArrayType>;

export type SliceFieldArrayName = keyof typeof SLICE_FIELD_ARRAYS;

export interface SliceFieldArrayInfo {
  type: SliceFieldArrayType;
  /** Byte offset from the start of the file; a multiple of 8. */
  offset: number;
  /** Values: dims[0] * dims[1] * dims[2]. */
  length: number;
}

export interface SliceFieldPattern {
  id: number;
  /** Orca's sparse_infill_pattern value ('gyroid', 'grid', …); 'none' for id 0. */
  name: string;
}

export interface SliceFieldObject {
  name: string;
  wallLoops: number;
  infillDensity: number;
  infillPattern: number;
}

/**
 * Which way gravity points during the print, relative to the build direction (the way layers stack). A normal
 * printer: against it. The Muon3D M1 prints upside down, the part hanging from the plate: along it.
 */
export type SliceFieldGravity = 'along_build' | 'against_build';

/**
 * The printer's gravity, from its machine preset's `printer_notes`: a line `gravity = along_build` or
 * `gravity = against_build` (docs/PROFILES.md). null when the preset does not say: never assumed either way.
 */
export function printerGravity(printerNotes: string | readonly string[] | undefined): SliceFieldGravity | null {
  const notes = Array.isArray(printerNotes) ? printerNotes.join('\n') : (printerNotes ?? '');
  const found = [...String(notes).replace(/\\n/g, '\n').matchAll(/^[ \t]*gravity[ \t]*[=:][ \t]*(\S+)[ \t]*$/gim)].map((m) => m[1]!.toLowerCase());
  const values = new Set(found);
  if (values.size !== 1) return null;
  const [value] = values;
  return value === 'along_build' || value === 'against_build' ? value : null;
}

export interface SliceFieldHeader {
  format: typeof SLICE_FIELD_FORMAT;
  version: number;
  units: 'mm';
  /** Bed coordinates of the grid's minimum corner (the corner of voxel [0, 0, 0]). */
  origin: [number, number, number];
  /** Edge of a (cubic) voxel, mm: 1 by default, 0.5 optional. */
  voxelSize: number;
  /** Voxels along x, y, z. Voxel [i, j, k] is value i + dims[0] * (j + dims[1] * k): x fastest. */
  dims: [number, number, number];
  /** The direction layers stack in, a unit vector in the grid's frame. */
  buildDirection: [number, number, number];
  /** Gravity during the print, relative to buildDirection, from the printer profile; null when it does not say. */
  gravity: SliceFieldGravity | null;
  material: { type: string; name: string | null; vendor: string | null };
  /** The process's layer height and first layer height, mm. */
  layerHeight: number;
  firstLayerHeight: number;
  layerCount: number;
  /** Top of each layer, mm from the bed: layer n spans (layerZ[n - 1], layerZ[n]] (layer 0 from 0). */
  layerZ: number[];
  infillPatterns: SliceFieldPattern[];
  objects: SliceFieldObject[];
  /** Where each array is in the file. depositionTime may be absent. */
  arrays: Partial<Record<SliceFieldArrayName, SliceFieldArrayInfo>>;
  /** Who wrote it, e.g. "Muon3D Slicer Engine 0.3.1". */
  generator?: string;
}

export interface SliceFieldArrays {
  wallFraction: Uint8Array;
  skinFraction: Uint8Array;
  infillFraction: Uint8Array;
  infillDensity: Uint8Array;
  infillPattern: Uint8Array;
  rasterDirection: Int8Array;
  layerIndex: Uint16Array;
  depositionTime?: Float32Array;
}

export interface SliceField extends SliceFieldArrays {
  header: SliceFieldHeader;
}

/** A header before encodeSliceField adds the array table. */
export type SliceFieldDescription = Omit<SliceFieldHeader, 'arrays' | 'format' | 'version' | 'units'>;

const BYTES: Record<SliceFieldArrayType, number> = { u8: 1, i8: 1, u16: 2, f32: 4 };
const align8 = (n: number): number => (n + 7) & ~7;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The voxel count of a header's grid. */
export const sliceFieldVoxels = (h: Pick<SliceFieldHeader, 'dims'>): number => h.dims[0] * h.dims[1] * h.dims[2];

/** The index of voxel [i, j, k] in each array. */
export const sliceFieldIndex = (h: Pick<SliceFieldHeader, 'dims'>, i: number, j: number, k: number): number => i + h.dims[0] * (j + h.dims[1] * k);

/** Writes the file: magic, u32 LE header length, u32 0, the header's JSON (space-padded to 8 bytes), the arrays. */
export function encodeSliceField(description: SliceFieldDescription, arrays: SliceFieldArrays): Uint8Array {
  const length = sliceFieldVoxels(description);
  const names = (Object.keys(SLICE_FIELD_ARRAYS) as SliceFieldArrayName[]).filter((n) => arrays[n] !== undefined);
  for (const name of names) {
    if (arrays[name]!.length !== length) throw new RangeError(`slice field: ${name} has ${arrays[name]!.length} values, the grid ${length}`);
  }
  const header: SliceFieldHeader = { format: SLICE_FIELD_FORMAT, version: SLICE_FIELD_VERSION, units: 'mm', ...description, arrays: {} };
  // The offsets depend on the header's length, which depends on the offsets' digits: lay out until stable.
  let json = '';
  for (let headerBytes = 0, pass = 0; ; pass++) {
    let offset = 16 + headerBytes;
    header.arrays = {};
    for (const name of names) {
      header.arrays[name] = { type: SLICE_FIELD_ARRAYS[name], offset, length };
      offset = align8(offset + length * BYTES[SLICE_FIELD_ARRAYS[name]]);
    }
    json = JSON.stringify(header);
    const bytes = align8(new TextEncoder().encode(json).length);
    if (bytes === headerBytes) break;
    if (pass > 8) throw new Error('slice field: header layout did not settle');
    headerBytes = bytes;
  }
  const head = new TextEncoder().encode(json);
  const headerBytes = align8(head.length);
  const last = names.at(-1);
  const total = last === undefined ? 16 + headerBytes : align8(header.arrays[last]!.offset + length * BYTES[SLICE_FIELD_ARRAYS[last]]);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = SLICE_FIELD_MAGIC.charCodeAt(i);
  view.setUint32(8, headerBytes, true);
  view.setUint32(12, 0, true);
  out.set(head, 16);
  out.fill(0x20, 16 + head.length, 16 + headerBytes);
  for (const name of names) {
    const info = header.arrays[name]!;
    const values = arrays[name]!;
    if (LITTLE_ENDIAN || BYTES[info.type] === 1) {
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), info.offset);
    } else if (info.type === 'u16') {
      for (let i = 0; i < length; i++) view.setUint16(info.offset + 2 * i, values[i], true);
    } else {
      for (let i = 0; i < length; i++) view.setFloat32(info.offset + 4 * i, values[i], true);
    }
  }
  return out;
}

/** True when the bytes start like a slice field. */
export function isSliceField(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SLICE_FIELD_MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Reads just the header. */
export function readSliceFieldHeader(bytes: Uint8Array): SliceFieldHeader {
  if (!isSliceField(bytes)) throw new Error('not a slice field (bad magic)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = view.getUint32(8, true);
  if (16 + headerBytes > bytes.length) throw new Error('slice field: truncated header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headerBytes))) as SliceFieldHeader;
  if (header.format !== SLICE_FIELD_FORMAT) throw new Error(`slice field: unknown format ${String(header.format)}`);
  if (header.version !== SLICE_FIELD_VERSION) throw new Error(`slice field: version ${header.version}, this reader reads ${SLICE_FIELD_VERSION}`);
  if (header.units !== 'mm') throw new Error(`slice field: units ${String(header.units)}`);
  if (header.gravity !== null && header.gravity !== 'along_build' && header.gravity !== 'against_build') {
    throw new Error(`slice field: gravity ${String(header.gravity)}`);
  }
  if (!Array.isArray(header.dims) || header.dims.length !== 3 || !header.dims.every((d) => Number.isInteger(d) && d >= 0)) {
    throw new Error('slice field: bad dims');
  }
  return header;
}

/**
 * Reads a slice field. The arrays are views of `bytes` where alignment allows (copies otherwise), so keep
 * `bytes` unchanged while they are in use. An array the file lacks is undefined (only depositionTime may be).
 */
export function decodeSliceField(bytes: Uint8Array): SliceField {
  const header = readSliceFieldHeader(bytes);
  const length = sliceFieldVoxels(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart = 16 + view.getUint32(8, true);
  const ranges: Array<{ name: SliceFieldArrayName; start: number; end: number }> = [];
  const read = (name: SliceFieldArrayName): Uint8Array | Int8Array | Uint16Array | Float32Array | undefined => {
    const info = header.arrays[name];
    if (info === undefined) return undefined;
    const type = SLICE_FIELD_ARRAYS[name];
    if (info.type !== type) throw new Error(`slice field: ${name} is ${info.type}, expected ${type}`);
    if (info.length !== length) throw new Error(`slice field: ${name} has ${info.length} values, the grid ${length}`);
    const size = BYTES[type];
    if (!Number.isSafeInteger(info.offset) || info.offset % 8 !== 0) throw new Error(`slice field: ${name} has an invalid offset (8-byte alignment required)`);
    const end = info.offset + length * size;
    if (info.offset < dataStart || end > bytes.length) throw new Error(`slice field: ${name} is outside the file data`);
    for (const range of ranges) {
      if (info.offset < range.end && end > range.start) throw new Error(`slice field: ${name} overlaps ${range.name}`);
    }
    ranges.push({ name, start: info.offset, end });
    const at = bytes.byteOffset + info.offset;
    if (type === 'u8') return new Uint8Array(bytes.buffer, at, length);
    if (type === 'i8') return new Int8Array(bytes.buffer, at, length);
    if (LITTLE_ENDIAN && at % size === 0) return type === 'u16' ? new Uint16Array(bytes.buffer, at, length) : new Float32Array(bytes.buffer, at, length);
    if (type === 'u16') {
      const out = new Uint16Array(length);
      for (let i = 0; i < length; i++) out[i] = view.getUint16(info.offset + 2 * i, true);
      return out;
    }
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = view.getFloat32(info.offset + 4 * i, true);
    return out;
  };
  const required = (name: SliceFieldArrayName) => {
    const values = read(name);
    if (values === undefined) throw new Error(`slice field: no ${name}`);
    return values;
  };
  const field: SliceField = {
    header,
    wallFraction: required('wallFraction') as Uint8Array,
    skinFraction: required('skinFraction') as Uint8Array,
    infillFraction: required('infillFraction') as Uint8Array,
    infillDensity: required('infillDensity') as Uint8Array,
    infillPattern: required('infillPattern') as Uint8Array,
    rasterDirection: required('rasterDirection') as Int8Array,
    layerIndex: required('layerIndex') as Uint16Array,
  };
  const time = read('depositionTime');
  if (time !== undefined) field.depositionTime = time as Float32Array;
  return field;
}
