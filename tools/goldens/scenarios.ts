// The inputs of the settings goldens (test/goldens/settings/): which presets, and which scripted
// edit sequences in the global, object and plate scopes. Pure data plus the preset sampler; the
// recorders (record-presets.ts, record-rules.ts) and the replaying tests share it.
//
//   - every Muon3D M1 printer (each nozzle) with every process and filament that lists it;
//   - SAMPLE_SIZE printers sampled evenly across every other vendor (Bambu Lab's H2D always among
//     them: two extruders with nozzle variants), each with a process and a filament that suit it;
//   - EDIT_SCRIPTS: edits a user makes, one after the other, in each scope.
type ConfigPatch = Record<string, string>;
import { FILAMENT_LIBRARY, listsPrinter, type ProfileTree } from './profiles.ts';

export const SAMPLE_SIZE = 50;

/** One printer + process + filament combination, by preset id ("<type>/<vendor>/<name>"). */
export interface PresetCase {
  id: string;
  vendor: string;
  machine: string;
  process: string;
  filament: string;
}

export const presetId = (type: string, vendor: string, name: string) => `${type}/${vendor}/${name}`;

/** The M1 matrix and the vendor sample, in a stable order. */
export function presetCases(tree: ProfileTree): PresetCase[] {
  const cases: PresetCase[] = [];
  const add = (vendor: string, machine: string, process: { vendor: string; name: string }, filament: { vendor: string; name: string }) =>
    cases.push({
      id: `${vendor}: ${machine} | ${process.name} | ${filament.name}`,
      vendor,
      machine: presetId('machine', vendor, machine),
      process: presetId('process', process.vendor, process.name),
      filament: presetId('filament', filament.vendor, filament.name),
    });

  // Muon3D M1: every nozzle, every process and filament that lists it.
  for (const machine of tree.instantiable('machine', 'Muon3D')) {
    const processes = tree.instantiable('process', 'Muon3D').filter((p) => listsPrinter(tree.flatten('process', 'Muon3D', p), machine, false));
    const filaments = tree.instantiable('filament', 'Muon3D').filter((f) => listsPrinter(tree.flatten('filament', 'Muon3D', f), machine, false));
    for (const process of processes) for (const filament of filaments) add('Muon3D', machine, { vendor: 'Muon3D', name: process }, { vendor: 'Muon3D', name: filament });
  }

  // Every other vendor's printers, sampled evenly (the H2D forced in), each with a process and a
  // filament that list it: the process nearest 0.20 mm, a PLA if there is one (else the library's).
  const machines: Array<{ vendor: string; name: string }> = [];
  for (const vendor of [...tree.vendors.keys()].sort()) {
    if (vendor === 'Muon3D' || vendor === FILAMENT_LIBRARY) continue;
    for (const name of tree.instantiable('machine', vendor)) machines.push({ vendor, name });
  }
  const picked: Array<{ vendor: string; name: string }> = [];
  const suitable = (m: { vendor: string; name: string }) => {
    const process = tree.instantiable('process', m.vendor).filter((p) => listsPrinter(tree.flatten('process', m.vendor, p), m.name, false));
    return process.length > 0 ? process : null;
  };
  const h2d = machines.find((m) => m.vendor === 'BBL' && m.name === 'Bambu Lab H2D 0.4 nozzle');
  if (h2d && suitable(h2d)) picked.push(h2d);
  const step = machines.length / SAMPLE_SIZE;
  for (let i = 0; picked.length < SAMPLE_SIZE && i < machines.length * 2; i++) {
    const m = machines[Math.floor((i * step) % machines.length) + (i >= SAMPLE_SIZE ? 1 : 0)];
    if (!m || picked.some((p) => p.vendor === m.vendor && p.name === m.name) || !suitable(m)) continue;
    picked.push(m);
  }
  for (const m of picked) {
    const processes = suitable(m)!;
    const height = (name: string) => Math.abs((Number.parseFloat(/(\d+\.\d+)\s*mm/.exec(name)?.[1] ?? '9') || 9) - 0.2);
    const process = [...processes].sort((a, b) => height(a) - height(b) || a.localeCompare(b))[0];
    const own = tree.instantiable('filament', m.vendor).filter((f) => listsPrinter(tree.flatten('filament', m.vendor, f), m.name, false));
    const pla = own.find((f) => /\bPLA\b/.test(f) && !/(CF|Silk|Matte|Tough|Wood|Marble|Glow|Metal|Galaxy|Sparkle|Aero|Lite)/i.test(f)) ?? own.find((f) => /\bPLA\b/.test(f));
    const filament = pla ? { vendor: m.vendor, name: pla } : { vendor: FILAMENT_LIBRARY, name: 'Generic PLA @System' };
    add(m.vendor, m.name, { vendor: m.vendor, name: process }, filament);
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------
// Scripted edits
// ---------------------------------------------------------------------------------------------

export type PresetScope = 'process' | 'filament' | 'machine';
export type PanelMode = 'simple' | 'advanced' | 'expert';

/** One user edit: slot `index` of `key` (undefined = the whole setting) set to `value`. */
export interface EditStep {
  scope: PresetScope;
  key: string;
  value: string;
  index?: number;
}

export interface GlobalScript {
  id: string;
  /** A PresetCase id. */
  case: string;
  mode?: PanelMode;
  /** The active plate's own settings. */
  plate?: ConfigPatch;
  steps: EditStep[];
}

export type ObjectStep = { add: string } | { set: string; value: string } | { remove: string };

export interface ObjectScript {
  id: string;
  case: string;
  mode?: PanelMode;
  /** Global overrides in place before the object is edited. */
  overrides?: Partial<Record<PresetScope, ConfigPatch>>;
  plate?: ConfigPatch;
  /** The object's settings to start from. */
  settings?: ConfigPatch;
  steps: ObjectStep[];
}

export interface PlateScript {
  id: string;
  case: string;
  overrides?: Partial<Record<PresetScope, ConfigPatch>>;
  /** The plate's objects and their own settings. */
  objects: Array<{ id: string; settings?: ConfigPatch }>;
  settings?: ConfigPatch;
  steps: Array<{ key: string; value: string | null }>;
}

const M1 = 'Muon3D: Muon3D M1 0.4 nozzle | 0.20mm Standard @Muon3D M1 | Generic PLA @Muon3D M1';
const M1_PETG = 'Muon3D: Muon3D M1 0.4 nozzle | 0.20mm Standard @Muon3D M1 | Generic PETG @Muon3D M1';
const M1_FINE = 'Muon3D: Muon3D M1 0.2 nozzle | 0.08mm Extra Fine @Muon3D M1 | Generic PLA @Muon3D M1';
/** Resolved against the sample by vendor and printer name prefix (the recorders fail if it is missing). */
export const H2D = 'BBL: Bambu Lab H2D 0.4 nozzle';

const p = (key: string, value: string, index?: number): EditStep => ({ scope: 'process', key, value, ...(index !== undefined ? { index } : {}) });
const f = (key: string, value: string, index?: number): EditStep => ({ scope: 'filament', key, value, ...(index !== undefined ? { index } : {}) });
const m = (key: string, value: string, index?: number): EditStep => ({ scope: 'machine', key, value, ...(index !== undefined ? { index } : {}) });

export const GLOBAL_SCRIPTS: GlobalScript[] = [
  {
    id: 'spiral-vase',
    case: M1,
    steps: [p('spiral_mode', '1'), p('wall_loops', '1'), p('top_shell_layers', '0'), p('sparse_infill_density', '0%'), p('enable_support', '0'), p('spiral_mode', '0')],
  },
  {
    id: 'supports-simple-mode',
    case: M1,
    mode: 'simple',
    steps: [p('enable_support', '1'), p('support_type', 'tree(auto)'), p('support_style', 'tree_organic'), p('support_type', 'normal(auto)'), p('enable_support', '0')],
  },
  {
    id: 'supports-expert-mode',
    case: M1,
    mode: 'expert',
    steps: [p('enable_support', '1'), p('support_type', 'tree(manual)'), p('support_style', 'grid'), p('support_interface_top_layers', '0'), p('raft_layers', '2')],
  },
  {
    id: 'layer-height',
    case: M1,
    steps: [p('layer_height', '0'), p('layer_height', '0.5'), p('layer_height', '0.01'), p('layer_height', '0.12'), p('initial_layer_print_height', '0.3')],
  },
  {
    id: 'walls-and-infill',
    case: M1,
    mode: 'expert',
    steps: [
      p('wall_generator', 'arachne'), p('fuzzy_skin', 'allwalls'), p('fuzzy_skin_mode', 'displacement'), p('wall_generator', 'classic'),
      p('alternate_extra_wall', '1'), p('ensure_vertical_shell_thickness', 'none'), p('sparse_infill_pattern', 'gyroid'),
      p('sparse_infill_rotate_template', '0,90'), p('sparse_infill_pattern', 'rectilinear'), p('fill_multiline', '3'), p('sparse_infill_pattern', 'lightning'),
      p('overhang_reverse', '1'), p('overhang_reverse_internal_only', '1'), p('make_overhang_printable', '1'), p('precise_z_height', '1'),
    ],
  },
  {
    id: 'arc-fitting-and-ironing',
    case: M1,
    mode: 'expert',
    steps: [p('enable_arc_fitting', '1'), p('ironing_type', 'top'), p('ironing_pattern', 'concentric'), p('seam_slope_type', 'all'), p('seam_slope_conditional', '1')],
  },
  {
    id: 'prime-tower-and-timelapse',
    case: M1,
    mode: 'expert',
    steps: [p('enable_prime_tower', '1'), p('timelapse_type', '1'), p('wipe_tower_no_sparse_layers', '1'), p('precise_z_height', '1'), p('enable_prime_tower', '0'), p('timelapse_type', '0')],
  },
  {
    id: 'print-sequence',
    case: M1,
    steps: [p('print_sequence', 'by object'), p('print_sequence', 'by layer'), p('print_sequence', 'by object')],
  },
  {
    id: 'filament-temperatures-and-cooling',
    case: M1,
    mode: 'expert',
    steps: [
      f('nozzle_temperature', '400', 0), f('nozzle_temperature', '150', 0), f('nozzle_temperature_initial_layer', '215', 0),
      f('chamber_temperatures', '60', 0), f('activate_chamber_temp_control', '1', 0), f('filament_max_volumetric_speed', '0.2', 0),
      f('close_fan_the_first_x_layers', '0', 0), f('full_fan_speed_layer', '1', 0), f('fan_cooling_layer_time', '30', 0),
      f('filament_type', 'PETG', 0), f('enable_pressure_advance', '1', 0), f('adaptive_pressure_advance', '1', 0),
      f('adaptive_pressure_advance_model', '0.4,0.5,0.6\\n0.3,0.4', 0),
    ],
  },
  {
    id: 'filament-overrides',
    case: M1_PETG,
    mode: 'expert',
    steps: [
      f('filament_retraction_length', '1.2', 0), f('filament_retract_before_wipe', '80%', 0), f('filament_retract_after_wipe', '50%', 0),
      f('filament_wipe', '1', 0), f('filament_retraction_length', 'nil', 0), f('filament_z_hop', '0.4', 0), f('filament_z_hop_types', 'Spiral Lift', 0),
    ],
  },
  {
    id: 'machine-firmware-and-limits',
    case: M1,
    mode: 'expert',
    steps: [
      m('gcode_flavor', 'marlin2'), m('silent_mode', '1'), m('machine_max_acceleration_x', '8000,6000'), m('emit_machine_limits_to_gcode', '0'),
      m('use_firmware_retraction', '1'), m('wipe', '1', 0), m('retract_before_wipe', '120%', 0), m('retract_after_wipe', '40%', 0),
      m('z_hop', '0.6', 0), m('retract_lift_enforce', 'Top Only', 0), m('gcode_flavor', 'klipper'), m('use_relative_e_distances', '0'),
      m('input_shaping_enable', '1'), m('min_layer_height', '0.08', 0), m('max_layer_height', '0.3', 0),
    ],
  },
  {
    id: 'fine-nozzle',
    case: M1_FINE,
    mode: 'advanced',
    steps: [p('layer_height', '0.2'), p('line_width', '0.25'), p('outer_wall_line_width', '150%'), p('initial_layer_line_width', '0.3')],
  },
  {
    id: 'plate-bed-type',
    case: M1,
    plate: { curr_bed_type: 'Textured PEI Plate' },
    steps: [f('hot_plate_temp', '70', 0), f('textured_plate_temp', '65', 0), p('curr_bed_type', 'Cool Plate')],
  },
  {
    id: 'h2d-variants',
    case: H2D,
    mode: 'expert',
    steps: [
      p('outer_wall_speed', '120', 0), p('outer_wall_speed', '90', 1), p('enable_prime_tower', '0'), p('enable_prime_tower', '1'),
      p('enable_wrapping_detection', '1'), m('min_layer_height', '0.1', 1), m('retraction_length', '1.4', 1), f('filament_max_volumetric_speed', '12', 0),
      p('support_filament', '1'), p('support_interface_filament', '1'),
    ],
  },
];

export const OBJECT_SCRIPTS: ObjectScript[] = [
  {
    id: 'object-quality',
    case: M1,
    steps: [{ add: 'layer_height' }, { set: 'layer_height', value: '0' }, { set: 'layer_height', value: '0.5' }, { set: 'layer_height', value: '0.12' }, { add: 'wall_loops' }, { set: 'wall_loops', value: '5' }],
  },
  {
    id: 'object-supports',
    case: M1,
    mode: 'simple',
    steps: [{ add: 'enable_support' }, { set: 'enable_support', value: '1' }, { add: 'support_type' }, { set: 'support_type', value: 'tree(auto)' }, { set: 'support_style', value: 'tree_slim' }, { remove: 'support_type' }],
  },
  {
    id: 'object-spiral',
    case: M1,
    settings: { wall_loops: '3' },
    steps: [{ set: 'spiral_mode', value: '1' }, { set: 'sparse_infill_density', value: '15%' }, { set: 'top_shell_layers', value: '0' }, { remove: 'wall_loops' }],
  },
  {
    id: 'object-overhangs',
    case: M1,
    mode: 'expert',
    overrides: { process: { enable_support: '1' } },
    plate: { print_sequence: 'by object' },
    steps: [{ set: 'make_overhang_printable', value: '1' }, { set: 'overhang_reverse', value: '1' }, { set: 'sparse_infill_rotate_template', value: '0,45' }, { set: 'precise_z_height', value: '1' }, { set: 'fuzzy_skin', value: 'external' }, { set: 'wall_generator', value: 'arachne' }],
  },
  {
    id: 'object-h2d',
    case: H2D,
    mode: 'expert',
    steps: [{ add: 'outer_wall_speed' }, { set: 'outer_wall_speed', value: '100,80' }, { add: 'sparse_infill_density' }, { set: 'sparse_infill_density', value: '0%' }],
  },
];

export const PLATE_SCRIPTS: PlateScript[] = [
  {
    id: 'plate-spiral-two-objects',
    case: M1,
    objects: [{ id: 'a' }, { id: 'b', settings: { wall_loops: '3', top_shell_layers: '0' } }],
    steps: [{ key: 'spiral_mode', value: '1' }, { key: 'print_sequence', value: 'by object' }, { key: 'spiral_mode', value: null }, { key: 'print_sequence', value: null }],
  },
  {
    id: 'plate-spiral-one-object',
    case: M1,
    overrides: { process: { sparse_infill_density: '0%' } },
    objects: [{ id: 'a', settings: { sparse_infill_density: '0%' } }],
    steps: [{ key: 'spiral_mode', value: '1' }, { key: 'curr_bed_type', value: 'Cool Plate' }],
  },
  {
    id: 'plate-sequence-i3',
    case: M1,
    overrides: { process: { print_sequence: 'by object' } },
    objects: [],
    steps: [{ key: 'print_sequence', value: 'by layer' }, { key: 'print_sequence', value: 'by object' }, { key: 'spiral_mode', value: '0' }],
  },
];

/** The case a script names: its exact id, or the only case whose id starts with it. */
export function resolveCase<T extends { id: string }>(cases: readonly T[], id: string): T {
  const exact = cases.find((c) => c.id === id);
  if (exact) return exact;
  const prefixed = cases.filter((c) => c.id.startsWith(`${id} |`));
  if (prefixed.length !== 1) throw new Error(`no single preset case "${id}" (${prefixed.length} match)`);
  return prefixed[0];
}
