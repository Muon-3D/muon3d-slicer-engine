// Which engine variants the host offers and loads (protocol 2.4): 'mt64' only where threads and Memory64 can run
// and the build has it, and only when a client names it ('auto' stays on 'mt'). A fake engine stands in for the wasm.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ErrorCode, type Response, type Variant } from '../../packages/protocol/src/envelope.ts';
import type { EngineManifest } from '../../packages/protocol/src/manifest.ts';
import type { HelloResult } from '../../packages/protocol/src/ops.ts';
import type { OrcaEngineModule } from '../src/bridge.ts';
import { memory64Supported } from '../src/bridge.ts';
import { createHost, type HostEnvironment } from '../src/core.ts';
import { BUILD } from '../src/info.ts';

const entry = (v: Variant) => ({ mjs: `engine-${v}.mjs`, wasm: `engine-${v}.wasm`, wasmBytes: 1 });
const manifest = (variants: Variant[]): EngineManifest => ({
  orcaVersion: 'test',
  orcaCommit: 'test',
  builtAt: '2026-01-01T00:00:00Z',
  variants: Object.fromEntries(variants.map((v) => [v, entry(v)])),
});

/** A host over a fake engine: requests in, the first answer to each id out. */
function host(environment: Partial<HostEnvironment>, built: Variant[]) {
  const answers = new Map<number, (r: Response) => void>();
  const loads: Variant[] = [];
  const h = createHost({
    base: 'file:///engine/',
    environment: { kind: 'node', hardwareConcurrency: 4, ...environment },
    send: (m) => {
      if (m.kind === 'result' || m.kind === 'error') answers.get(m.id)?.(m);
    },
    readManifest: async () => manifest(built),
    loadEngine: async (_base, variant) => {
      loads.push(variant);
      return { engine: {} as OrcaEngineModule, initMs: 1, memory: null };
    },
  });
  let id = 0;
  const request = (op: string, params: unknown) =>
    new Promise<Response>((resolve) => {
      answers.set(++id, resolve);
      h.receive({ v: 2, id, op, params });
    });
  return { request, loads };
}

const hello = async (r: ReturnType<typeof host>) => {
  const m = await r.request('hello', { protocol: { major: 2 }, client: { name: 'test', version: '1' } });
  assert.equal(m.kind, 'result');
  return (m as { result: HelloResult }).result;
};

describe('engine variants (2.4)', () => {
  test('memory64Supported() is what this Node can do (24 or newer: yes)', () => {
    assert.equal(memory64Supported(), Number(process.versions.node.split('.')[0]) >= 24);
  });

  test("hello lists 'mt64' only with threads, Memory64 and a build that has it, with its heap limit", async () => {
    const all: Variant[] = ['st', 'mt', 'mt64'];
    assert.deepEqual((await hello(host({ threads: true, memory64: true }, all))).variants, all);
    assert.deepEqual((await hello(host({ threads: true, memory64: false }, all))).variants, ['st', 'mt']);
    assert.deepEqual((await hello(host({ threads: false, memory64: true }, all))).variants, ['st']);
    assert.deepEqual((await hello(host({ threads: true, memory64: true }, ['st', 'mt']))).variants, ['st', 'mt']);
    const limits = (await hello(host({ threads: true, memory64: true }, all))).limits;
    assert.equal(limits.maxHeapBytes, BUILD.maxHeapBytes);
    assert.deepEqual(limits.maxHeapBytesByVariant, { st: BUILD.maxHeapBytes, mt: BUILD.maxHeapBytes, mt64: 16 * 1024 ** 3 });
  });

  test("'auto' loads 'mt', never 'mt64'; 'mt64' loads when named", async () => {
    const auto = host({ threads: true, memory64: true }, ['st', 'mt', 'mt64']);
    assert.deepEqual(await auto.request('load', {}).then((m) => (m as { result: unknown }).result), { variant: 'mt', initMs: 1 });
    const named = host({ threads: true, memory64: true }, ['st', 'mt', 'mt64']);
    assert.equal(((await named.request('load', { variant: 'mt64' })) as { result: { variant: string } }).result.variant, 'mt64');
    assert.deepEqual(named.loads, ['mt64']);
  });

  test("'mt64' where it cannot run, or is not built, is a BadRequest that loads nothing", async () => {
    for (const [env, built, message] of [
      [{ threads: false, memory64: true }, ['st', 'mt', 'mt64'], /SharedArrayBuffer/],
      [{ threads: true, memory64: false }, ['st', 'mt', 'mt64'], /Memory64/],
      [{ threads: true, memory64: true }, ['st', 'mt'], /not part of this build/],
    ] as const) {
      const h = host(env, [...built]);
      const m = await h.request('load', { variant: 'mt64' });
      assert.equal(m.kind, 'error');
      const error = (m as { error: { code: number; message: string } }).error;
      assert.equal(error.code, ErrorCode.BadRequest);
      assert.match(error.message, message);
      assert.deepEqual(h.loads, []);
    }
  });
});
