// SPDX-License-Identifier: Apache-2.0
// The operations of protocol v2 (2.1): their params and results, and the capability names a host lists in
// `hello`. docs/PROTOCOL.md describes each.
import type { SettingsCatalogue } from './catalogue.ts';
import type { ConfigPatch, ConfigSet, Mesh, Vec3 } from './data.ts';
import type { ConfigDefinitions } from './definitions.ts';
import type { EngineWarning, HostState, Variant } from './envelope.ts';
import type {
  ProfilesNormalizeParams,
  ProfilesNormalizeResult,
  ProfilesResolveParams,
  ProfilesResolveResult,
  ProfilesValidateParams,
  ProfilesValidateResult,
} from './profiles.ts';
import type { SettingsEditParams, SettingsEditResult, SettingsView, SettingsViewParams } from './settings.ts';

// ---------------------------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------------------------

export interface HelloParams {
  /** The protocol the client speaks: its major, and the lowest minor it needs (default 0). */
  protocol: { major: number; minMinor?: number };
  client: { name: string; version: string };
}

export interface HelloResult {
  protocol: { major: number; minor: number };
  engine: EngineInfo;
  /** Every op this host serves, and the sub-features it has (CAPABILITIES). Unknown strings: ignore. */
  capabilities: string[];
  /** The variants that can run here: 'mt' only where threads can (a cross-origin isolated page, Node) and it is built. */
  variants: Variant[];
  limits: {
    /** Threads 'mt' would use. */
    maxThreads: number;
    /** The engine's heap can grow to this. */
    maxHeapBytes: number;
  };
  /** The data formats this host produces. */
  formats: { definitions: number; catalogue: number; toolpaths: number; settingsView: number };
}

export interface EngineInfo {
  name: string;
  /** This engine release (semver), e.g. "0.2.0". */
  version: string;
  /** The OrcaSlicer it is built from. */
  orca: { version: string; commit: string; repository: string };
  /** SPDX licence of the engine: "AGPL-3.0-only". */
  license: string;
  /** Where this build's Corresponding Source is: this repository at the commit the host was built from. */
  source: string;
  /** URL of the NOTICE served next to the host (for an About -> Licences screen). */
  notice: string;
  /** A string unique to the engine host: a client checks that its own bundle does not contain it. */
  canary: string;
  /** The commit of the engine repository the host was built from. */
  commit: string;
}

export interface LoadParams {
  /** Default 'auto': 'mt' where it can run and is built, else 'st'. */
  variant?: Variant | 'auto';
  /** 'mt': the most threads to use (default: every core). */
  threads?: number;
  /** URL of the folder with engine-<variant>.mjs/.wasm; default the host's own folder. */
  base?: string;
}

export interface LoadResult {
  variant: Variant;
  initMs: number;
}

export interface CancelParams {
  /** The id of the request to cancel. */
  target: number;
}

