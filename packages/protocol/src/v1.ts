// Contract between the browser slicing engine (OrcaSlicer's libslic3r compiled to WebAssembly,
// running in a Web Worker: engine/ + web/src/engine/worker.ts) and the rest of the web app.
// Type-only module. Change it only additively: the C++ bridge, the worker and the UI all
// build against it.
//
// Coordinates are Orca bed coordinates (mm, +Z up), exactly as in shared/types.ts.
import type { FlatConfig, GcodeStats } from '../../../shared/types.ts';
import type { ParsedGcode } from '../gcode/parse.ts';

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** One plate object, already placed: its mesh is in bed coordinates, resting on z = 0. */
export interface EngineObject {
  /**
   * Object name as Orca writes it in the G-code (EXCLUDE_OBJECT_DEFINE NAME=…). The server path
   * uses the sanitised STL file name, e.g. "Benchy.stl"; keep the same convention for parity.
   */
  name: string;
  /** Triangle soup: 9 floats (3 vertices × xyz) per triangle. */
  positions: Float32Array;
  /**
   * Per-object settings (PlateObject.settings, keys from shared/objectSettings.ts): Orca option
   * name → value text, applied to the ModelObject's config as Orca's 3MF loader does
   * (config.set_deserialize). An unknown key or a bad value fails the job with code -5, naming the
   * object. Absent or {} = none.
   */
  config?: Record<string, string>;
}

export interface SliceJob {
  /**
   * Fully resolved presets (inheritance flattened, overrides applied) exactly as the server
   * writes cfg/{machine,process,filament}.json for the CLI: `from: "system"`, a `type`, no
   * `inherits`.
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
   * Orca CLI exit codes (src/libslic3r/Utils.hpp), so the UI can explain them the way the
   * server does: -5 bad preset, -17 incompatible process, -18 invalid values, -50 nothing
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
   * Toolpaths for the preview, in the same format the G-code parser (web/src/gcode/parse.ts)
   * produces, so the preview can show them without re-reading the G-code. Null when not
   * requested.
   */
  toolpaths: ParsedGcode | null;
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
// Worker messages (web/src/engine/worker.ts)
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
  | { type: 'ready'; variant: EngineVariant; orcaVersion: string; orcaCommit: string; initMs: number }
  /** Download progress of the .wasm while the engine starts: bytes of the uncompressed file, total 0 when unknown. */
  | { type: 'loading'; loadedBytes: number; totalBytes: number }
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

/** What the build publishes next to the engine files (web/public/engine/manifest.json). */
export interface EngineManifest {
  orcaVersion: string;
  orcaCommit: string;
  builtAt: string;
  /**
   * `mjs` and `wasm` are relative to manifest.json and may sit in a folder of their own (e.g. one
   * named after a content hash, cached for good). The engine loads engine-<variant>.mjs and
   * engine-<variant>.wasm from the folder of `mjs`: those names are built into the .mjs, which
   * also starts its pthread workers from its own URL. `wasmBytes` is the uncompressed size;
   * `wasmTransferBytes`, when present, what the server actually sends (compressed).
   */
  variants: Partial<Record<EngineVariant, EngineManifestVariant>>;
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

// ---------------------------------------------------------------------------
// Client API (web/src/engine/client.ts) — what the store and UI use
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
