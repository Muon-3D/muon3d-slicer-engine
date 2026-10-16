// One fresh MT engine per process: load 'mt' through the real host (in-process, as the conformance suite's
// first target does), then slice the conformance cube twice. Prints one JSON line; a crash prints the raw
// stacks first (the wasm trap on the calling thread, a pthread's error event) and exits 1.
//   node mt-stress.mjs <repo root> [engine dir] [--no-progress] [--pregrow=MiB]
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const engineDir = path.resolve(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : path.join(root, 'dist'));
const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith('--')));
const fromRoot = (name) => import(pathToFileURL(path.join(root, name)).href);
process.on('uncaughtException', (e) => {
  console.error('MT_UNCAUGHT', e?.stack ?? String(e));
  process.exit(1);
});

const { createHost } = await fromRoot('host/src/core.ts');
const bridge = await fromRoot('host/src/bridge.ts');
const { EngineConnection } = await fromRoot('packages/protocol/src/connection.ts');
const { m1Presets, cube, cylinder } = await fromRoot('test/fixtures.ts');

let module = null;
const phase = { name: 'start' };
const loadEngine = async (...args) => {
  const loaded = await bridge.loadEngine(...args);
  module = loaded.engine;
  const slice = module.slice.bind(module);
  module.slice = (...a) => {
    try {
      return slice(...a);
    } catch (e) {
      console.error('MT_TRAP', phase.name, e?.stack ?? String(e));
      throw e;
    }
  };
  return loaded;
};

const listeners = [new Set(), new Set()];
const end = (self) => ({
  send: (message, transfer = []) => {
    const copy = structuredClone(message, { transfer: [...transfer] });
    setImmediate(() => {
      for (const l of listeners[1 - self]) l(copy);
    });
  },
  listen: (f) => {
    listeners[self].add(f);
    return () => listeners[self].delete(f);
  },
  close: () => undefined,
});
const base = pathToFileURL(engineDir + path.sep).href;
const host = createHost({ base, environment: { kind: 'node' }, send: (m, t) => end(0).send(m, t), loadEngine });
end(0).listen((m) => host.receive(m));
const connection = new EngineConnection(end(1));
await connection.open({ name: 'mt-stress', version: '1' });

const presets = await m1Presets();
phase.name = 'load';
const started = performance.now();
const threadsFlag = [...flags].find((f) => f.startsWith('--threads='));
const load = await connection.request('load', { variant: flags.has('--st') ? 'st' : 'mt', ...(threadsFlag ? { threads: Number(threadsFlag.split('=')[1]) } : {}) });
const pregrow = [...flags].find((f) => f.startsWith('--pregrow='));
if (pregrow) {
  // Experiment: grow the shared memory up front, from this (the engine's) thread, before any slice runs.
  const target = Number(pregrow.split('=')[1]) * 1024 * 1024;
  const mem = module.wasmMemory;
  if (mem.buffer.byteLength < target) mem.grow((target - mem.buffer.byteLength) / 65536);
}
const heap0 = module.wasmMemory?.buffer.byteLength;
const heavy = flags.has('--heavy');
const objects = heavy
  ? [-35, 0, 35].flatMap((dx) => [-35, 0, 35].map((dy) => ({ name: `Cyl${dx}_${dy}.stl`, mesh: { positions: cylinder([100 + dx, 90 + dy], 12, 60) } })))
  : [{ name: 'Cube.stl', mesh: { positions: cube([100, 90]) } }];
const params = { configs: presets, objects };
const results = [];
for (const name of ['first-slice', 'second-slice']) {
  phase.name = name;
  const progress = [];
  try {
    const r = await connection.request('slice', params, flags.has('--no-progress') ? {} : { onProgress: (p) => progress.push(p.percent) });
    if (!heavy && r.stats.layers !== 100) throw new Error(`layers ${r.stats.layers}`);
    results.push({ phase: name, ms: Math.round(r.timings.total), heap: module.wasmMemory?.buffer.byteLength, progress: progress.length });
  } catch (e) {
    console.error('MT_FAILED', name, e?.message, JSON.stringify({ heap0, heap: module?.heapSize?.(), freeMemory: os.freemem() }));
    process.exitCode = 1;
    break;
  }
}
let idleCpu;
if (flags.has('--idle-cpu')) {
  // CPU the process burns while the engine sits idle after its jobs (all threads of this process).
  for (let i = 0; i < 12; i++) {
    const wait = 0;
    const c0 = process.cpuUsage(); const t0 = performance.now(); const e0 = performance.eventLoopUtilization(); const r0 = process.resourceUsage();
    await new Promise((r) => setTimeout(r, 250));
    const c = process.cpuUsage(c0);
    (idleCpu ??= []).push([+((c.user + c.system) / 1000 / (performance.now() - t0)).toFixed(2), +performance.eventLoopUtilization(e0).utilization.toFixed(2)]);
  }
}
console.log(JSON.stringify({ mainThreadGrows: globalThis.__mtGrows, idleCpu, ok: process.exitCode !== 1, root, engineDir, initMs: Math.round(load.initMs), heap0, results, total: Math.round(performance.now() - started) }));
process.exit(process.exitCode ?? 0);
