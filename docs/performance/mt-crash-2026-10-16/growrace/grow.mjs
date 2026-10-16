// Does V8 let a thread read memory another thread has just grown? The main thread grows a shared
// WebAssembly.Memory one page at a time and publishes the new page's number with an atomic store; a
// worker waits for it in wasm and reads that page at once (atomically, or with a plain load).
//   node grow.mjs <atomic|plain|blocked> [pages] [settle ms]
import fs from 'node:fs';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
const wasm = fs.readFileSync(new URL('./grow.wasm', import.meta.url));
if (isMainThread) {
  const mode = process.argv[2] ?? 'atomic';
  const pages = Number(process.argv[3] ?? 4000);
  const settleMs = Number(process.argv[4] ?? 0); // wait between growing and publishing
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32768, shared: true });
  const worker = new Worker(new URL(import.meta.url), { workerData: { memory, mode, pages, base: 15 } });
  await new Promise((r) => worker.once('message', r)); // ready
  let failed = null;
  worker.on('error', (e) => { failed = e; });
  const done = new Promise((r) => worker.once('exit', r));
  for (let k = 1; k <= pages && !failed; k++) {
    memory.grow(1);
    if (settleMs) { const t = performance.now(); while (performance.now() - t < settleMs); }
    Atomics.store(new Int32Array(memory.buffer), 0, k);
    if (mode === 'blocked') Atomics.notify(new Int32Array(memory.buffer), 0);
    if (k % 64 === 0) await new Promise((r) => setImmediate(r)); // let the worker's error arrive
  }
  await done;
  console.log(JSON.stringify({ mode, pages, settleMs, trap: failed ? failed.message : null, firstTrapAfterGrows: failed ? Atomics.load(new Int32Array(memory.buffer), 0) : null, node: process.version, flags: process.execArgv }));
  process.exit(failed ? 1 : 0);
} else {
  const { instance } = await WebAssembly.instantiate(wasm, { m: { m: workerData.memory } });
  parentPort.postMessage('ready');
  const atomic = workerData.mode === 'atomic' ? 1 : 0;
  for (let k = 1; k <= workerData.pages; k++) {
    if (workerData.mode === 'blocked') instance.exports.probe_blocked(k, workerData.base);
    else instance.exports.probe(k, workerData.base, atomic);
  }
}
