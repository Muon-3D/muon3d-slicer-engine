// End-to-end: setting overrides of every kind of Orca option, converted to each preset's JSON shape
// (test/helpers/overrides.ts, by the option types in the settings catalogue), reach the G-code the
// engine writes, read back from its CONFIG block; options only newer Orca builds know included.
// Skipped until the engine is built (npm run test:engine fails instead).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSlice } from '../host/src/worker.ts';
import { cube, engineSkip, m1Presets, startEngine, variant } from './fixtures.ts';
import { applyOverrides, presetValueText } from './helpers/overrides.ts';

/** The `; key = value` lines between CONFIG_BLOCK_START and CONFIG_BLOCK_END. */
function configBlock(gcode: string): Map<string, string> {
  const start = gcode.indexOf('; CONFIG_BLOCK_START');
  const end = gcode.indexOf('; CONFIG_BLOCK_END', start);
  assert.ok(start >= 0 && end > start, 'the G-code has a CONFIG block');
  const out = new Map<string, string>();
  for (const line of gcode.slice(start, end).split('\n')) {
    const m = /^; (\w+) = (.*)$/.exec(line.trimEnd());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

describe(`setting overrides on the engine (${variant})`, { skip: engineSkip }, () => {
  it('slices with converted overrides of every kind, newer options too, and writes them into the G-code', async () => {
    const [{ engine }, presets] = await Promise.all([startEngine(), m1Presets()]);
    const bed = presetValueText('printable_area', presets.machine.printable_area);
    const overrides = {
      machine: { retraction_length: '1.3', z_hop_types: 'Auto Lift', printable_area: bed, bed_mesh_probe_distance: '30,30' },
      process: {
        sparse_infill_density: '23%', outer_wall_line_width: '105%', outer_wall_speed: '123', seam_position: 'back',
        enable_arc_fitting: 'false', wipe_inward: 'true', print_order: 'snake',
      },
      filament: { nozzle_temperature: '222', filament_retraction_length: '1.1', filament_start_gcode: '; engine test start\nM117 overrides ok' },
    };
    const job = {
      machine: applyOverrides(presets.machine, overrides.machine),
      process: applyOverrides(presets.process, overrides.process),
      filaments: presets.filaments.map((f) => applyOverrides(f, overrides.filament)),
      objects: [{ name: 'Cube.stl', positions: cube([100, 100]) }],
      toolpaths: false,
    };
    const gcode = new TextDecoder().decode(runSlice(engine, job).gcode);
    const block = configBlock(gcode);
    const expected: Record<string, string> = {
      retraction_length: '1.3', // per extruder
      z_hop_types: 'Auto Lift', // per-extruder enum
      printable_area: bed, // a list of points
      bed_mesh_probe_distance: '30,30', // a point
      sparse_infill_density: '23%', // percent
      outer_wall_line_width: '105%', // mm or %
      outer_wall_speed: '123', // per variant
      seam_position: 'back', // enum
      enable_arc_fitting: '0', // bool written 1/0
      wipe_inward: '1', // an option older Orca builds lack
      print_order: 'snake', // an enum value older Orca builds lack
      nozzle_temperature: '222', // per filament
      filament_retraction_length: '1.1', // nullable filament override
      filament_start_gcode: '"; engine test start\\nM117 overrides ok"', // one text slot, ";" comment and all
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(block.get(key), value, key);
    assert.match(gcode, /^M117 overrides ok$/m, 'the filament start G-code ran');
  });
});
