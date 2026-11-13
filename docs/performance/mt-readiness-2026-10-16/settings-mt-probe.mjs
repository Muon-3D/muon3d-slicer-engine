// Diagnostic only. Instrumentation is deliberately separate from the unchanged latency gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import { Session } from 'node:inspector';

const root = path.resolve(process.argv[2]);
const label = process.argv[3];
const loadFirst = process.argv.includes('--loaded');
const events = { engineImports: 0, workers: 0, workerMessages: 0, sharedBuffers: 0, wasmMemories: 0 };
registerHooks({ load(url, context, next) {
  if (/\/engine-(?:st|mt)\.mjs$/.test(url)) events.engineImports++;
  return next(url, context);
}});
const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class extends OriginalWorker {
  constructor(...args) { super(...args); events.workers++; }
  postMessage(...args) { events.workerMessages++; return super.postMessage(...args); }
};
syncBuiltinESMExports();
globalThis.SharedArrayBuffer = new Proxy(SharedArrayBuffer, { construct(target, args) {
  events.sharedBuffers++;
  return Reflect.construct(target, args);
}});
WebAssembly.Memory = new Proxy(WebAssembly.Memory, { construct(target, args) {
  events.wasmMemories++;
  return Reflect.construct(target, args);
}});
const { createHost } = await import(pathToFileURL(path.join(root, 'host/src/core.ts')));
const { machine, process: presetProcess, filaments } = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/presets/muon3d-m1-0.4.json')));
let done;
let id = 0;
const host = createHost({ base: pathToFileURL(path.join(root,'dist') + path.sep).href, environment: { kind: 'node', threads: true }, send(message) {
  if (message.id === id && (message.kind === 'result' || message.kind === 'error')) done(message);
}});
const request = async (op, params) => {
  const reply = await new Promise(resolve => { done = resolve; host.receive({ v: 2, id: ++id, op, params }); });
  assert.equal(reply.kind, 'result', JSON.stringify(reply));
  return reply.result;
};
const presets = { machine: { hash: 'm', config: machine }, process: { hash: 'p', config: presetProcess }, filament: { hash: 'f', config: filaments[0] } };
if (loadFirst) await request('load', { variant: 'mt', threads: 2 });
const before = { ...events };
const views = [{scope:'process', env:{mode:'expert'}}, {scope:'filament', env:{mode:'advanced'}}, {scope:'machine', env:{mode:'expert'}}, {scope:'object', object:{wall_loops:'3', layer_height:'0.12'}}];
const view = i => request('settings.view', { ...views[i % 4], presets, overrides:{process:{wall_loops:String(1+i%5)}}, version:i });
await view(0);
for (const ref of Object.values(presets)) delete ref.config;
for (let i=0; i<40; i++) await view(i);
const session = new Session();
session.connect();
const post = (method, args={}) => new Promise((resolve,reject) => session.post(method,args,(err,result)=>err?reject(err):resolve(result)));
await post('Profiler.enable');
await post('Profiler.start');
await post('HeapProfiler.startSampling', {samplingInterval:16384,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
for (let i=0; i<1000; i++) {
  await view(i);
  await request('settings.edit', {scope:'process',presets,edit:{set:'wall_loops',value:String(1+i%5)},version:i,view:true});
}
const cpu = (await post('Profiler.stop')).profile;
const heap = (await post('HeapProfiler.stopSampling')).profile;
session.disconnect();
const delta = Object.fromEntries(Object.keys(events).map(k=>[k,events[k]-before[k]]));
fs.writeFileSync(label+'.cpuprofile', JSON.stringify(cpu));
fs.writeFileSync(label+'.heapprofile', JSON.stringify(heap));
console.log(JSON.stringify({root,loadFirst,before,after:events,settingsDelta:delta,state:host.state(),views:1041,edits:1000},null,2));
assert.deepEqual(delta, {engineImports:0,workers:0,workerMessages:0,sharedBuffers:0,wasmMemories:0});
assert.equal(host.state().state, loadFirst ? 'ready' : 'idle');
if (loadFirst) {
  assert.ok(before.engineImports > 0 && before.workers > 0 && before.workerMessages > 0 && before.wasmMemories > 0, 'positive control must observe MT startup');
}
process.exit(0); // Emscripten's pool is persistent; end this diagnostic subprocess explicitly.
