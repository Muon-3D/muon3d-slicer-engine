// The slice field (docs/SLICE_FIELD.md) without the engine: the TypeScript reader and writer round trip,
// the roles' classes, the request's checks, and the builder on hand-made toolpaths (the layer index
// matches Z). test/sliceField.e2e.test.ts slices real cubes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BridgeToolpaths } from '../host/src/bridge.ts';
import { BadRequest, sliceJob } from '../host/src/ops.ts';
import { buildSliceField, fieldClass, INFILL_PATTERNS, sizeFromCode } from '../host/src/sliceField.ts';
import {
  decodeSliceField,
  encodeSliceField,
  isSliceField,
  readSliceFieldHeader,
  SLICE_FIELD_NO_DIRECTION,
  SLICE_FIELD_NO_LAYER,
  sliceFieldIndex,
  type SliceFieldArrays,
  type SliceFieldDescription,
} from '../packages/protocol/src/sliceField.ts';
import { cube } from './fixtures.ts';

const description = (dims: [number, number, number]): SliceFieldDescription => ({
  origin: [10.5, -3, 0],
  gravity: 'along_build',
  voxelSize: 0.5,
  dims,
  buildDirection: [0, 0, 1],
  material: { type: 'PLA', name: 'Generic PLA', vendor: null },
  layerHeight: 0.2,
  firstLayerHeight: 0.2,
  layerCount: 3,
  layerZ: [0.2, 0.4, 0.6],
  infillPatterns: [{ id: 0, name: 'none' }, { id: 1, name: 'gyroid' }],
  objects: [{ name: 'Part', wallLoops: 2, infillDensity: 20, infillPattern: 1 }],
});

function randomArrays(n: number, time: boolean): SliceFieldArrays {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const u8 = () => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
  const arrays: SliceFieldArrays = {
    wallFraction: u8(), skinFraction: u8(), infillFraction: u8(), infillDensity: u8(), infillPattern: u8(),
    rasterDirection: Int8Array.from({ length: n }, () => Math.floor(rnd() * 256) - 128),
    layerIndex: Uint16Array.from({ length: n }, () => Math.floor(rnd() * 65536)),
  };
  if (time) arrays.depositionTime = Float32Array.from({ length: n }, (_, i) => (i % 5 === 0 ? Number.NaN : rnd() * 1e4));
  return arrays;
}

describe('slice field file', () => {
  it('round-trips through the TypeScript reader, with and without depositionTime', () => {
    for (const time of [false, true]) {
      const dims: [number, number, number] = [3, 5, 7];
      const arrays = randomArrays(105, time);
      const bytes = encodeSliceField(description(dims), arrays);
      assert.ok(isSliceField(bytes));
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), 'MSLFIELD');
      const field = decodeSliceField(bytes);
      assert.deepEqual({ ...field.header, arrays: undefined }, { format: 'muon3d.slice-field', version: 1, units: 'mm', ...description(dims), arrays: undefined });
      for (const [name, info] of Object.entries(field.header.arrays)) assert.equal(info.offset % 8, 0, `${name} is 8-byte aligned`);
      for (const name of ['wallFraction', 'skinFraction', 'infillFraction', 'infillDensity', 'infillPattern', 'rasterDirection', 'layerIndex'] as const) {
        assert.deepEqual(Array.from(field[name]), Array.from(arrays[name]), name);
      }
      assert.equal(field.depositionTime === undefined, !time);
      if (time) assert.deepEqual(Array.from(field.depositionTime!), Array.from(arrays.depositionTime!));
      const { header, ...decoded } = field;
      assert.deepEqual(encodeSliceField(header, decoded), bytes, 'writing what was read gives the same bytes');
    }
  });

  it('stores little-endian values at the offsets the header gives', () => {
    const arrays = randomArrays(2, true);
    arrays.layerIndex.set([0x0102, 0xfffe]);
    arrays.depositionTime!.set([1.5, -2]);
    const bytes = encodeSliceField(description([2, 1, 1]), arrays);
    const header = readSliceFieldHeader(bytes);
    const view = new DataView(bytes.buffer);
    assert.equal(view.getUint32(8, true) % 8, 0);
    assert.equal(bytes[header.arrays.layerIndex!.offset], 0x02);
    assert.equal(view.getUint16(header.arrays.layerIndex!.offset + 2, true), 0xfffe);
    assert.equal(view.getFloat32(header.arrays.depositionTime!.offset + 4, true), -2);
  });

  it('reads a file that is not 8-byte aligned in memory', () => {
    const arrays = randomArrays(12, true);
    const bytes = encodeSliceField(description([2, 2, 3]), arrays);
    const shifted = new Uint8Array(bytes.length + 1).subarray(1);
    shifted.set(bytes);
    const field = decodeSliceField(shifted);
    assert.deepEqual(Array.from(field.layerIndex), Array.from(arrays.layerIndex));
    assert.deepEqual(Array.from(field.depositionTime!).map(String), Array.from(arrays.depositionTime!).map(String));
  });

  it('refuses what is not a slice field', () => {
    assert.throws(() => decodeSliceField(new TextEncoder().encode('; G-code, not a field......')), /bad magic/);
    const bytes = encodeSliceField(description([1, 1, 1]), randomArrays(1, false));
    assert.throws(() => decodeSliceField(bytes.subarray(0, bytes.length - 8)), /outside the file/);
    assert.throws(() => encodeSliceField(description([2, 1, 1]), randomArrays(1, false)), /has 1 values, the grid 2/);
  });
});

