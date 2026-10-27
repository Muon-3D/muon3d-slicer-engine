#!/usr/bin/env node
// Browser against server: slices the same models with the same frozen preset twice, once through the slice job
// service (Node, as the agent-CAD server runs it) and once in a real browser (headless Chromium, the engine host in a
// module Web Worker, driven by the protocol package exactly as the Muon3D Slicer web app drives it), then compares.
//
//   node service/compare-browser.mjs --runtime <runtime folder> [--preset muon3d-m1-0.4] [--out report.json] model.stl|.3mf ...
//
// Needs playwright-core (PLAYWRIGHT_CORE=<path to the package>, or resolvable from here) and a Chromium it knows.
// Both sides get the same placed triangles (the service's own placement, computed once here), so any difference is
// the engine's. Compared: layer count, estimated time (±1 %), filament length (±0.5 %), G1 moves per layer, and the
// G-code itself with the header comments that name a time or a host taken out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPreset, modelTriangles } from './slice-job.mjs';
import { placeOnBed } from '../examples/node-cli/stl.mjs';
import { startHost } from '../examples/start-host.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals: models } = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: 'string' },
    preset: { type: 'string', default: 'muon3d-m1-0.4' },
    out: { type: 'string' },
    variant: { type: 'string', default: 'st' },
  },
});
if (!opts.runtime || !models.length) {
  console.error('usage: node service/compare-browser.mjs --runtime <folder> [--preset <name>] [--out <json>] model ...');
  process.exit(2);
}
const runtime = path.resolve(opts.runtime);
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));

