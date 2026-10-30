// The conformance file's order, cut down: an engine in this thread (as the in-process and byte-stream targets
// load one) slices a cube, and the unchanged settings.view gate procedure then runs at once against a
// node-worker host (host/src/worker.ts in a worker thread, settings only). Prints the gate's p50/p95 and the
// process CPU used during it. A diagnostic; the gate itself is test/conformance/conformance.test.ts.
//   node gate-after-slice.mjs <repo root> <st|mt|none> [--settle=ms]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const variant = process.argv[3];
const settle = Number((process.argv.find((a) => a.startsWith('--settle=')) ?? '--settle=0').split('=')[1]);
process.env.ENGINE_VARIANT = variant === 'none' ? 'st' : variant;
const fromRoot = (name) => import(pathToFileURL(path.join(root, name)).href);
const { TARGETS } = await fromRoot('test/conformance/targets.ts');
const { SettingsClient } = await fromRoot('packages/protocol/src/connection.ts');
const { m1Presets, cube } = await fromRoot('test/fixtures.ts');
const presets = await m1Presets();
const target = (name) => TARGETS.find((t) => t.name === name);

let sliceMs = null;
if (variant !== 'none') {
  const engineHost = await target('in-process').connect();
  await engineHost.connection.request('load', { variant });
  const t = performance.now();
  await engineHost.connection.request('slice', { configs: presets, objects: [{ name: 'Cube.stl', mesh: { positions: cube([100, 90]) } }] });
  sliceMs = Math.round(performance.now() - t);
}
if (settle) await new Promise((r) => setTimeout(r, settle));

// The gate procedure of conformance.test.ts, unchanged: 40 warmups, then 200 timed views over four scopes.
const host = await target('node-worker').connect();
await host.connection.open({ name: 'gate-after-slice', version: '1' });
const settings = new SettingsClient(host.connection);
const settingsPresets = () => ({ machine: presets.machine, process: presets.process, filament: presets.filaments[0] });
const views = [
  { scope: 'process', env: { mode: 'expert' } },
  { scope: 'filament', env: { mode: 'advanced' } },
  { scope: 'machine', env: { mode: 'expert' } },
  { scope: 'object', object: { wall_loops: '3', layer_height: '0.12' } },
];
const run = (i) => settings.view({ ...views[i % views.length], presets: settingsPresets(), overrides: { process: { wall_loops: String(1 + (i % 5)) } }, version: i });
for (let i = 0; i < 40; i++) await run(i);
const c0 = process.cpuUsage();
const t0 = performance.now();
const times = [];
for (let i = 0; i < 200; i++) {
  const started = performance.now();
  await run(i);
  times.push(performance.now() - started);
}
const cpu = process.cpuUsage(c0);
const wall = performance.now() - t0;
const sorted = [...times].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; // conformance.test.ts percentile()
console.log(JSON.stringify({ variant, settle, sliceMs, p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), gateMs: Math.round(wall), processCores: +((cpu.user + cpu.system) / 1000 / wall).toFixed(2) }));
await host.close();
process.exit(0);
