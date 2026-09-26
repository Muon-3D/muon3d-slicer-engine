// End-to-end: setting overrides of every kind of Orca option, converted by shared/overrides.ts the
// way the browser job does (web/src/engine/localJob.ts), reach the G-code the in-browser engine
// writes, read back from its CONFIG block; engine-only options included. The server CLI's side
// is server/settingsOverrides.e2e.test.ts. Skipped until the engine is built.
//
// The engine and its test fixtures are imported by URL: the fixtures set ORCA_RESOURCES (the
// engine's Orca profiles) before anything reads the server config, and the browser worker must
// not be pulled into the Node type check.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyOverrides, presetValueText } from '../overrides.ts';
import type { FlatConfig, SettingOverrides } from '../types.ts';

interface Presets {
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];
}

const root = new URL('../../', import.meta.url);
const fixtures = (await import(new URL('engine/test/fixtures.ts', root).href)) as {
  engineBuilt: boolean;
  engineModulePath: string;
  m1ResourcesAvailable: boolean;
  startEngine(): Promise<{ engine: unknown }>;
  m1Presets(): Promise<Presets>;
  cube(center: [number, number], size?: number): Float32Array;
};

const skip = !fixtures.engineBuilt
  ? `${fixtures.engineModulePath} not found: build the engine first`
  : !fixtures.m1ResourcesAvailable && 'no Muon3D M1 profiles in the engine\'s Orca resources';

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

describe('setting overrides on the engine', { skip }, () => {
  it('slices with converted overrides of every kind, engine-only options too, and writes them into the G-code', async () => {
    const worker = (await import(new URL('web/src/engine/worker.ts', root).href)) as {
      runSlice(engine: unknown, job: Presets & { objects: Array<{ name: string; positions: Float32Array }>; toolpaths: boolean }): { gcode: Uint8Array };
    };
    const [{ engine }, presets] = await Promise.all([fixtures.startEngine(), fixtures.m1Presets()]);
    const bed = presetValueText('printable_area', presets.machine.printable_area);
    const overrides: SettingOverrides = {
      machine: { retraction_length: '1.3', z_hop_types: 'Auto Lift', printable_area: bed, bed_mesh_probe_distance: '30,30' },
      process: {
        sparse_infill_density: '23%', outer_wall_line_width: '105%', outer_wall_speed: '123', seam_position: 'back',
        enable_arc_fitting: 'false', wipe_inward: 'true', print_order: 'snake',
      },
      filament: { nozzle_temperature: '222', filament_retraction_length: '1.1', filament_start_gcode: '; web slicer start\nM117 overrides ok' },
    };
    const job = {
      machine: applyOverrides(presets.machine, overrides.machine),
      process: applyOverrides(presets.process, overrides.process),
      filaments: presets.filaments.map((f) => applyOverrides(f, overrides.filament)),
      objects: [{ name: 'Cube.stl', positions: fixtures.cube([100, 100]) }],
      toolpaths: false,
    };
    const gcode = new TextDecoder().decode(worker.runSlice(engine, job).gcode);
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
      wipe_inward: '1', // only the engine's Orca knows it
      print_order: 'snake', // an enum value only the engine's Orca knows
      nozzle_temperature: '222', // per filament
      filament_retraction_length: '1.1', // nullable filament override
      filament_start_gcode: '"; web slicer start\\nM117 overrides ok"', // one text slot, ";" comment and all
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(block.get(key), value, key);
    assert.match(gcode, /^M117 overrides ok$/m, 'the filament start G-code ran');
  });
});
