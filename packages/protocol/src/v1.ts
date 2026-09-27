// SPDX-License-Identifier: Apache-2.0
// Protocol v1 of the Muon3D Slicer Engine: the messages between a page and the engine's Web Worker
// host (host/src/worker.ts, which runs OrcaSlicer's libslic3r compiled to WebAssembly), the job and
// result types, and the manifest the build publishes. Type-only module. Change it only additively:
// the C++ bridge, the host and every client build against it.
//
// Coordinates are Orca bed coordinates (mm, +Z up): origin at the printable area's front-left.

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** One preset value in Orca's JSON encoding: a string, or an array of strings for a vector option. */
export type ConfigValue = string | string[];
/** A fully resolved (inheritance-flattened) Orca preset: option key -> value. */
export type FlatConfig = Record<string, ConfigValue>;

export type Vec3 = [number, number, number];

/** Print statistics, as Orca writes them into the G-code header and footer. */
export interface GcodeStats {
  /** Estimated print time in seconds (normal mode). */
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

// ---------------------------------------------------------------------------
// Toolpaths
// ---------------------------------------------------------------------------

export interface SegmentSet {
  /** Segment endpoints, 6 floats each (x0, y0, z0, x1, y1, z1) in mm, in file (= layer) order. */
  positions: Float32Array;
  /** Index of each layer's first segment; `layerCount + 1` entries, the last is `count`. */
  layerStart: Uint32Array;
  count: number;
}

export interface ExtrusionSet extends SegmentSet {
  /** Per segment: index into `Toolpaths.roles`. */
  roleIndex: Uint8Array;
  /**
   * Per segment: line width as a size code (0.01 mm steps up to 2 mm = code 200, then 0.05 mm steps
   * up to 4.75 mm = code 255; so 42 = 0.42 mm). 0 means unknown (use `Toolpaths.lineWidth` then).
   */
  width: Uint8Array;
  /**
   * Per segment: bead height as a size code, as Orca's GCodeProcessor sees it: usually the layer
   * thickness, more for bridges and overhang walls. The segment's Z is the top of the bead. 0 means
   * unknown.
   */
  height: Uint8Array;
}

/** Toolpaths for a preview, built from Orca's GCodeProcessor result. */
export interface Toolpaths {
  layerCount: number;
  /** Print height of each layer in mm. */
  layerZ: Float32Array;
  extrusions: ExtrusionSet;
  travels: SegmentSet;
  /** Feature roles in first-seen order, as named after ';TYPE:' (e.g. "Outer wall"). */
  roles: string[];
  /** Toolpath length in mm extruded for each role, parallel to `roles`. */
  roleLength: number[];
  /** The line width (mm) most of the toolpath length is printed at; null when unknown. */
  lineWidth: number | null;
  /** Box around every extrusion, or null when nothing is extruded. */
  bounds: { min: Vec3; max: Vec3 } | null;
}

/** The name the first clients used for Toolpaths (the shape of their G-code parser's output). */
export type ParsedGcode = Toolpaths;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** One plate object, already placed: its mesh is in bed coordinates, resting on z = 0. */
export interface EngineObject {
  /**
   * Object name as Orca writes it in the G-code (EXCLUDE_OBJECT_DEFINE NAME=…). Orca's CLI uses the
   * STL file name, e.g. "Benchy.stl"; keep the same convention for parity with it.
   */
  name: string;
  /** Triangle soup: 9 floats (3 vertices × xyz) per triangle. */
  positions: Float32Array;
  /**
   * Per-object settings: Orca option name (a per-object key: objectKeys or regionKeys of
   * configDefinitions()) → value text, applied to the ModelObject's config as Orca's 3MF loader does
   * (config.set_deserialize). An unknown key or a bad value fails the job with code -5, naming the
   * object. Absent or {} = none.
   */
  config?: Record<string, string>;
}

export interface SliceJob {
  /**
   * Fully resolved presets (inheritance flattened, overrides applied) exactly as Orca's CLI takes
   * them with --load-settings / --load-filaments: `from: "system"`, a `type`, no `inherits`.
   */
  machine: FlatConfig;
  process: FlatConfig;
  /** One per filament slot; the Muon3D M1 uses one. */
  filaments: FlatConfig[];
  objects: EngineObject[];
  /** Return the toolpaths (for the preview) along with the G-code. Default true. */
  toolpaths?: boolean;
  /**
   * Return `toolpathExtras` along with the toolpaths. Default true. A caller that has no use for
   * them turns them off: about 15 bytes per extrusion segment it need not carry.
   */
  toolpathExtras?: boolean;
}

/** A placement check: Orca's own pre-slice object checks, without slicing. */
export interface CheckJob {
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];
  objects: EngineObject[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface EngineError {
  /**
   * Orca CLI exit codes (src/libslic3r/Utils.hpp), so a client can explain them as it would
   * for a CLI run: -5 bad preset, -17 incompatible process, -18 invalid values, -50 nothing
   * inside the plate, -51 validation error, -52 partly outside, -63/-64 collisions (incl.
   * exclusion volumes), -100 slicing error, -102 unprintable area.
   * Engine-level codes: 1 = internal error / abort, 2 = out of memory, 3 = cancelled.
   */
  code: number;
  /** Orca's own message (untranslated English). */
  message: string;
  /** Objects the error concerns, when Orca names them. */
  objects?: string[];
  /** The browser's own error text, when `message` explains an engine-level failure in words. */
  detail?: string;
}

export interface EngineWarning {
  /** Stable class, e.g. Orca's warning step name, or 'exclusion_volume_path'. */
  kind: string;
  message: string;
  objects?: string[];
}

/** Extra per-extrusion-segment data from Orca's GCodeProcessor, parallel to `extrusions`. */
export interface ToolpathExtras {
  /** mm/s. */
  feedrate: Float32Array;
  /** 0–100 %. */
  fanSpeed: Uint8Array;
  /** Nozzle temperature, °C. */
  temperature: Uint16Array;
  /** Seconds from print start at the end of the segment (normal mode). */
  time: Float32Array;
  /** Layer height (mm) of each segment. */
  height: Float32Array;
}

export interface SliceOutput {
  /** The G-code, as Orca writes it. */
  gcode: Uint8Array;
  stats: GcodeStats;
  /**
   * Toolpaths for a preview, so it can show them without re-reading the G-code. Null when not
   * requested.
   */
  toolpaths: Toolpaths | null;
  toolpathExtras: ToolpathExtras | null;
  warnings: EngineWarning[];
  /** Wall-clock milliseconds per stage, for diagnostics. */
  timings: { load: number; slice: number; export: number; total: number };
}

export interface CheckOutput {
  objects: Array<{
    name: string;
    /** Fully inside the printable volume (Orca's PartPlate::check_outside semantics). */
    inside: boolean;
    /** Exclusion volumes the object intersects, with the intersecting surface (bed coords, triangle soup) for drawing. */
    exclusionHits: Array<{ extruder: number; regionIndex: number; triangles: Float32Array }>;
  }>;
}

// ---------------------------------------------------------------------------
// Worker messages (host/src/worker.ts)
// ---------------------------------------------------------------------------

export type EngineVariant = 'st' | 'mt';

export type EngineRequest =
  | {
      type: 'init';
      /** URL of the folder holding engine-*.mjs/.wasm, ending in '/'. */
      baseUrl: string;
      variant: EngineVariant;
      threads?: number;
      /** Size of the uncompressed .wasm (the manifest's wasmBytes), for download progress. */
      wasmBytes?: number;
    }
  | { type: 'slice'; id: string; job: SliceJob }
  | { type: 'check'; id: string; job: CheckJob };

// `heapBytes` on job results: the size of the engine's wasm memory after the job. Wasm memory
// never shrinks, so the client replaces a worker whose heap has grown large. Absent when unknown.
export type EngineResponse =
  /**
   * The engine is loaded. `canary`: a string unique to the engine host, which it reports so a client
   * can check that it runs the host from its own URL (a client's own bundle must never contain it).
   */
  | { type: 'ready'; variant: EngineVariant; orcaVersion: string; orcaCommit: string; initMs: number; canary?: string }
  /**
   * Download progress of the .wasm while the engine starts: bytes of the uncompressed file, total 0
   * when unknown. `done` on the last one, once the whole file has arrived (it then compiles and starts).
   */
  | { type: 'loading'; loadedBytes: number; totalBytes: number; done?: boolean }
  | { type: 'progress'; id: string; percent: number; message: string }
  | { type: 'warning'; id: string; warning: EngineWarning }
  | { type: 'sliced'; id: string; output: SliceOutput; heapBytes?: number }
  | { type: 'checked'; id: string; output: CheckOutput; heapBytes?: number }
  | { type: 'failed'; id: string; error: EngineError; heapBytes?: number }
  /**
   * The engine could not start (download, compile or out of memory); the worker is unusable.
   * `message` says why in a sentence; `code` is 2 when memory ran out (default 1); `detail` is
   * the browser's own error text.
   */
  | { type: 'fatal'; message: string; code?: number; detail?: string };

/** What the build publishes next to the engine files (dist/manifest.json). */
export interface EngineManifest {
  orcaVersion: string;
  orcaCommit: string;
  builtAt: string;
  /** The worker host to start: new Worker(<folder of manifest.json> + host.file, { type: 'module' }). */
  host?: EngineManifestHost;
  /**
   * `mjs` and `wasm` are relative to manifest.json and may sit in a folder of their own (e.g. one
   * named after a content hash, cached for good). The engine loads engine-<variant>.mjs and
   * engine-<variant>.wasm from the folder of `mjs`: those names are built into the .mjs, which
   * also starts its pthread workers from its own URL. `wasmBytes` is the uncompressed size;
   * `wasmTransferBytes`, when present, what a server sends a browser that accepts brotli (the .br).
   */
  variants: Partial<Record<EngineVariant, EngineManifestVariant>>;
  // The fields below are written by the release tooling (tools/release/assemble.mjs) into the runtime of a
  // release or prerelease; a local `npm run build` has only the ones above.
  /** Format of this manifest: 2 once the release fields below are present. */
  manifest?: 2;
  name?: 'muon3d-slicer-engine';
  /** This release's version (semver), e.g. "0.1.0", or "0.1.0-edge.<commit>" for the rolling prerelease. */
  version?: string;
  /** The protocol the host speaks. */
  protocol?: { major: number; minor: number };
  license?: 'AGPL-3.0-only';
  orca?: EngineManifestOrca;
  build?: { engineCommit: string; emsdk: string; builtAt: string };
  source?: EngineManifestSource;
  /** Every other file of the runtime, with its sha256 (hex) and size. */
  files?: Record<string, { sha256: string; bytes: number }>;
}

export interface EngineManifestOrca {
  version: string;
  commit: string;
  /** The tag on `repository` naming `commit`, which keeps its source reachable. */
  tag: string;
  repository: string;
  /** The upstream OrcaSlicer commit the fork's branch is based on. */
  base?: { repository: string; ref: string; commit: string };
}

/** Where this build's Corresponding Source is (SOURCE.md next to the manifest says the same in words). */
export interface EngineManifestSource {
  /** This repository. */
  url: string;
  /** Its release tag, when this is a release. */
  tag?: string;
  /** Its commit the build was made from. */
  commit: string;
  /** Release assets: this repository at `tag`, the Orca tree at `orca.commit`, and every third-party source archive. */
  bundle?: EngineManifestSourceFile;
  orca?: EngineManifestSourceFile;
  thirdParty?: EngineManifestSourceFile;
}

export interface EngineManifestSourceFile {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface EngineManifestVariant {
  mjs: string;
  wasm: string;
  wasmBytes: number;
  wasmTransferBytes?: number;
  /** sha256 (hex) of the two files as published, to check a rebuild or a deployed copy against them. */
  sha256?: { mjs: string; wasm: string };
  /**
   * The commit of this repository the build ran from (the bridge and build recipe in engine/), with
   * "-dirty" when engine/ had uncommitted changes. The Orca source is `orcaCommit`.
   */
  engineCommit?: string;
}

export interface EngineManifestHost {
  /** File name, relative to manifest.json: host.<content hash>.js, an ES module worker script. */
  file: string;
  /** sha256 (hex) of the file. */
  sha256: string;
  /** The protocol major version the host speaks. */
  protocol: 1;
  /** The string the host reports in `ready` (see there). */
  canary: string;
  /** The commit of this repository the host was built from ("-dirty" with uncommitted changes in host/). */
  engineCommit?: string;
}

// ---------------------------------------------------------------------------
// Client API: what a client wrapping the worker offers its app (the first client's shape; optional)
// ---------------------------------------------------------------------------

export type EngineStatus =
  | { state: 'unavailable'; reason: string }
  /**
   * Not running. `loadedBefore`: it ran in this page and was stopped (unused for a while, a
   * cancelled slice, a crash), so starting it again needs no download.
   */
  | { state: 'idle'; loadedBefore?: boolean }
  /** Starting; `loadedBytes`/`totalBytes` is the download so far (total 0 when unknown), once it has begun. */
  | { state: 'loading'; variant: EngineVariant; loadedBytes?: number; totalBytes?: number }
  | { state: 'ready'; variant: EngineVariant; orcaVersion: string }
  /** It could not start: `message` says why in a sentence, `detail` is the browser's own error text. */
  | { state: 'failed'; message: string; detail?: string };

export interface SliceHandle {
  /** Resolves with the output; rejects with an EngineError (code 3 when cancelled). */
  result: Promise<SliceOutput>;
  cancel(): void;
}

export interface EngineClient {
  status(): EngineStatus;
  subscribe(listener: (status: EngineStatus) => void): () => void;
  /** Starts downloading/compiling the engine (idempotent). Resolves when ready. */
  warmUp(): Promise<void>;
  slice(job: SliceJob, onProgress?: (percent: number, message: string) => void, onWarning?: (w: EngineWarning) => void): SliceHandle;
  check(job: CheckJob): Promise<CheckOutput>;
}
