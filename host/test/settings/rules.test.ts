import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { ConfigValue } from '../../../shared/types.ts';
import {
  MATERIAL_TYPES,
  ORCA_RULES_COMMIT,
  RULES_PORTED_FROM,
  SKIPPED_BEHAVIOURS,
  SKIPPED_CALL_SITES,
  editEffects,
  evaluateRules,
  isDisabled,
  isHidden,
  issuesFor,
  layeredConfig,
  orcaNumber,
  tabRules,
  validateAdaptivePaModel,
  type RuleIssue,
  type RuleScope,
  type RulesEnv,
  type RulesResult,
} from './rules.ts';
import {
  ORCA_ENGINE_ROOT,
  RULES_TS,
  findCppDefinitions,
  parseEnumKeyMaps,
  parseOrcaDefinitions,
  readTableEntries,
  readTableInRules,
  readTableSource,
  ruleSourceHashes,
  rulesReadKeys,
  stripCppComments,
  type OrcaDefinition,
} from './rulesSource.ts';

type Values = Record<string, ConfigValue>;

const run = (values: Values = {}, env: Omit<RulesEnv, 'config'> = {}): RulesResult =>
  evaluateRules({ ...env, config: layeredConfig(values) });
/** run() with every key of `values` set by the user, so the checks Orca makes on an edit run too. */
const runEdited = (values: Values = {}, env: Omit<RulesEnv, 'config'> = {}): RulesResult =>
  run(values, { ...env, edited: new Set(Object.keys(values)) });
const shown = (r: RulesResult, key: string, scope: RuleScope = 'process', index?: number) => !isHidden(r[scope], key, index);
const enabled = (r: RulesResult, key: string, scope: RuleScope = 'process', index?: number) => !isDisabled(r[scope], key, index);
const find = (r: RulesResult, id: string): RuleIssue | undefined => r.issues.find((i) => i.id === id);
const ids = (r: RulesResult) => r.issues.map((i) => i.id);
const edit = (scope: RuleScope, key: string, value: string, values: Values = {}, env: Omit<RulesEnv, 'config'> = {}, index = 0) =>
  editEffects(scope, key, value, { ...env, config: layeredConfig(values) }, index);

// ---------------------------------------------------------------------------------------------
// Reading values
// ---------------------------------------------------------------------------------------------

describe('rules: reading the configuration', () => {
  it('uses Orca’s defaults for unset keys and raises nothing on them', () => {
    const r = run();
    assert.deepEqual(ids(r), []);
    // wall_loops 2, 20% crosshatch infill, 4 top and 3 bottom layers, supports off
    assert.ok(shown(r, 'sparse_infill_pattern') && enabled(r, 'top_surface_pattern') && enabled(r, 'seam_position'));
    assert.ok(!enabled(r, 'support_type') && !enabled(r, 'support_style'));
  });

  it('takes the first layer that has a key', () => {
    const view = layeredConfig({ wall_loops: '0' }, null, undefined, { wall_loops: '3', enable_support: '1' });
    assert.equal(view.get('wall_loops'), '0');
    assert.equal(view.get('enable_support'), '1');
    assert.equal(view.get('spiral_mode'), undefined);
    const r = evaluateRules({ config: view });
    assert.ok(!enabled(r, 'seam_position'));
    assert.ok(enabled(r, 'support_type'));
  });

  it('reads vectors as preset arrays, Orca’s comma text or quoted strings, and slot 0 past the end', () => {
    const twoNozzles = { nozzle_diameter: ['0.4', '0.4'] };
    for (const retraction_length of [['0.8', '0'], '0.8,0']) {
      const r = run({ ...twoNozzles, retraction_length });
      assert.ok(enabled(r, 'retraction_minimum_travel', 'machine', 0));
      assert.ok(!enabled(r, 'retraction_minimum_travel', 'machine', 1));
    }
    // One slot for two extruders: slot 1 reads slot 0, as get_at does.
    assert.ok(enabled(run({ ...twoNozzles, retraction_length: ['0.8'] }), 'retraction_minimum_travel', 'machine', 1));
    // filament_type as Orca’s serialized strings
    const r = runEdited({ filament_type: '"PETG";"PLA"', nozzle_temperature_range_low: '100', nozzle_temperature_range_high: '240', nozzle_temperature: '220', nozzle_temperature_initial_layer: '220' });
    assert.match(find(r, 'recommended-temperature-range')!.message, /above 190℃ is recommended for PETG/);
  });

  it('reads booleans as 1/0 or true/false, percents by their number and nil as not set', () => {
    assert.ok(enabled(run({ enable_support: 'true' }), 'support_type'));
    assert.ok(!shown(run({ sparse_infill_density: '0%' }), 'sparse_infill_pattern'));
    assert.ok(shown(run({ sparse_infill_density: '0.5%' }), 'sparse_infill_pattern'));
    // A nil filament override is unchecked: the field is off, the checkbox usable.
    const r = run({ filament_retraction_length: ['nil'], filament_z_hop: ['0.2'] });
    assert.ok(!enabled(r, 'filament_retraction_length', 'filament'));
    assert.ok(enabled(r, 'filament_z_hop', 'filament'));
  });

  it('writes numbers the way Orca prints doubles', () => {
    assert.equal(orcaNumber(0.1 + 0.2), '0.3');
    assert.equal(orcaNumber(1.7500867), '1.75009');
    assert.equal(orcaNumber(100), '100');
  });

  it('exposes the tabs and each row’s issues', () => {
    const r = run({ ironing_spacing: '0.01', layer_height: '0' });
    assert.equal(tabRules(r, 'filament'), r.filament);
    assert.deepEqual(issuesFor(r, 'process', 'ironing_spacing').map((i) => i.id), ['ironing-spacing-small']);
    assert.deepEqual(issuesFor(r, 'process', 'layer_height').map((i) => i.severity), ['error']);
  });
});

// ---------------------------------------------------------------------------------------------
// Process: ConfigManipulation::toggle_print_fff_options and TabPrint::toggle_options
// ---------------------------------------------------------------------------------------------

