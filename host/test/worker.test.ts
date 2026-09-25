// Run: node --test web/src/engine/worker.test.ts
// The worker's engine-facing functions against a fake engine module (the real one is exercised by
// engine/test/slice.ts once the engine is built).
import assert from 'node:assert/strict';
import { afterEach, describe, it, test } from 'node:test';
import type { CheckOutput, EngineWarning, SliceJob, SliceOutput } from './protocol.ts';
import {
  EngineJobError,
  EngineStartError,
  engineFailure,
  engineHeap,
  instantiateEngineWasm,
  runCheck,
  runSlice,
  sliceTransferables,
  startFailure,
  withoutAssertionsHint,
  type OrcaEngineModule,
} from './worker.ts';

const job: SliceJob = {
  machine: { name: 'Muon3D M1 0.4 nozzle', type: 'machine', from: 'system' },
  process: { name: '0.20mm Standard @Muon3D M1', type: 'process', from: 'system' },
  filaments: [{ name: 'Generic PLA @Muon3D M1', type: 'filament', from: 'system' }],
  objects: [{ name: 'Cube.stl', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
};

function output(): SliceOutput {
  return {
    gcode: new Uint8Array([59, 10]),
    stats: {
      printTimeSeconds: 60,
      printTimeText: '1m 0s',
      firstLayerTimeText: '10s',
      filamentMm: 10,
      filamentCm3: 0.02,
      filamentG: 0.03,
      filamentCost: 0,
      layers: 3,
      maxZ: 0.6,
    },
    toolpaths: {
      layerCount: 1,
      layerZ: new Float32Array([0.2]),
      extrusions: {
        positions: new Float32Array(6),
        layerStart: new Uint32Array([0, 1]),
        count: 1,
        roleIndex: new Uint8Array(1),
        width: new Uint8Array([42]),
        height: new Uint8Array([20]),
      },
      travels: { positions: new Float32Array(0), layerStart: new Uint32Array([0, 0]), count: 0 },
      roles: ['Outer wall'],
      roleLength: [1],
      lineWidth: 0.42,
      bounds: { min: [0, 0, 0.2], max: [1, 0, 0.2] },
    },
    toolpathExtras: {
      feedrate: new Float32Array(1),
      fanSpeed: new Uint8Array(1),
      temperature: new Uint16Array(1),
      time: new Float32Array(1),
      height: new Float32Array(1),
    },
    warnings: [],
    timings: { load: 1, slice: 2, export: 3, total: 6 },
  };
}

function fakeEngine(overrides: Partial<OrcaEngineModule> = {}): OrcaEngineModule {
  return {
    version: () => ({ orcaVersion: '2.5.0-dev', orcaCommit: 'abc' }),
    slice: () => output(),
    check: () => ({ objects: [] }),
    requestCancel: () => {},
    setLogLevel: () => {},
    ...overrides,
  };
}

test('runSlice passes presets as JSON and objects as typed arrays', () => {
  const calls: unknown[][] = [];
  const engine = fakeEngine({
    slice: (...args) => {
      calls.push(args);
      return output();
    },
  });
  runSlice(engine, job);
  const [machine, process, filaments, objects, toolpaths] = calls[0] as [string, string, string[], Array<{ name: string; positions: Float32Array }>, boolean];
  assert.deepEqual(JSON.parse(machine), job.machine);
  assert.deepEqual(JSON.parse(process), job.process);
  assert.deepEqual(filaments.map((f) => JSON.parse(f)), job.filaments);
  assert.equal(objects[0].name, 'Cube.stl');
  assert.equal(objects[0].positions, job.objects[0].positions, 'the mesh is handed over as is, not copied');
  assert.equal(toolpaths, true, 'toolpaths default to on');

  runSlice(engine, { ...job, toolpaths: false });
  assert.equal(calls[1][4], false);
});

test('runSlice keeps the engine stage timings and measures the total itself', () => {
  const result = runSlice(fakeEngine(), job);
  assert.equal(result.timings.load, 1);
  assert.equal(result.timings.slice, 2);
  assert.equal(result.timings.export, 3);
  assert.ok(result.timings.total >= 0 && result.timings.total < 1000);
});

test('runSlice forwards callbacks, and a throwing callback does not reach the engine', () => {
  const seen: string[] = [];
  const engine = fakeEngine({
    slice: (_m, _p, _f, _o, _t, onProgress, onWarning) => {
      onProgress(50, 'Generating infill');
      onWarning({ kind: 'need_support_on', message: 'It seems object Cube.stl has large overhangs' });
      return output();
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    runSlice(
      engine,
      job,
      (percent, message) => {
        seen.push(`${percent} ${message}`);
        throw new Error('UI bug');
      },
      (warning: EngineWarning) => seen.push(warning.kind),
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ['50 Generating infill', 'need_support_on']);
});

test('an Orca error comes back as EngineJobError with the CLI code', () => {
  const engine = fakeEngine({
    slice: () => ({ error: { code: -64, message: 'Cube.stl intersects an exclusion volume for extruder 1.', objects: ['Cube.stl'] } }),
    check: () => ({ error: { code: -5, message: 'The machine preset still inherits.' } }),
  });
  assert.throws(
    () => runSlice(engine, job),
    (err: unknown) => err instanceof EngineJobError && err.error.code === -64 && err.error.objects?.[0] === 'Cube.stl',
  );
  assert.throws(
    () => runCheck(engine, { ...job }),
    (err: unknown) => err instanceof EngineJobError && err.error.code === -5,
  );
});

test('runCheck returns the engine output', () => {
  const checked: CheckOutput = { objects: [{ name: 'Cube.stl', inside: true, exclusionHits: [] }] };
  assert.equal(runCheck(fakeEngine({ check: () => checked }), job), checked);
});

test('engine failures are classified as out of memory (2) or crash (1)', () => {
  for (const message of [
    'Aborted(OOM)',
    'Cannot enlarge memory arrays to size 2147483648 bytes (OOM).',
    'Array buffer allocation failed',
    'WebAssembly.Memory.grow(): Maximum memory size exceeded',
  ]) {
    assert.equal(engineFailure(new RangeError(message)).code, 2, message);
  }
  for (const message of ['memory access out of bounds', 'unreachable', 'Aborted(Assertion failed)']) {
    const failure = engineFailure(new Error(message));
    assert.equal(failure.code, 1, message);
    assert.match(failure.message, new RegExp(message.replace(/[()]/g, '\\$&')));
  }
  assert.equal(engineFailure('plain string').code, 1);
});

test('slice results transfer every buffer once and never a shared one', () => {
  const result = output();
  const shared = new Float32Array(new SharedArrayBuffer(8));
  result.toolpathExtras!.height = shared;
  result.toolpaths!.travels.positions = result.toolpaths!.extrusions.positions; // same buffer twice
  const transfer = sliceTransferables(result);
  assert.equal(new Set(transfer).size, transfer.length);
  assert.ok(transfer.includes(result.gcode.buffer as ArrayBuffer));
  assert.ok(!transfer.includes(shared.buffer as unknown as ArrayBuffer));
  // gcode, layerZ, extrusion positions/layerStart/roleIndex/width/height, travel layerStart, 4 extras.
  assert.equal(transfer.length, 12);
});

test('runSlice drops the toolpath extras when the job does not want them', () => {
  assert.notEqual(runSlice(fakeEngine(), job).toolpathExtras, null, 'kept by default');
  const result = runSlice(fakeEngine(), { ...job, toolpathExtras: false });
  assert.equal(result.toolpathExtras, null);
  assert.notEqual(result.toolpaths, null);
  // gcode, layerZ, extrusion positions/layerStart/roleIndex/width/height, travel positions/layerStart.
  assert.equal(sliceTransferables(result).length, 9);
});

test("Emscripten's -sASSERTIONS hint is dropped from engine errors", () => {
  const abort = new WebAssembly.RuntimeError('Aborted(Assertion failed). Build with -sASSERTIONS for more info.');
  assert.equal(withoutAssertionsHint(abort.message), 'Aborted(Assertion failed)');
  assert.equal(engineFailure(abort).message, 'The slicing engine crashed: Aborted(Assertion failed)');
});

test('a trap with the heap (nearly) at its maximum is out of memory, whatever it says', () => {
  const GB = 1024 ** 3;
  assert.equal(engineFailure(new WebAssembly.RuntimeError('unreachable'), { bytes: 4 * GB, maxBytes: 4 * GB }).code, 2);
  assert.equal(engineFailure(new WebAssembly.RuntimeError('unwind'), { bytes: 3.8 * GB, maxBytes: 4 * GB }).code, 2);
  assert.equal(engineFailure(new WebAssembly.RuntimeError('unreachable'), { bytes: 1 * GB, maxBytes: 4 * GB }).code, 1);
  assert.equal(engineFailure(new WebAssembly.RuntimeError('unreachable'), { bytes: 4 * GB }).code, 1, 'no maximum known');
});

test('engineHeap asks the bridge where the build can, else reads the memory', () => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  assert.deepEqual(engineHeap(fakeEngine({ heapSize: () => ({ bytes: 5, maxBytes: 10 }) }), memory), { bytes: 5, maxBytes: 10 });
  assert.deepEqual(engineHeap(fakeEngine(), memory), { bytes: 2 * 65536 });
  const broken = fakeEngine({
    heapSize: () => {
      throw new Error('gone');
    },
  });
  assert.deepEqual(engineHeap(broken, memory), { bytes: 2 * 65536 });
  assert.equal(engineHeap(fakeEngine(), null), null);
});

test('startFailure says why the engine could not start in a sentence, with the raw text as detail', () => {
  assert.deepEqual(startFailure(new EngineStartError('engine-mt.wasm could not be downloaded (HTTP 404).')), {
    code: 1,
    message: 'engine-mt.wasm could not be downloaded (HTTP 404).',
  });
  const oom = startFailure(new RangeError('WebAssembly.Memory(): could not allocate memory'));
  assert.equal(oom.code, 2);
  assert.match(oom.message, /not have enough memory/);
  assert.equal(oom.detail, 'WebAssembly.Memory(): could not allocate memory');
  // Emscripten's own fetch-and-compile path wraps the error in its abort message.
  const wrapped = startFailure(
    new WebAssembly.RuntimeError(
      'Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 7b 22 65 72 @+0). Build with -sASSERTIONS for more info.',
    ),
  );
  assert.equal(wrapped.code, 1);
  assert.match(wrapped.message, /^The engine files on the server are incomplete or come from different builds\./);
  assert.equal(wrapped.detail, 'Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 7b 22 65 72 @+0)');
  assert.deepEqual(startFailure(new Error('Aborted(something else). Build with -sASSERTIONS for more info.')), { code: 1, message: 'Aborted(something else)' });
});

// ---------------------------------------------------------------------------
// instantiateEngineWasm: the worker's own fetch of the .wasm
// ---------------------------------------------------------------------------

/** The smallest module with an exported memory, and one that imports a function "a"."a". */
const MEMORY_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 2, 0]);
const IMPORTING_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 7, 1, 1, 0x61, 1, 0x61, 0, 0]);
const WASM_URL = 'https://slicer.test/engine/abc123/engine-mt.wasm';

