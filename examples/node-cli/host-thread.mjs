// Runs the engine's worker host (dist/host.<hash>.js, the very file a browser loads) in a Node
// worker thread. The host installs its message loop when it sees a worker global scope; this file
// provides the three things it uses of one (postMessage, onmessage, WorkerGlobalScope) on top of
// worker_threads, and nothing else.
import { parentPort, workerData } from 'node:worker_threads';

globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
// Only while the host module starts: the engine module (Emscripten) also looks for WorkerGlobalScope
// and must find Node instead, so it reads its .wasm from disk.
globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
await import(workerData.hostUrl);
delete globalThis.WorkerGlobalScope;

parentPort.on('message', (data) => globalThis.onmessage?.({ data }));
