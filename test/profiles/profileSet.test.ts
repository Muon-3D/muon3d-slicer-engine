// flattenPreset and canonicalConfigJson (packages/protocol/src/profileSet.ts) on small hand-made bundles: the lookup
// order OrcaSlicer uses, renamed presets, the recorded adjustments, the inherited filament id. The engine's CI checks
// the same code against OrcaSlicer's own loader for every preset of the library (tools/profiles/check.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config, PresetScope } from '../../packages/protocol/src/data.ts';
import { PresetNotFoundError, canonicalConfigJson, currentPresetName, flattenPreset, type VendorBundle } from '../../packages/protocol/src/profileSet.ts';

const defaults: Record<PresetScope, Config> = {
  machine: { inherits: '', nozzle_diameter: ['0.4'], printable_height: '100', gcode_flavor: 'marlin' },
  process: { inherits: '', layer_height: '0.2', wall_loops: '2', compatible_printers: [] },
  filament: { inherits: '', nozzle_temperature: ['200'], filament_type: ['PLA'], compatible_printers: [] },
};

function bundle(id: string, presets: Partial<VendorBundle['presets']>, extra: Partial<VendorBundle> = {}): VendorBundle {
  return {
    format: 1,
    vendor: { id, name: id, version: '01.00.00.00' },
    models: {},
    presets: { machine: {}, process: {}, filament: {}, ...presets },
    adjust: {},
    renamed: { machine: {}, process: {}, filament: {} },
    assets: {},
    report: { renamed: {}, dropped: {}, misplaced: {}, substituted: 0 },
    ...extra,
  };
}

const library = bundle('OrcaFilamentLibrary', {
  filament: {
    fdm_filament_common: { type: 'filament', name: 'fdm_filament_common', instantiation: 'false', nozzle_temperature: ['210'] },
    'Generic PLA @System': { type: 'filament', name: 'Generic PLA @System', inherits: 'fdm_filament_common', filament_id: 'OFPLA', instantiation: 'true' },
    // A process-type name in the library: a vendor's process must never find it.
    fdm_process_common: { type: 'filament', name: 'fdm_process_common', instantiation: 'false', nozzle_temperature: ['999'] },
  },
});

const vendor = bundle(
  'Acme',
  {
    machine: {
      fdm_machine_common: { type: 'machine', name: 'fdm_machine_common', instantiation: 'false', gcode_flavor: 'klipper' },
      'Acme One 0.4 nozzle': { type: 'machine', name: 'Acme One 0.4 nozzle', inherits: 'fdm_machine_common', instantiation: 'true', setting_id: 'X', printable_height: '250' },
    },
    process: {
      fdm_process_common: { type: 'process', name: 'fdm_process_common', instantiation: 'false', wall_loops: '3' },
      '0.20mm Standard @Acme': { type: 'process', name: '0.20mm Standard @Acme', inherits: 'fdm_process_common', instantiation: 'true', compatible_printers: ['Acme One 0.4 nozzle'] },
      '0.25mm Fast @Acme': { type: 'process', name: '0.25mm Fast @Acme', inherits: '0.20mm Standard @Acme', instantiation: 'true', layer_height: '0.25' },
    },
    filament: {
      'Generic PLA @Acme': { type: 'filament', name: 'Generic PLA @Acme', inherits: 'Generic PLA @System', instantiation: 'true', nozzle_temperature: ['215'] },
      'Acme Silk @Acme': { type: 'filament', name: 'Acme Silk @Acme', inherits: 'Generic PLA @Acme', filament_id: 'OFSILK', instantiation: 'true' },
    },
  },
  {
    adjust: { machine: { 'Acme One 0.4 nozzle': { nozzle_diameter: ['0.4', '0.4'] } } },
    renamed: { machine: {}, process: { '0.20mm Standard Acme': '0.20mm Standard @Acme' }, filament: {} },
  },
);

const sources = { vendor, library, defaults };

test('flattenPreset: the defaults, then the chain from the root to the preset, then the adjustments; stamped', () => {
  const machine = flattenPreset('machine', 'Acme One 0.4 nozzle', sources);
  assert.deepEqual(machine, {
    inherits: '',
    nozzle_diameter: ['0.4', '0.4'],
    printable_height: '250',
    gcode_flavor: 'klipper',
    name: 'Acme One 0.4 nozzle',
    from: 'system',
    type: 'machine',
  });
  // An instantiated parent: the child gets its settings, not its name.
  const fast = flattenPreset('process', '0.25mm Fast @Acme', sources);
  assert.equal(fast.layer_height, '0.25');
  assert.equal(fast.wall_loops, '3');
  assert.deepEqual(fast.compatible_printers, ['Acme One 0.4 nozzle']);
  assert.equal(fast.name, '0.25mm Fast @Acme');
});

test('flattenPreset: filaments continue in the library, other types never; the filament id is inherited', () => {
  const pla = flattenPreset('filament', 'Generic PLA @Acme', sources);
  assert.deepEqual(pla.nozzle_temperature, ['215']);
  assert.equal(pla.filament_id, 'OFPLA', 'from the library parent');
  const silk = flattenPreset('filament', 'Acme Silk @Acme', sources);
  assert.equal(silk.filament_id, 'OFSILK', 'its own');
  // The vendor's process chain ends at the vendor's own fdm_process_common, never the library's.
  assert.equal(flattenPreset('process', '0.20mm Standard @Acme', sources).wall_loops, '3');
  // A library preset asked for through a vendor.
  assert.equal(flattenPreset('filament', 'Generic PLA @System', sources).nozzle_temperature[0], '210');
  assert.throws(() => flattenPreset('process', 'Generic PLA @System', sources), PresetNotFoundError);
});

test('flattenPreset: an old name finds the renamed preset; missing parents and loops are errors', () => {
  assert.equal(currentPresetName(vendor, 'process', '0.20mm Standard Acme'), '0.20mm Standard @Acme');
  assert.equal(flattenPreset('process', '0.20mm Standard Acme', sources).name, '0.20mm Standard @Acme');
  const broken = bundle('Broken', {
    process: {
      a: { name: 'a', inherits: 'b', instantiation: 'true' },
      b: { name: 'b', inherits: 'a', instantiation: 'false' },
      c: { name: 'c', inherits: 'nowhere', instantiation: 'true' },
    },
  });
  assert.throws(() => flattenPreset('process', 'a', { ...sources, vendor: broken }), /inherits from itself/);
  assert.throws(() => flattenPreset('process', 'c', { ...sources, vendor: broken }), /inherits "nowhere", which is missing/);
  assert.throws(() => flattenPreset('process', 'zzz', sources), /No process preset "zzz" in Acme/);
});

test('canonicalConfigJson: every setting sorted, without the stamps', () => {
  const text = canonicalConfigJson({ type: 'process', name: 'n', from: 'system', version: '1', instantiation: 'true', wall_loops: '3', inherits: '', b: ['1'] });
  assert.equal(text, '{"b":["1"],"inherits":"","wall_loops":"3"}');
});