describe('instantiateEngineWasm', () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const serve = (respond: () => Response | Promise<Response>) => {
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return respond();
    };
  };
  const wasm = (bytes: Uint8Array<ArrayBuffer>, type = 'application/wasm') => new Response(bytes, { headers: { 'content-type': type } });
  /** The EngineStartError instantiateEngineWasm rejects with. */
  const startError = async (imports: WebAssembly.Imports = {}): Promise<EngineStartError> => {
    try {
      await instantiateEngineWasm(WASM_URL, imports, {});
    } catch (err) {
      assert.ok(err instanceof EngineStartError, String(err));
      return err;
    }
    assert.fail('expected a rejection');
  };
  afterEach(() => {
    globalThis.fetch = originalFetch;
    requested.length = 0;
  });

  it('compiles the response while it streams in, and reports the download', async () => {
    serve(() => wasm(MEMORY_MODULE));
    const progress: Array<[number, number]> = [];
    const result = await instantiateEngineWasm(WASM_URL, {}, { wasmBytes: MEMORY_MODULE.length, onDownload: (l, t) => progress.push([l, t]) });
    assert.ok(result.instance.exports.memory instanceof WebAssembly.Memory);
    assert.ok(result.module instanceof WebAssembly.Module);
    assert.deepEqual(requested, [WASM_URL]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(progress.at(-1), [MEMORY_MODULE.length, MEMORY_MODULE.length]);
  });

  it('compiles the bytes when the server does not say application/wasm', async () => {
    serve(() => wasm(MEMORY_MODULE, 'application/octet-stream'));
    const progress: Array<[number, number]> = [];
    const result = await instantiateEngineWasm(WASM_URL, {}, { onDownload: (l, t) => progress.push([l, t]) });
    assert.ok(result.instance.exports.memory instanceof WebAssembly.Memory);
    assert.deepEqual(progress.at(-1), [MEMORY_MODULE.length, 0], 'no total known');
  });

  it('names the file that is missing or could not be downloaded', async () => {
    serve(() => new Response('{"error":"This slicing engine file does not exist on the server."}', { status: 404, headers: { 'content-type': 'application/json' } }));
    const missing = await startError();
    assert.equal(missing.message, 'engine-mt.wasm could not be downloaded (HTTP 404).');
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const offline = await startError();
    assert.equal(offline.message, 'engine-mt.wasm could not be downloaded.');
    assert.equal(offline.detail, 'Failed to fetch');
    serve(() => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    assert.equal((await startError()).message, 'engine-mt.wasm is missing on the server (it sent a web page instead).');
  });

  it('explains a .wasm that is cut off or from another build', async () => {
    serve(() => wasm(MEMORY_MODULE.slice(0, 20)));
    const truncated = await startError();
    assert.match(truncated.message, /^The engine files on the server are incomplete or come from different builds\./);
    assert.match(truncated.detail ?? '', /CompileError|WebAssembly/);
    serve(() => wasm(IMPORTING_MODULE));
    const mismatched = await startError({ a: { a: 42 } });
    assert.match(mismatched.message, /from different builds/);
    assert.match(mismatched.detail ?? '', /Import #0/);
  });
});
