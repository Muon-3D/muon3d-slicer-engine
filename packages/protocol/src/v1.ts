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
  | { type: 'init'; /** URL of the folder holding engine-*.mjs/.wasm, ending in '/'. */ baseUrl: string; variant: EngineVariant; threads?: number }
  | { type: 'slice'; id: string; job: SliceJob }
  | { type: 'check'; id: string; job: CheckJob };

export type EngineResponse =
  | { type: 'ready'; variant: EngineVariant; orcaVersion: string; orcaCommit: string; initMs: number }
  | { type: 'progress'; id: string; percent: number; message: string }
  | { type: 'warning'; id: string; warning: EngineWarning }
  | { type: 'sliced'; id: string; output: SliceOutput }
  | { type: 'checked'; id: string; output: CheckOutput }
  | { type: 'failed'; id: string; error: EngineError }
  /** The engine could not start (download, compile or out of memory); the worker is unusable. */
  | { type: 'fatal'; message: string };

/** What the build publishes next to the engine files (web/public/engine/manifest.json). */
export interface EngineManifest {
  orcaVersion: string;
  orcaCommit: string;
  builtAt: string;
  variants: Partial<Record<EngineVariant, { mjs: string; wasm: string; wasmBytes: number }>>;
}

// ---------------------------------------------------------------------------
// Client API (web/src/engine/client.ts) — what the store and UI use
// ---------------------------------------------------------------------------

export type EngineStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'idle' }
  | { state: 'loading'; variant: EngineVariant }
  | { state: 'ready'; variant: EngineVariant; orcaVersion: string }
  | { state: 'failed'; message: string };

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
