// Shared set-up for the engine tests (engine.test.ts, settingsOverrides.e2e.test.ts) and the CLI
// comparison (compare.ts): where the built engine is, the flattened presets they slice with, and the
// test plates.
//
// Environment:
//   ENGINE_DIR          folder with engine-<variant>.mjs/.wasm          (default dist/)
//   ENGINE_VARIANT      st | mt                                         (default st)
//   ENGINE_TEST_OUT     where G-code and CLI runs are written           (default test-out/)
//   ENGINE_TEST_BENCHY  an STL of 3DBenchy for the Benchy tests         (default test/fixtures/local/benchy.stl;
//                       skipped without it: 3DBenchy is not redistributed here)
//   ENGINE_TEST_REQUIRE 1: fail instead of skipping when the engine is not built (npm run test:engine)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CheckJob, EngineObject, EngineVariant, FlatConfig, SliceJob } from '../packages/protocol/src/v1.ts';
import { loadEngine, type OrcaEngineModule } from '../host/src/worker.ts';
import { parseStl } from './helpers/stl.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const engineDir = path.resolve(process.env.ENGINE_DIR ?? path.join(repoRoot, 'dist'));
export const variant = (process.env.ENGINE_VARIANT ?? 'st') as EngineVariant;
export const outDir = path.resolve(process.env.ENGINE_TEST_OUT ?? path.join(repoRoot, 'test-out'));

export const engineModulePath = path.join(engineDir, `engine-${variant}.mjs`);
export const engineBuilt = existsSync(engineModulePath);
/** Why the engine suites do not run, or false when they do (npm run test:engine fails them instead). */
export const engineSkip: string | false =
  engineBuilt || process.env.ENGINE_TEST_REQUIRE === '1' ? false : `${engineModulePath} not found: build the engine first (npm run build:engine)`;

export async function startEngine(): Promise<{ engine: OrcaEngineModule; initMs: number }> {
  // The same loader the worker host uses in a browser.
  return loadEngine(pathToFileURL(engineDir + path.sep).href, variant);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface Presets {
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];
}

interface PresetFixture extends Presets {
  names: { vendor: string; machine: string; process: string; filament: string };
}

/**
 * Committed presets (test/fixtures/presets), flattened from the Orca profiles of the pinned commit
 * (orca/resources/profiles) the way Orca's CLI takes them: inheritance resolved, `from: "system"`, a
 * `type`, `instantiation: "true"`, no `inherits`. Regenerate them when the pin moves and a profile the
 * tests use has changed.
 */
function presetFixture(id: string): PresetFixture {
  return JSON.parse(readFileSync(path.join(repoRoot, 'test/fixtures/presets', `${id}.json`), 'utf8')) as PresetFixture;
}

/** Muon3D M1 0.4 nozzle, 0.20mm Standard, Generic PLA: the printer with exclusion volumes. */
export const M1 = 'muon3d-m1-0.4';
/** A Bambu Lab printer: Orca writes a different G-code dialect for those (object label ids, M624). */
export const X1C = 'bbl-x1c-0.4';

export async function flatPresets(id: string): Promise<Presets> {
  const { machine, process, filaments } = presetFixture(id);
  return { machine, process, filaments };
}

export const m1Presets = (): Promise<Presets> => flatPresets(M1);

/** The preset names of a fixture (the CLI comparison pins the process to the printer by name). */
export const presetNames = (id: string) => presetFixture(id).names;

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

/** A closed cylinder on the bed, its side made of `segments` flat facets. */
export function cylinder(center: [number, number], radius: number, height: number, segments = 96): Float32Array {
  const [cx, cy] = center;
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (2 * Math.PI * i) / segments, a1 = (2 * Math.PI * (i + 1)) / segments;
    const x0 = cx + radius * Math.cos(a0), y0 = cy + radius * Math.sin(a0);
    const x1 = cx + radius * Math.cos(a1), y1 = cy + radius * Math.sin(a1);
    out.push(cx, cy, 0, x1, y1, 0, x0, y0, 0); // bottom (-z)
    out.push(cx, cy, height, x0, y0, height, x1, y1, height); // top (+z)
    out.push(x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, 0, x1, y1, height, x0, y0, height); // side
  }
  return new Float32Array(out);
}

let benchyCache: Float32Array | null = null;

/** 3DBenchy, when an STL of it is on this machine (it is not redistributed with the tests). */
export const benchyPath = path.resolve(process.env.ENGINE_TEST_BENCHY ?? path.join(repoRoot, 'test/fixtures/local/benchy.stl'));
export const benchyAvailable = existsSync(benchyPath);

/**
 * 3DBenchy centred on the origin in X and Y, resting on z = 0 (in place, in float32 steps, as an app
 * normalises an upload), then moved to `center`.
 */
export async function benchy(center: [number, number]): Promise<Float32Array> {
  if (!benchyCache) {
    benchyCache = parseStl(readFileSync(benchyPath));
    const { min, max } = bounds(benchyCache);
    const [dx, dy, dz] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
    for (let i = 0; i < benchyCache.length; i += 3) {
      benchyCache[i] -= dx;
      benchyCache[i + 1] -= dy;
      benchyCache[i + 2] -= dz;
    }
  }
  return translate(benchyCache, center[0], center[1]);
}

export function translate(positions: Float32Array, dx: number, dy: number): Float32Array {
  const moved = new Float32Array(positions);
  for (let i = 0; i < moved.length; i += 3) {
    moved[i] += dx;
    moved[i + 1] += dy;
  }
  return moved;
}

/**
 * Two 20 mm cubes: "CubeA.stl" at (60, 60) with `settings` as its own settings, and "CubeB.stl" at
 * (130, 60) with none. The same plate was sliced with Orca's CLI from a 3MF with those object
 * settings; the per-object tests compare against what it printed.
 */
export function objectSettingsPlate(settings: Record<string, string> = { layer_height: '0.1', wall_loops: '5' }): EngineObject[] {
  return [
    { name: 'CubeA.stl', positions: cube([60, 60]), config: settings },
    { name: 'CubeB.stl', positions: cube([130, 60]) },
  ];
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