function bedCentre(machine) {
  const points = [machine.printable_area].flat().join(',').split(',').map((p) => p.split('x').map(Number));
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

// ---- A static server: the runtime, the protocol package as JavaScript, and the page ------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>slice</title><script type="module">
const { EngineConnection, workerTransport } = await import(location.origin + '/protocol/index.ts');
window.sliceInBrowser = async (job) => {
  const worker = new Worker('/runtime/' + job.host, { type: 'module', name: 'engine' });
  const connection = new EngineConnection(workerTransport(worker));
  try {
    const hello = await connection.open({ name: 'compare-browser', version: '2' });
    await connection.request('load', { variant: job.variant });
    const t = performance.now();
    const r = await connection.request('slice', { configs: job.configs,
      objects: [{ name: job.name, mesh: { positions: new Float32Array(job.positions) } }], output: { toolpaths: false } });
    return { stats: r.stats, gcode: new TextDecoder().decode(r.gcode), engine: hello.engine, sliceMs: performance.now() - t,
             userAgent: navigator.userAgent };
  } finally { connection.close(); worker.terminate(); }
};
window.ready = true;
</script>`;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    let file;
    if (url.pathname === '/') return res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname.startsWith('/runtime/')) file = path.join(runtime, url.pathname.slice(9));
    else if (url.pathname.startsWith('/protocol/')) file = path.join(repo, 'packages/protocol/src', url.pathname.slice(10));
    const root = url.pathname.startsWith('/runtime/') ? runtime : path.join(repo, 'packages/protocol/src');
    if (!file || !path.resolve(file).startsWith(root) || !fs.existsSync(file)) return res.writeHead(404, headers).end();
    let body = fs.readFileSync(file);
    if (file.endsWith('.ts')) body = stripTypeScriptTypes(body.toString('utf8'));
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Comparing two G-code files -------------------------------------------------------------------------------------
/** Header lines that name when or where it was made are not the print. */
const VOLATILE = /^;\s*(generated by|HEADER_BLOCK|thumbnail|.*date|.*time stamp)/i;

function normalised(text) {
  return text.split('\n').filter((l) => !VOLATILE.test(l)).join('\n');
}

function movesPerLayer(text) {
  const out = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(';LAYER_CHANGE')) { out.push(n); n = 0; } else if (line.startsWith('G1 ')) n++;
  }
  out.push(n);
  return out;
}

function compare(server, browser) {
  const s = server.stats, b = browser.stats;
  const rel = (x, y) => (x === y ? 0 : Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));
  const ms = movesPerLayer(server.gcode), mb = movesPerLayer(browser.gcode);
  const differentLayers = ms.map((m, i) => (m === mb[i] ? -1 : i)).filter((i) => i >= 0);
  const ns = normalised(server.gcode), nb = normalised(browser.gcode);
  const checks = {
    layers: { server: s.layers, browser: b.layers, pass: s.layers === b.layers },
    printTime: { server: s.printTimeSeconds, browser: b.printTimeSeconds, rel: rel(s.printTimeSeconds, b.printTimeSeconds), pass: rel(s.printTimeSeconds, b.printTimeSeconds) <= 0.01 },
    filament: { server: s.filamentMm, browser: b.filamentMm, rel: rel(s.filamentMm, b.filamentMm), pass: rel(s.filamentMm, b.filamentMm) <= 0.005 },
    movesPerLayer: { layers: ms.length, differentLayers: differentLayers.slice(0, 10), pass: ms.length === mb.length && !differentLayers.length },
    gcode: {
      server: crypto.createHash('sha256').update(ns).digest('hex'), browser: crypto.createHash('sha256').update(nb).digest('hex'),
      identical: ns === nb, rawIdentical: server.gcode === browser.gcode,
    },
  };
  return { checks, pass: checks.layers.pass && checks.printTime.pass && checks.filament.pass && checks.movesPerLayer.pass };
}

// ---- Main -------------------------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const playwright = await import(pathToFileURL(require.resolve(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')).href);
const { chromium } = playwright.default ?? playwright;
const preset = loadPreset(opts.preset);
const configs = { machine: preset.presets.machine, process: preset.presets.process, filaments: preset.presets.filaments };
const server = await serve();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.ready === true);
const host = await startHost(runtime);
await host.connection.request('load', { variant: opts.variant });
const rows = [];
try {
  for (const file of models) {
    const format = path.extname(file).slice(1).toLowerCase();
    const positions = placeOnBed(modelTriangles({ format, data: fs.readFileSync(file).toString('base64') }), bedCentre(preset.presets.machine));
    const name = `${path.basename(file).replace(/\.[^.]+$/, '')}.stl`;
    const t = performance.now();
    const r = await host.connection.request('slice', { configs, objects: [{ name, mesh: { positions } }], output: { toolpaths: false } });
    const serverSide = { stats: r.stats, gcode: Buffer.from(r.gcode).toString('utf8'), sliceMs: performance.now() - t };
    const browserSide = await page.evaluate((job) => window.sliceInBrowser(job),
      { host: manifest.host.file, variant: opts.variant, configs, name, positions: Array.from(positions) });
    const c = compare(serverSide, browserSide);
    rows.push({ model: path.basename(file), triangles: positions.length / 9, ...c,
      serverMs: Math.round(serverSide.sliceMs), browserMs: Math.round(browserSide.sliceMs), userAgent: browserSide.userAgent });
    console.log(`${c.pass ? 'PASS' : 'FAIL'} ${path.basename(file)}: ${serverSide.stats.layers}/${browserSide.stats.layers} layers, `
      + `${serverSide.stats.printTimeText} / ${browserSide.stats.printTimeText}, ${serverSide.stats.filamentMm}/${browserSide.stats.filamentMm} mm, `
      + `G-code ${c.checks.gcode.identical ? 'identical' : 'differs'} (server ${Math.round(serverSide.sliceMs)} ms, browser ${Math.round(browserSide.sliceMs)} ms)`);
  }
} finally {
  host.close();
  await browser.close();
  server.close();
}
const report = { preset: { name: opts.preset, sha256: preset.sha256 }, engine: manifest.version ?? null, variant: opts.variant,
  models: rows, pass: rows.every((r) => r.pass), identical: rows.filter((r) => r.checks.gcode.identical).length };
if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 1));
console.log(`${report.pass ? 'PASS' : 'FAIL'}: ${rows.filter((r) => r.pass).length}/${rows.length} models match; G-code identical for ${report.identical}`);
process.exitCode = report.pass ? 0 : 1;
