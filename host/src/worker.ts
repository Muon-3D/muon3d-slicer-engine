// The engine host's entry point: the script a client starts (host.<hash>.js in dist/, named in
// manifest.json). It serves protocol v2 (core.ts) over the transport it finds itself in:
//   - a Web Worker (a page's `new Worker(url, { type: 'module' })`): postMessage, results transferred;
//   - a Node worker_threads Worker (`new Worker(url)`): the same over parentPort.
// The engine files are loaded from the host's own folder unless `load` names another. Imported on a
// Node main thread (or anywhere else) it does nothing: a server embeds core.ts's createHost()/serve()
// instead, over a byte stream (packages/protocol byteStreamTransport).
import { nodeWorkerTransport, workerTransport, type NodeMessageEndpoint, type PostMessageEndpoint } from '../../packages/protocol/src/transport.ts';
import { serve } from './core.ts';

const base = new URL('./', import.meta.url).href;

const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
const inNode = typeof process === 'object' && typeof process.versions?.node === 'string';

if (inWorker) {
  serve(workerTransport(globalThis as unknown as PostMessageEndpoint), {
    base,
    environment: {
      kind: 'browser',
      threads: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && typeof SharedArrayBuffer === 'function',
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
    },
  });
} else if (inNode) {
  const { isMainThread, parentPort, workerData } = await import('node:worker_threads');
  if (!isMainThread && parentPort) {
    const os = await import('node:os');
    serve(nodeWorkerTransport(parentPort as unknown as NodeMessageEndpoint), {
      // workerData.engineBase: the engine files are elsewhere (the tests run these sources against dist/).
      base: typeof workerData?.engineBase === 'string' ? workerData.engineBase : base,
      environment: { kind: 'node', threads: typeof SharedArrayBuffer === 'function', hardwareConcurrency: os.availableParallelism() },
    });
  }
}
