// Shared set-up for the engine tests (engine.test.ts) and the CLI comparison (compare.ts): where the
// built engine is, the Muon3D M1 presets flattened from the Orca branch the engine is built from,
// and the test plates.
//
// Environment:
//   ENGINE_DIR      folder with engine-<variant>.mjs/.wasm   (default web/public/engine)
//   ENGINE_VARIANT  st | mt                                  (default st)
//   ORCA_RESOURCES  Orca resources the presets come from     (default ~/OrcaWasm/orca/resources,
//                   the muon3d-wasm branch: M1 collision volumes are in bed_exclude_volumes)
//   ENGINE_TEST_OUT where G-code and CLI runs are written     (default ~/OrcaWasm/test-out)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FlatConfig } from '../../shared/types.ts';
import type { CheckJob, EngineObject, EngineVariant, SliceJob } from '../../web/src/engine/protocol.ts';
import { loadEngine, type OrcaEngineModule } from '../../web/src/engine/worker.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const engineDir = path.resolve(process.env.ENGINE_DIR ?? path.join(repoRoot, 'web/public/engine'));
export const variant = (process.env.ENGINE_VARIANT ?? 'st') as EngineVariant;
export const outDir = path.resolve(process.env.ENGINE_TEST_OUT ?? '~/OrcaWasm/test-out');
// Must be set before server/config.ts is first imported (it reads the environment once).
process.env.ORCA_RESOURCES ??= '~/OrcaWasm/orca/resources';

export const engineModulePath = path.join(engineDir, `engine-${variant}.mjs`);
export const engineBuilt = existsSync(engineModulePath);

export async function startEngine(): Promise<{ engine: OrcaEngineModule; initMs: number }> {
  // The same loader the browser worker uses.
  return loadEngine(pathToFileURL(engineDir + path.sep).href, variant);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const M1 = {
  vendor: 'Muon3D',
  machine: 'Muon3D M1 0.4 nozzle',
  process: '0.20mm Standard @Muon3D M1',
  filament: 'Generic PLA @Muon3D M1',
};

export interface Presets {
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];
}

/** The M1 presets flattened exactly as the server flattens them for the CLI (server/profiles.ts). */
export async function m1Presets(): Promise<Presets> {
  const { resolvePreset } = await import('../../server/profiles.ts');
  const [machine, processPreset, filament] = await Promise.all([
    resolvePreset('machine', { vendor: M1.vendor, name: M1.machine }),
    resolvePreset('process', { vendor: M1.vendor, name: M1.process }),
    resolvePreset('filament', { vendor: M1.vendor, name: M1.filament }),
  ]);
  return { machine, process: processPreset, filaments: [filament] };
}

// ---------------------------------------------------------------------------
// Meshes (bed coordinates, resting on z = 0)
// ---------------------------------------------------------------------------

/** An axis-aligned box centred on (x, y), outward-facing triangles. */
export function box(size: [number, number, number], center: [number, number]): Float32Array {
  const [sx, sy, sz] = size;
  const x0 = center[0] - sx / 2, x1 = center[0] + sx / 2;
  const y0 = center[1] - sy / 2, y1 = center[1] + sy / 2;
  const v = [
    [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
    [x0, y0, sz], [x1, y0, sz], [x1, y1, sz], [x0, y1, sz],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom (-z)
    [4, 5, 6], [4, 6, 7], // top (+z)
    [0, 1, 5], [0, 5, 4], // front (-y)
    [1, 2, 6], [1, 6, 5], // right (+x)
    [2, 3, 7], [2, 7, 6], // back (+y)
    [3, 0, 4], [3, 4, 7], // left (-x)
  ];
  return new Float32Array(faces.flatMap((face) => face.flatMap((i) => v[i])));
}

export const cube = (center: [number, number], size = 20): Float32Array => box([size, size, size], center);

let benchyCache: Float32Array | null = null;

/** 3DBenchy from data/samples, normalised like an upload (centred, on the bed) and moved to `center`. */
export async function benchy(center: [number, number]): Promise<Float32Array> {
  if (!benchyCache) {
    const { parseStl, normalizeInPlace } = await import('../../server/meshio.ts');
    benchyCache = parseStl(readFileSync(path.join(repoRoot, 'data/samples/benchy-raw.stl')));
    normalizeInPlace(benchyCache);
  }
  const placed = new Float32Array(benchyCache);
  for (let i = 0; i < placed.length; i += 3) {
    placed[i] += center[0];
    placed[i + 1] += center[1];
  }
  return placed;
}

export function translate(positions: Float32Array, dx: number, dy: number): Float32Array {
  const moved = new Float32Array(positions);
  for (let i = 0; i < moved.length; i += 3) {
    moved[i] += dx;
    moved[i + 1] += dy;
  }
  return moved;
}

export function sliceJob(presets: Presets, objects: EngineObject[], toolpaths = true): SliceJob {
  return { ...presets, objects, toolpaths };
}

export function checkJob(presets: Presets, objects: EngineObject[]): CheckJob {
  return { ...presets, objects };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export const ms = (value: number) => `${Math.round(value).toLocaleString('en')} ms`;

/** A mesh's bounding box, for reporting. */
export function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}
