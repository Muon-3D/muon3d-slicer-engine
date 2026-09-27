// get_index_for_extruder: the slot of a nozzle in options stored per (extruder, nozzle variant).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VARIANT_KEYS, extruderVariantString, indexForExtruder } from './variants.ts';

const H2D = {
  variants: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'],
  ids: ['1', '1', '2', '2', '2'],
};

describe('nozzle variants', () => {
  it('names a variant as Orca does, a Hybrid nozzle as Standard', () => {
    assert.equal(extruderVariantString('Direct Drive', 'Standard'), 'Direct Drive Standard');
    assert.equal(extruderVariantString('Bowden', 'High Flow'), 'Bowden High Flow');
    assert.equal(extruderVariantString('Direct Drive', 'Hybrid'), 'Direct Drive Standard');
  });

  it('finds the slot of an extruder and variant', () => {
    assert.equal(indexForExtruder(H2D, 1, 'Direct Drive Standard'), 0);
    assert.equal(indexForExtruder(H2D, 1, 'Direct Drive High Flow'), 1);
    assert.equal(indexForExtruder(H2D, 2, 'Direct Drive Standard'), 2);
    assert.equal(indexForExtruder(H2D, 2, 'Direct Drive TPU High Flow'), 4);
    assert.equal(indexForExtruder(H2D, 1, 'Direct Drive TPU High Flow'), -1);
    assert.equal(indexForExtruder(H2D, 2, 'Direct Drive Standard', 2), 4, 'machine limits: two slots per variant');
  });

  it('matches the variant alone where the preset has no extruder ids (filaments)', () => {
    const filament = { variants: ['Direct Drive Standard', 'Direct Drive High Flow'], ids: null };
    assert.equal(indexForExtruder(filament, 2, 'Direct Drive High Flow'), 1);
    assert.equal(indexForExtruder(filament, 2, 'Bowden Standard'), -1);
  });

  it('numbers the variants through extruder_variant_list when the id list is short', () => {
    const short = {
      variants: H2D.variants,
      ids: ['1'],
      extruderVariantList: ['Direct Drive Standard,Direct Drive High Flow', 'Direct Drive Standard, Direct Drive High Flow, Direct Drive TPU High Flow'],
    };
    assert.equal(indexForExtruder(short, 2, 'Direct Drive Standard'), 2);
    assert.equal(indexForExtruder({ ...short, extruderVariantList: null }, 2, 'Direct Drive Standard'), -1);
  });

  it("uses Orca's option names per preset (extruder_variant_keys)", () => {
    assert.deepEqual(VARIANT_KEYS.machine, { id: 'printer_extruder_id', variant: 'printer_extruder_variant' });
    assert.deepEqual(VARIANT_KEYS.process, { id: 'print_extruder_id', variant: 'print_extruder_variant' });
    assert.deepEqual(VARIANT_KEYS.filament, { id: null, variant: 'filament_extruder_variant' });
  });
});
