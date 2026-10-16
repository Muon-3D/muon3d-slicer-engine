// The slice field's gravity (docs/SLICE_FIELD.md, docs/PROFILES.md §9.1): read from the printer profile, never assumed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decodeSliceField, encodeSliceField, printerGravity, type SliceFieldArrays, type SliceFieldDescription, type SliceFieldGravity } from '../packages/protocol/src/sliceField.ts';

function tiny(gravity: SliceFieldGravity | null): { description: SliceFieldDescription; arrays: SliceFieldArrays } {
  const n = 2;
  return {
    description: {
      origin: [0, 0, 0], voxelSize: 1, dims: [2, 1, 1], buildDirection: [0, 0, 1], gravity,
      material: { type: 'PLA', name: null, vendor: null }, layerHeight: 0.2, firstLayerHeight: 0.2, layerCount: 5,
      layerZ: [0.2, 0.4, 0.6, 0.8, 1], infillPatterns: [{ id: 0, name: 'none' }], objects: [],
    },
    arrays: {
      wallFraction: new Uint8Array([255, 0]), skinFraction: new Uint8Array(n), infillFraction: new Uint8Array([0, 255]),
      infillDensity: new Uint8Array([0, 20]), infillPattern: new Uint8Array(n), rasterDirection: new Int8Array(n), layerIndex: new Uint16Array([2, 2]),
    },
  };
}

describe('slice field gravity', () => {
  it('reads the printer_notes line, and gives null rather than a guess', () => {
    assert.equal(printerGravity('gravity = along_build'), 'along_build');
    assert.equal(printerGravity('Some notes\nGravity: against_build\nmore'), 'against_build');
    assert.equal(printerGravity(['first', 'gravity=along_build']), 'along_build');
    assert.equal(printerGravity('a\\ngravity = along_build'), 'along_build');
    assert.equal(printerGravity(undefined), null);
    assert.equal(printerGravity(''), null);
    assert.equal(printerGravity('gravity = down'), null);
    assert.equal(printerGravity('gravity = along_build\ngravity = against_build'), null);
    assert.equal(printerGravity('the gravity = along_build line is missing'), null);
  });

  it('round-trips through the header, and refuses another value', () => {
    for (const gravity of ['along_build', 'against_build', null] as const) {
      const { description, arrays } = tiny(gravity);
      assert.equal(decodeSliceField(encodeSliceField(description, arrays)).header.gravity, gravity);
    }
    const { description, arrays } = tiny('along_build');
    assert.throws(() => decodeSliceField(encodeSliceField({ ...description, gravity: 'down' as SliceFieldGravity }, arrays)), /gravity down/);
  });

  it('the Muon3D M1 profile says along_build', () => {
    const m1 = JSON.parse(readFileSync(new URL('../profiles/muon3d/Muon3D/machine/fdm_common_muon_m1.json', import.meta.url), 'utf8')) as { printer_notes?: string };
    assert.equal(printerGravity(m1.printer_notes), 'along_build');
  });
});
