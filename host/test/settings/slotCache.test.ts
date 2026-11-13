import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGUE } from '../../src/settings/catalogue.ts';
import { layoutCatalogue } from '../../src/settings/layout.ts';
import { slotResolver, type SettingsState } from '../../src/settings/model.ts';

test('one view resolves a nozzle variant once for all its rows, with independent silent slots', () => {
  let reads = 0;
  const machine = {
    extruder_type: ['Direct Drive', 'Direct Drive'],
    printer_extruder_id: ['1', '1', '2'],
    get printer_extruder_variant() {
      reads++;
      return ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'];
    },
  };
  const state: SettingsState = {
    catalogue: layoutCatalogue(CATALOGUE), configs: { process: null, filament: null, machine },
    overrides: { process: {}, filament: {}, machine: {} },
  };
  const resolve = slotResolver(state, 'machine');
  const def = { ...CATALOGUE.options.retraction_length, slots: 'variant' as const };
  const line = { options: [{ key: 'retraction_length' }] };
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(resolve('retraction_length', def, 'extruder', 1, line), { index: 2, ruleIndex: 1 });
    assert.deepEqual(resolve('retraction_length', def, 0, 1, { ...line, modeColumns: true }), { index: 4, ruleIndex: 0 });
  }
  assert.ok(reads <= 2, `variant table read ${reads} times for one nozzle's rows`);
  // A different nozzle, then a fresh request with changed overrides, must not reuse stale slots.
  assert.deepEqual(resolve('retraction_length', def, 'extruder', 0, line), { index: 0, ruleIndex: 0 });
  state.overrides.machine = { printer_extruder_variant: 'Direct Drive High Flow,Direct Drive Standard', printer_extruder_id: '1,2' };
  const changed = slotResolver(state, 'machine');
  assert.deepEqual(changed('retraction_length', def, 'extruder', 1, line), { index: 1, ruleIndex: 1 });
});
