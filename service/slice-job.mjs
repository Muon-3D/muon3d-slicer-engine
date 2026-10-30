#!/usr/bin/env node
// The slicer job service: one slice per run, as its own process. A model and the name of a frozen preset go in on
// stdin; the G-code, its stats and the source offer come out on stdout. Callers (the agent-CAD MCP server in
// muon3d-design) start this as a separate program and exchange only these files: they never load the engine.
//
//   node service/slice-job.mjs --runtime <engine runtime folder> < job.json > answer.json
//
// Job:    { "model": { "format": "3mf" | "stl", "data": "<base64>" }, "preset": "muon3d-m1-0.4", "name": "part" }
// Answer: { "ok": true, "stats": {...}, "gcode": "<base64>", "gcodeSha256": "...", "warnings": [...],
//           "engine": {...}, "preset": {...}, "source": {...}, "timings": {...} }
//      or { "ok": false, "error": { "kind": "...", "message": "..." }, "source": {...} }
//
// Presets are frozen: a caller names one of service/presets/*.json (flattened machine, process and filament) and
// cannot change a setting. The model is centred on the bed's printable area and dropped to z = 0, as the CLI example
// does. Licence: AGPL-3.0-only, like the rest of this repository; every answer carries the source offer (§13).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startHost } from '../examples/start-host.mjs';
import { parseStl, placeOnBed } from '../examples/node-cli/stl.mjs';
import { read3mf } from './threemf.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_TRIANGLES = 2_000_000;
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

function sourceOffer(engine) {
  return {
    licence: 'AGPL-3.0-only',
    repository: 'https://github.com/Muon-3D/muon3d-slicer-engine',
    service: { version: pkg.version, commit: process.env.SLICE_JOB_COMMIT ?? null },
    engine: engine ? { name: engine.name, version: engine.version, orca: engine.orca } : null,
    offer: 'The Corresponding Source of this slicer (engine, host and this service) is at the repository above, '
      + 'at the release tag of the engine version named here.',
  };
}

function answer(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(kind, message, engine) {
  answer({ ok: false, error: { kind, message: String(message).slice(0, 2000) }, source: sourceOffer(engine) });
  process.exitCode = 1;
}

function bedCentre(machine) {
  const points = [machine.printable_area].flat().join(',').split(',').map((p) => p.split('x').map(Number));
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function loadPreset(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error('preset must be a preset name');
  const file = path.join(repo, 'service', 'presets', `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = fs.readdirSync(path.join(repo, 'service', 'presets')).map((f) => f.replace(/\.json$/, ''));
    throw new Error(`unknown preset "${name}": use one of ${known.join(', ')}`);
  }
  const presets = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { presets, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

export function modelTriangles(model) {
  if (!model || typeof model.data !== 'string') throw new Error('model.data must be base64');
  const bytes = Buffer.from(model.data, 'base64');
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error(`model larger than ${MAX_MODEL_BYTES} bytes`);
  const format = String(model.format ?? '').toLowerCase();
  const positions = format === 'stl' ? parseStl(bytes) : format === '3mf' ? read3mf(bytes) : null;
  if (!positions) throw new Error('model.format must be 3mf or stl');
  if (positions.length / 9 > MAX_TRIANGLES) throw new Error(`more than ${MAX_TRIANGLES} triangles`);
  if (positions.length === 0 || positions.some((v) => !Number.isFinite(v))) throw new Error('the model has no usable triangles');
  return positions;
}

async function main() {
  const t0 = performance.now();
  const { values: opts } = parseArgs({
    options: {
      runtime: { type: 'string', default: process.env.SLICE_JOB_RUNTIME ?? path.join(repo, 'dist') },
      variant: { type: 'string', default: 'st' },
    },
  });
  let job;
  try {
    job = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    return fail('job', `the job is not JSON: ${e.message}`);
  }
  let preset, positions;
  try {
    preset = loadPreset(job.preset ?? 'muon3d-m1-0.4');
    positions = modelTriangles(job.model);
  } catch (e) {
    return fail('job', e.message);
  }
  const name = String(job.name ?? 'part').replace(/[^\w .-]/g, '_').slice(0, 64) || 'part';
  const host = await startHost(path.resolve(opts.runtime));
  const engine = host.hello.engine;
  try {
    const loaded = await host.connection.request('load', { variant: opts.variant });
    const t1 = performance.now();
    const warnings = [];
    const result = await host.connection.request(
      'slice',
      {
        configs: { machine: preset.presets.machine, process: preset.presets.process, filaments: preset.presets.filaments },
        objects: [{ name: `${name}.stl`, mesh: { positions: placeOnBed(positions, bedCentre(preset.presets.machine)) } }],
        output: { toolpaths: false },
      },
      { onWarning: (w) => warnings.push({ kind: w.kind, message: w.message }) },
    );
    const gcode = Buffer.from(result.gcode);
    answer({
      ok: true,
      stats: result.stats,
      gcode: gcode.toString('base64'),
      gcodeBytes: gcode.byteLength,
      gcodeSha256: crypto.createHash('sha256').update(gcode).digest('hex'),
      warnings: [...warnings, ...(result.warnings ?? []).map((w) => ({ kind: w.kind, message: w.message }))],
      triangles: positions.length / 9,
      engine: { name: engine.name, version: engine.version, orca: engine.orca, variant: loaded.variant },
      preset: { name: job.preset ?? 'muon3d-m1-0.4', sha256: preset.sha256, names: preset.presets.names ?? null },
      source: sourceOffer(engine),
      timings: { loadMs: Math.round(loaded.initMs), sliceMs: Math.round(performance.now() - t1), totalMs: Math.round(performance.now() - t0) },
    });
  } catch (e) {
    fail(e.code < 0 ? 'refused' : 'engine', `${e.message}${e.detail ? ` (${e.detail})` : ''}`, engine);
  } finally {
    host.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
