// End-to-end, 'mt' only: the engine's shared heap does not grow while a job's threads run.
//
// V8 (Node, Chrome) bounds-checks a wasm atomic access against the memory size the accessing thread last
// saw. A thread sees another thread's memory.grow only once it handles the interrupt V8 sends it: tens of
// microseconds later while it runs, at once when it wakes from a wait. An atomic access to the new pages
// in between traps "memory access out of bounds" and the engine is dead (tbbmalloc's free lists, which
// libslic3r's Points allocate from, were where it happened). The first 'mt' slice of a fresh engine used to
// grow the heap from 256 MB to about 1 GB with every TBB thread running, and about one fresh engine in 50
// crashed that way (docs/performance/mt-crash-2026-10-16). The host now grows the heap itself, between
// jobs, while the threads are parked (bridge.ts SharedHeapReserve).
//
// Skipped until the engine is built (npm run test:engine fails instead), and for 'st', whose heap is not shared.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { createHost } from '../host/src/core.ts';
import { loadEngine } from '../host/src/bridge.ts';
import { EngineConnection } from '../packages/protocol/src/connection.ts';
import type { Transport } from '../packages/protocol/src/transport.ts';
import { cube, engineDir, engineSkip, m1Presets, variant } from './fixtures.ts';

const MiB = 1024 ** 2;

/** The host in this thread, with the engine's slice() wrapped to record its heap before and after each job. */
async function hostRecordingHeap() {
  const jobs: { before: number; after: number }[] = [];
  let memory: WebAssembly.Memory | undefined;
  const host = createHost({
    base: pathToFileURL(engineDir + path.sep).href,
    environment: { kind: 'node' },
    send: (m) => setImmediate(() => client.forEach((l) => l(structuredClone(m)))),
    loadEngine: async (...args) => {
      const loaded = await loadEngine(...args);
      memory = (loaded.engine as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
      const slice = loaded.engine.slice.bind(loaded.engine);
      loaded.engine.slice = (...a) => {
        const before = memory!.buffer.byteLength;
        try {
          return slice(...a);
        } finally {
          jobs.push({ before, after: memory!.buffer.byteLength });
        }
      };
      return loaded;
    },
  });
  const client = new Set<(m: unknown) => void>();
  const transport: Transport = {
    send: (m) => setImmediate(() => host.receive(structuredClone(m))),
    listen: (l) => {
      client.add(l);
      return () => client.delete(l);
    },
    close: () => undefined,
  };
  return { connection: new EngineConnection(transport), jobs, memory: () => memory };
}

const skip = engineSkip || (variant !== 'mt' && "the 'st' heap is not shared");

describe('the shared heap of the mt engine', { skip }, () => {
  it('does not grow while a slice runs: the host grows it between jobs', async () => {
    const { connection, jobs, memory } = await hostRecordingHeap();
    await connection.open({ name: 'shared-heap test', version: '1' });
    const loaded = await connection.request('load', { variant: 'mt' });
    assert.equal(loaded.variant, 'mt');
    assert.ok(memory()!.buffer instanceof SharedArrayBuffer, 'the mt heap is shared');
    const presets = await m1Presets();
    const params = { configs: presets, objects: [{ name: 'Cube.stl', mesh: { positions: cube([100, 90]) } }] };
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await connection.request('slice', params));
    assert.equal(jobs.length, 2);
    for (const [i, { before, after }] of jobs.entries()) {
      assert.equal(after, before, `slice ${i + 1} grew the shared heap from ${before / MiB} to ${after / MiB} MiB while its threads ran`);
    }
    for (const result of results) {
      assert.equal(result.stats.layers, 100);
      assert.equal(result.heapBytes, memory()!.buffer.byteLength, 'the result reports the heap');
    }
  });
});
