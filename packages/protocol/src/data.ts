// SPDX-License-Identifier: Apache-2.0
// Data shapes shared by the operations of protocol v2: configs in OrcaSlicer's preset-file text form,
// meshes as float arrays. Every value a message carries is JSON (objects, arrays, strings, finite
// numbers, booleans, null) or a typed array; nothing else (no Map, Set, Date, class instance,
// undefined in arrays, BigInt or SharedArrayBuffer), so every transport can carry it (docs/PROTOCOL.md,
// "Transports").

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** A config value in Orca's text form, exactly as a preset JSON file stores it: a string, or a string per slot. */
export type ConfigValue = string | string[];

/** A preset or config: Orca option key -> value. The shape of Orca's preset .json files. */
export type Config = Record<string, ConfigValue>;

/** Single values in Orca's serialized text (overrides, an object's or a plate's settings): key -> text. */
export type ConfigPatch = Record<string, string>;

/** The three flattened presets of a job: inheritance resolved, `from: "system"`, a `type`, no `inherits`. */
export interface ConfigSet {
  machine: Config;
  process: Config;
  /** One per filament slot. */
  filaments: Config[];
}

/** The preset a setting is stored in (Orca's preset types). */
export type PresetScope = 'machine' | 'process' | 'filament';

/**
 * A triangle mesh in mm. Without `indices` it is a triangle soup: 9 floats (3 vertices, xyz) per
 * triangle, as in an STL. With `indices`, 3 vertex indices per triangle into `positions` (3 floats a
 * vertex).
 */
export interface Mesh {
  positions: Float32Array;
  indices?: Uint32Array;
}