describe('rules: process visibility (toggle_print_fff_options)', () => {
  it('extrusion rate smoothing greys out arc fitting', () => {
    const off = run();
    assert.ok(enabled(off, 'enable_arc_fitting'));
    assert.ok(!shown(off, 'max_volumetric_extrusion_rate_slope_segment_length'));
    assert.ok(!shown(off, 'extrusion_rate_smoothing_external_perimeter_only'));
    const on = run({ max_volumetric_extrusion_rate_slope: '15' });
    assert.ok(!enabled(on, 'enable_arc_fitting'));
    assert.ok(shown(on, 'max_volumetric_extrusion_rate_slope_segment_length'));
  });

  it('no walls greys out the wall options; the last toggle wins for detect_thin_wall', () => {
    const r = run({ wall_loops: '0', wall_generator: 'classic' });
    for (const key of ['extra_perimeters_on_overhangs', 'ensure_vertical_shell_thickness', 'detect_overhang_wall', 'seam_position',
      'staggered_inner_seams', 'wall_sequence', 'outer_wall_line_width', 'inner_wall_speed', 'outer_wall_speed', 'small_perimeter_speed',
      'small_perimeter_threshold', 'gap_infill_speed'])
      assert.ok(!enabled(r, key), key);
    // detect_thin_wall is toggled by the walls, then by the wall generator: classic enables it.
    assert.ok(enabled(r, 'detect_thin_wall'));
    assert.ok(!enabled(run({ wall_generator: 'arachne' }), 'detect_thin_wall'));
    // Walls or a brim keep the wall filaments and inner wall width.
    assert.ok(enabled(run({ wall_loops: '0', brim_type: 'outer_only' }), 'outer_wall_filament_id'));
    assert.ok(!enabled(run({ wall_loops: '0', brim_type: 'no_brim' }), 'outer_wall_filament_id'));
    assert.ok(!enabled(run({ wall_loops: '0', brim_type: 'no_brim', skirt_loops: '0' }), 'inner_wall_line_width'));
  });

  it('no sparse infill hides the infill rows; anchors follow the pattern', () => {
    const none = run({ sparse_infill_density: '0%' });
    for (const key of ['sparse_infill_pattern', 'infill_combination', 'fill_multiline', 'minimum_sparse_infill_area', 'sparse_infill_filament_id',
      'sparse_infill_rotate_template', 'infill_anchor', 'infill_anchor_max', 'gyroid_optimized'])
      assert.ok(!shown(none, key), key);
    assert.ok(!shown(run({ sparse_infill_pattern: 'concentric' }), 'infill_anchor'));
    assert.ok(!shown(run({ sparse_infill_pattern: 'spiralinset' }), 'infill_anchor_max'));
    const line = run({ sparse_infill_pattern: 'line' });
    assert.ok(!enabled(line, 'infill_anchor_max') && !enabled(line, 'infill_anchor'));
    assert.ok(!enabled(run({ infill_anchor_max: '0' }), 'infill_anchor'));
    assert.ok(enabled(run({ infill_anchor_max: '40%' }), 'infill_anchor'));
    assert.ok(shown(run({ sparse_infill_pattern: 'gyroid' }), 'gyroid_optimized'));
    assert.ok(!shown(run(), 'gyroid_optimized'));
  });

  it('infill combination, multiline, smoothing and the zig-zag family', () => {
    assert.ok(!shown(run(), 'infill_combination_max_layer_height'));
    assert.ok(shown(run({ infill_combination: '1' }), 'infill_combination_max_layer_height'));
    assert.ok(!shown(run({ infill_combination: '1', sparse_infill_density: '0%' }), 'infill_combination_max_layer_height'));
    assert.ok(enabled(run({ sparse_infill_pattern: 'gyroid' }), 'fill_multiline'));
    assert.ok(!enabled(run({ sparse_infill_pattern: 'zigzag' }), 'fill_multiline'));
    assert.ok(shown(run({ sparse_infill_pattern: 'honeycomb' }), 'sparse_infill_smooth_factor'));
    assert.ok(!shown(run({ sparse_infill_pattern: 'grid' }), 'sparse_infill_smooth_factor'));
    assert.ok(shown(run({ sparse_infill_pattern: 'grid', fill_multiline: '2' }), 'sparse_infill_smooth_factor'));
    const locked = run({ sparse_infill_pattern: 'lockedzag' });
    for (const key of ['infill_shift_step', 'skeleton_infill_density', 'skin_infill_density', 'infill_lock_depth', 'skin_infill_depth',
      'skin_infill_line_width', 'skeleton_infill_line_width', 'symmetric_infill_y_axis'])
      assert.ok(shown(locked, key), key);
    const zig = run({ sparse_infill_pattern: 'zigzag' });
    assert.ok(shown(zig, 'symmetric_infill_y_axis') && !shown(zig, 'infill_shift_step') && !shown(zig, 'skin_infill_depth'));
    // infill_shift_step is shown for cross zag even without infill: its second toggle wins.
    assert.ok(shown(run({ sparse_infill_pattern: 'crosszag', sparse_infill_density: '0%' }), 'infill_shift_step'));
    assert.ok(shown(run({ sparse_infill_pattern: 'lateral-lattice' }), 'lateral_lattice_angle_1'));
    assert.ok(shown(run({ sparse_infill_pattern: 'lightning' }), 'lightning_prune_angle'));
    assert.ok(shown(run({ sparse_infill_pattern: 'lateral-honeycomb' }), 'infill_overhang_angle'));
    assert.ok(!shown(run(), 'lightning_prune_angle') && !shown(run(), 'infill_overhang_angle'));
  });

  it('rotation templates and adaptive cubic', () => {
    assert.ok(enabled(run(), 'infill_direction'));
    assert.ok(!enabled(run({ sparse_infill_rotate_template: '0,90' }), 'infill_direction'));
    const adaptive = run({ sparse_infill_pattern: 'adaptivecubic' });
    assert.ok(!enabled(adaptive, 'sparse_infill_rotate_template') && !enabled(adaptive, 'infill_direction'));
    assert.ok(!enabled(run({ solid_infill_rotate_template: '45' }), 'solid_infill_direction'));
    assert.ok(shown(run({ sparse_infill_pattern: 'gyroid', solid_infill_rotate_template: '45' }), 'separated_infills'));
    assert.ok(!shown(run({ sparse_infill_pattern: 'gyroid' }), 'separated_infills'));
  });

  it('spiral vase hides and greys out what it cannot use', () => {
    const off = run();
    assert.ok(!shown(off, 'spiral_mode_smooth') && !shown(off, 'spiral_starting_flow_ratio'));
    const vase = run({ spiral_mode: '1', spiral_mode_smooth: '1' });
    for (const key of ['spiral_mode_smooth', 'spiral_mode_max_xy_smoothing', 'spiral_starting_flow_ratio', 'spiral_finishing_flow_ratio'])
      assert.ok(shown(vase, key), key);
    assert.ok(!enabled(vase, 'top_shell_thickness') && !enabled(vase, 'bottom_shell_thickness'));
    assert.ok(!shown(vase, 'overhang_reverse') && !shown(vase, 'overhang_reverse_threshold'));
    assert.ok(!enabled(vase, 'seam_slope_type'));
    assert.ok(!shown(run({ spiral_mode: '1', seam_slope_type: 'external' }), 'seam_slope_conditional'));
    // A vase with more than one bottom layer still has a top shell.
    assert.ok(enabled(run({ spiral_mode: '1', top_shell_layers: '0', bottom_shell_layers: '3' }), 'top_surface_pattern'));
    assert.ok(!enabled(run({ top_shell_layers: '0' }), 'top_surface_pattern'));
  });

  it('shells: surface patterns, densities, expansion, centring and fill order', () => {
    const noTop = run({ top_shell_layers: '0' });
    assert.ok(!enabled(noTop, 'top_surface_pattern') && !enabled(noTop, 'top_surface_density') && !enabled(noTop, 'top_shell_thickness'));
    assert.ok(!enabled(noTop, 'top_surface_speed') && !enabled(noTop, 'top_surface_line_width') && !shown(noTop, 'only_one_wall_top'));
    const unfilled = run({ top_surface_density: '0%' });
    assert.ok(!enabled(unfilled, 'top_surface_pattern') && enabled(unfilled, 'top_surface_density') && shown(unfilled, 'only_one_wall_top'));
    const noBottom = run({ bottom_shell_layers: '0' });
    assert.ok(!enabled(noBottom, 'bottom_surface_pattern') && !enabled(noBottom, 'bottom_surface_density') && !shown(noBottom, 'only_one_wall_first_layer'));
    assert.ok(!enabled(run(), 'top_surface_expansion_margin') && shown(run(), 'top_surface_expansion_margin'));
    assert.ok(enabled(run({ top_surface_expansion: '1' }), 'top_surface_expansion_direction'));
    assert.ok(!shown(run(), 'center_of_surface_pattern'));
    assert.ok(shown(run({ bottom_surface_pattern: 'archimedeanchords' }), 'center_of_surface_pattern'));
    assert.ok(!shown(run({ bottom_surface_pattern: 'archimedeanchords', bottom_shell_layers: '0' }), 'center_of_surface_pattern'));
    assert.ok(shown(run({ top_surface_pattern: 'concentric' }), 'top_surface_fill_order'));
    assert.ok(!shown(run(), 'top_surface_fill_order') && !shown(run(), 'bottom_surface_fill_order'));
    // No infill and no shells: bridges and infill speeds have nothing to act on.
    const empty = run({ sparse_infill_density: '0%', top_shell_layers: '0', bottom_shell_layers: '0' });
    for (const key of ['bridge_speed', 'internal_bridge_speed', 'bridge_angle', 'internal_bridge_angle', 'sparse_infill_speed', 'internal_solid_infill_pattern'])
      assert.ok(!enabled(empty, key), key);
    assert.ok(enabled(run({ sparse_infill_density: '0%', top_shell_layers: '0' }), 'bridge_speed'));
  });

  it('one wall on top, polyholes, flow ratios, overhang speeds', () => {
    assert.ok(!shown(run(), 'min_width_top_surface'));
    assert.ok(shown(run({ only_one_wall_top: '1' }), 'min_width_top_surface'));
    assert.ok(shown(run({ min_length_factor: '0.6' }), 'min_width_top_surface'));
    assert.ok(!shown(run({ min_length_factor: '0.6', wall_generator: 'classic' }), 'min_width_top_surface'));
    assert.ok(shown(run({ hole_to_polyhole: '1' }), 'hole_to_polyhole_twisted') && !shown(run(), 'hole_to_polyhole_twisted'));
    assert.ok(shown(run({ set_other_flow_ratios: '1' }), 'gap_fill_flow_ratio') && !shown(run(), 'gap_fill_flow_ratio'));
    assert.ok(shown(run(), 'overhang_2_4_speed') && !shown(run({ enable_overhang_speed: ['0'] }), 'slowdown_for_curled_perimeters'));
    assert.ok(shown(run({ reduce_crossing_wall: '1' }), 'max_travel_detour_distance') && !shown(run(), 'max_travel_detour_distance'));
    assert.ok(shown(run({ make_overhang_printable: '1' }), 'make_overhang_printable_angle') && !shown(run(), 'make_overhang_printable_hole_size'));
    assert.ok(shown(run({ small_area_infill_flow_compensation: '1' }), 'small_area_infill_flow_compensation_model'));
    assert.ok(shown(run({ zaa_enabled: '1' }), 'ironing_expansion') && !shown(run(), 'zaa_min_z'));
  });

  it('accelerations, jerk and junction deviation follow the defaults and the firmware', () => {
    assert.ok(enabled(run(), 'travel_acceleration'));
    assert.ok(!enabled(run({ default_acceleration: ['0'] }), 'outer_wall_acceleration'));
    const marlin = run();
    assert.ok(!shown(marlin, 'default_junction_deviation') && enabled(marlin, 'default_jerk'));
    assert.ok(shown(marlin, 'travel_jerk') && !enabled(marlin, 'travel_jerk'));
    assert.ok(enabled(run({ default_jerk: ['8'] }), 'infill_jerk'));
    const jd = run({ gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0.02', '0.02'] });
    assert.ok(shown(jd, 'default_junction_deviation') && enabled(jd, 'default_junction_deviation'));
    assert.ok(!enabled(jd, 'default_jerk') && !shown(jd, 'travel_jerk') && !shown(jd, 'initial_layer_jerk'));
    const noJd = run({ gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0'] });
    assert.ok(shown(noJd, 'default_junction_deviation') && !enabled(noJd, 'default_junction_deviation') && shown(noJd, 'travel_jerk'));
    const klipper = run({ gcode_flavor: 'klipper' });
    assert.ok(shown(klipper, 'accel_to_decel_enable') && enabled(klipper, 'accel_to_decel_factor'));
    assert.ok(!enabled(run({ gcode_flavor: 'klipper', accel_to_decel_enable: '0' }), 'accel_to_decel_factor'));
    assert.ok(!shown(run(), 'accel_to_decel_factor'));
  });

  it('skirt and draft shield', () => {
    const none = run({ skirt_loops: '0' });
    for (const key of ['skirt_height', 'skirt_type', 'min_skirt_length', 'skirt_distance', 'skirt_start_angle', 'skirt_speed', 'draft_shield'])
      assert.ok(!enabled(none, key), key);
    assert.ok(!shown(none, 'single_loop_draft_shield'));
    assert.ok(enabled(run(), 'skirt_height'));
    assert.ok(!enabled(run({ draft_shield: 'enabled' }), 'skirt_height'));
  });

  it('brim type none greys out the brim width; ears relabel it', () => {
    const none = run({ brim_type: 'no_brim' });
    for (const key of ['brim_width', 'brim_object_gap', 'brim_use_efc_outline', 'combine_brims', 'brim_flow_ratio'])
      assert.ok(!enabled(none, key), key);
    const auto = run({ brim_type: 'auto_brim' });
    assert.ok(!enabled(auto, 'brim_width') && enabled(auto, 'brim_object_gap'));
    assert.ok(enabled(run({ brim_type: 'outer_only' }), 'brim_width'));
    assert.equal(run().process.labels.get('brim_width'), 'Brim width');
    const ears = run({ brim_type: 'brim_ears', brim_width: '0' });
    assert.equal(ears.process.labels.get('brim_width'), 'Brim ear radius');
    assert.ok(shown(ears, 'brim_ears_max_angle') && !enabled(ears, 'brim_ears_max_angle') && !enabled(ears, 'brim_ears_outer_only'));
    assert.ok(enabled(run({ brim_type: 'brim_ears', brim_width: '5' }), 'brim_ears_detection_length'));
    const painted = run({ brim_type: 'painted', brim_width: '0' });
    assert.ok(!shown(painted, 'brim_ears_max_angle') && shown(painted, 'brim_ears_outer_only') && enabled(painted, 'brim_ears_outer_only'));
    assert.ok(!enabled(painted, 'brim_width'));
  });

  it('elephant foot layers show with a compensation or a reduced density', () => {
    assert.ok(!shown(run(), 'elefant_foot_compensation_layers'));
    assert.ok(shown(run({ elefant_foot_compensation: '0.1' }), 'elefant_foot_compensation_layers'));
    assert.ok(shown(run({ elefant_foot_layers_density: '80%' }), 'elefant_foot_compensation_layers'));
  });

  it('support off greys out every support option; a raft turns them on', () => {
    const supportKeys = ['support_style', 'support_base_pattern', 'support_base_pattern_spacing', 'support_expansion', 'support_angle',
      'support_interface_pattern', 'support_interface_top_layers', 'support_interface_bottom_layers', 'bridge_no_support', 'max_bridge_length',
      'support_top_z_distance', 'support_bottom_z_distance', 'support_type', 'support_on_build_plate_only', 'support_critical_regions_only',
      'support_interface_not_for_body', 'support_object_xy_distance', 'support_object_first_layer_gap', 'independent_support_layer_height',
      'support_threshold_angle', 'support_threshold_overlap', 'support_interface_filament', 'support_interface_loop_pattern',
      'support_bottom_interface_spacing', 'support_interface_spacing', 'support_ironing', 'small_support_perimeter_speed',
      'small_support_perimeter_threshold', 'raft_first_layer_density', 'raft_first_layer_expansion'];
    const off = run();
    for (const key of supportKeys) assert.ok(!enabled(off, key), `${key} off`);
    const on = run({ enable_support: '1', support_interface_bottom_layers: '2' });
    for (const key of supportKeys.filter((k) => k !== 'support_threshold_overlap'))
      assert.ok(enabled(on, key), `${key} on`);
    const raft = run({ raft_layers: '2' });
    assert.ok(enabled(raft, 'support_type') && enabled(raft, 'support_ironing') && shown(raft, 'raft_contact_distance'));
    assert.ok(!enabled(raft, 'small_support_perimeter_speed')); // enable_support only
    assert.ok(!shown(run({ raft_layers: '2', support_top_z_distance: '0' }), 'raft_contact_distance'));
    assert.ok(!enabled(run({ skirt_loops: '0' }), 'support_filament') && enabled(run(), 'support_filament'));
  });

  it('support types: thresholds, trees, organic and hybrid', () => {
    const manual = run({ enable_support: '1', support_type: 'normal(manual)' });
    assert.ok(!enabled(manual, 'support_threshold_angle') && !enabled(manual, 'support_threshold_overlap'));
    assert.ok(enabled(run({ enable_support: '1', support_threshold_angle: '0' }), 'support_threshold_overlap'));
    const normal = run({ enable_support: '1' });
    assert.ok(shown(normal, 'bridge_no_support') && !shown(normal, 'max_bridge_length') && !shown(normal, 'support_critical_regions_only'));
    assert.ok(!shown(normal, 'tree_support_branch_angle') && !shown(normal, 'tree_support_tip_diameter') && shown(normal, 'support_threshold_overlap'));
    const slim = run({ enable_support: '1', support_type: 'tree(auto)', support_style: 'tree_slim' });
    assert.ok(shown(slim, 'tree_support_branch_angle') && !shown(slim, 'tree_support_branch_angle_organic'));
    assert.ok(shown(slim, 'max_bridge_length') && !shown(slim, 'bridge_no_support') && shown(slim, 'support_critical_regions_only'));
    assert.ok(!shown(slim, 'support_threshold_overlap') && shown(slim, 'independent_support_layer_height'));
    assert.ok(!enabled(slim, 'tree_support_brim_width') && !enabled(slim, 'raft_first_layer_expansion'));
    assert.ok(enabled(run({ enable_support: '1', support_type: 'tree(auto)', support_style: 'tree_slim', tree_support_auto_brim: '0' }), 'tree_support_brim_width'));
    assert.ok(enabled(run({ enable_support: '1', support_type: 'tree(auto)', support_style: 'tree_hybrid' }), 'raft_first_layer_expansion'));
    const organic = run({ enable_support: '1', support_type: 'tree(manual)', support_style: 'default' });
    assert.ok(shown(organic, 'tree_support_tip_diameter') && !shown(organic, 'tree_support_branch_diameter'));
    assert.ok(!shown(organic, 'independent_support_layer_height') && !shown(organic, 'support_critical_regions_only'));
    // Tree types with support off (raft only) are not trees.
    assert.ok(!shown(run({ raft_layers: '1', support_type: 'tree(auto)' }), 'max_bridge_length'));
  });

  it('support interfaces and support ironing', () => {
    const noInterface = run({ enable_support: '1', support_interface_top_layers: '0', support_interface_bottom_layers: '0' });
    assert.ok(!enabled(noInterface, 'support_interface_filament') && !enabled(noInterface, 'support_interface_spacing') && !enabled(noInterface, 'support_ironing'));
    const ironing = run({ enable_support: '1', support_ironing: '1' });
    assert.ok(shown(ironing, 'support_ironing_pattern') && shown(ironing, 'ironing_speed') && !enabled(ironing, 'support_interface_spacing'));
    assert.ok(!shown(run({ support_ironing: '1' }), 'support_ironing_flow'));
    assert.ok(!shown(run(), 'support_interface_not_for_body'));
    assert.ok(shown(run({ support_interface_filament: '1' }), 'support_interface_not_for_body'));
    assert.ok(!shown(run({ support_interface_filament: '1', support_filament: '1' }), 'support_interface_not_for_body'));
  });

  it('ironing off hides the ironing options; only rectilinear takes an angle', () => {
    const off = run();
    for (const key of ['ironing_pattern', 'ironing_flow', 'ironing_spacing', 'ironing_angle', 'ironing_inset', 'ironing_angle_fixed', 'ironing_speed'])
      assert.ok(!shown(off, key), key);
    const top = run({ ironing_type: 'top' });
    assert.ok(shown(top, 'ironing_flow') && enabled(top, 'ironing_angle') && shown(top, 'ironing_speed'));
    const concentric = run({ ironing_type: 'top', ironing_pattern: 'concentric' });
    assert.ok(!enabled(concentric, 'ironing_angle') && !enabled(concentric, 'ironing_angle_fixed'));
  });

  it('sequence, ooze prevention and the prime tower', () => {
    assert.ok(!enabled(run({ print_sequence: 'by object' }), 'print_order'));
    // single_extruder_multi_material defaults to on: ooze prevention is greyed out.
    assert.ok(!enabled(run(), 'ooze_prevention') && enabled(run({ single_extruder_multi_material: '0' }), 'ooze_prevention'));
    const ooze = run({ ooze_prevention: '1', preheat_steps: '0' });
    assert.ok(shown(ooze, 'standby_temperature_delta') && shown(ooze, 'preheat_time') && !shown(ooze, 'preheat_steps'));
    const off = run();
    for (const key of ['prime_tower_width', 'prime_tower_brim_width', 'wipe_tower_wall_type', 'wipe_tower_no_sparse_layers', 'wipe_tower_rotation_angle', 'prime_volume'])
      assert.ok(!shown(off, key), key);
    assert.ok(!enabled(off, 'flush_into_infill'));
    const tower = run({ enable_prime_tower: '1', wipe_tower_wall_type: 'rectangle' });
    assert.ok(shown(tower, 'wipe_tower_rotation_angle') && enabled(tower, 'prime_tower_width') && !shown(tower, 'wipe_tower_cone_angle'));
    assert.ok(!shown(tower, 'prime_volume')); // SEMM purging in the tower
    assert.ok(shown(run({ enable_prime_tower: '1', purge_in_prime_tower: '0' }), 'prime_volume'));
    const rib = run({ enable_prime_tower: '1', wipe_tower_wall_type: 'rib' });
    assert.ok(shown(rib, 'wipe_tower_rib_width') && !enabled(rib, 'prime_tower_width'));
    assert.ok(shown(run({ enable_prime_tower: '1', wipe_tower_wall_type: 'cone' }), 'wipe_tower_cone_angle'));
    const type1 = run({ enable_prime_tower: '1', wipe_tower_type: 'type1' });
    assert.ok(!shown(type1, 'wipe_tower_extra_flow') && shown(type1, 'wipe_tower_no_sparse_layers'));
    assert.ok(!shown(run({ enable_prime_tower: '1' }, { isBbl: true }), 'wipe_tower_bridging'));
    assert.ok(shown(run({ enable_prime_tower: '1', single_extruder_multi_material: '0' }), 'single_extruder_multi_material_priming'));
    assert.ok(shown(run({ enable_prime_tower: '1', enable_tower_interface_features: '1' }), 'enable_tower_interface_cooldown_during_tower'));
    assert.ok(shown(run({ toolchange_ordering: 'cyclic' }), 'toolchange_cyclic_order') && !shown(run(), 'toolchange_cyclic_first_layer'));
  });

  it('flush into objects shows only for an object’s settings', () => {
    assert.ok(!shown(run(), 'flush_into_objects'));
    assert.ok(shown(run({}, { context: 'object' }), 'flush_into_objects'));
    assert.ok(shown(run({}, { context: 'plate' }), 'flush_into_objects'));
  });

  it('fuzzy skin rows follow the noise type', () => {
    assert.ok(!shown(run(), 'fuzzy_skin_mode'));
    const classic = run({ fuzzy_skin: 'external' });
    assert.ok(shown(classic, 'fuzzy_skin_thickness') && !shown(classic, 'fuzzy_skin_scale') && !shown(classic, 'fuzzy_skin_octaves'));
    const perlin = run({ fuzzy_skin: 'external', fuzzy_skin_noise_type: 'perlin' });
    assert.ok(shown(perlin, 'fuzzy_skin_scale') && shown(perlin, 'fuzzy_skin_octaves') && shown(perlin, 'fuzzy_skin_persistence'));
    const voronoi = run({ fuzzy_skin: 'all', fuzzy_skin_noise_type: 'voronoi' });
    assert.ok(shown(voronoi, 'fuzzy_skin_scale') && !shown(voronoi, 'fuzzy_skin_octaves') && !shown(voronoi, 'fuzzy_skin_persistence'));
    const ripple = run({ fuzzy_skin: 'all', fuzzy_skin_noise_type: 'ripple' });
    assert.ok(shown(ripple, 'fuzzy_skin_ripple_offset') && !shown(ripple, 'fuzzy_skin_scale'));
    assert.ok(!shown(run({ fuzzy_skin_noise_type: 'ripple' }), 'fuzzy_skin_ripples_per_layer'));
  });

  it('Arachne, wipe and the overhang options', () => {
    assert.ok(shown(run(), 'min_bead_width') && !shown(run({ wall_generator: 'classic' }), 'wall_transition_angle'));
    assert.ok(!enabled(run(), 'wipe_speed') && enabled(run({ role_based_wipe_speed: '0' }), 'wipe_speed'));
    assert.ok(shown(run({ wipe_inward: '1' }), 'wipe_inward_distance') && !shown(run(), 'wipe_inward_distance'));
    assert.ok(shown(run(), 'unsupported_wall_last') && !shown(run({ detect_overhang_wall: '0' }), 'unsupported_wall_last'));
    assert.ok(shown(run({ overhang_reverse: '1' }), 'overhang_reverse_threshold'));
    assert.ok(!shown(run({ overhang_reverse: '1', overhang_reverse_internal_only: '1' }), 'overhang_reverse_threshold'));
    assert.ok(!shown(run(), 'overhang_reverse_internal_only'));
  });

  it('scarf seams', () => {
    assert.ok(!shown(run(), 'seam_slope_start_height'));
    const scarf = run({ seam_slope_type: 'external' });
    for (const key of ['seam_slope_conditional', 'seam_slope_start_height', 'seam_slope_entire_loop', 'seam_slope_min_length', 'seam_slope_steps',
      'seam_slope_inner_walls', 'scarf_joint_speed', 'scarf_joint_flow_ratio'])
      assert.ok(shown(scarf, key), key);
    assert.ok(!shown(scarf, 'scarf_angle_threshold'));
    assert.ok(shown(run({ seam_slope_type: 'all', seam_slope_conditional: '1' }), 'scarf_overhang_threshold'));
    assert.ok(!enabled(run({ seam_slope_type: 'all', seam_slope_entire_loop: '1' }), 'seam_slope_min_length'));
  });

  it('interlocking beams, timelapse and wrapping detection', () => {
    assert.ok(shown(run(), 'mmu_segmented_region_interlocking_depth') && !shown(run(), 'interlocking_depth'));
    const beam = run({ interlocking_beam: '1' });
    assert.ok(!shown(beam, 'mmu_segmented_region_interlocking_depth') && shown(beam, 'interlocking_boundary_avoidance'));
    assert.ok(!shown(run(), 'timelapse_type') && shown(run({}, { isBbl: true }), 'timelapse_type'));
    assert.ok(!shown(run(), 'enable_wrapping_detection') && shown(run({}, { supportsWrappingDetection: true }), 'enable_wrapping_detection'));
  });

  it('narrows support styles to the support type and cone walls to non-Bambu printers', () => {
    assert.deepEqual(run().process.enumFilters.get('support_style'), ['default', 'grid', 'snug']);
    assert.deepEqual(run({ support_type: 'tree(manual)' }).process.enumFilters.get('support_style'), ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic']);
    assert.deepEqual(run().process.enumFilters.get('wipe_tower_wall_type'), ['rectangle', 'cone', 'rib']);
    assert.deepEqual(run({}, { isBbl: true }).process.enumFilters.get('wipe_tower_wall_type'), ['rectangle', 'rib']);
  });
});

// ---------------------------------------------------------------------------------------------
// Process: update_print_fff_config and the silent rewrites
// ---------------------------------------------------------------------------------------------

describe('rules: process checks (update_print_fff_config)', () => {
  it('layer heights: zero, and the printer’s limits', () => {
    const zeroNoLimit = find(runEdited({ layer_height: '0', min_layer_height: ['0'] }), 'layer-height-zero')!;
    assert.deepEqual([zeroNoLimit.severity, zeroNoLimit.fix], ['error', { layer_height: '0.2' }]);
    const zero = runEdited({ layer_height: '0', min_layer_height: ['0.08'] });
    assert.deepEqual(find(zero, 'layer-height-limits')!.fix, { layer_height: '0.08' });
    assert.equal(find(zero, 'layer-height-zero'), undefined);
    const high = find(runEdited({ layer_height: '0.4', min_layer_height: ['0.08', '0.1'], max_layer_height: ['0.28', '0.32'] }), 'layer-height-limits')!;
    assert.deepEqual([high.severity, high.fix, high.fixLabel, high.checkedOn], ['warning', { layer_height: '0.32' }, 'Adjust to 0.32 mm', ['layer_height']]);
    assert.deepEqual(find(runEdited({ layer_height: '0.05' }), 'layer-height-limits')!.fix, { layer_height: '0.07' });
    assert.equal(find(runEdited({ layer_height: '0.3', max_layer_height: ['0'] }), 'layer-height-limits'), undefined);
    // Orca checks the limits only when layer_height is edited: a preset, or an edit of the limits,
    // raises nothing, and a zero layer height then gets update_print_fff_config's reset.
    assert.equal(find(run({ layer_height: '0.4', max_layer_height: ['0.32'] }), 'layer-height-limits'), undefined);
    assert.equal(find(run({ layer_height: '0.4', max_layer_height: ['0.32'] }, { edited: new Set(['max_layer_height']) }), 'layer-height-limits'), undefined);
    assert.deepEqual(find(run({ layer_height: '0', min_layer_height: ['0.08'] }), 'layer-height-zero')!.fix, { layer_height: '0.2' });
    assert.deepEqual(find(run({ initial_layer_print_height: '0' }), 'initial-layer-height-zero')!.fix, { initial_layer_print_height: '0.2' });
  });

  it('resets values Orca refuses', () => {
    assert.deepEqual(find(run({ ironing_spacing: '0.01' }), 'ironing-spacing-small')!.fix, { ironing_spacing: '0.1' });
    assert.deepEqual(find(run({ support_ironing_spacing: '0' }), 'support-ironing-spacing-small')!.fix, { support_ironing_spacing: '0.1' });
    assert.deepEqual(find(run({ xy_hole_compensation: '-2.5' }), 'xy-hole-compensation-large')!.fix, { xy_hole_compensation: '0' });
    assert.equal(find(run({ xy_contour_compensation: '2' }), 'xy-contour-compensation-large'), undefined);
    assert.deepEqual(find(run({ elefant_foot_compensation: '1.2' }), 'elephant-foot-compensation-large')!.fix, { elefant_foot_compensation: '0' });
    assert.deepEqual(find(run({ infill_lock_depth: '3', skin_infill_depth: '2' }), 'infill-lock-depth')!.fix, { infill_lock_depth: '1' });
    const seam = run({ seam_slope_type: 'external', seam_slope_start_height: '0.25', layer_height: '0.2' });
    assert.deepEqual(find(seam, 'seam-slope-start-height')!.fix, { seam_slope_start_height: '0' });
    // A percentage is of the layer height.
    assert.ok(find(run({ seam_slope_type: 'external', seam_slope_start_height: '100%' }), 'seam-slope-start-height'));
    assert.equal(find(run({ seam_slope_type: 'external', seam_slope_start_height: '50%' }), 'seam-slope-start-height'), undefined);
    assert.equal(find(run({ seam_slope_start_height: '1' }), 'seam-slope-start-height'), undefined);
  });

  it('spiral vase lists its requirements with Orca’s answers', () => {
    const r = run({ spiral_mode: '1' });
    const vase = find(r, 'spiral-vase')!;
    assert.equal(vase.severity, 'warning');
    assert.deepEqual(vase.fix, {
      wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%', enable_support: '0', enforce_support_layers: '0',
      detect_thin_wall: '0', overhang_reverse: '0', timelapse_type: '0', enable_wrapping_detection: '0',
    });
    assert.deepEqual(vase.alternative, { label: 'Turn off spiral mode', values: { spiral_mode: '0' } });
    assert.deepEqual(ids(run({ spiral_mode: '1', ...vase.fix })), []);
    assert.equal(find(run({ spiral_mode: '1' }, { context: 'object' }), 'spiral-vase')!.alternative, undefined);
    assert.equal(find(run({ spiral_mode: '1' }, { context: 'plate' }), 'spiral-vase'), undefined);
    assert.match(find(run({ spiral_mode: '1', printer_structure: 'i3' }), 'spiral-vase')!.message, /I3 structure/);
  });

  it('asks about alternate extra walls, fuzzy skin modes and wall generators', () => {
    const wall = find(run({ alternate_extra_wall: '1' }), 'alternate-extra-wall')!;
    assert.deepEqual(wall.fix, { ensure_vertical_shell_thickness: 'ensure_moderate', alternate_extra_wall: '1' });
    assert.deepEqual(wall.alternative?.values, { ensure_vertical_shell_thickness: 'ensure_all', alternate_extra_wall: '0' });
    assert.equal(find(run({ alternate_extra_wall: '1' }, { context: 'object' }), 'alternate-extra-wall')!.alternative, undefined);
    assert.equal(find(run({ alternate_extra_wall: '1', ensure_vertical_shell_thickness: 'ensure_moderate' }), 'alternate-extra-wall'), undefined);
    const fuzzy = find(run({ fuzzy_skin_mode: 'extrusion', wall_generator: 'classic' }), 'fuzzy-skin-arachne')!;
    assert.deepEqual([fuzzy.fix, fuzzy.alternative?.values], [{ wall_generator: 'arachne' }, { fuzzy_skin_mode: 'displacement' }]);
    assert.equal(find(run({ fuzzy_skin_mode: 'combined' }), 'fuzzy-skin-arachne'), undefined);
  });

  it('records Orca’s silent rewrites with the keys that start them', () => {
    const arc = find(run({ max_volumetric_extrusion_rate_slope: '10', enable_arc_fitting: '1' }), 'arc-fitting-with-smoothing')!;
    assert.deepEqual([arc.severity, arc.fix, arc.triggers], ['info', { enable_arc_fitting: '0' }, ['max_volumetric_extrusion_rate_slope']]);
    assert.ok(find(run({ max_volumetric_extrusion_rate_slope_segment_length: '0.2' }), 'smoothing-segment-length'));
    assert.deepEqual(find(run({ sparse_infill_pattern: 'zigzag', fill_multiline: '3' }), 'fill-multiline-pattern')!.fix, { fill_multiline: '1' });
    assert.equal(find(run({ sparse_infill_pattern: 'zigzag', fill_multiline: '3', sparse_infill_density: '0%' }), 'fill-multiline-pattern'), undefined);
    assert.deepEqual(find(run({ overhang_reverse_internal_only: '1' }), 'overhang-reverse-internal-only')!.fix, { overhang_reverse_threshold: '0%' });
    assert.ok(find(run({ enable_prime_tower: '1', wipe_tower_wall_type: 'cone' }, { isBbl: true }), 'wipe-tower-cone-bbl'));
    assert.equal(find(run({ enable_prime_tower: '1', wipe_tower_wall_type: 'cone' }), 'wipe-tower-cone-bbl'), undefined);
    assert.deepEqual(find(run({ enable_support: '1', support_type: 'tree(auto)', support_style: 'snug' }), 'support-style-type')!.fix, { support_style: 'default' });
    assert.equal(find(run({ support_type: 'tree(auto)', support_style: 'snug' }), 'support-style-type'), undefined);
    assert.deepEqual(find(run({ support_filament: '2' }), 'filament-id-range')!.fix, { support_filament: '0' });
    assert.equal(find(run({ support_filament: '2' }, { filamentCount: 2 }), 'filament-id-range'), undefined);
    // An object's id falls back to the global value when the plater config holds the key and the value is in range.
    const global = layeredConfig({ support_filament: '1', top_surface_filament_id: '1' });
    const object = find(run({ support_filament: '3' }, { context: 'object', filamentCount: 2, globalConfig: global }), 'filament-id-range')!;
    assert.deepEqual([object.fix, object.fixLabel], [{ support_filament: '1' }, 'Use filament 1']);
    assert.deepEqual(find(run({ top_surface_filament_id: '3' }, { context: 'object', globalConfig: global }), 'filament-id-range')!.fix, { top_surface_filament_id: '0' });
    assert.deepEqual(find(run({ support_filament: '3' }, { context: 'object', globalConfig: layeredConfig({ support_filament: '4' }) }), 'filament-id-range')!.fix, { support_filament: '0' });
    assert.deepEqual(find(run({ support_filament: '3' }, { globalConfig: global }), 'filament-id-range')!.fix, { support_filament: '0' });
    assert.ok(find(run({ enable_wrapping_detection: '1' }), 'wrapping-detection-unsupported'));
    assert.equal(find(run({ enable_wrapping_detection: '1' }, { supportsWrappingDetection: true }), 'wrapping-detection-unsupported'), undefined);
    for (const issue of run({ max_volumetric_extrusion_rate_slope: '10', enable_arc_fitting: '1', overhang_reverse_internal_only: '1' }).issues)
      assert.ok(issue.triggers?.length, issue.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Filament: TabFilament::toggle_options, update_filament_overrides_page, the check_* functions
// ---------------------------------------------------------------------------------------------

describe('rules: filament', () => {
  it('cooling', () => {
    const r = run({ enable_overhang_bridge_fan: ['0'], slow_down_for_layer_cooling: ['0'] });
    assert.ok(!enabled(r, 'overhang_fan_speed', 'filament') && !enabled(r, 'internal_bridge_fan_speed', 'filament'));
    assert.ok(!enabled(r, 'dont_slow_down_outer_wall', 'filament'));
    assert.ok(!shown(run(), 'initial_layer_fan_speed', 'filament')); // close_fan_the_first_x_layers defaults to 1
    assert.ok(shown(run({ close_fan_the_first_x_layers: ['0'] }), 'initial_layer_fan_speed', 'filament'));
    const fan = find(run({ initial_layer_fan_speed: ['40'] }), 'initial-layer-fan-speed')!;
    assert.deepEqual([fan.fix, fan.triggers], [{ initial_layer_fan_speed: '-1' }, ['close_fan_the_first_x_layers']]);
    assert.ok(shown(run({ auxiliary_fan: '1' }), 'additional_cooling_fan_speed', 'filament'));
    assert.ok(!shown(run({ support_air_filtration: '0' }), 'activate_air_filtration', 'filament'));
    const air = run({ activate_air_filtration: ['1'], activate_air_filtration_during_print: ['0'] });
    assert.ok(enabled(air, 'activate_air_filtration_during_print', 'filament') && !enabled(air, 'during_print_exhaust_fan_speed', 'filament'));
    assert.ok(enabled(air, 'complete_print_exhaust_fan_speed', 'filament'));
    assert.ok(!enabled(run(), 'activate_air_filtration_on_completion', 'filament'));
  });

  it('pressure advance, pellets and chamber control', () => {
    const off = run();
    assert.ok(!enabled(off, 'pressure_advance', 'filament') && !enabled(off, 'adaptive_pressure_advance', 'filament'));
    assert.ok(!shown(off, 'adaptive_pressure_advance_model', 'filament'));
    const pa = run({ enable_pressure_advance: ['1'], adaptive_pressure_advance: ['1'] });
    assert.ok(enabled(pa, 'pressure_advance', 'filament') && shown(pa, 'adaptive_pressure_advance_bridges', 'filament'));
    assert.ok(!shown(run({ adaptive_pressure_advance: ['1'] }), 'adaptive_pressure_advance_model', 'filament'));
    assert.ok(shown(off, 'filament_diameter', 'filament') && !shown(off, 'pellet_flow_coefficient', 'filament'));
    const pellet = run({ pellet_modded_printer: '1' });
    assert.ok(!shown(pellet, 'filament_diameter', 'filament') && shown(pellet, 'pellet_flow_coefficient', 'filament'));
    assert.ok(!shown(run({ support_chamber_temp_control: '0' }), 'activate_chamber_temp_control', 'filament'));
    assert.ok(!enabled(run({ volumetric_speed_coefficients: ['0 0 0 0 0 0'] }), 'filament_adaptive_volumetric_speed', 'filament'));
    assert.ok(enabled(run({ volumetric_speed_coefficients: ['1 2 3 4 5 6'] }), 'filament_adaptive_volumetric_speed', 'filament'));
  });

  it('shows the first layer bed temperature of the plate’s bed type only', () => {
    const keys = ['supertack_plate_temp_initial_layer', 'cool_plate_temp_initial_layer', 'textured_cool_plate_temp_initial_layer',
      'eng_plate_temp_initial_layer', 'textured_plate_temp_initial_layer', 'hot_plate_temp_initial_layer'];
    const pei = run({ curr_bed_type: 'Textured PEI Plate' });
    assert.deepEqual(keys.filter((k) => shown(pei, k, 'filament')), ['textured_plate_temp_initial_layer']);
    assert.deepEqual(keys.filter((k) => shown(run({ curr_bed_type: 'High Temp Plate' }), k, 'filament')), ['hot_plate_temp_initial_layer']);
    for (const r of [run({ curr_bed_type: 'Textured PEI Plate', support_multi_bed_types: '1' }), run({ curr_bed_type: 'Cool Plate' }, { isBbl: true }), run({ curr_bed_type: 'Default Plate' })])
      assert.equal(keys.filter((k) => shown(r, k, 'filament')).length, 6);
  });

  it('Setting Overrides: checkboxes, nil slots and long retractions', () => {
    const overrides = ['filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below',
      'filament_retract_lift_enforce', 'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_restart_extra',
      'filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange', 'filament_retraction_minimum_travel',
      'filament_retract_when_changing_layer', 'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_retract_after_wipe',
      'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'];
    const unset = run();
    for (const key of overrides) {
      assert.ok(!unset.filament.lockedOverrides.has(key), `${key} checkbox`);
      assert.ok(!enabled(unset, key, 'filament'), `${key} field`);
    }
    const set = run({ filament_retraction_length: ['1.2'], filament_wipe: ['1'] });
    assert.ok(enabled(set, 'filament_retraction_length', 'filament') && enabled(set, 'filament_wipe', 'filament'));
    assert.ok(!enabled(set, 'filament_z_hop', 'filament'));
    // No retraction in the filament: every other override checkbox is locked.
    const none = run({ filament_retraction_length: ['0'], filament_wipe: ['1'] });
    assert.ok(!none.filament.lockedOverrides.has('filament_retraction_length') && enabled(none, 'filament_retraction_length', 'filament'));
    assert.ok(none.filament.lockedOverrides.has('filament_wipe') && !enabled(none, 'filament_wipe', 'filament'));
    // Long retractions when cut: the printer's level 2 lets the filament decide.
    assert.ok(!shown(unset, 'filament_long_retractions_when_cut', 'filament'));
    const level2 = run({ enable_long_retraction_when_cut: '2', filament_long_retractions_when_cut: ['1'], filament_retraction_distances_when_cut: ['18'] });
    assert.ok(shown(level2, 'filament_long_retractions_when_cut', 'filament') && enabled(level2, 'filament_long_retractions_when_cut', 'filament'));
    assert.ok(shown(level2, 'filament_retraction_distances_when_cut', 'filament') && enabled(level2, 'filament_retraction_distances_when_cut', 'filament'));
    assert.ok(!shown(run({ enable_long_retraction_when_cut: '2' }), 'filament_retraction_distances_when_cut', 'filament'));
    // Ironing overrides: always usable, the field follows its own nil.
    const ironing = run({ filament_ironing_flow: ['12%'] });
    assert.ok(!ironing.filament.lockedOverrides.has('filament_ironing_speed'));
    assert.ok(enabled(ironing, 'filament_ironing_flow', 'filament') && !enabled(ironing, 'filament_ironing_speed', 'filament'));
  });

  it('multimaterial', () => {
    assert.ok(enabled(run(), 'filament_loading_speed', 'filament') && !enabled(run({}, { isBbl: true }), 'filament_cooling_moves', 'filament'));
    assert.ok(!enabled(run(), 'filament_multitool_ramming_flow', 'filament'));
    assert.ok(enabled(run({ filament_multitool_ramming: ['1'] }), 'filament_multitool_ramming_volume', 'filament'));
    assert.ok(!shown(run({}, { isBbl: true }), 'long_retractions_when_ec', 'filament'));
    const bbl2 = run({ nozzle_diameter: ['0.4', '0.4'], long_retractions_when_ec: ['1'] }, { isBbl: true });
    assert.ok(shown(bbl2, 'long_retractions_when_ec', 'filament') && shown(bbl2, 'retraction_distances_when_ec', 'filament'));
  });

  it('checks volumetric speed, temperatures, chamber and the adaptive PA model', () => {
    assert.deepEqual(find(run({ filament_max_volumetric_speed: ['0.2'] }), 'max-volumetric-speed-small')!.fix, { filament_max_volumetric_speed: '0.5' });
    const recommended = find(runEdited({ filament_type: ['PLA'], nozzle_temperature_range_low: ['170'], nozzle_temperature_range_high: ['260'] }), 'recommended-temperature-range')!;
    assert.match(recommended.message, /A minimum temperature above 180℃ is recommended for PLA\. A maximum temperature below 240℃ is recommended for PLA\. Please check\./);
    assert.match(find(runEdited({ filament_type: ['Unobtainium'], nozzle_temperature_range_low: ['180'] }), 'recommended-temperature-range')!.message, /above 190℃ is recommended for Unknown/);
    assert.match(find(runEdited({ nozzle_temperature_range_low: ['230'], nozzle_temperature_range_high: ['220'], nozzle_temperature: ['225'], nozzle_temperature_initial_layer: ['225'] }), 'recommended-temperature-range')!.message, /cannot be higher/);
    const hot = runEdited({ nozzle_temperature: ['260'] });
    assert.match(find(hot, 'nozzle-temperature-range')!.message, /\[190, 240\] degrees Celsius/);
    assert.equal(find(hot, 'nozzle-temperature-initial-layer-range'), undefined);
    assert.ok(find(runEdited({ nozzle_temperature_initial_layer: ['180'] }), 'nozzle-temperature-initial-layer-range'));
    assert.match(find(runEdited({ chamber_temperature: ['60'] }), 'chamber-temperature-safe')!.message, /maximum safe temperature for the material is 45$/);
    assert.equal(find(runEdited({ chamber_temperature: ['60'], support_chamber_temp_control: '0' }), 'chamber-temperature-safe'), undefined);
    assert.equal(find(runEdited({ chamber_temperature: ['60'], filament_type: ['ABS'] }), 'chamber-temperature-safe'), undefined);
    assert.deepEqual(find(runEdited({ chamber_minimal_temperature: ['50'], chamber_temperature: ['40'], filament_type: ['ABS'] }), 'chamber-minimal-temperature')!.fix, { chamber_minimal_temperature: '40' });
    // The adaptive PA model is checked when it is edited, which is possible only while it is shown.
    const pa = { enable_pressure_advance: ['1'], adaptive_pressure_advance: ['1'] };
    const modelEdited = { edited: new Set(['adaptive_pressure_advance_model']) };
    assert.match(find(run(pa, modelEdited), 'adaptive-pa-model')!.message, /Line 1: flow value must be greater than PA value/);
    assert.equal(find(run({ ...pa, adaptive_pressure_advance_model: ['0.04,1,1000\n0.05,2,3000'] }, modelEdited), 'adaptive-pa-model'), undefined);
    assert.equal(find(run({}, modelEdited), 'adaptive-pa-model'), undefined);
    // Orca's default model fails its own validation, but turning PA on does not check it.
    assert.equal(find(runEdited(pa), 'adaptive-pa-model'), undefined);
  });

  it('makes the checks Orca makes on an edit only for the keys the user has set', () => {
    // Values as a preset loads them: none of these checks runs.
    const stock: Values = {
      filament_type: ['PLA'], nozzle_temperature_range_low: ['170'], nozzle_temperature_range_high: ['250'], nozzle_temperature: ['260'],
      nozzle_temperature_initial_layer: ['260'], chamber_temperature: ['60'], chamber_minimal_temperature: ['70'],
      enable_pressure_advance: ['1'], adaptive_pressure_advance: ['1'], adaptive_pressure_advance_model: ['x'], layer_height: '0.5', max_layer_height: ['0.32'],
    };
    const onEdit = new Set(['recommended-temperature-range', 'nozzle-temperature-range', 'nozzle-temperature-initial-layer-range',
      'chamber-temperature-safe', 'chamber-minimal-temperature', 'adaptive-pa-model', 'layer-height-limits']);
    assert.deepEqual(ids(run(stock)).filter((id) => onEdit.has(id)), []);
    assert.deepEqual(ids(run(stock, { edited: new Set() })).filter((id) => onEdit.has(id)), []);
    // Each one after an edit of one of its keys, and only then.
    const checkedOn: Record<string, string[]> = {};
    for (const key of Object.keys(stock)) {
      for (const issue of run(stock, { edited: new Set([key]) }).issues) {
        if (!issue.checkedOn) continue;
        assert.ok(onEdit.has(issue.id) && issue.checkedOn.includes(key), `${issue.id} on ${key}`);
        (checkedOn[issue.id] ??= []).push(key);
      }
    }
    assert.deepEqual(checkedOn, {
      'recommended-temperature-range': ['nozzle_temperature_range_low', 'nozzle_temperature_range_high'],
      'nozzle-temperature-range': ['nozzle_temperature'],
      'nozzle-temperature-initial-layer-range': ['nozzle_temperature_initial_layer'],
      'chamber-temperature-safe': ['chamber_temperature'],
      'chamber-minimal-temperature': ['chamber_temperature', 'chamber_minimal_temperature'],
      'adaptive-pa-model': ['adaptive_pressure_advance_model'],
      'layer-height-limits': ['layer_height'],
    });
    for (const issue of runEdited(stock).issues) assert.equal(Boolean(issue.checkedOn), onEdit.has(issue.id), issue.id);
  });

  it('validates adaptive PA models like AdaptivePAProcessor', () => {
    assert.equal(validateAdaptivePaModel(''), '');
    assert.equal(validateAdaptivePaModel(' 0.03,1,1000 \r\n\n0.04,2,2000'), '');
    assert.equal(validateAdaptivePaModel('0.03,1,1000\n0.04;2;2000'), 'Line 2: only numbers, commas and dots are allowed');
    assert.equal(validateAdaptivePaModel('0.03,1'), 'Line 1: must contain exactly 3 comma-separated values (PA, flow, acceleration)');
    assert.equal(validateAdaptivePaModel(',1,1000'), 'Line 1: invalid numeric value');
    assert.equal(validateAdaptivePaModel('0.03,,1000'), 'Line 1: invalid numeric value');
    assert.equal(validateAdaptivePaModel('0.03,1,'), 'Line 1: missing acceleration value');
    assert.equal(validateAdaptivePaModel(',1,'), 'Line 1: invalid numeric value');
    assert.equal(validateAdaptivePaModel('0.03,.,1000'), 'Line 1: invalid numeric value');
    assert.equal(validateAdaptivePaModel(`0.03,1,1${'0'.repeat(400)}`), 'Line 1: invalid numeric value');
    // std::stod reads the leading number.
    assert.equal(validateAdaptivePaModel('0.03.5,1.,1000'), '');
    assert.equal(validateAdaptivePaModel('2,3,4'), 'Line 1: PA value must be less than 2');
    assert.equal(validateAdaptivePaModel('0.5,0.4,4'), 'Line 1: flow value must be greater than PA value');
    assert.equal(validateAdaptivePaModel('0.5,5,4'), 'Line 1: acceleration value must be greater than flow value');
  });
});

// ---------------------------------------------------------------------------------------------
// Printer: TabPrinter::toggle_options, update_input_shaper_menu, build_unregular_pages
// ---------------------------------------------------------------------------------------------

describe('rules: printer', () => {
  it('basic information: Bambu Lab only and non-Bambu options', () => {
    const other = run();
    assert.ok(!shown(other, 'scan_first_layer', 'machine') && shown(other, 'use_firmware_retraction', 'machine') && shown(other, 'thumbnails', 'machine'));
    const bbl = run({}, { isBbl: true });
    assert.ok(shown(bbl, 'bbl_calib_mark_logo', 'machine') && !shown(bbl, 'bed_mesh_min', 'machine') && shown(bbl, 'enable_power_loss_recovery', 'machine'));
    assert.ok(!shown(other, 'enable_power_loss_recovery', 'machine') && shown(run({ gcode_flavor: 'marlin2' }), 'enable_power_loss_recovery', 'machine'));
    assert.ok(shown(run({ support_parallel_printheads: '1' }), 'parallel_printheads_count', 'machine'));
    assert.ok(shown(run({ auxiliary_fan: '1' }), 'fan_direction', 'machine') && !shown(other, 'fan_direction', 'machine'));
    assert.ok(shown(other, 'support_air_filtration', 'machine') && !shown(other, 'cooling_filter_enabled', 'machine'));
    const filter = run({ support_cooling_filter: '1' });
    assert.ok(!shown(filter, 'support_air_filtration', 'machine') && shown(filter, 'cooling_filter_enabled', 'machine'));
    assert.ok(!shown(other, 'wrapping_detection_gcode', 'machine'));
  });

  it('bed exclusion volumes per extruder', () => {
    const one = run({ bed_exclude_volumes: '0..5;0x0,10x0,10x10' });
    assert.ok(!shown(one, 'bed_exclude_volume_mode', 'machine') && shown(one, 'bed_exclude_volumes', 'machine'));
    const two = { nozzle_diameter: ['0.4', '0.4'] };
    assert.ok(!shown(run(two), 'bed_exclude_volume_mode', 'machine'));
    assert.ok(shown(run({ ...two, bed_exclude_volumes: '0x0,10x0,10x10' }), 'bed_exclude_volume_mode', 'machine'));
    const perExtruder = run({ ...two, bed_exclude_volume_mode: 'per_extruder', extruder_bed_exclude_volumes: ['', '0x0,5x0,5x5'] });
    assert.ok(!shown(perExtruder, 'bed_exclude_volumes', 'machine'));
    assert.ok(shown(perExtruder, 'extruder_bed_exclude_volumes', 'machine', 1));
    // Per extruder but empty: the mode is not active.
    const empty = run({ ...two, bed_exclude_volume_mode: 'per_extruder', extruder_bed_exclude_volumes: ['', ' '] });
    assert.ok(shown(empty, 'bed_exclude_volumes', 'machine') && !shown(empty, 'extruder_bed_exclude_volumes', 'machine', 0));
  });

  it('multimaterial: wipe tower type, SEMM and tool changes', () => {
    const r = run();
    assert.ok(shown(r, 'wipe_tower_type', 'machine') && enabled(r, 'cooling_tube_length', 'machine'));
    assert.ok(!shown(run({}, { isBbl: true }), 'wipe_tower_type', 'machine'));
    assert.ok(!enabled(run({ wipe_tower_type: 'type1' }), 'high_current_on_filament_swap', 'machine'));
    // SEMM (the default)
    assert.ok(!enabled(r, 'extruders_count', 'machine') && enabled(r, 'manual_filament_change', 'machine') && enabled(r, 'purge_in_prime_tower', 'machine'));
    assert.ok(!enabled(r, 'tool_change_on_wipe_tower', 'machine'));
    const tools = run({ single_extruder_multi_material: '0', nozzle_diameter: ['0.4', '0.4'] });
    assert.ok(enabled(tools, 'extruders_count', 'machine') && enabled(tools, 'tool_change_on_wipe_tower', 'machine') && enabled(tools, 'wait_for_temp_on_wipe_tower', 'machine'));
    const manual = find(run({ single_extruder_multi_material: '0', manual_filament_change: '1' }), 'manual-filament-change-semm')!;
    assert.deepEqual([manual.fix, manual.triggers], [{ manual_filament_change: '0' }, ['single_extruder_multi_material']]);
  });

  it('extruder pages, per extruder', () => {
    const two = { nozzle_diameter: ['0.4', '0.6'] };
    const r = run({ ...two, retraction_length: ['0.8', '0'], z_hop: ['0.4', '0'], wipe: ['1', '1'], retract_before_wipe: ['70%', '100%'], retract_after_wipe: ['100%', '0%'] });
    for (const i of [0, 1]) {
      assert.ok(!enabled(r, 'extruder_printable_area', 'machine', i) && shown(r, 'extruder_printable_area', 'machine', i));
      assert.ok(!enabled(r, 'extruder_printable_height', 'machine', i));
    }
    assert.ok(enabled(r, 'retraction_minimum_travel', 'machine', 0) && !enabled(r, 'retraction_minimum_travel', 'machine', 1));
    assert.ok(enabled(r, 'z_hop', 'machine', 0) && !enabled(r, 'z_hop', 'machine', 1));
    assert.ok(enabled(r, 'retract_lift_above', 'machine', 0) && !enabled(r, 'retract_lift_enforce', 'machine', 1));
    // Extruder 0 wipes: before is locked by after = 100%, after is free (before < 100%).
    assert.ok(!enabled(r, 'retract_before_wipe', 'machine', 0) && enabled(r, 'retract_after_wipe', 'machine', 0));
    assert.ok(enabled(r, 'wipe_distance', 'machine', 0) && !enabled(r, 'wipe_distance', 'machine', 1));
    assert.ok(!shown(run(), 'extruder_printable_area', 'machine', 0));
    assert.ok(enabled(r, 'retract_restart_extra_toolchange', 'machine', 0) && !enabled(run({ retract_length_toolchange: ['0'] }), 'retract_restart_extra_toolchange', 'machine', 0));
    assert.ok(!enabled(run(), 'long_retractions_when_cut', 'machine', 0) && enabled(run({ enable_long_retraction_when_cut: '1' }), 'long_retractions_when_cut', 'machine', 0));
    assert.ok(shown(run({ long_retractions_when_cut: ['1'] }), 'retraction_distances_when_cut', 'machine', 0));
    assert.ok(enabled(run(), 'travel_slope', 'machine', 0) && !enabled(run({ z_hop_types: ['Normal Lift'] }), 'travel_slope', 'machine', 0));
  });

  it('firmware retraction', () => {
    const fw = run({ use_firmware_retraction: '1', retraction_length: ['0'], wipe: ['1'], retract_before_wipe: ['80%'] });
    assert.ok(enabled(fw, 'retraction_minimum_travel', 'machine', 0) && !enabled(fw, 'retraction_speed', 'machine', 0) && !enabled(fw, 'long_retractions_when_cut', 'machine', 0));
    const issue = find(fw, 'firmware-retraction-wipe')!;
    assert.deepEqual([issue.fix, issue.alternative?.values], [{ wipe: '0', retract_before_wipe: '100%' }, { use_firmware_retraction: '0' }]);
    assert.equal(find(run({ use_firmware_retraction: '1', wipe: ['1'], retract_before_wipe: ['100%'] }), 'firmware-retraction-wipe'), undefined);
  });

  it('the Motion ability page exists for Marlin-like flavors only', () => {
    for (const flavor of ['marlin', 'marlin2', 'klipper', 'reprapfirmware', 'repetier'])
      assert.equal(run({ gcode_flavor: flavor }).when.marlinLikeFlavor, true, flavor);
    for (const flavor of ['smoothie', 'reprap', 'sailfish', 'no-extrusion'])
      assert.equal(run({ gcode_flavor: flavor }).when.marlinLikeFlavor, false, flavor);
  });

  it('motion ability: limits, jerk, junction deviation, resonance and input shaping', () => {
    const marlin = run(); // gcode_flavor defaults to marlin (legacy)
    assert.ok(!shown(marlin, 'machine_max_acceleration_travel', 'machine') && !enabled(marlin, 'machine_max_acceleration_travel', 'machine', 0));
    assert.ok(!shown(marlin, 'machine_max_junction_deviation', 'machine') && enabled(marlin, 'emit_machine_limits_to_gcode', 'machine'));
    const rrf = run({ gcode_flavor: 'reprapfirmware' });
    assert.ok(shown(rrf, 'machine_max_acceleration_travel', 'machine') && enabled(rrf, 'machine_max_acceleration_travel', 'machine', 0));
    assert.ok(!shown(run({ gcode_flavor: 'klipper' }), 'machine_max_acceleration_travel', 'machine'));
    assert.ok(!enabled(run({ gcode_flavor: 'klipper' }), 'emit_machine_limits_to_gcode', 'machine'));
    // The silent (second) column is toggled only in silent mode.
    assert.ok(!run({ gcode_flavor: 'klipper' }).machine.disabled.has('machine_max_acceleration_travel#1'));
    assert.ok(run({ gcode_flavor: 'klipper', silent_mode: '1' }).machine.disabled.has('machine_max_acceleration_travel#1'));
    const jd = run({ gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0', '0.02'], silent_mode: '1' });
    assert.ok(shown(jd, 'machine_max_junction_deviation', 'machine') && enabled(jd, 'machine_max_junction_deviation', 'machine', 1));
    assert.ok(!enabled(jd, 'machine_max_jerk_x', 'machine', 0) && !enabled(jd, 'machine_max_jerk_e', 'machine', 1));
    assert.ok(enabled(run({ gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0', '0'] }), 'machine_max_jerk_z', 'machine', 0));
    assert.ok(!enabled(marlin, 'min_resonance_avoidance_speed', 'machine') && enabled(run({ resonance_avoidance: '1' }), 'max_resonance_avoidance_speed', 'machine'));
    // Input shaping: Marlin 2 and RepRapFirmware.
    assert.ok(!shown(marlin, 'input_shaping_type', 'machine') && !shown(run({ gcode_flavor: 'klipper' }), 'input_shaping_emit', 'machine'));
    const m2 = run({ gcode_flavor: 'marlin2', input_shaping_type: 'ZV' });
    assert.ok(shown(m2, 'input_shaping_type', 'machine') && enabled(m2, 'input_shaping_emit', 'machine') && !enabled(m2, 'input_shaping_type', 'machine'));
    const emit = run({ gcode_flavor: 'reprapfirmware', input_shaping_emit: '1' });
    assert.ok(enabled(emit, 'input_shaping_freq_x', 'machine') && !enabled(emit, 'input_shaping_freq_y', 'machine') && !enabled(emit, 'input_shaping_damp_y', 'machine'));
    assert.ok(!enabled(run({ gcode_flavor: 'marlin2', emit_machine_limits_to_gcode: '0', input_shaping_emit: '1' }), 'input_shaping_emit', 'machine'));
  });

  it('input shapers follow the firmware; others are reset to the first', () => {
    const filter = (flavor: string) => run({ gcode_flavor: flavor }).machine.enumFilters.get('input_shaping_type');
    assert.deepEqual(filter('klipper'), ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI', 'Disable']);
    assert.deepEqual(filter('reprapfirmware'), ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA', 'Disable']);
    assert.deepEqual(filter('marlin2'), ['ZV', 'Disable']);
    assert.deepEqual(filter('marlin'), ['Default', 'Disable']);
    const reset = find(run({ gcode_flavor: 'marlin2', input_shaping_type: 'Default' }), 'input-shaper-type')!;
    assert.deepEqual([reset.fix, reset.triggers], [{ input_shaping_type: 'ZV' }, ['gcode_flavor']]);
    // Also for a flavor without the Motion ability page.
    assert.deepEqual(find(run({ gcode_flavor: 'smoothie', input_shaping_type: 'MZV' }), 'input-shaper-type')!.fix, { input_shaping_type: 'Default' });
  });
});

// ---------------------------------------------------------------------------------------------
// Edits: on_value_change and the silent rewrites an edit starts
// ---------------------------------------------------------------------------------------------

describe('rules: edits (editEffects)', () => {
  it('keeps the wipe percentages in range (printer)', () => {
    assert.deepEqual(edit('machine', 'retract_after_wipe', '50%', { retract_before_wipe: ['70%'] }).patch, { retract_after_wipe: '30%' });
    assert.deepEqual(edit('machine', 'retract_before_wipe', '120%').patch, { retract_before_wipe: '100%' });
    assert.deepEqual(edit('machine', 'retract_before_wipe', '100%', { retract_after_wipe: ['20%'] }).patch, { retract_after_wipe: '0%' });
    // Slot 1 of two extruders
    const values = { nozzle_diameter: ['0.4', '0.4'], retract_before_wipe: ['70%', '60%'], retract_after_wipe: ['0%', '0%'] };
    assert.deepEqual(edit('machine', 'retract_after_wipe', '0%,80%', values, {}, 1).patch, { retract_after_wipe: '0%,40%' });
    assert.deepEqual(edit('machine', 'retract_after_wipe', '10%', values).patch, {});
  });

  it('keeps the wipe percentages in range (filament overrides fall back to the printer)', () => {
    assert.deepEqual(edit('filament', 'filament_retract_after_wipe', '60%', { retract_before_wipe: ['70%'] }).patch, { filament_retract_after_wipe: '30%' });
    assert.deepEqual(edit('filament', 'filament_retract_after_wipe', '60%', { retract_before_wipe: ['70%'], filament_retract_before_wipe: ['20%'] }).patch, {});
    assert.deepEqual(edit('filament', 'filament_retract_before_wipe', '-5%').patch, { filament_retract_before_wipe: '0%' });
  });

  it('leaves an unchecked (nil) wipe override nil, and writes nothing for text that is not a number', () => {
    // Unchecking the override sets the slot to nil: Orca's clamp of NaN writes nil back.
    assert.deepEqual(edit('filament', 'filament_retract_before_wipe', 'nil').patch, {});
    assert.deepEqual(edit('filament', 'filament_retract_after_wipe', 'nil', { filament_retract_after_wipe: ['30%'] }).patch, {});
    // ...but the other percentage is still kept in range, with the printer's value in place of the nil one.
    assert.deepEqual(edit('filament', 'filament_retract_before_wipe', 'nil', { retract_before_wipe: ['80%'], filament_retract_after_wipe: ['50%'] }).patch,
      { filament_retract_after_wipe: '20%' });
    const two = { nozzle_diameter: ['0.4', '0.4'], filament_retract_before_wipe: ['20%', '30%'] };
    assert.deepEqual(edit('filament', 'filament_retract_before_wipe', '20%,nil', two, {}, 1).patch, {});
    for (const value of ['', 'abc', 'nil']) {
      assert.deepEqual(edit('machine', 'retract_before_wipe', value).patch, {}, JSON.stringify(value));
      assert.deepEqual(edit('machine', 'retract_after_wipe', value).patch, {}, JSON.stringify(value));
    }
  });

  it('converts between pellet flow and filament diameter', () => {
    assert.deepEqual(edit('filament', 'pellet_flow_coefficient', '0.4157').patch, { filament_diameter: '1.75011' });
    assert.deepEqual(edit('filament', 'filament_diameter', '1.75').patch, { pellet_flow_coefficient: '0.415752' });
    // No infinite or NaN result is written (Orca would write inf for 0).
    for (const value of ['0', '', 'nil', 'abc', '-1']) {
      assert.deepEqual(edit('filament', 'pellet_flow_coefficient', value).patch, {}, JSON.stringify(value));
      if (value !== '-1') assert.deepEqual(edit('filament', 'filament_diameter', value).patch, {}, JSON.stringify(value));
    }
  });

  it('asks about the prime tower, clumping detection and precise Z', () => {
    const prompts = (e: ReturnType<typeof edit>) => e.prompts.map((p) => p.id);
    assert.deepEqual(prompts(edit('process', 'enable_prime_tower', '0', { enable_prime_tower: '1' })), []);
    assert.deepEqual(prompts(edit('process', 'enable_prime_tower', '0', { extruder_max_nozzle_count: ['1', '2'] })), ['prime-tower-nozzle-change']);
    assert.deepEqual(prompts(edit('process', 'enable_prime_tower', '0', { extruder_max_nozzle_count: ['nil'] })), []);
    assert.deepEqual(prompts(edit('process', 'enable_prime_tower', '0', { timelapse_type: '1', enable_wrapping_detection: '1' })),
      ['prime-tower-smooth-timelapse', 'prime-tower-wrapping-detection']);
    const precise = edit('process', 'enable_prime_tower', '1', { precise_z_height: '1' });
    assert.deepEqual(precise.prompts[0].choices.map((c) => c.values), [{}, { enable_prime_tower: '0' }]);
    assert.deepEqual(prompts(edit('process', 'precise_z_height', '1', { enable_prime_tower: '1' })), ['precise-z-prime-tower']);
    assert.deepEqual(prompts(edit('process', 'enable_wrapping_detection', '1', {}, { supportsWrappingDetection: true })), ['wrapping-detection-prime-tower']);
  });

  it('smooth timelapse and sparse layers exclude each other', () => {
    const smooth = edit('process', 'timelapse_type', '1', { wipe_tower_no_sparse_layers: '1' });
    assert.deepEqual(smooth.patch, { wipe_tower_no_sparse_layers: '0' });
    assert.deepEqual(smooth.prompts.map((p) => p.id), ['smooth-timelapse-sparse-layers', 'smooth-timelapse-prime-tower']);
    assert.deepEqual(smooth.prompts[1].choices[0].values, { enable_prime_tower: '1' });
    assert.deepEqual(edit('process', 'wipe_tower_no_sparse_layers', '1', { timelapse_type: '1' }).patch, { timelapse_type: '0' });
    assert.deepEqual(edit('process', 'wipe_tower_no_sparse_layers', '1').patch, {});
  });

  it('by-object on an I3 printer, make overhang printable, rotation templates, long retractions', () => {
    assert.deepEqual(edit('process', 'print_sequence', 'by object', { printer_structure: 'i3' }).prompts[0].choices[1].values, { print_sequence: 'by layer' });
    assert.equal(edit('process', 'print_sequence', 'by object', { printer_structure: 'corexy' }).prompts.length, 0);
    assert.equal(edit('process', 'make_overhang_printable', '1').prompts[0].id, 'make-overhang-printable');
    assert.equal(edit('process', 'make_overhang_printable', '0').prompts.length, 0);
    assert.equal(edit('process', 'sparse_infill_rotate_template', '0,90', { sparse_infill_pattern: 'gyroid' }).prompts[0].id, 'sparse-infill-rotate-template');
    assert.equal(edit('process', 'sparse_infill_rotate_template', '0,90', { sparse_infill_pattern: 'rectilinear' }).prompts.length, 0);
    assert.equal(edit('process', 'sparse_infill_rotate_template', '0,90', { sparse_infill_pattern: 'gyroid', sparse_infill_rotate_template: '45' }).prompts.length, 0);
    assert.equal(edit('machine', 'long_retractions_when_cut', '1').prompts[0].id, 'long-retractions-when-cut');
    assert.equal(edit('filament', 'filament_long_retractions_when_cut', '1').prompts[0].id, 'filament-long-retractions-when-cut');
    assert.equal(edit('filament', 'filament_long_retractions_when_cut', 'nil').prompts.length, 0);
  });

  it('support filaments', () => {
    const base = { filament_is_support: ['1'], filament_soluble: ['0'] };
    assert.deepEqual(edit('process', 'support_filament', '1', base).prompts[0].choices[1].values, { support_filament: '0' });
    assert.equal(edit('process', 'support_filament', '1').prompts.length, 0);
    assert.equal(edit('process', 'support_filament', '1', { ...base, filament_type: ['TPU'] }).prompts.length, 0);
    const iface = edit('process', 'support_interface_filament', '1', base);
    assert.deepEqual(iface.prompts[0].choices[0].values, {
      support_top_z_distance: '0', support_interface_spacing: '0', support_interface_pattern: 'rectilinear_interlaced', independent_support_layer_height: '0',
    });
    // has_filaments: PETG support for PLA objects counts as a support filament, but only with objects on the plate.
    const petg = { filament_type: ['PLA', 'PETG'] };
    assert.equal(edit('process', 'support_filament', '2', petg, { filamentCount: 2 }).prompts[0].id, 'support-filament-not-soluble');
    assert.equal(edit('process', 'support_filament', '2', petg, { filamentCount: 2, hasObjects: false }).prompts.length, 0);
    const soluble = edit('process', 'support_interface_filament', '1', { filament_soluble: ['1'], support_filament: '0' }, { filamentCount: 1 });
    assert.match(soluble.prompts[0].message, /soluble material/);
    assert.equal(edit('process', 'support_interface_filament', '1', { ...base, support_top_z_distance: '0', support_interface_spacing: '0', support_interface_pattern: 'rectilinear_interlaced' }).prompts.length, 0);
  });

  it('writes what Orca writes with an edit', () => {
    assert.deepEqual(edit('process', 'support_type', 'tree(auto)', {}, { mode: 'simple' }).patch, { support_style: 'default' });
    assert.deepEqual(edit('process', 'support_type', 'tree(auto)').patch, {});
    assert.deepEqual(edit('process', 'enable_support', '1', { detect_overhang_wall: '0' }).patch, { detect_overhang_wall: '1' });
    assert.deepEqual(edit('process', 'enable_support', '1', { detect_overhang_wall: '0' }, { context: 'object' }).patch, {});
    assert.deepEqual(edit('process', 'enable_support', '1', { detect_overhang_wall: '0', enable_support: '1' }).patch, {});
    assert.deepEqual(edit('machine', 'single_extruder_multi_material', '0').patch, { purge_in_prime_tower: '0' });
    assert.deepEqual(edit('machine', 'single_extruder_multi_material', '0', { manual_filament_change: '1' }).patch, { purge_in_prime_tower: '0', manual_filament_change: '0' });
    assert.deepEqual(edit('machine', 'min_layer_height', '0.08,0.1', { nozzle_diameter: ['0.4', '0.4'] }, { isBbl: true }, 1).patch, { min_layer_height: '0.1,0.1' });
    assert.deepEqual(edit('machine', 'min_layer_height', '0.08,0.1', { nozzle_diameter: ['0.4', '0.4'] }, {}, 1).patch, {});
    const heads = { support_parallel_printheads: '1', parallel_printheads_bed_exclude_areas: ['0x0,10x0,10x10', '0x0,20x0,20x20'] };
    assert.deepEqual(edit('machine', 'parallel_printheads_count', '2', heads).patch, { bed_exclude_area: '0x0,20x0,20x20' });
    assert.deepEqual(edit('machine', 'parallel_printheads_count', '3', heads).patch, { bed_exclude_area: '' });
    assert.deepEqual(edit('machine', 'parallel_printheads_count', '2', { ...heads, support_parallel_printheads: '0' }).patch, {});
  });

  it('applies the silent rewrites the edited key starts, and only those', () => {
    assert.deepEqual(edit('process', 'max_volumetric_extrusion_rate_slope', '10', { enable_arc_fitting: '1' }).patch, { enable_arc_fitting: '0' });
    assert.deepEqual(edit('process', 'layer_height', '0.16', { max_volumetric_extrusion_rate_slope: '10', enable_arc_fitting: '1' }).patch, {});
    assert.deepEqual(edit('process', 'sparse_infill_pattern', 'zigzag', { fill_multiline: '3' }).patch, { fill_multiline: '1' });
    assert.deepEqual(edit('process', 'overhang_reverse_internal_only', '1').patch, { overhang_reverse_threshold: '0%' });
    assert.deepEqual(edit('process', 'support_type', 'tree(auto)', { enable_support: '1', support_style: 'snug' }).patch, { support_style: 'default' });
    assert.deepEqual(edit('process', 'max_volumetric_extrusion_rate_slope_segment_length', '0.3').patch, { max_volumetric_extrusion_rate_slope_segment_length: '1' });
    assert.deepEqual(edit('filament', 'close_fan_the_first_x_layers', '2', { initial_layer_fan_speed: ['35'] }).patch, { initial_layer_fan_speed: '-1' });
    assert.deepEqual(edit('machine', 'gcode_flavor', 'marlin2', { input_shaping_type: 'MZV' }).patch, { input_shaping_type: 'ZV' });
    assert.deepEqual(edit('process', 'enable_prime_tower', '1', { wipe_tower_wall_type: 'cone' }, { isBbl: true }).patch, { wipe_tower_wall_type: 'rectangle' });
    // A rewrite in another preset is not applied to this one.
    assert.deepEqual(edit('process', 'wall_loops', '3', { max_volumetric_extrusion_rate_slope: '10', enable_arc_fitting: '1' }).patch, {});
  });
});

// ---------------------------------------------------------------------------------------------
// The port against Orca's sources (skipped without the engine's Orca tree)
// ---------------------------------------------------------------------------------------------

const orcaTree = fs.existsSync(`${ORCA_ENGINE_ROOT}/src/slic3r/GUI/ConfigManipulation.cpp`);
const orcaFile = (file: string) => fs.readFileSync(`${ORCA_ENGINE_ROOT}/${file}`, 'utf8');
const rulesSrc = fs.readFileSync(RULES_TS, 'utf8');
const rulesCode = stripCppComments(rulesSrc.replace(/\r\n?/g, '\n'));

/** The body of `function name(` in rules.ts (comments stripped). */
function portFunction(name: string): string {
  const start = rulesCode.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `rules.ts has no function ${name}`);
  const open = rulesCode.indexOf('{', rulesCode.indexOf(')', start));
  for (let depth = 0, i = open; i < rulesCode.length; i++) {
    if (rulesCode[i] === '{') depth++;
    else if (rulesCode[i] === '}' && --depth === 0) return rulesCode.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

/** Each ported toggle function: Orca's function, the port, and how their calls correspond. */
const TOGGLE_PORTS = [
  { orca: 'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::toggle_print_fff_options', port: 'togglePrintFffOptions' },
  { orca: 'src/slic3r/GUI/Tab.cpp#TabFilament::toggle_options', port: 'tabFilamentToggleOptions' },
  { orca: 'src/slic3r/GUI/Tab.cpp#TabFilament::update_filament_overrides_page', port: 'updateFilamentOverridesPage' },
  { orca: 'src/slic3r/GUI/Tab.cpp#TabPrinter::toggle_options', port: 'tabPrinterToggleOptions' },
] as const;

/** Orca toggle calls: toggle_field/option (greyed), toggle_line (hidden), set_option_label, field->toggle, checkbox Enable. */
function orcaCallSites(body: string) {
  return {
    field: count(body, /\btoggle_(?:field|option)\(/g) + count(body, /->toggle\(/g),
    line: count(body, /\btoggle_line\(/g),
    label: count(body, /\bset_option_label\(/g),
    checkbox: count(body, /->Enable\(/g),
  };
}

function portCallSites(body: string) {
  return {
    field: count(body, /\bt\.field\(/g),
    line: count(body, /\bt\.line\(/g),
    label: count(body, /\bt\.label\(/g),
    checkbox: count(body, /\bt\.overrideEnabled\(/g),
  };
}

/** Keys the Orca function names that the port's function does not, and why (none the other way). */
const KEY_DIFFERENCES: Record<string, { keys: string[]; reason: string }> = {
  'TabPrinter::toggle_options': {
    keys: ['extruder_type', 'nozzle_volume_type', 'printer_extruder_id', 'printer_extruder_variant'],
    reason: 'get_index_for_extruder: the web slicer has one variant per extruder, so the variant index is the extruder index.',
  },
};

/** Words rules.ts uses as strings that are neither option keys nor enum values. */
const TS_WORDS = new Set([
  'process', 'filament', 'machine', 'error', 'warning', 'info', 'global', 'object', 'plate', 'simple', 'advanced', 'expert', 'develop',
  'float', 'floats', 'int', 'ints', 'bool', 'bools', 'percent', 'percents', 'enum', 'enums', 'string', 'strings', 'nil', 'true', 'mode',
  's', 'n', 't', 'r',
  'extruders_count', // TabPrinter's synthetic "Extruders" option (build_unregular_pages)
]);

describe('rules: the port against Orca’s sources', { skip: orcaTree ? false : `no Orca tree at ${ORCA_ENGINE_ROOT}` }, () => {
  const printConfigCpp = orcaTree ? orcaFile('src/libslic3r/PrintConfig.cpp') : '';
  const defs: ReadonlyMap<string, OrcaDefinition> = orcaTree ? parseOrcaDefinitions(printConfigCpp) : new Map();
  const enumMaps = orcaTree ? parseEnumKeyMaps(printConfigCpp) : new Map<string, Map<string, string>>();
  const enumKey = (enumName: string, constant: string) => {
    const key = enumMaps.get(enumName)?.get(constant.replace(/.*::/, ''));
    assert.ok(key !== undefined, `${enumName}::${constant}`);
    return key;
  };
  const orcaBody = (id: string) => {
    const [file, name] = id.split('#');
    const found = findCppDefinitions(orcaFile(file), name);
    assert.equal(found.length, 1, id);
    return found[0];
  };

  it('fingerprints match every ported Orca function (a mismatch names the function to re-port)', () => {
    assert.match(ORCA_RULES_COMMIT, /^[0-9a-f]{40}$/);
    const current = ruleSourceHashes(ORCA_ENGINE_ROOT, Object.keys(RULES_PORTED_FROM));
    const changed = Object.keys(RULES_PORTED_FROM).filter((id) => RULES_PORTED_FROM[id] !== current[id]);
    assert.deepEqual(changed, [], `Orca changed since the port: re-port these, then run node web/src/settings/rulesSource.ts --write`);
    for (const hash of Object.values(RULES_PORTED_FROM)) assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('READ has Orca’s type and default of every key the rules read', () => {
    const expected = readTableSource(readTableEntries(rulesReadKeys(rulesSrc), defs));
    assert.equal(readTableInRules(rulesSrc), expected, 'run node web/src/settings/rulesSource.ts --write');
  });

  it('ports every toggle call site of Orca’s functions, minus the listed ones', () => {
    let orcaTotal = 0;
    let portTotal = 0;
    for (const { orca, port } of TOGGLE_PORTS) {
      const name = orca.split('#')[1];
      const o = orcaCallSites(orcaBody(orca));
      const p = portCallSites(portFunction(port));
      const skipped = SKIPPED_CALL_SITES[name.replace(/^ConfigManipulation::/, '')]?.length ?? 0;
      orcaTotal += o.field + o.line + o.label + o.checkbox;
      portTotal += p.field + p.line + p.label + p.checkbox;
      assert.deepEqual({ ...p, field: p.field + skipped }, o, name);
    }
    // TabPrint::toggle_options's two enum filters and update_input_shaper_menu's one
    const tabPrint = orcaBody('src/slic3r/GUI/Tab.cpp#TabPrint::toggle_options');
    assert.equal(count(tabPrint, /get_field\("/g), count(portFunction('tabPrintToggleOptions'), /\bt\.enumOnly\(/g));
    assert.equal(count(portFunction('updateInputShaperMenu'), /\bt\.enumOnly\(/g), 1);
    const skippedTotal = Object.values(SKIPPED_CALL_SITES).flat().length;
    assert.equal(portTotal + skippedTotal, orcaTotal);
    assert.equal(orcaTotal, 258, 'Orca’s toggle call sites (the report quotes this count)');
  });

  it('names the same option keys as each Orca function', () => {
    const keysIn = (text: string, quote: string) => new Set([...text.matchAll(new RegExp(`${quote}([a-z0-9_]+)${quote}`, 'g'))].map((m) => m[1]).filter((k) => defs.has(k)));
    // The port writes enum values as strings (Orca uses constants): drop them first. Some are also
    // option names (brim_type 'brim_ears').
    const withoutEnumValues = (text: string) => text
      .replace(/(\b(?:c\.is|v)\(\s*'\w+'\s*,\s*)'[^']*'/g, "$1''")
      .replace(/(\b(?:enumValues|enumList)\(\s*'\w+'\s*,\s*)\[[^\]]*\]/g, '$1[]');
    for (const { orca, port } of TOGGLE_PORTS) {
      const name = orca.split('#')[1];
      const inOrca = keysIn(orcaBody(orca), '"');
      const inPort = keysIn(withoutEnumValues(portFunction(port)), "'");
      const allowed = new Set(KEY_DIFFERENCES[name]?.keys ?? []);
      for (const key of allowed) assert.ok(inOrca.has(key) && !inPort.has(key), `${name}: KEY_DIFFERENCES ${key} is out of date`);
      assert.deepEqual([...inOrca].filter((k) => !inPort.has(k) && !allowed.has(k)).sort(), [], `${name}: keys the port misses`);
      assert.deepEqual([...inPort].filter((k) => !inOrca.has(k)).sort(), [], `${name}: keys Orca does not name`);
    }
  });

  it('every key literal is an Orca option and every enum literal a value of its option', () => {
    const allEnumValues = new Set([...defs.values()].flatMap((d) => [...d.enumKeys, ...d.enumValues]));
    const unknown = [...new Set([...rulesCode.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]))]
      .filter((w) => !defs.has(w) && !allEnumValues.has(w) && !TS_WORDS.has(w));
    assert.deepEqual(unknown, []);
    const pairs: [string, string][] = [];
    for (const m of rulesCode.matchAll(/\bc\.is\(\s*'(\w+)'\s*,\s*'([^']*)'/g)) pairs.push([m[1], m[2]]);
    for (const m of rulesCode.matchAll(/\bv\(\s*'(\w+)'\s*,\s*'([^']*)'\s*\)/g)) pairs.push([m[1], m[2]]);
    for (const m of rulesCode.matchAll(/\b(?:enumValues|enumList)\(\s*'(\w+)'\s*,\s*\[([^\]]*)\]/g))
      for (const value of m[2].matchAll(/'([^']*)'/g)) pairs.push([m[1], value[1]]);
    assert.ok(pairs.length > 150, `found ${pairs.length} enum literals`);
    for (const [key, value] of pairs) {
      const def = defs.get(key);
      assert.ok(def && /^enums?$/.test(def.type), `${key} is an enum option`);
      assert.ok(def.enumKeys.includes(value), `${key}: "${value}" is not one of ${def.enumKeys.join(', ')}`);
    }
  });

  it('predicates and enum filters match Orca’s (checked through the rules)', () => {
    const infill = [...enumMaps.get('InfillPattern')!.values()];
    const constants = (text: string) => [...text.matchAll(/\b(ip\w+)\b/g)].map((m) => enumKey('InfillPattern', m[1]));
    // is_separable_infill_pattern
    const separable = new Set(constants(orcaBody('src/libslic3r/PrintConfig.hpp#is_separable_infill_pattern').split('return false')[0]));
    for (const p of infill) assert.equal(shown(run({ sparse_infill_pattern: p }), 'separated_infills'), separable.has(p), `separated_infills ${p}`);
    // is_smoothable_infill_pattern: always, or only with several lines
    const [always, multi] = orcaBody('src/libslic3r/PrintConfig.hpp#is_smoothable_infill_pattern').split('return true');
    const smoothAlways = new Set(constants(always));
    const smoothMulti = new Set(constants(multi.split('return multiline')[0]));
    for (const p of infill) {
      assert.equal(shown(run({ sparse_infill_pattern: p }), 'sparse_infill_smooth_factor'), smoothAlways.has(p), `smooth ${p}`);
      assert.equal(shown(run({ sparse_infill_pattern: p, fill_multiline: '2' }), 'sparse_infill_smooth_factor'), smoothAlways.has(p) || smoothMulti.has(p), `smooth x2 ${p}`);
    }
    // The multiline patterns of toggle_print_fff_options
    const fff = orcaBody('src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::toggle_print_fff_options');
    const multiline = new Set(constants(/have_multiline_infill_pattern\s*=([^;]*);/.exec(fff)![1]));
    for (const p of infill) assert.equal(enabled(run({ sparse_infill_pattern: p }), 'fill_multiline'), multiline.has(p), `fill_multiline ${p}`);
    // is_tree / is_auto
    const supportConstants = (fn: string) => new Set([...orcaBody(`src/libslic3r/PrintConfig.hpp#${fn}`).matchAll(/\b(st[A-Z]\w*)\b/g)].map((m) => enumKey('SupportType', m[1])));
    const tree = supportConstants('is_tree');
    const auto = supportConstants('is_auto');
    for (const t of enumMaps.get('SupportType')!.values()) {
      const r = run({ enable_support: '1', support_type: t, support_style: 'tree_slim' });
      assert.equal(shown(r, 'max_bridge_length'), tree.has(t), `tree ${t}`);
      assert.equal(enabled(r, 'support_threshold_angle'), auto.has(t), `auto ${t}`);
    }
    // TabPrint::toggle_options enum filters
    const tabPrint = orcaBody('src/slic3r/GUI/Tab.cpp#TabPrint::toggle_options');
    const set = (name: string, enumName: string) => [...new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`).exec(tabPrint)![1].matchAll(/(\w+)/g)].map((m) => enumKey(enumName, m[1]));
    assert.deepEqual(run().process.enumFilters.get('support_style'), set('enum_set_normal', 'SupportMaterialStyle'));
    assert.deepEqual(run({ support_type: 'tree(auto)' }).process.enumFilters.get('support_style'), set('enum_set_tree', 'SupportMaterialStyle'));
    assert.deepEqual(run({}, { isBbl: true }).process.enumFilters.get('wipe_tower_wall_type'), set('enum_set_bbl', 'WipeTowerWallType'));
    assert.deepEqual(run().process.enumFilters.get('wipe_tower_wall_type'), set('enum_set_none_bbl', 'WipeTowerWallType'));
    // input_shaper_types_for_flavor
    const shapers = orcaBody('src/slic3r/GUI/Tab.cpp#input_shaper_types_for_flavor');
    for (const block of shapers.split(/\bcase\s+|default\s*:/).slice(1)) {
      const flavor = /^GCodeFlavor::(\w+)/.exec(block)?.[1];
      const types = [...block.matchAll(/InputShaperType::(\w+)/g)].map((m) => enumKey('InputShaperType', m[1]));
      const gcode_flavor = flavor ? enumKey('GCodeFlavor', flavor) : 'smoothie';
      assert.deepEqual(run({ gcode_flavor }).machine.enumFilters.get('input_shaping_type'), types, gcode_flavor);
    }
    // build_unregular_pages: the Motion ability page
    const pages = orcaBody('src/slic3r/GUI/Tab.cpp#TabPrinter::build_unregular_pages');
    const marlinLike = new Set([...(/is_marlin_flavor\s*=\s*\(([^;]*)\);/.exec(pages)![1].matchAll(/\b(gcf\w+)\b/g))].map((m) => enumKey('GCodeFlavor', m[1])));
    for (const flavor of enumMaps.get('GCodeFlavor')!.values())
      assert.equal(run({ gcode_flavor: flavor }).when.marlinLikeFlavor, marlinLike.has(flavor), flavor);
    // get_bed_temp_1st_layer_key
    const bedKeys = orcaBody('src/libslic3r/PrintConfig.hpp#get_bed_temp_1st_layer_key');
    for (const m of bedKeys.matchAll(/type\s*==\s*(bt\w+)\s*\)\s*return\s*"(\w+)"/g)) {
      const r = run({ curr_bed_type: enumKey('BedType', m[1]) });
      assert.ok(shown(r, m[2], 'filament') && r.filament.hidden.size >= 5, m[1]);
    }
  });

  it('MATERIAL_TYPES is MaterialType::all', () => {
    const all = orcaBody('src/libslic3r/MaterialType.cpp#MaterialType::all');
    const rows = [...all.matchAll(/\{\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/g)]
      .map((m) => [m[1], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]);
    assert.deepEqual(MATERIAL_TYPES, rows);
  });

  it('lists what is skipped, with reasons', () => {
    for (const item of [...Object.values(SKIPPED_CALL_SITES).flat(), ...SKIPPED_BEHAVIOURS]) assert.ok(item.reason.length > 20);
    assert.ok(orcaBody('src/slic3r/GUI/Tab.cpp#TabPrinter::toggle_options').includes('toggle_option("retract_length", !use_firmware_retraction, i)'));
    assert.equal(defs.has('retract_length'), false);
  });

  it('sweeps every enum value the rules read: nothing throws, and every issue, fix and edit is well formed', () => {
    const presetKey = (key: string) => defs.has(key) || TS_WORDS.has(key);
    const checkValues = (values: Record<string, string> | undefined, where: string) => {
      for (const [key, value] of Object.entries(values ?? {})) {
        const def = defs.get(key);
        assert.ok(def, `${where}: ${key} is an option`);
        if (/^enums?$/.test(def.type)) assert.ok(def.enumKeys.includes(value), `${where}: ${key}=${value}`);
      }
    };
    const checkResult = (r: RulesResult, where: string) => {
      for (const scope of ['process', 'filament', 'machine'] as const) {
        for (const id of [...r[scope].hidden, ...r[scope].disabled, ...r[scope].lockedOverrides, ...r[scope].labels.keys(), ...r[scope].enumFilters.keys()])
          assert.ok(presetKey(id.replace(/#\d+$/, '')), `${where}: ${scope} ${id}`);
      }
      for (const issue of r.issues) {
        assert.equal(issue.keys[0], issue.key, `${where}: ${issue.id}`);
        for (const key of [...issue.keys, ...(issue.triggers ?? []), ...(issue.checkedOn ?? [])]) assert.ok(defs.has(key), `${where}: ${issue.id} names ${key}`);
        checkValues(issue.fix, `${where}: ${issue.id} fix`);
        checkValues(issue.alternative?.values, `${where}: ${issue.id} alternative`);
      }
    };
    const readEnums = readTableEntries(rulesReadKeys(rulesSrc), defs).filter(([, type]) => /^enums?$/.test(type));
    const everyKey: ReadonlySet<string> = new Set(defs.keys());
    const toggles: Values[] = [{}, { enable_support: '1', support_type: 'tree(auto)', raft_layers: '2' }, { spiral_mode: '1', enable_prime_tower: '1' },
      { nozzle_diameter: ['0.4', '0.4'], single_extruder_multi_material: '0', use_firmware_retraction: '1', wipe: ['1', '1'] }];
    let runs = 0;
    for (const [key] of readEnums) {
      for (const value of defs.get(key)!.enumKeys) {
        for (const base of toggles) {
          for (const env of [{}, { isBbl: true, context: 'object' as const, edited: everyKey, globalConfig: layeredConfig({ support_filament: '1' }) }]) {
            checkResult(run({ ...base, [key]: value }, env), `${key}=${value}`);
            runs++;
          }
        }
      }
    }
    assert.ok(runs > 1000, `${runs} evaluations`);
    // An edit of every key the rules read, to its default and to a changed value
    for (const [key, type, fallback] of readTableEntries(rulesReadKeys(rulesSrc), defs)) {
      const other = /^enums?$/.test(type) ? defs.get(key)!.enumKeys.at(-1)! : /^bools?$/.test(type) ? (fallback === '1' ? '0' : '1') : type.startsWith('string') ? 'x' : '1';
      for (const value of [fallback, other]) {
        const scope: RuleScope = /^filament_|^(nozzle_temperature|chamber|pellet|close_fan|initial_layer_fan)/.test(key) ? 'filament' : 'process';
        const effects = editEffects(scope, key, value, { config: layeredConfig({ enable_support: '1', enable_prime_tower: '1' }) });
        checkValues(effects.patch, `edit ${key}=${value}`);
        for (const p of effects.prompts) for (const choice of p.choices) checkValues(choice.values, `edit ${key}=${value} ${p.id}`);
      }
    }
  });

  it('never writes NaN, Infinity or undefined, whatever text a setting holds', () => {
    const bad = /NaN|Infinity|undefined/;
    const problems: string[] = [];
    const scan = (values: Record<string, string> | undefined, where: string) => {
      for (const [k, value] of Object.entries(values ?? {})) if (bad.test(value)) problems.push(`${where}: ${k}=${value}`);
    };
    const bases: Values[] = [{}, {
      nozzle_diameter: ['0.4', '0.4'], enable_support: '1', enable_prime_tower: '1', timelapse_type: '1', support_parallel_printheads: '1',
      filament_retract_before_wipe: ['nil'], filament_retraction_length: ['nil'], pellet_modded_printer: '1',
    }];
    const everyKey: ReadonlySet<string> = new Set(defs.keys());
    for (const [key] of readTableEntries(rulesReadKeys(rulesSrc), defs)) {
      for (const value of ['nil', '', '-5', '0', '1', '1e9', 'abc', '150%']) {
        for (const scope of ['process', 'filament', 'machine'] as const) {
          for (const base of bases) {
            const effects = editEffects(scope, key, value, { config: layeredConfig(base) });
            scan(effects.patch, `${scope} edit ${key}=${JSON.stringify(value)}`);
            for (const p of effects.prompts) for (const choice of p.choices) scan(choice.values, `${scope} edit ${key}=${JSON.stringify(value)} ${p.id}`);
          }
        }
        const r = run({ [key]: value }, { edited: everyKey });
        for (const issue of r.issues) {
          scan(issue.fix, `${key}=${JSON.stringify(value)} ${issue.id}`);
          scan(issue.alternative?.values, `${key}=${JSON.stringify(value)} ${issue.id} alternative`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});
