// Run: node --test web/src/engine/worker.test.ts
// The worker's engine-facing functions against a fake engine module (the real one is exercised by
// engine/test/slice.ts once the engine is built).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CheckOutput, EngineWarning, SliceJob, SliceOutput } from './protocol.ts';
import { EngineJobError, engineFailure, runCheck, runSlice, sliceTransferables, type OrcaEngineModule } from './worker.ts';

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
  // gcode, layerZ, extrusion positions/layerStart/roleIndex/width, travel layerStart, 4 extras.
  assert.equal(transfer.length, 11);
});
