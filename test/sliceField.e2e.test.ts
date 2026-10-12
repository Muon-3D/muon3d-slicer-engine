// End-to-end: the slice field of a real slice, through the host's ops (protocol params in, protocol
// result out) and the TypeScript reader: a 20 mm cube with 2 walls and 20 % gyroid. docs/SLICE_FIELD.md.
// Skipped until the engine is built (npm run test:engine fails instead).
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { runSlice, type OrcaEngineModule } from '../host/src/bridge.ts';
import { sliceJob, sliceResult } from '../host/src/ops.ts';
import type { SliceParams } from '../packages/protocol/src/ops.ts';
import { decodeSliceField, encodeSliceField, SLICE_FIELD_NO_LAYER, sliceFieldIndex, type SliceField } from '../packages/protocol/src/sliceField.ts';
import { cube, engineSkip, m1Presets, startEngine, variant, type Presets } from './fixtures.ts';

const SIZE = 20;
const CENTER: [number, number] = [100, 90];

describe(`slice field on the engine (${variant})`, { skip: engineSkip }, () => {
  let engine: OrcaEngineModule;
  let presets: Presets;
  before(async () => {
    [{ engine }, presets] = await Promise.all([startEngine(), m1Presets()]);
  });

  function slice(output: SliceParams['output']) {
    const params: SliceParams = {
      configs: { ...presets, process: { ...presets.process, wall_loops: '2', sparse_infill_density: '20%', sparse_infill_pattern: 'gyroid' } },
      objects: [{ name: 'Cube.stl', mesh: { positions: cube(CENTER, SIZE) } }],
      output,
    };
    const result = sliceResult(runSlice(engine, sliceJob(params)), undefined);
    assert.ok(result.sliceField instanceof Uint8Array, 'the result has the field');
    return { result, field: decodeSliceField(result.sliceField) };
  }

  /** Distance of a voxel's farthest point from the cube's nearest side face, and its centre's from any face. */
  function place(f: SliceField, i: number, j: number, k: number) {
    const { origin: [ox, oy], voxelSize: v } = f.header;
    const x0 = ox + i * v - (CENTER[0] - SIZE / 2), y0 = oy + j * v - (CENTER[1] - SIZE / 2);
    const side = (a: number) => Math.min(a, SIZE - a);
    const fx = Math.max(side(x0), side(x0 + v)), fy = Math.max(side(y0), side(y0 + v));
    const far = Math.min(fx, fy);
    // The vertical edges: a bead turning a corner leaves its radius unfilled there, so they are not all wall.
    const edge = fx <= 1 && fy <= 1;
    const zc = (k + 0.5) * v;
    const near = Math.min(side(x0 + v / 2), side(y0 + v / 2), zc, SIZE - zc);
    return { far, near, zc, edge };
  }

  for (const voxelSize of [0.5, 1]) {
    it(`${voxelSize} mm voxels: walls within 0.8 mm of the surface, none in the core, 20 % gyroid infill in the core`, () => {
      const { field: f } = slice({ toolpaths: false, sliceField: { voxelSize } });
      const h = f.header;
      assert.deepEqual(h.dims, [SIZE / voxelSize, SIZE / voxelSize, SIZE / voxelSize]);
      assert.deepEqual(h.origin, [CENTER[0] - SIZE / 2, CENTER[1] - SIZE / 2, 0]);
      const gyroid = h.infillPatterns.find((p) => p.name === 'gyroid')!.id;
      assert.deepEqual(h.objects, [{ name: 'Cube.stl', wallLoops: 2, infillDensity: 20, infillPattern: gyroid }]);
      let walls = 0, cores = 0;
      for (let k = 0; k < h.dims[2]; k++) {
        for (let j = 0; j < h.dims[1]; j++) {
          for (let i = 0; i < h.dims[0]; i++) {
            const at = sliceFieldIndex(h, i, j, k);
            const { far, near, zc, edge } = place(f, i, j, k);
            // Side walls between the bottom and top skins: a voxel wholly within 0.8 mm of a side is all wall.
            if (far <= 0.8 + 1e-9 && !edge && zc > 1.5 && zc < SIZE - 1.5) {
              walls++;
              assert.equal(f.wallFraction[at], 255, `wall at ${i},${j},${k}`);
            }
            if (near >= 2) {
              cores++;
              assert.equal(f.wallFraction[at], 0, `no wall in the core at ${i},${j},${k}`);
              assert.equal(f.skinFraction[at], 0, `no skin in the core at ${i},${j},${k}`);
              assert.equal(f.infillFraction[at], 255, `infill in the core at ${i},${j},${k}`);
              assert.equal(f.infillDensity[at], 20);
              assert.equal(f.infillPattern[at], gyroid);
            }
          }
        }
      }
      assert.ok(cores > 0);
      // 1 mm voxels at the surface hold the 0.82 mm wall band and some infill: none lies wholly within 0.8 mm.
      if (voxelSize === 0.5) assert.ok(walls > 0);
      else {
        const surface = sliceFieldIndex(h, 0, h.dims[1] >> 1, h.dims[2] >> 1);
        assert.ok(f.wallFraction[surface] >= 0.75 * 255 && f.wallFraction[surface] <= 0.95 * 255, `surface wall ${f.wallFraction[surface]}`);
        assert.equal(f.wallFraction[surface] + f.infillFraction[surface], 255);
      }
    });
  }

  it('the layer index matches Z, and the skins sit at the bottom and top', () => {
    const { result, field: f } = slice({ sliceField: { voxelSize: 0.5, depositionTime: true } });
    const h = f.header;
    const layerZ = result.toolpaths!.layerZ;
    assert.equal(h.layerCount, result.toolpaths!.layerCount);
    assert.deepEqual(h.layerZ, Array.from(layerZ, (z) => Math.round(z * 1e4) / 1e4));
    assert.equal(h.layerHeight, 0.2);
    assert.equal(h.material.type, 'PLA');
    for (let k = 0; k < h.dims[2]; k++) {
      const zc = (k + 0.5) * h.voxelSize;
      for (let at = sliceFieldIndex(h, 0, 0, k), end = sliceFieldIndex(h, 0, 0, k + 1); at < end; at++) {
        const n = f.layerIndex[at];
        assert.notEqual(n, SLICE_FIELD_NO_LAYER);
        assert.ok(layerZ[n] >= zc - 1e-4 && (n === 0 || layerZ[n - 1] < zc), `voxel slab ${k} (z ${zc}) in layer ${n}`);
      }
    }
    const middle = (k: number) => sliceFieldIndex(h, h.dims[0] >> 1, h.dims[1] >> 1, k);
    assert.equal(f.skinFraction[middle(0)], 255, '3 bottom layers: 0.6 mm of skin');
    assert.equal(f.skinFraction[middle(h.dims[2] - 1)], 255, '4 top layers: 0.8 mm of skin');
    // Deposition time grows with the layers.
    const times = Array.from({ length: h.dims[2] }, (_, k) => f.depositionTime![middle(k)]).filter(Number.isFinite);
    assert.ok(times.length > 0 && times.every((t, n) => n === 0 || t > times[n - 1]), `times ${times.join(' ')}`);
  });

  it('round-trips the engine\'s file through the TypeScript reader byte for byte', () => {
    const { result, field } = slice({ toolpaths: false, sliceField: {} });
    assert.equal(result.toolpaths, null, 'toolpaths stay off when only the field is asked for');
    assert.equal(field.header.voxelSize, 1);
    assert.equal(field.depositionTime, undefined);
    const { header, ...arrays } = field;
    assert.deepEqual(encodeSliceField(header, arrays), result.sliceField);
  });
});
