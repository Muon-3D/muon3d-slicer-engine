#!/usr/bin/env node
// Slices a model from the command line with the Muon3D Slicer Engine: the built engine and worker
// host in dist/, started in a Node worker thread and driven through the worker protocol (v1), exactly
// as a web page drives them. No web app involved.
//
//   node examples/node-cli/slice.mjs model.stl                      # M1 presets, centre of the bed
//   node examples/node-cli/slice.mjs --cube 20 --at 100,90 -o cube.gcode
//   node examples/node-cli/slice.mjs model.stl --presets my-presets.json --variant mt
//
// Options:
//   --presets <file>   flattened presets: { "machine": {...}, "process": {...}, "filaments": [{...}] }
//                      (default test/fixtures/presets/muon3d-m1-0.4.json)
//   --cube <mm>        slice a cube of that size instead of an STL file
//   --at <x>,<y>       where to centre the model on the bed, in mm (default: the printable area's centre)
//   --name <name>      the object's name in the G-code (default: the STL's file name, or Cube.stl)
//   -o, --out <file>   where to write the G-code (default: the model's name with .gcode, in the current folder)
//   --variant st|mt    engine variant (default st)
//   --dist <folder>    the built engine and host (default dist/ of this repository)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { box, parseStl, placeOnBed } from './stl.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    presets: { type: 'string', default: path.join(repo, 'test/fixtures/presets/muon3d-m1-0.4.json') },
    cube: { type: 'string' },
    at: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string', short: 'o' },
    variant: { type: 'string', default: 'st' },
    dist: { type: 'string', default: path.join(repo, 'dist') },
    help: { type: 'boolean', short: 'h' },
  },
});

function usage(message) {
  if (message) console.error(`slice: ${message}`);
  console.error('usage: node examples/node-cli/slice.mjs <model.stl | --cube <mm>> [--presets <json>] [--at x,y] [--name <name>] [-o <file>] [--variant st|mt] [--dist <folder>]');
  process.exit(message ? 2 : 0);
}
if (opts.help) usage();
if ((positionals.length !== 1) === !opts.cube) usage('give one STL file, or --cube <mm>');
if (opts.variant !== 'st' && opts.variant !== 'mt') usage('--variant must be st or mt');

// ---- The job: presets and one placed object ---------------------------------------------------------
const presets = JSON.parse(fs.readFileSync(opts.presets, 'utf8'));
for (const key of ['machine', 'process', 'filaments']) if (!presets[key]) usage(`${opts.presets} has no "${key}"`);

/** The centre of the machine's printable_area ("0x0,200x0,200x200,0x200"). */
function bedCentre(machine) {
  const area = [machine.printable_area].flat().join(',');
  const points = area.split(',').map((p) => p.split('x').map(Number));
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

const at = opts.at ? opts.at.split(',').map(Number) : bedCentre(presets.machine);
if (at.length !== 2 || at.some((v) => !Number.isFinite(v))) usage('--at must be x,y in mm');
const size = Number(opts.cube);
if (opts.cube && !(size > 0)) usage('--cube must be a size in mm');
const mesh = opts.cube ? box([size, size, size]) : parseStl(fs.readFileSync(positionals[0]));
const name = opts.name ?? (opts.cube ? 'Cube.stl' : path.basename(positionals[0]));
const out = path.resolve(opts.out ?? `${name.replace(/\.[^.]*$/, '')}.gcode`);
const job = { ...presets, objects: [{ name, positions: placeOnBed(mesh, at) }], toolpaths: false };

// ---- The engine: the host from dist/, in a worker thread --------------------------------------------
const dist = path.resolve(opts.dist);
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (!manifest.host) usage(`${dist}/manifest.json names no host: build it (npm run build:host)`);
if (!manifest.variants?.[opts.variant]) usage(`${dist} has no ${opts.variant} engine: build it (npm run build:engine -- ${opts.variant})`);

const worker = new Worker(new URL('./host-thread.mjs', import.meta.url), {
  workerData: { hostUrl: pathToFileURL(path.join(dist, manifest.host.file)).href },
});
const started = performance.now();
let lastPercent = -1;

worker.on('error', (err) => {
  console.error(`slice: the engine thread failed: ${err.message}`);
  process.exit(1);
});
worker.on('message', (message) => {
  switch (message.type) {
    case 'loading':
      break;
    case 'ready':
      console.log(`engine ${message.variant} ready in ${Math.round(message.initMs)} ms: OrcaSlicer ${message.orcaVersion} (${message.orcaCommit.slice(0, 10)})`);
      worker.postMessage({ type: 'slice', id: '1', job });
      break;
    case 'progress':
      if (Math.floor(message.percent / 10) !== Math.floor(lastPercent / 10)) console.log(`  ${String(Math.round(message.percent)).padStart(3)} % ${message.message}`);
      lastPercent = message.percent;
      break;
    case 'warning':
      console.warn(`  warning (${message.warning.kind}): ${message.warning.message}`);
      break;
    case 'sliced': {
      const { gcode, stats } = message.output;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, gcode);
      console.log(`sliced ${name} in ${((performance.now() - started) / 1000).toFixed(1)} s: ${stats.layers} layers, ${stats.printTimeText}, ` +
        `${stats.filamentMm} mm / ${stats.filamentG} g filament, max Z ${stats.maxZ}`);
      console.log(`G-code: ${out} (${gcode.length.toLocaleString('en')} bytes)`);
      void worker.terminate();
      break;
    }
    case 'failed':
      console.error(`slice: Orca refused the job (code ${message.error.code}): ${message.error.message}`);
      void worker.terminate().then(() => process.exit(1));
      break;
    case 'fatal':
      console.error(`slice: the engine could not start: ${message.message}${message.detail ? ` (${message.detail})` : ''}`);
      void worker.terminate().then(() => process.exit(1));
      break;
  }
});

worker.postMessage({ type: 'init', baseUrl: pathToFileURL(dist + path.sep).href, variant: opts.variant, wasmBytes: manifest.variants[opts.variant].wasmBytes });