export interface CancelResult {
  /**
   * true: the request is cancelled (it ends with error Cancelled). false: it is running and cannot be
   * stopped (without 'cancel.cooperative'), or it has already finished; to stop a running slice,
   * end the host (terminate the worker).
   */
  accepted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------------------------

export interface PlateObject {
  /** The name Orca writes in the G-code (EXCLUDE_OBJECT_DEFINE NAME=...), e.g. "Benchy.stl". */
  name: string;
  /** In bed coordinates, resting on z = 0 (the client applies the placement). */
  mesh: Mesh;
  /**
   * The object's own settings (a per-object key of config.definitions: objectKeys or regionKeys), applied
   * as Orca's 3MF loader does. An unknown key or a bad value fails the job with -5, naming the object.
   */
  config?: ConfigPatch;
}

export interface SliceParams {
  configs: ConfigSet;
  objects: PlateObject[];
  output?: {
    /** Return toolpaths for a preview. Default true. */
    toolpaths?: boolean;
    /** Return toolpathExtras with the toolpaths. Default true. */
    toolpathExtras?: boolean;
    /**
     * Return Orca's log of the slice down to this level ('slice.log'; 2.1): `SliceResult.log`, or `EngineError.log`
     * when the slice fails. Default: none.
     */
    log?: LogLevel;
  };
}

/** Orca's log levels, most severe first. */
export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'trace';

export interface SliceResult {
  /** The G-code, as Orca writes it. */
  gcode: Uint8Array;
  stats: GcodeStats;
  toolpaths: Toolpaths | null;
  toolpathExtras: ToolpathExtras | null;
  warnings: EngineWarning[];
  /** Wall-clock milliseconds per stage. */
  timings: { load: number; slice: number; export: number; total: number };
  /** With output.log: Orca's log of the slice, a line each ("<level>: <message>"). */
  log?: string;
  /** The engine's heap after the job (it only grows). */
  heapBytes?: number;
}

/** Print statistics, as Orca writes them into the G-code. */
export interface GcodeStats {
  printTimeSeconds: number | null;
  /** Orca's own formatting, e.g. "44m 38s". */
  printTimeText: string | null;
  firstLayerTimeText: string | null;
  filamentMm: number | null;
  filamentCm3: number | null;
  filamentG: number | null;
  filamentCost: number | null;
  layers: number | null;
  maxZ: number | null;
}

export interface SegmentSet {
  /** Segment end points, 6 floats each (x0 y0 z0 x1 y1 z1) in mm, in layer order. */
  positions: Float32Array;
  /** Index of each layer's first segment; layerCount + 1 entries, the last is `count`. */
  layerStart: Uint32Array;
  count: number;
}

export interface ExtrusionSet extends SegmentSet {
  /** Per segment: index into Toolpaths.roles. */
  roleIndex: Uint8Array;
  /** Per segment: line width as a size code (0.01 mm steps to 2 mm = 200, then 0.05 mm steps to 4.75 mm = 255); 0 unknown. */
  width: Uint8Array;
  /** Per segment: bead height as a size code (as `width`); the segment's z is the top of the bead; 0 unknown. */
  height: Uint8Array;
}

/** Neutral preview data, format 1 (capability 'toolpaths.v1'): a G-code parser can produce the same from any slicer's file. */
export interface Toolpaths {
  format: 1;
  layerCount: number;
  /** Print height of each layer, mm. */
  layerZ: Float32Array;
  extrusions: ExtrusionSet;
  travels: SegmentSet;
  /** Feature roles in first-seen order, as named after ';TYPE:' ("Outer wall"), with the length extruded for each. */
  roles: Array<{ name: string; lengthMm: number }>;
  /** The line width (mm) most of the toolpath length is printed at. */
  lineWidth: number | null;
  /** Box around every extrusion; null when nothing is extruded. */
  bounds: { min: Vec3; max: Vec3 } | null;
}

/** Per extrusion segment, parallel to Toolpaths.extrusions (capability 'slice.toolpathExtras'). */
export interface ToolpathExtras {
  /** mm/s. */
  feedrate: Float32Array;
  /** 0-100 %. */
  fanSpeed: Uint8Array;
  /** Nozzle temperature, degrees C. */
  temperature: Uint16Array;
  /** Seconds from the start of the print at the end of the segment. */
  time: Float32Array;
  /** Layer height, mm. */
  height: Float32Array;
}

/** Orca's pre-slice placement checks for a plate, without slicing. */
export interface CheckParams {
  configs: ConfigSet;
  objects: Array<{ name: string; mesh: Mesh }>;
}

export interface CheckResult {
  objects: Array<{
    name: string;
    /** Fully inside the printable volume (Orca's check_outside semantics). */
    inside: boolean;
    /** The exclusion volumes it intersects, with the intersecting surface (bed coordinates, a triangle soup). */
    exclusionHits: Array<{ extruder: number; region: number; triangles: Float32Array }>;
  }>;
  heapBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

interface Op<P, R> {
  params: P;
  result: R;
}

type NoParams = Record<string, never>;

export interface Ops {
  hello: Op<HelloParams, HelloResult>;
  load: Op<LoadParams, LoadResult>;
  status: Op<NoParams, HostState>;
  cancel: Op<CancelParams, CancelResult>;
  slice: Op<SliceParams, SliceResult>;
  check: Op<CheckParams, CheckResult>;
  'config.definitions': Op<NoParams, ConfigDefinitions>;
  'settings.catalogue': Op<{ locale?: string }, SettingsCatalogue>;
  'settings.view': Op<SettingsViewParams, SettingsView>;
  'settings.edit': Op<SettingsEditParams, SettingsEditResult>;
  'profiles.normalize': Op<ProfilesNormalizeParams, ProfilesNormalizeResult>;
  'profiles.resolve': Op<ProfilesResolveParams, ProfilesResolveResult>;
  'profiles.validate': Op<ProfilesValidateParams, ProfilesValidateResult>;
}

export type OpName = keyof Ops;
export type OpParams<K extends OpName> = Ops[K]['params'];
export type OpResult<K extends OpName> = Ops[K]['result'];

/** The ops of protocol 2.0, in the order docs/PROTOCOL.md lists them. */
export const OPS_2_0: readonly OpName[] = [
  'hello', 'load', 'status', 'cancel', 'slice', 'check', 'config.definitions', 'settings.catalogue', 'settings.view', 'settings.edit',
];

/** The ops protocol 2.1 adds: a host that serves one lists it in `hello.capabilities`. */
export const PROFILE_OPS: readonly OpName[] = ['profiles.normalize', 'profiles.resolve', 'profiles.validate'];

/** Every op of protocol 2.1, in the order docs/PROTOCOL.md lists them. */
export const OPS: readonly OpName[] = [...OPS_2_0, ...PROFILE_OPS];

/** Ops that need the engine (wasm): the host loads it on the first of them ('auto' variant). */
export const ENGINE_OPS: readonly OpName[] = ['load', 'slice', 'check', 'config.definitions', ...PROFILE_OPS];

/**
 * Capability names besides the op names. A client checks one before sending a request or a field that
 * needs it; strings it does not know it ignores.
 */
export const Capability = {
  /** Toolpaths format 1 in slice results. */
  toolpathsV1: 'toolpaths.v1',
  /** SliceParams.output.toolpathExtras and SliceResult.toolpathExtras. */
  toolpathExtras: 'slice.toolpathExtras',
  /** Mesh.indices (indexed meshes) in slice and check. */
  indexedMeshes: 'mesh.indexed',
  /** A running request can be cancelled and the engine stays loaded (without it: only queued requests). */
  cooperativeCancel: 'cancel.cooperative',
  /** settings.view format 1. */
  settingsViewV1: 'settings.view.v1',
  /** SliceParams.output.log, SliceResult.log and EngineError.log (2.1). */
  sliceLog: 'slice.log',
} as const;