describe('slice field building', () => {
  it('counts perimeters as wall, solid infill as skin, sparse infill as infill and leaves support out', () => {
    const cases: Record<string, ReturnType<typeof fieldClass>> = {
      'Outer wall': 'wall', 'Inner wall': 'wall', 'Overhang wall': 'wall', 'Gap infill': 'wall',
      'Internal solid infill': 'skin', 'Top surface': 'skin', 'Bottom surface': 'skin', Bridge: 'skin', 'Internal Bridge': 'skin',
      'Sparse infill': 'infill',
      Support: null, 'Support interface': null, 'Support transition': null, Skirt: null, Brim: null, Ironing: null, Custom: null, 'Prime tower': null,
    };
    for (const [role, expected] of Object.entries(cases)) assert.equal(fieldClass(role), expected, role);
    assert.equal(sizeFromCode(45), 0.45);
    assert.equal(sizeFromCode(255), 4.75);
  });

  it('checks output.sliceField', () => {
    const params = (sliceField: unknown) => ({ configs: { machine: {}, process: {}, filaments: [{}] }, objects: [{ name: 'a', mesh: { positions: cube([50, 50]) } }], output: { sliceField } }) as never;
    assert.deepEqual(sliceJob(params({ voxelSize: 0.5, depositionTime: true })).sliceField, { voxelSize: 0.5, depositionTime: true });
    assert.deepEqual(sliceJob(params({})).sliceField, {});
    assert.equal(sliceJob({ ...(params({}) as object), output: {} } as never).sliceField, undefined);
    assert.throws(() => sliceJob(params({ voxelSize: 0.3 })), BadRequest);
    assert.throws(() => sliceJob(params({ depositionTime: 'yes' })), BadRequest);
  });

  // A 10 mm cube, 0.2 mm layers: one 0.4 mm wall loop on its outline and sparse lines along X 2 mm apart.
  function handMadeCube(layers: number): BridgeToolpaths {
    const segs: number[][] = [], roles: number[] = [], layerStart = [0];
    for (let L = 0; L < layers; L++) {
      const z = 0.2 * (L + 1);
      const loop = [[0.2, 0.2], [9.8, 0.2], [9.8, 9.8], [0.2, 9.8], [0.2, 0.2]];
      for (let n = 0; n < 4; n++) segs.push([...loop[n], z, ...loop[n + 1], z]), roles.push(0);
      for (let y = 1; y < 10; y += 2) segs.push([0.4, y, z, 9.6, y, z]), roles.push(1);
      layerStart.push(segs.length);
    }
    return {
      layerCount: layers,
      layerZ: Float32Array.from({ length: layers }, (_, L) => 0.2 * (L + 1)),
      extrusions: {
        positions: Float32Array.from(segs.flat()), layerStart: Uint32Array.from(layerStart), count: segs.length,
        roleIndex: Uint8Array.from(roles), width: new Uint8Array(segs.length).fill(40), height: new Uint8Array(segs.length).fill(20),
      },
      travels: { positions: new Float32Array(), layerStart: new Uint32Array(layers + 1), count: 0 },
      roles: ['Outer wall', 'Sparse infill'],
      roleLength: [0, 0],
      lineWidth: 0.4,
      bounds: null,
    };
  }

  it('samples hand-made toolpaths: the wall band, the infill region, its density and direction, the layer matching Z', () => {
    const toolpaths = handMadeCube(50);
    const { description: d, arrays: a } = buildSliceField({
      machine: {},
      process: { layer_height: '0.2', initial_layer_print_height: '0.2', sparse_infill_density: '20%', sparse_infill_pattern: 'gyroid', wall_loops: '1' },
      filaments: [{ filament_type: ['PETG'] }],
      objects: [{ name: 'Cube', positions: cube([5, 5], 10) }],
      toolpaths,
      extras: null,
      request: { voxelSize: 0.5 },
    });
    assert.deepEqual(d.dims, [20, 20, 20]);
    assert.deepEqual(d.origin, [0, 0, 0]);
    assert.equal(d.material.type, 'PETG');
    assert.equal(d.infillPatterns[d.objects[0].infillPattern].name, 'gyroid');
    assert.equal(INFILL_PATTERNS[d.objects[0].infillPattern], 'gyroid');
    const at = (i: number, j: number, k: number) => sliceFieldIndex(d, i, j, k);
    for (let k = 0; k < 20; k++) {
      // The 0.4 mm wall fills 0.8 of the outer 0.5 mm voxels, away from the corners (to a raster cell, 1/8).
      assert.ok(Math.abs(a.wallFraction[at(0, 10, k)] - 0.8 * 255) <= 255 / 8, `wall ${a.wallFraction[at(0, 10, k)]}`);
      assert.equal(a.wallFraction[at(10, 10, k)], 0);
      assert.equal(a.infillFraction[at(10, 10, k)], 255);
      assert.equal(a.infillDensity[at(10, 10, k)], 20);
      assert.equal(a.infillPattern[at(10, 10, k)], d.objects[0].infillPattern);
      // Lines along X at y = 1, 3, …: voxel row j = 2 holds y = 1.0-1.5; lines are along 0°.
      assert.equal(a.rasterDirection[at(10, 2, k)], 0);
      assert.equal(a.rasterDirection[at(10, 3, k)], SLICE_FIELD_NO_DIRECTION);
      // The layer printed at the voxel's centre: layerZ[n - 1] < z ≤ layerZ[n].
      const zc = (k + 0.5) * 0.5;
      const n = a.layerIndex[at(10, 10, k)];
      assert.ok(toolpaths.layerZ[n] >= zc - 1e-6 && (n === 0 || toolpaths.layerZ[n - 1] < zc), `layer ${n} at z ${zc}`);
    }
    assert.equal(a.depositionTime, undefined);
  });

  it('marks voxels with no material as empty', () => {
    const { arrays } = buildSliceField({
      machine: {},
      process: {}, filaments: [], objects: [{ name: 'Cube', positions: cube([5, 5], 10) }], toolpaths: handMadeCube(10), extras: null, request: {},
    });
    // Only 2 mm of the 10 mm cube is printed: the upper voxels stay empty.
    assert.equal(arrays.layerIndex[sliceFieldIndex({ dims: [10, 10, 10] }, 5, 5, 9)], SLICE_FIELD_NO_LAYER);
    assert.equal(arrays.infillFraction[sliceFieldIndex({ dims: [10, 10, 10] }, 5, 5, 9)], 0);
  });
});
