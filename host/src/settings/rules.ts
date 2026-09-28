// OrcaSlicer's settings rules: which settings are hidden or greyed out for the current values, the
// checks Orca shows as dialogs, and the values Orca changes by itself when a setting is edited.
//
// A hand port of the engine's Orca ($ORCA_WASM_ROOT/orca at ORCA_RULES_COMMIT), one function at a time
// and in Orca's statement order, because the last toggle of an option wins:
//   src/slic3r/GUI/ConfigManipulation.cpp  toggle_print_fff_options, update_print_fff_config,
//                                          check_layer_height and the filament check_* functions
//   src/slic3r/GUI/Tab.cpp                 TabPrint/TabFilament/TabPrinter::toggle_options,
//                                          update_filament_overrides_page, update_input_shaper_menu,
//                                          build_unregular_pages (the Motion ability page) and the
//                                          on_value_change handlers
// Differences from Orca, all deliberate:
//   - Orca toggles only the page it shows; evaluateRules() toggles every page of the three tabs.
//   - A dialog becomes an issue shown next to the setting, with Orca's answers as `fix` and
//     `alternative`. Nothing changes until the user applies one. Checks Orca makes only when a
//     field is edited (layer height limits, temperatures, chamber, the adaptive PA model) are
//     issues marked `checkedOn`: they are reported while one of those keys is among the keys the
//     user has set (RulesEnv.edited), so stock presets raise none of them, as in Orca.
//   - Orca's silent rewrites never run on preset load. Each is an issue (severity info) whose
//     `triggers` name the keys that start it; editEffects() applies its fix when the user edits one
//     of them, as Orca would at that moment.
//   - Orca's questions about an edit ("are you sure?") are editEffects() prompts.
//   - Rules are evaluated on the stored values, not on values a silent rewrite would produce.
// SKIPPED_CALL_SITES and SKIPPED_BEHAVIOURS list what is left out and why. RULES_PORTED_FROM
// fingerprints every ported function; rules.test.ts fails when Orca changes one, so the port can
// be redone (rulesSource.ts then refreshes the fingerprints and the READ table).
//
// Using it: build a ConfigView of the effective values (layeredConfig), call evaluateRules() on
// every change for the hidden and disabled rows, labels, enum filters and issues (pass the keys the
// user has set as `edited`), and call editEffects() when the user edits a setting, applying its
// patch with the edit.
//
// Pure (types-only imports) so it runs under plain Node in tests.
import type { ConfigValue } from '../../../packages/protocol/src/data.ts';
import { extruderVariantString, indexForExtruder } from './variants.ts';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type RuleScope = 'process' | 'filament' | 'machine';

/**
 * error: Orca refuses the value and resets it (an OK-only dialog). warning: Orca asks what to do,
 * or warns. info: Orca changes the value silently. None of them blocks slicing.
 */
export type IssueSeverity = 'error' | 'warning' | 'info';

/** The effective configuration the rules read. */
export interface ConfigView {
  /**
   * Effective value of `key` (object setting, else plate setting, else global override, else preset)
   * in Orca's text form: the preset's JSON shape (a string, or a string[] per slot), or Orca's
   * serialized text (a vector as "a,b", strings as "\"a\";\"b\""); a plain string for a vector
   * means every slot. undefined = not set anywhere, and Orca's default is used.
   * Keys are unique across the process, filament and machine presets, so one view serves all three.
   */
  get(key: string): ConfigValue | undefined;
}

export interface RulesEnv {
  config: ConfigView;
  /**
   * What is being edited: the global settings (Orca's print tab, default), one object's settings
   * (the object list) or one plate's settings. Orca shows `flush_into_objects` only outside the
   * global settings, never asks the spiral vase question for a plate, does not offer "No" to it or
   * to the alternate extra wall question for an object, and turns detect_overhang_wall on with
   * support only in the global settings.
   */
  context?: 'global' | 'object' | 'plate';
  /** PresetBundle::is_bbl_vendor(): a Bambu Lab printer. Default false. */
  isBbl?: boolean;
  /** Nozzles on the printer. Default: the number of nozzle_diameter slots. */
  extruderCount?: number;
  /** Filaments in the project. Default 1 (the web slicer loads one filament). */
  filamentCount?: number;
  /** The settings mode the user picked. Orca resets support_style on a support_type edit only in Simple mode. */
  mode?: 'simple' | 'advanced' | 'expert' | 'develop';
  /** DevPrinterConfigUtil::support_wrapping_detection(printer_type): Bambu's device database. Default false. */
  supportsWrappingDetection?: boolean;
  /**
   * The keys the user has set: global overrides, and for an object or a plate its own settings too.
   * Orca checks some values only when the user edits them (issues with `checkedOn`); those issues
   * are reported only while one of their `checkedOn` keys is in here. Default: none, so a preset
   * as loaded raises none of them, as in Orca.
   */
  edited?: ReadonlySet<string>;
  /**
   * For an object's or a plate's settings: the global effective values (Orca's plater config),
   * which Orca falls back to when it resets an object's filament id. Default: none (0 is used).
   */
  globalConfig?: ConfigView;
  /** Whether the plate has objects (has_filaments only looks at the filaments objects use). Default true. */
  hasObjects?: boolean;
}

/** One tab's display state. Ids are option keys, or `key#index` for one slot (extruder i, machine-limit column). */
export interface TabRules {
  /** Rows Orca hides (toggle_line). A row with several options is hidden when any of them is. */
  hidden: ReadonlySet<string>;
  /** Fields Orca greys out (toggle_field / toggle_option). */
  disabled: ReadonlySet<string>;
  /** Row labels Orca replaces (set_option_label). */
  labels: ReadonlyMap<string, string>;
  /** Enum options narrowed to these values, in this order. */
  enumFilters: ReadonlyMap<string, readonly string[]>;
  /** Filament "Setting Overrides" whose Override checkbox is greyed out. */
  lockedOverrides: ReadonlySet<string>;
}

export interface RuleFix {
  label: string;
  /** Values to write, in Orca's text form, all in the issue's scope. */
  values: Record<string, string>;
}

export interface RuleIssue {
  /** Stable id of the check, e.g. `spiral-vase`, `firmware-retraction-wipe`. */
  id: string;
  /** The preset the keys (and the fix) belong to. */
  scope: RuleScope;
  /** The row the issue is shown on. */
  key: string;
  /** Every key involved, `key` first. */
  keys: readonly string[];
  severity: IssueSeverity;
  message: string;
  /** What Orca's "Yes" (or its automatic reset) writes, in Orca's text form. */
  fix?: Record<string, string>;
  fixLabel?: string;
  /** Orca's "No" answer when it also changes values. */
  alternative?: RuleFix;
  /** For a silent Orca rewrite: editing one of these keys applies `fix` (see editEffects). */
  triggers?: readonly string[];
  /**
   * For a check Orca makes only when one of these keys is edited (a dialog at that moment, never on
   * preset load): the issue is reported only while RulesEnv.edited holds one of them.
   */
  checkedOn?: readonly string[];
}

export interface RulesResult {
  process: TabRules;
  filament: TabRules;
  machine: TabRules;
  /** Page conditions of the settings layout (schema `Page.when`). */
  when: { marlinLikeFlavor: boolean };
  issues: RuleIssue[];
}

/** A question Orca asks about an edit. The first choice is Orca's default; `values` = {} keeps the edit. */
export interface RulePrompt {
  id: string;
  scope: RuleScope;
  key: string;
  message: string;
  choices: RuleFix[];
}

export interface EditEffects {
  /**
   * Values Orca writes together with the edit, in Orca's text form, all in the edited key's scope.
   * It holds the edited key itself only when Orca changes the typed value (a clamp or a reset).
   */
  patch: Record<string, string>;
  /** Orca's questions about the edit, in the order Orca asks them. */
  prompts: RulePrompt[];
}

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------

/** The engine Orca commit the rules were ported from. */
export const ORCA_RULES_COMMIT = '2d1163eb6f5228de605150e3b4800081947070eb';

/**
 * `<file under the Orca root>#<function>` -> fingerprint of the Orca function as ported (see
 * rulesSource.ts cppFunctionHash: sha256 of the definition with comments dropped and whitespace
 * collapsed). The settings generator writes the same map as `schema.orca.ruleSources`; a mismatch
 * means Orca changed that function since the port.
 */
export const RULES_PORTED_FROM: Readonly<Record<string, string>> = {
  // Process
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::toggle_print_fff_options': 'sha256:b68694e7165e0f5abc79ae01323821aed2266815a006931d656f0aaf53b5542e',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::update_print_fff_config': 'sha256:9b420c795f73115b8e4e1dffe7c46ec2edc3d90e92ea0f99b64a40e09fd1f569',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::show_spiral_mode_settings_dialog': 'sha256:8b8d6bf384868744d718410bfdb3171d6fe4ff8f6b6c6306d63f44f385dad55e',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_layer_height': 'sha256:4af10da1f309d29265049f8640e525adec2eadfeae3fc1791e4ca15a8b3c836e',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::layer_height_limits': 'sha256:b5293a00fcbf89ed0d06ddda7a915b8d8d284c50dafb67b2c61f6ca40d03b2f7',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::layer_height_out_of_range_dialog': 'sha256:f936a05840d71c64c2e7dc843e3e5666da8df850cc64b2cc458f6bcc34a98e9e',
  'src/slic3r/GUI/Tab.cpp#TabPrint::toggle_options': 'sha256:89758bbe51eda27d49b89033b3604344edb96ac544658b6258d7833c3884cfe6',
  'src/slic3r/GUI/Tab.cpp#TabPrint::update': 'sha256:bfff2ff76fbd72eb3963a659ed3cdeecaebb81580461d6169b5aa073ab7e2fb4',
  'src/slic3r/GUI/Tab.cpp#Tab::on_value_change': 'sha256:4ac26dcd2c4eeb6a70e914b727fc851e1e4018e4f172c9034257a4cb2124e3ce',
  // Filament
  'src/slic3r/GUI/Tab.cpp#TabFilament::toggle_options': 'sha256:9357ebf2cbee456af90374097a9b338d57c0e1006af255453b381cd7925e9fd1',
  'src/slic3r/GUI/Tab.cpp#TabFilament::update_filament_overrides_page': 'sha256:278069403669cde0b66c5f1d2a02fdfa03aeb89b111a35ebe43b932d3b555cf0',
  'src/slic3r/GUI/Tab.cpp#TabFilament::update': 'sha256:8ff495f208b40807b4e2c243d6b7b28f559f9042fe5d649098ac74b3f907bfda',
  'src/slic3r/GUI/Tab.cpp#TabFilament::on_value_change': 'sha256:b5b1396e27215d6e12c013898be9d499c3b30f215c35b80a13100d63dcc43ac1',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::get_temperature_range': 'sha256:4e5b3f97397b80e4742a699e1287808571eb38cfa55390c4777783658a6da8ae',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_nozzle_recommended_temperature_range': 'sha256:804ef60e285458b75b1612fd09fed60f3202371d43656af1adc6419ba65a062a',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_nozzle_temperature_range': 'sha256:782cccbbf070f2d9912d5128bc425b7a91f9f94d5fc053b059a8f40d8ae45c9c',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_nozzle_temperature_initial_layer_range': 'sha256:66c94789e39d2e09f0729ee424802cdadc87dc23b35be45c77b35c40db38de7b',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_adaptive_pressure_advance_model': 'sha256:782266aadf67f61077b0108c73045820ea8112f8225dfda6573f314f510e6ecd',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_filament_max_volumetric_speed': 'sha256:1ca37b34d4db98d473089279ed6f3f41020b5ae0ddaf6aad5c80adc36b3acbad',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_chamber_temperature': 'sha256:3ebb0a86d35c06b772053e4ab1f47aaea046392fe2f837255ae5b4eaa0127f36',
  'src/slic3r/GUI/ConfigManipulation.cpp#ConfigManipulation::check_chamber_minimal_temperature': 'sha256:ab26381640f7cf11202768b99ba9f431325f51e450efba61ba61aa46abca6f3f',
  // Printer
  'src/slic3r/GUI/Tab.cpp#TabPrinter::toggle_options': 'sha256:86cb982aeed1192c557bfdaf0c077ceaca45d2f9e8474bce084b0cad580e9ae1',
  'src/slic3r/GUI/Tab.cpp#TabPrinter::on_value_change': 'sha256:e13fc0a7ca4a29314da80def512f474f12c1a1d25afb335aa4a9ff34f0cf6154',
  'src/slic3r/GUI/Tab.cpp#TabPrinter::on_gcode_flavor_changed': 'sha256:ca1a0462e1b12ae575f06a9a6ebd87f819f2923defc58e63b6c77f56baab6e06',
  'src/slic3r/GUI/Tab.cpp#TabPrinter::update_input_shaper_menu': 'sha256:0a316480bd401c703387a0547ce16e07b01bc951acb9d7b579d38145efe1feae',
  'src/slic3r/GUI/Tab.cpp#input_shaper_types_for_flavor': 'sha256:8fe6107644a4b03ac6d7a01f3c5e5b586c28c05f53c63620ef9dd546bf0e6743',
  'src/slic3r/GUI/Tab.cpp#TabPrinter::build_unregular_pages': 'sha256:8bfe9638a4ed14b071e7cda3c57a9c8df1c182555edad0f6ea07b419f420acd4',
  // Helpers the rules call
  'src/slic3r/GUI/GUI_App.cpp#is_support_filament': 'sha256:c6975ef8b07b92c6e97248428dd76039ae33c34e864b8f82012fd0f1a0babbee',
  'src/slic3r/GUI/GUI_App.cpp#is_soluble_filament': 'sha256:21e7f74d634f54dacc495badec2ad02a79404be10adc8750e4b052a8f65b5d71',
  'src/slic3r/GUI/GUI_App.cpp#has_filaments': 'sha256:9ffb90808f07d7bb32e5148f22b9703c7d7a25c5b8cf30be32a684690691829c',
  'src/libslic3r/PrintConfig.hpp#is_separable_infill_pattern': 'sha256:dcbcc5fc3ff1d7ba9a32e6cf1b444d80174c45be069c593fadc12a7c812b1530',
  'src/libslic3r/PrintConfig.hpp#is_smoothable_infill_pattern': 'sha256:92f04a4f924e6c5306d4451bc0ed5486b6857da9f96eab39ae2725cfdecd312b',
  'src/libslic3r/PrintConfig.hpp#is_tree': 'sha256:57e3ce1d187820646a2cf34cf7d4cde820b5cb3f953f75c6c9e5042ebdb4473a',
  'src/libslic3r/PrintConfig.hpp#is_auto': 'sha256:91b9e7089709453b5a0efe5f2137f39ab46cf39c8f1c25ca108580e7dd8e7df0',
  'src/libslic3r/PrintConfig.hpp#get_bed_temp_1st_layer_key': 'sha256:4b67f21db588b5a505f62a37806ee184c92c42edad3d1ec515e16a4e42a1efa8',
  'src/libslic3r/PrintConfig.cpp#has_bed_exclude_volumes': 'sha256:a6841b69c22e23f9ad31277afecf7a157be5dc74954a96af6a6fb84d4acfc0e0',
  'src/libslic3r/PrintConfig.cpp#active_bed_exclude_volume_mode': 'sha256:c59ef9312cd446da7249566ca917f4316ce15b3080cd9dea6924a8197dea11d0',
  'src/libslic3r/PrintConfig.cpp#collision_volumes_configured': 'sha256:bab05049773a9950f9aebf03a98b8e1c619c85553b77358f083178674eb109ed',
  'src/libslic3r/PrintConfig.cpp#has_nonempty_string': 'sha256:e0d7327e8e7e9807657503dda07848917f83225630a6bdec567de0d1201c5254',
  'src/libslic3r/MaterialType.cpp#MaterialType::all': 'sha256:0f01ed46ed4ca60cd3a0763fbf8da5f26ab4c334a74dad0d3011ecff5e308497',
  'src/libslic3r/MaterialType.cpp#MaterialType::find': 'sha256:c647806d98973d3d6ba60dffbd0959793a53e98e629fa6eff584c41e6931df84',
  'src/libslic3r/MaterialType.cpp#MaterialType::get_temperature_range': 'sha256:e869ee5b9845cf2de397612871f353a64a5e51a9c26cb921ff1dcabec5c8ac6b',
  'src/libslic3r/MaterialType.cpp#MaterialType::get_chamber_temperature_range': 'sha256:a59464a3cd982edde2f67c80367efbb473a3abee892bf42d98712238007aaaae',
  'src/libslic3r/Preset.hpp#Preset::convert_pellet_flow_to_filament_diameter': 'sha256:836fea2b5931e974100e452e3a1b1833bd6b5c947362808070f6d38cdd705578',
  'src/libslic3r/Preset.hpp#Preset::convert_filament_diameter_to_pellet_flow': 'sha256:c7afd982d498e70feb13cc855e08be1a2cca468c7faf05a1e2ba0e2796b599af',
  'src/libslic3r/GCode/AdaptivePAProcessor.cpp#AdaptivePAProcessor::validate_adaptive_pa_model': 'sha256:d9a3ced64a3fbfd1adabb45724578141d20bd3f61c6fd6cc31069ea842490032',
};

/**
 * Orca call sites (toggle_field / toggle_line / toggle_option, and the override checkbox calls of
 * update_filament_overrides_page) that are not ported, per Orca function. rules.test.ts checks that
 * the port has exactly Orca's call sites minus these.
 */
export const SKIPPED_CALL_SITES: Readonly<Record<string, readonly { site: string; reason: string }[]>> = {
  'TabPrinter::toggle_options': [
    {
      site: 'toggle_option("retract_length", !use_firmware_retraction, i)',
      reason: '"retract_length" is not an Orca option (the key is retraction_length), so the call does nothing in Orca. The same name is dropped from the list a few lines later.',
    },
  ],
};

/**
 * What the ported functions do besides toggling that the port leaves out, and why. (The value
 * checks and rewrites not listed here are ported, as issues or as editEffects().)
 */
export const SKIPPED_BEHAVIOURS: readonly { where: string; what: string; reason: string }[] = [
  {
    where: 'Tab::on_value_change',
    what: 'bed_exclude_area: offer to convert collision-volume syntax into bed_exclude_volumes',
    reason: 'Printer geometry is read-only in the web slicer (v1).',
  },
  {
    where: 'Tab::on_value_change',
    what: 'bed_exclude_volume_mode set to per_extruder: copy the shared volumes to every extruder',
    reason: 'Printer geometry is read-only in the web slicer (v1).',
  },
  {
    where: 'Tab::on_value_change',
    what: 'plugin-backed options: rebuild the plugins manifest and prune stale plugin overrides',
    reason: 'The web slicer does not offer plugins.',
  },
  {
    where: 'Tab::on_value_change',
    what: 'refresh desktop widgets: compatible_prints/printers lists, the sidebar (sparse infill, support, brim), the wiping and SEMM buttons, the print tab after single_extruder_multi_material or purge_in_prime_tower',
    reason: 'Desktop UI state. The web settings run the rules again after every change.',
  },
  {
    where: 'Tab::on_value_change',
    what: 'extruders_count: add or remove filaments to match a tool changer',
    reason: 'The web slicer loads one filament.',
  },
  {
    where: 'Tab::on_value_change',
    what: 'nozzle_volume_type: switch the tabs to the extruder variant; long_retractions_when_cut, filament_long_retractions_when_cut: recalculate flush volumes',
    reason: 'The web slicer shows one extruder variant and loads one filament, so there is nothing to switch or flush.',
  },
  {
    where: 'ConfigManipulation::update_print_fff_config',
    what: 'reset support_filament, support_interface_filament and wipe_tower_filament when they name a mixed filament',
    reason: 'The web slicer has no mixed filaments. The reset of ids above the filament count is ported.',
  },
  {
    where: 'ConfigManipulation::update_print_fff_config',
    what: 'warn once when enable_mixed_color_sublayer meets a variable layer height profile',
    reason: 'The web slicer has no variable layer height profiles.',
  },
  {
    where: 'ConfigManipulation::update_print_fff_config',
    what: 'the #if 0 block (prime tower with adaptive or independent support layer height)',
    reason: 'Not compiled in Orca.',
  },
  {
    where: 'ConfigManipulation::toggle_print_fff_options, TabPrinter::toggle_options, update_print_fff_config',
    what: "DevPrinterConfigUtil::support_wrapping_detection(printer_type), Bambu Lab's device database",
    reason: 'Not available in the browser: RulesEnv.supportsWrappingDetection says it (default false).',
  },
];

// ---------------------------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------------------------

type OrcaKind =
  | 'float' | 'floats' | 'int' | 'ints' | 'bool' | 'bools' | 'percent' | 'percents'
  | 'floatOrPercent' | 'floatsOrPercents' | 'enum' | 'enums' | 'string' | 'strings';

/**
 * Orca's type and default (first slot for a vector) of every option the rules read, from
 * PrintConfigDef in the engine Orca. The default is used when the view has no value. Generated:
 * `node tools/settings-catalogue/rulesSource.ts --write` rewrites the lines below, and rules.test.ts fails
 * when they differ from what it would write.
 */
const READ: Readonly<Record<string, readonly [OrcaKind, string]>> = {
  // @generated-read-table (every key passed to a Config accessor or listed in readKeys)
  accel_to_decel_enable: ['bool', '1'],
  activate_air_filtration: ['bools', '0'],
  activate_air_filtration_during_print: ['bools', '1'],
  activate_air_filtration_on_completion: ['bools', '1'],
  adaptive_pressure_advance: ['bools', '0'],
  adaptive_pressure_advance_model: ['strings', '0,0,0\n0,0,0'],
  alternate_extra_wall: ['bool', '0'],
  auxiliary_fan: ['bool', '0'],
  bed_exclude_volume_mode: ['enum', 'shared'],
  bed_exclude_volumes: ['string', ''],
  bottom_shell_layers: ['int', '3'],
  bottom_surface_filament_id: ['int', '0'],
  bottom_surface_pattern: ['enum', 'monotonic'],
  brim_type: ['enum', 'auto_brim'],
  brim_width: ['float', '0'],
  chamber_minimal_temperature: ['ints', '0'],
  chamber_temperature: ['ints', '0'],
  close_fan_the_first_x_layers: ['ints', '1'],
  curr_bed_type: ['enum', 'Cool Plate'],
  default_acceleration: ['floats', '500'],
  default_jerk: ['floats', '0'],
  detect_overhang_wall: ['bool', '1'],
  detect_thin_wall: ['bool', '0'],
  draft_shield: ['enum', 'disabled'],
  elefant_foot_compensation: ['float', '0'],
  elefant_foot_layers_density: ['percent', '100%'],
  emit_machine_limits_to_gcode: ['bool', '1'],
  enable_arc_fitting: ['bool', '0'],
  enable_long_retraction_when_cut: ['int', '0'],
  enable_overhang_bridge_fan: ['bools', '1'],
  enable_overhang_speed: ['bools', '1'],
  enable_pressure_advance: ['bools', '0'],
  enable_prime_tower: ['bool', '0'],
  enable_support: ['bool', '0'],
  enable_tower_interface_features: ['bool', '0'],
  enable_wrapping_detection: ['bool', '0'],
  enforce_support_layers: ['int', '0'],
  ensure_vertical_shell_thickness: ['enum', 'ensure_all'],
  extruder_bed_exclude_volumes: ['strings', ''],
  extruder_max_nozzle_count: ['ints', '1'],
  extruder_type: ['enums', 'Direct Drive'],
  extruder_variant_list: ['strings', 'Direct Drive Standard'],
  filament_deretraction_speed: ['floats', 'nil'],
  filament_diameter: ['floats', '1.75'],
  filament_ironing_flow: ['percents', 'nil'],
  filament_ironing_inset: ['floats', 'nil'],
  filament_ironing_spacing: ['floats', 'nil'],
  filament_ironing_speed: ['floats', 'nil'],
  filament_is_support: ['bools', '0'],
  filament_long_retractions_when_cut: ['bools', 'nil'],
  filament_max_volumetric_speed: ['floats', '2'],
  filament_multitool_ramming: ['bools', '0'],
  filament_retract_after_wipe: ['percents', 'nil'],
  filament_retract_before_wipe: ['percents', 'nil'],
  filament_retract_length_toolchange: ['floats', 'nil'],
  filament_retract_lift_above: ['floats', 'nil'],
  filament_retract_lift_below: ['floats', 'nil'],
  filament_retract_lift_enforce: ['enums', 'nil'],
  filament_retract_restart_extra: ['floats', 'nil'],
  filament_retract_restart_extra_toolchange: ['floats', 'nil'],
  filament_retract_when_changing_layer: ['bools', 'nil'],
  filament_retraction_distances_when_cut: ['floats', 'nil'],
  filament_retraction_length: ['floats', 'nil'],
  filament_retraction_minimum_travel: ['floats', 'nil'],
  filament_retraction_speed: ['floats', 'nil'],
  filament_soluble: ['bools', '0'],
  filament_type: ['strings', 'PLA'],
  filament_wipe: ['bools', 'nil'],
  filament_wipe_distance: ['floats', 'nil'],
  filament_z_hop: ['floats', 'nil'],
  filament_z_hop_types: ['enums', 'nil'],
  fill_multiline: ['int', '1'],
  fuzzy_skin: ['enum', 'disabled_fuzzy'],
  fuzzy_skin_mode: ['enum', 'displacement'],
  fuzzy_skin_noise_type: ['enum', 'classic'],
  gcode_flavor: ['enum', 'marlin'],
  hole_to_polyhole: ['bool', '0'],
  infill_anchor_max: ['floatOrPercent', '20'],
  infill_combination: ['bool', '0'],
  infill_lock_depth: ['float', '1'],
  initial_layer_fan_speed: ['ints', '-1'],
  initial_layer_print_height: ['float', '0.2'],
  inner_wall_filament_id: ['int', '0'],
  input_shaping_emit: ['bool', '0'],
  input_shaping_type: ['enum', 'Default'],
  interlocking_beam: ['bool', '0'],
  internal_solid_filament_id: ['int', '0'],
  ironing_pattern: ['enum', 'rectilinear'],
  ironing_spacing: ['float', '0.1'],
  ironing_type: ['enum', 'no ironing'],
  layer_height: ['float', '0.2'],
  long_retractions_when_cut: ['bools', '0'],
  long_retractions_when_ec: ['bools', '0'],
  machine_max_junction_deviation: ['floats', '0.01'],
  make_overhang_printable: ['bool', '0'],
  manual_filament_change: ['bool', '0'],
  max_layer_height: ['floats', '0'],
  max_volumetric_extrusion_rate_slope: ['float', '0'],
  max_volumetric_extrusion_rate_slope_segment_length: ['float', '3'],
  min_layer_height: ['floats', '0.07'],
  min_length_factor: ['float', '0.5'],
  nozzle_diameter: ['floats', '0.4'],
  nozzle_temperature: ['ints', '200'],
  nozzle_temperature_initial_layer: ['ints', '200'],
  nozzle_temperature_range_high: ['ints', '240'],
  nozzle_temperature_range_low: ['ints', '190'],
  only_one_wall_top: ['bool', '0'],
  ooze_prevention: ['bool', '0'],
  outer_wall_filament_id: ['int', '0'],
  overhang_reverse: ['bool', '0'],
  overhang_reverse_internal_only: ['bool', '0'],
  overhang_reverse_threshold: ['floatOrPercent', '50%'],
  parallel_printheads_bed_exclude_areas: ['strings', ''],
  parallel_printheads_count: ['int', '1'],
  pellet_flow_coefficient: ['floats', '0.4157'],
  pellet_modded_printer: ['bool', '0'],
  precise_z_height: ['bool', '0'],
  preheat_steps: ['int', '1'],
  print_sequence: ['enum', 'by layer'],
  printer_extruder_id: ['ints', '1'],
  printer_extruder_variant: ['strings', 'Direct Drive Standard'],
  printer_structure: ['enum', 'undefine'],
  purge_in_prime_tower: ['bool', '1'],
  raft_layers: ['int', '0'],
  reduce_crossing_wall: ['bool', '0'],
  resonance_avoidance: ['bool', '0'],
  retract_after_wipe: ['percents', '0%'],
  retract_before_wipe: ['percents', '100%'],
  retract_length_toolchange: ['floats', '10'],
  retraction_length: ['floats', '0.8'],
  role_based_wipe_speed: ['bool', '1'],
  seam_slope_conditional: ['bool', '0'],
  seam_slope_entire_loop: ['bool', '0'],
  seam_slope_start_height: ['floatOrPercent', '0'],
  seam_slope_type: ['enum', 'none'],
  set_other_flow_ratios: ['bool', '0'],
  silent_mode: ['bool', '0'],
  single_extruder_multi_material: ['bool', '1'],
  skin_infill_depth: ['float', '2'],
  skirt_loops: ['int', '1'],
  slow_down_for_layer_cooling: ['bools', '1'],
  small_area_infill_flow_compensation: ['bool', '0'],
  solid_infill_rotate_template: ['string', ''],
  sparse_infill_density: ['percent', '20%'],
  sparse_infill_filament_id: ['int', '0'],
  sparse_infill_pattern: ['enum', 'crosshatch'],
  sparse_infill_rotate_template: ['string', ''],
  spiral_mode: ['bool', '0'],
  spiral_mode_smooth: ['bool', '0'],
  support_air_filtration: ['bool', '1'],
  support_chamber_temp_control: ['bool', '1'],
  support_cooling_filter: ['bool', '0'],
  support_filament: ['int', '0'],
  support_interface_bottom_layers: ['int', '0'],
  support_interface_filament: ['int', '0'],
  support_interface_pattern: ['enum', 'auto'],
  support_interface_spacing: ['float', '0.5'],
  support_interface_top_layers: ['int', '3'],
  support_ironing: ['bool', '0'],
  support_ironing_spacing: ['float', '0.1'],
  support_multi_bed_types: ['bool', '0'],
  support_parallel_printheads: ['bool', '0'],
  support_style: ['enum', 'default'],
  support_threshold_angle: ['int', '30'],
  support_top_z_distance: ['float', '0.2'],
  support_type: ['enum', 'normal(auto)'],
  timelapse_type: ['enum', '0'],
  toolchange_ordering: ['enum', 'default'],
  top_shell_layers: ['int', '4'],
  top_surface_density: ['percent', '100%'],
  top_surface_expansion: ['float', '0'],
  top_surface_filament_id: ['int', '0'],
  top_surface_pattern: ['enum', 'monotonicline'],
  tree_support_auto_brim: ['bool', '1'],
  use_firmware_retraction: ['bool', '0'],
  volumetric_speed_coefficients: ['strings', ''],
  wall_generator: ['enum', 'arachne'],
  wall_loops: ['int', '2'],
  wipe: ['bools', '0'],
  wipe_inward: ['bool', '0'],
  wipe_tower_filament: ['int', '0'],
  wipe_tower_no_sparse_layers: ['bool', '0'],
  wipe_tower_type: ['enum', 'type2'],
  wipe_tower_wall_type: ['enum', 'rib'],
  xy_contour_compensation: ['float', '0'],
  xy_hole_compensation: ['float', '0'],
  z_hop: ['floats', '0.4'],
  z_hop_types: ['enums', 'Slope Lift'],
  zaa_enabled: ['bool', '0'],
};

const EPSILON = 1e-4;
const isApprox = (a: number, b: number) => Math.abs(a - b) < EPSILON;
const isVector = (kind: OrcaKind) => kind.endsWith('s') && kind !== 'floatOrPercent';

/** Orca's text for a double (C++ ostream: 6 significant digits). */
export function orcaNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Slots of a ConfigOptionStrings serialized as `"a";"b"` (C-style escapes). */
function parseQuotedStrings(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') return [text];
    let value = '';
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) {
        const next = text[++i];
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      } else value += text[i];
      i++;
    }
    out.push(value);
    i++;
    while (i < text.length && /[\s;]/.test(text[i])) i++;
  }
  return out;
}

/** The effective values, read the way Orca's DynamicPrintConfig accessors read them. */
class Config {
  private readonly view: ConfigView;
  constructor(view: ConfigView) {
    this.view = view;
  }

  private spec(key: string): readonly [OrcaKind, string] {
    const spec = READ[key];
    if (!spec) throw new Error(`rules.ts reads "${key}", which is missing from READ`);
    return spec;
  }

  /** Every slot of the value (one for a scalar). */
  slots(key: string): string[] {
    const [kind, fallback] = this.spec(key);
    const value = this.view.get(key);
    if (value === undefined) return [fallback];
    if (Array.isArray(value)) return value.length ? value.map(String) : [fallback];
    if (!isVector(kind)) return [value];
    if (kind === 'strings') return value.startsWith('"') ? parseQuotedStrings(value) : [value];
    return value.split(',').map((v) => v.trim());
  }

  /** Slot `index` (Orca's get_at: past the end reads slot 0). */
  text(key: string, index = 0): string {
    const slots = this.slots(key);
    return (slots[index] ?? slots[0]).trim();
  }

  isNil(key: string, index = 0): boolean {
    return this.text(key, index) === 'nil';
  }

  /** opt_float / opt_int / ->value of a percent: "15%" reads 15, nil reads NaN. */
  num(key: string, index = 0): number {
    const text = this.text(key, index);
    return text === 'nil' ? NaN : Number.parseFloat(text);
  }

  /** opt_bool. A nil slot is Orca's nil_value (255), which reads true. */
  bool(key: string, index = 0): boolean {
    const text = this.text(key, index).toLowerCase();
    return text === '1' || text === 'true' || text === 'nil';
  }

  /** opt_enum == value. rules.test.ts checks `value` is one of the key's enum values. */
  is(key: string, value: string, index = 0): boolean {
    return this.text(key, index) === value;
  }

  oneOf(key: string, values: ReadonlySet<string>, index = 0): boolean {
    return values.has(this.text(key, index));
  }

  /** The serialized vector with slot `index` replaced, or `value` alone when the vector has one slot. */
  withSlot(key: string, index: number, value: string): string {
    const slots = this.slots(key);
    if (slots.length <= 1) return value;
    return slots.map((v, i) => (i === index ? value : v)).join(',');
  }
}

// Enum literals are written through these helpers, with the option they belong to, so that
// rules.test.ts can check each one against the option's enum in Orca.

/** Enum values of `key` used as a set. */
function enumValues(key: string, values: readonly string[]): ReadonlySet<string> {
  void key;
  return new Set(values);
}

/** Enum values of `key` in order (an enum filter). */
function enumList(key: string, values: readonly string[]): readonly string[] {
  void key;
  return values;
}

/** One enum value of `key`. */
function v(key: string, value: string): string {
  void key;
  return value;
}

/**
 * Option keys the rules read in a loop. Marks the list for rulesSource.ts, which builds READ from
 * the keys passed to Config's accessors and the keys of these lists.
 */
function readKeys<const T extends readonly string[]>(keys: T): T {
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Recording toggles
// ---------------------------------------------------------------------------------------------

const slotId = (key: string, index?: number) => (index === undefined ? key : `${key}#${index}`);

/** Records Orca's toggle calls in order; the last call for an id wins, as in Orca. */
class Toggles {
  private readonly fields = new Map<string, boolean>();
  private readonly lines = new Map<string, boolean>();
  private readonly overrideCheckboxes = new Map<string, boolean>();
  private readonly labels = new Map<string, string>();
  private readonly enumFilters = new Map<string, readonly string[]>();

  /** toggle_field / toggle_option: enabled or greyed out. */
  field(key: string, enabled: boolean, index?: number): void {
    this.fields.set(slotId(key, index), enabled);
  }

  /** toggle_line: the row is shown or hidden. */
  line(key: string, visible: boolean, index?: number): void {
    this.lines.set(slotId(key, index), visible);
  }

  /** m_overrides_options[key]->Enable(): the filament override checkbox. */
  overrideEnabled(key: string, enabled: boolean): void {
    this.overrideCheckboxes.set(key, enabled);
  }

  label(key: string, text: string): void {
    this.labels.set(key, text);
  }

  enumOnly(key: string, values: readonly string[]): void {
    this.enumFilters.set(key, values);
  }

  result(): TabRules {
    const off = (map: Map<string, boolean>) => new Set([...map].filter(([, on]) => !on).map(([id]) => id));
    return {
      hidden: off(this.lines),
      disabled: off(this.fields),
      labels: new Map(this.labels),
      enumFilters: new Map(this.enumFilters),
      lockedOverrides: off(this.overrideCheckboxes),
    };
  }
}

/** Whether the row of `key` (slot `index` on a per-extruder page or machine-limit column) is hidden. */
export function isHidden(tab: TabRules, key: string, index?: number): boolean {
  return tab.hidden.has(key) || (index !== undefined && tab.hidden.has(slotId(key, index)));
}

/** Whether the field of `key` (slot `index`) is greyed out. */
export function isDisabled(tab: TabRules, key: string, index?: number): boolean {
  return tab.disabled.has(key) || (index !== undefined && tab.disabled.has(slotId(key, index)));
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

interface Ctx {
  c: Config;
  isBbl: boolean;
  /** Orca's is_global_config (TabPrint: m_type < Preset::TYPE_COUNT). */
  isGlobal: boolean;
  /** Orca's is_plate_config. */
  isPlate: boolean;
  extruderCount: number;
  filamentCount: number;
  mode: NonNullable<RulesEnv['mode']>;
  supportsWrappingDetection: boolean;
  /** Orca's plater config (RulesEnv.globalConfig), for object and plate settings only. */
  plater: Config | null;
  hasObjects: boolean;
  /** Whether a check Orca makes when one of `keys` is edited runs (RulesEnv.edited has one of them). */
  checksOn: (keys: readonly string[]) => boolean;
}

function context(env: RulesEnv): Ctx {
  const c = new Config(env.config);
  const isGlobal = (env.context ?? 'global') === 'global';
  const edited = env.edited;
  return {
    c,
    isBbl: env.isBbl ?? false,
    isGlobal,
    isPlate: env.context === 'plate',
    extruderCount: Math.max(1, env.extruderCount ?? c.slots('nozzle_diameter').length),
    filamentCount: Math.max(1, env.filamentCount ?? 1),
    mode: env.mode ?? 'advanced',
    supportsWrappingDetection: env.supportsWrappingDetection ?? false,
    plater: !isGlobal && env.globalConfig ? new Config(env.globalConfig) : null,
    hasObjects: env.hasObjects ?? true,
    checksOn: (keys) => edited !== undefined && keys.some((k) => edited.has(k)),
  };
}

// ---------------------------------------------------------------------------------------------
// libslic3r predicates the rules use (PrintConfig.hpp / PrintConfig.cpp)
// ---------------------------------------------------------------------------------------------

// Orca: Infill patterns whose alignment origin follows the fill bounding box, so the
// "separated_infills" option can re-center them per connected body.
const SEPARABLE_INFILL_PATTERNS = enumValues('sparse_infill_pattern', [
  'rectilinear', 'alignedrectilinear', 'zigzag', 'crosszag', 'lockedzag', 'grid', 'triangles', 'tri-hexagon',
  'cubic', 'quartercubic', 'lateral-honeycomb', 'lateral-lattice', 'hilbertcurve', 'archimedeanchords', 'octagramspiral',
]);

// Orca: Infill patterns that round their corners by the "sparse_infill_smooth_factor" option.
// Grid, Triangles and Tri-hexagon only do so in their trapezoidal form, which is generated with more
// than one line per infill wall.
const SMOOTHABLE_INFILL_PATTERNS = enumValues('sparse_infill_pattern', [
  'hilbertcurve', 'octagramspiral', 'lightning', 'honeycomb', '3dhoneycomb', 'concentric', 'crosshatch',
]);
const SMOOTHABLE_MULTILINE_INFILL_PATTERNS = enumValues('sparse_infill_pattern', ['grid', 'triangles', 'tri-hexagon']);

function isSmoothableInfillPattern(c: Config, multiline: number): boolean {
  if (c.oneOf('sparse_infill_pattern', SMOOTHABLE_INFILL_PATTERNS)) return true;
  if (c.oneOf('sparse_infill_pattern', SMOOTHABLE_MULTILINE_INFILL_PATTERNS)) return multiline > 1;
  return false;
}

const TREE_SUPPORT_TYPES = enumValues('support_type', ['tree(auto)', 'tree(manual)']);
const AUTO_SUPPORT_TYPES = enumValues('support_type', ['normal(auto)', 'tree(auto)']);

/** get_bed_temp_1st_layer_key: the first layer bed temperature option of a curr_bed_type, '' for any other bed type. */
function getBedTemp1stLayerKey(type: string): string {
  if (type === v('curr_bed_type', 'Supertack Plate'))
    return 'supertack_plate_temp_initial_layer';

  if (type === v('curr_bed_type', 'Cool Plate'))
    return 'cool_plate_temp_initial_layer';

  if (type === v('curr_bed_type', 'Textured Cool Plate'))
    return 'textured_cool_plate_temp_initial_layer';

  if (type === v('curr_bed_type', 'Engineering Plate'))
    return 'eng_plate_temp_initial_layer';

  if (type === v('curr_bed_type', 'High Temp Plate'))
    return 'hot_plate_temp_initial_layer';

  if (type === v('curr_bed_type', 'Textured PEI Plate'))
    return 'textured_plate_temp_initial_layer';

  return '';
}

/** has_nonempty_string */
const hasNonemptyString = (value: string) => /\S/.test(value);

/** has_bed_exclude_volumes (collision_volumes_configured): collision volumes are set for the mode. */
function hasBedExcludeVolumes(c: Config): boolean {
  if (c.is('bed_exclude_volume_mode', 'per_extruder'))
    return c.slots('extruder_bed_exclude_volumes').some(hasNonemptyString);
  return hasNonemptyString(c.text('bed_exclude_volumes'));
}

/**
 * TabPrinter::toggle_options's get_index_for_extruder(i): the slot of extruder i's nozzle variant
 * in the printer's per-variant options (variants.ts), with a Standard nozzle as both slicers use.
 * Orca stops when there is none; the port reads extruder i's slot then.
 */
function printerVariantIndex(c: Config, extruder: number): number {
  const index = indexForExtruder(
    { variants: c.slots('printer_extruder_variant'), ids: c.slots('printer_extruder_id'), extruderVariantList: c.slots('extruder_variant_list') },
    extruder + 1,
    extruderVariantString(c.text('extruder_type', extruder), 'Standard'),
  );
  return index >= 0 ? index : extruder;
}

/** active_bed_exclude_volume_mode: the mode, which is Shared while no collision volume is set. */
function activeBedExcludeVolumeMode(c: Config): string {
  if (!hasBedExcludeVolumes(c))
    return v('bed_exclude_volume_mode', 'shared');
  return c.text('bed_exclude_volume_mode');
}

/**
 * MaterialType::all(): name, nozzle min/max, chamber min/max temperature (°C). Exported for
 * rules.test.ts, which compares it with MaterialType.cpp.
 */
export const MATERIAL_TYPES: readonly (readonly [string, number, number, number, number])[] = [
  ['ABS', 190, 300, 50, 65], ['ABS-CF', 220, 300, 50, 65], ['ABS-GF', 240, 280, 50, 65],
  ['ASA', 220, 300, 50, 65], ['ASA-CF', 230, 300, 50, 65], ['ASA-GF', 240, 300, 50, 65], ['ASA-AERO', 240, 280, 50, 65],
  ['BVOH', 190, 240, 0, 70], ['CoPE', 190, 240, 0, 45], ['EVA', 175, 220, 0, 50], ['FLEX', 210, 230, 0, 50],
  ['HIPS', 220, 270, 50, 60], ['PA', 235, 280, 50, 60], ['PA-CF', 240, 315, 50, 60], ['PA-GF', 240, 290, 50, 60],
  ['PA6', 260, 300, 50, 60], ['PA6-CF', 230, 300, 50, 60], ['PA6-GF', 260, 300, 50, 60],
  ['PA11', 275, 295, 50, 60], ['PA11-CF', 275, 295, 50, 60], ['PA11-GF', 275, 295, 50, 60],
  ['PA12', 250, 270, 50, 60], ['PA12-CF', 250, 300, 50, 60], ['PA12-GF', 255, 270, 50, 60],
  ['PAHT', 260, 310, 55, 65], ['PAHT-CF', 270, 310, 55, 65], ['PAHT-GF', 270, 310, 55, 65],
  ['PC', 240, 300, 60, 70], ['PC-ABS', 230, 270, 60, 70], ['PC-CF', 270, 295, 60, 70], ['PC-PBT', 260, 300, 60, 70],
  ['PCL', 130, 170, 0, 45], ['PCTG', 220, 300, 0, 55], ['PE', 175, 260, 45, 60], ['PE-CF', 175, 260, 45, 60],
  ['PE-GF', 230, 270, 45, 60], ['PEI-1010', 370, 430, 80, 100], ['PEI-1010-CF', 380, 430, 80, 100],
  ['PEI-1010-GF', 380, 430, 80, 100], ['PEI-9085', 350, 390, 80, 100], ['PEI-9085-CF', 365, 390, 80, 100],
  ['PEI-9085-GF', 370, 390, 80, 100], ['PEEK', 350, 460, 80, 100], ['PEEK-CF', 380, 410, 80, 100],
  ['PEEK-GF', 375, 410, 80, 100], ['PEKK', 325, 400, 80, 100], ['PEKK-CF', 360, 400, 80, 100], ['PES', 340, 390, 80, 100],
  ['PET', 200, 290, 0, 55], ['PET-CF', 240, 320, 0, 55], ['PET-GF', 280, 320, 0, 55], ['PETG', 190, 260, 0, 55],
  ['PETG-CF', 230, 290, 0, 55], ['PETG-GF', 210, 270, 0, 55], ['PHA', 190, 250, 0, 55], ['PI', 390, 410, 90, 100],
  ['PLA', 180, 240, 0, 45], ['PLA-AERO', 220, 270, 0, 55], ['PLA-CF', 190, 250, 0, 50], ['POM', 210, 250, 50, 65],
  ['PP', 200, 240, 45, 60], ['PP-CF', 210, 250, 45, 60], ['PP-GF', 220, 260, 45, 60], ['PPA-CF', 260, 300, 55, 70],
  ['PPA-GF', 260, 290, 55, 70], ['PPS', 300, 345, 90, 100], ['PPS-CF', 295, 350, 90, 100], ['PPSU', 360, 420, 90, 100],
  ['PSU', 350, 380, 90, 100], ['PVA', 185, 250, 0, 60], ['PVB', 190, 250, 0, 55], ['PVDF', 245, 265, 40, 60],
  ['SBS', 195, 250, 0, 55], ['TPI', 420, 445, 90, 100], ['TPU', 175, 260, 0, 50],
];

const materialType = (name: string) => MATERIAL_TYPES.find((m) => m[0] === name);

/** AdaptivePAProcessor::validate_adaptive_pa_model: '' when valid, else the first problem. */
export function validateAdaptivePaModel(model: string): string {
  if (!model) return ''; // Empty model is valid
  const lines = model.split('\n');
  for (let n = 0; n < lines.length; n++) {
    // Trim whitespace
    const line = lines[n].replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    if (!line) continue; // Skip empty lines
    const at = `Line ${n + 1}`;
    // Only numbers, commas and dots are allowed (no letters or other characters)
    if (!/^[0-9,.]*$/.test(line)) return `${at}: only numbers, commas and dots are allowed`;
    // Count commas to validate format (should be exactly 2 for 3 values)
    if (line.split(',').length !== 3) return `${at}: must contain exactly 3 comma-separated values (PA, flow, acceleration)`;
    // Parse and validate the values. std::getline(stream, value, ',') fails only at the end of the
    // line, so an empty last value is "missing"; std::stod throws on an empty or dot-only value and
    // on one out of the double range, which Orca reports as an invalid numeric value.
    const [pa_text, flow_text, accel_text] = line.split(',');
    const stod = (text: string) => {
      const value = /^\d*\.?\d+|^\d+\.?/.test(text) ? Number.parseFloat(text) : NaN;
      return Number.isFinite(value) && !(value === 0 && /[1-9]/.test(text)) ? value : NaN;
    };
    const pa = stod(pa_text);
    if (Number.isNaN(pa)) return `${at}: invalid numeric value`;
    const flow = stod(flow_text);
    if (Number.isNaN(flow)) return `${at}: invalid numeric value`;
    if (accel_text === '') return `${at}: missing acceleration value`;
    const accel = stod(accel_text);
    if (Number.isNaN(accel)) return `${at}: invalid numeric value`;
    // Validate constraints
    if (pa >= 2.0) return `${at}: PA value must be less than 2`;
    if (flow <= pa) return `${at}: flow value must be greater than PA value`;
    if (accel <= flow) return `${at}: acceleration value must be greater than flow value`;
  }
  return '';
}

// ---------------------------------------------------------------------------------------------
// Process: ConfigManipulation::toggle_print_fff_options (ConfigManipulation.cpp)
// ---------------------------------------------------------------------------------------------

// Infill patterns that support multiline infill.
const MULTILINE_INFILL_PATTERNS = enumValues('sparse_infill_pattern', [
  'gyroid', 'grid', 'rectilinear', 'tpmsd', 'tpmsfk', 'crosshatch', 'honeycomb', 'lateral-lattice', 'lateral-honeycomb',
  'concentric', 'cubic', 'tri-hexagon', 'alignedrectilinear', 'lightning', '3dhoneycomb', 'adaptivecubic', 'supportcubic',
  'triangles', 'quartercubic', 'archimedeanchords', 'hilbertcurve', 'octagramspiral',
]);
// Orca: Archimedean Chords and Octagram Spiral are the centered surface patterns that the
// pattern-centering feature acts on.
const CENTERED_SURFACE_PATTERNS = enumValues('top_surface_pattern', ['archimedeanchords', 'octagramspiral']);
// Fill order is only meaningful for the center-based surface fill patterns.
const CENTERED_FILL_PATTERNS = enumValues('top_surface_pattern', ['concentric', 'spiralinset', 'archimedeanchords', 'octagramspiral']);

// Orca toggles the process options that vary per variant (per extruder type and nozzle volume)
// with the variant index of the extruder the tab shows. The web slicer shows one variant, so those
// calls toggle the option itself.

function togglePrintFffOptions(x: Ctx, t: Toggles): void {
  const { c } = x;
  // Orca: use booleans to avoid repeated comparisons with enum values
  const gcf_is_marlin_firmware = c.is('gcode_flavor', 'marlin2');
  const gcf_is_klipper = c.is('gcode_flavor', 'klipper');

  const have_volumetric_extrusion_rate_slope = c.num('max_volumetric_extrusion_rate_slope') > 0;
  t.field('enable_arc_fitting', !have_volumetric_extrusion_rate_slope);
  t.line('max_volumetric_extrusion_rate_slope_segment_length', have_volumetric_extrusion_rate_slope);
  t.line('extrusion_rate_smoothing_external_perimeter_only', have_volumetric_extrusion_rate_slope);
  // Orca then sets enable_arc_fitting = false and a segment length below 0.5 to 1: see
  // printFffRewrites.

  const have_perimeters = c.num('wall_loops') > 0;
  for (const el of ['extra_perimeters_on_overhangs', 'ensure_vertical_shell_thickness', 'detect_thin_wall', 'detect_overhang_wall',
    'seam_position', 'staggered_inner_seams', 'wall_sequence', 'outer_wall_line_width'])
    t.field(el, have_perimeters);
  for (const el of ['inner_wall_speed', 'outer_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold'])
    t.field(el, have_perimeters);

  const have_infill = c.num('sparse_infill_density') > 0;
  // sparse_infill_filament_id uses the same logic as in Print::extruders()
  for (const el of ['sparse_infill_pattern', 'infill_combination', 'fill_multiline', 'infill_direction',
    'minimum_sparse_infill_area', 'sparse_infill_filament_id', 'infill_shift_step', 'sparse_infill_rotate_template', 'symmetric_infill_y_axis'])
    t.line(el, have_infill);

  // Orca: the concentric patterns follow the surface outline instead of crossing it, so there is
  // nothing for an infill anchor to attach to. Hide the anchor settings for them.
  const have_infill_anchor = have_infill && !c.is('sparse_infill_pattern', 'concentric') && !c.is('sparse_infill_pattern', 'spiralinset');
  t.line('infill_anchor', have_infill_anchor);
  t.line('infill_anchor_max', have_infill_anchor);

  const have_combined_infill = c.bool('infill_combination') && have_infill;
  t.line('infill_combination_max_layer_height', have_combined_infill);

  // Infill patterns that support multiline infill.
  const have_multiline_infill_pattern = c.oneOf('sparse_infill_pattern', MULTILINE_INFILL_PATTERNS);

  // gyroid_optimized only applies when the sparse infill pattern is gyroid;
  // hide the whole line otherwise.
  t.line('gyroid_optimized', have_infill && c.is('sparse_infill_pattern', 'gyroid'));

  // If there is infill, enable/disable fill_multiline according to whether the pattern supports multiline infill.
  if (have_infill) {
    t.field('fill_multiline', have_multiline_infill_pattern);
    // (Orca sets fill_multiline to 1 here when the pattern does not support it: see printFffRewrites.)
    // Hide infill anchor max if sparse_infill_pattern is not line or if sparse_infill_pattern is line but infill_anchor_max is 0.
    const infill_anchor = !c.is('sparse_infill_pattern', 'line');
    t.field('infill_anchor_max', infill_anchor);

    // Only allow configuration of open anchors if the anchoring is enabled.
    const has_infill_anchors = infill_anchor && c.num('infill_anchor_max') > 0;
    t.field('infill_anchor', has_infill_anchors);
  }

  //cross zag
  const is_cross_zag = c.is('sparse_infill_pattern', 'crosszag');
  const is_locked_zig = c.is('sparse_infill_pattern', 'lockedzag');

  t.line('infill_shift_step', is_cross_zag || is_locked_zig);

  for (const el of ['skeleton_infill_density', 'skin_infill_density', 'infill_lock_depth', 'skin_infill_depth', 'skin_infill_line_width', 'skeleton_infill_line_width'])
    t.line(el, is_locked_zig);

  const is_zig_zag = c.is('sparse_infill_pattern', 'zigzag');

  t.line('symmetric_infill_y_axis', is_zig_zag || is_cross_zag || is_locked_zig);

  const has_spiral_vase = c.bool('spiral_mode');
  t.line('spiral_mode_smooth', has_spiral_vase);
  t.line('spiral_mode_max_xy_smoothing', has_spiral_vase && c.bool('spiral_mode_smooth'));
  t.line('spiral_starting_flow_ratio', has_spiral_vase);
  t.line('spiral_finishing_flow_ratio', has_spiral_vase);
  const has_top_shell_layers = c.num('top_shell_layers') > 0 || (has_spiral_vase && c.num('bottom_shell_layers') > 1);
  const has_top_shell = has_top_shell_layers && c.num('top_surface_density') > 0;
  const has_bottom_shell = c.num('bottom_shell_layers') > 0;
  const has_solid_infill = has_top_shell_layers || has_bottom_shell;
  t.line('sparse_infill_smooth_factor', isSmoothableInfillPattern(c, c.num('fill_multiline')));
  t.field('top_surface_pattern', has_top_shell);
  t.field('bottom_surface_pattern', has_bottom_shell);
  t.field('top_surface_density', has_top_shell_layers);
  t.field('bottom_surface_density', has_bottom_shell);
  t.field('top_layer_direction', has_top_shell);
  t.field('bottom_layer_direction', has_bottom_shell);

  t.line('top_surface_expansion', has_top_shell);
  t.line('top_surface_expansion_margin', has_top_shell);
  const has_top_surface_expansion = c.num('top_surface_expansion') > 0;
  t.field('top_surface_expansion_margin', has_top_surface_expansion);
  t.line('top_surface_expansion_direction', has_top_shell);
  t.field('top_surface_expansion_direction', has_top_surface_expansion);

  const is_top_centered = c.oneOf('top_surface_pattern', CENTERED_SURFACE_PATTERNS);
  const is_bottom_centered = c.oneOf('bottom_surface_pattern', CENTERED_SURFACE_PATTERNS);
  const has_centered_surface = (has_top_shell && is_top_centered) || (has_bottom_shell && is_bottom_centered);

  // Orca: center of surface pattern
  t.line('center_of_surface_pattern', has_centered_surface);

  // Orca: separate infills
  const is_internal_infill_separable = c.oneOf('sparse_infill_pattern', SEPARABLE_INFILL_PATTERNS) ||
    c.text('sparse_infill_rotate_template') !== '' ||
    c.text('solid_infill_rotate_template') !== '';
  t.line('separated_infills', is_internal_infill_separable);

  // Fill order is only meaningful for the center-based surface fill patterns; hide it otherwise.
  t.line('top_surface_fill_order', has_top_shell && c.oneOf('top_surface_pattern', CENTERED_FILL_PATTERNS));
  t.line('bottom_surface_fill_order', has_bottom_shell && c.oneOf('bottom_surface_pattern', CENTERED_FILL_PATTERNS));

  for (const el of ['infill_direction', 'sparse_infill_line_width', 'gap_fill_target', 'filter_out_gap_fill', 'infill_wall_overlap',
    'bridge_angle', 'internal_bridge_angle', 'relative_bridge_angle',
    'solid_infill_direction', 'solid_infill_rotate_template', 'internal_solid_infill_pattern', 'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id',
  ])
    t.field(el, have_infill || has_solid_infill);
  for (const el of ['sparse_infill_speed', 'bridge_speed', 'internal_bridge_speed'])
    t.field(el, have_infill || has_solid_infill);

  t.field('top_shell_thickness', !has_spiral_vase && has_top_shell_layers);
  t.field('bottom_shell_thickness', !has_spiral_vase && has_bottom_shell);

  // Gap fill is newly allowed in between perimeter lines even for empty infill (see GH #1476).
  t.field('gap_infill_speed', have_perimeters);

  t.field('top_surface_line_width', has_top_shell);
  t.field('top_surface_speed', has_top_shell);

  const have_default_acceleration = c.num('default_acceleration') > 0;

  for (const el of ['outer_wall_acceleration', 'inner_wall_acceleration', 'initial_layer_acceleration', 'initial_layer_travel_acceleration',
    'top_surface_acceleration', 'travel_acceleration', 'bridge_acceleration', 'sparse_infill_acceleration', 'internal_solid_infill_acceleration'])
    t.field(el, have_default_acceleration);

  let machine_supports_junction_deviation = false;
  if (gcf_is_marlin_firmware) machine_supports_junction_deviation = c.num('machine_max_junction_deviation', 0) > 0;
  t.line('default_junction_deviation', gcf_is_marlin_firmware);
  if (machine_supports_junction_deviation) {
    t.field('default_junction_deviation', true);
    t.field('default_jerk', false);
    for (const el of ['outer_wall_jerk', 'inner_wall_jerk', 'initial_layer_jerk', 'initial_layer_travel_jerk', 'top_surface_jerk', 'travel_jerk', 'infill_jerk'])
      t.line(el, false);
  } else {
    t.field('default_junction_deviation', false);
    t.field('default_jerk', true);
    const have_default_jerk = c.num('default_jerk') > 0;
    for (const el of ['outer_wall_jerk', 'inner_wall_jerk', 'initial_layer_jerk', 'initial_layer_travel_jerk', 'top_surface_jerk', 'travel_jerk', 'infill_jerk']) {
      t.line(el, true);
      t.field(el, have_default_jerk);
    }
  }

  const have_skirt = c.num('skirt_loops') > 0;
  t.field('skirt_height', have_skirt && !c.is('draft_shield', 'enabled'));
  t.line('single_loop_draft_shield', have_skirt); // ORCA: Display one wall if skirt enabled
  for (const el of ['skirt_type', 'min_skirt_length', 'skirt_distance', 'skirt_start_angle', 'skirt_speed', 'draft_shield'])
    t.field(el, have_skirt);

  const have_brim = !c.is('brim_type', 'no_brim');
  t.field('brim_object_gap', have_brim);
  t.field('brim_use_efc_outline', have_brim);
  t.field('combine_brims', have_brim);
  const have_brim_width = !c.is('brim_type', 'no_brim') && !c.is('brim_type', 'auto_brim') && !c.is('brim_type', 'painted');
  t.field('brim_width', have_brim_width);
  t.field('brim_flow_ratio', have_brim);
  // Wall filament selectors use the same logic as in Print::extruders().
  t.field('outer_wall_filament_id', have_perimeters || have_brim);
  t.field('inner_wall_filament_id', have_perimeters || have_brim);

  const have_auto_brim_ear = c.is('brim_type', 'brim_ears');
  const have_painted_brim_ear = c.is('brim_type', 'painted');
  t.label('brim_width', have_auto_brim_ear ? 'Brim ear radius' : 'Brim width');
  const brim_width = c.num('brim_width');
  // Automatic brim ear settings require a non-zero brim width.
  t.field('brim_ears_max_angle', brim_width > 0);
  t.field('brim_ears_detection_length', brim_width > 0);
  // Painted ears carry their own radius and do not depend on brim_width.
  t.field('brim_ears_outer_only', have_painted_brim_ear || brim_width > 0);
  t.line('brim_ears_max_angle', have_auto_brim_ear);
  t.line('brim_ears_detection_length', have_auto_brim_ear);
  t.line('brim_ears_outer_only', have_auto_brim_ear || have_painted_brim_ear);

  // Hide Elephant foot compensation layers if elefant_foot_compensation is not enabled
  t.line('elefant_foot_compensation_layers', c.num('elefant_foot_compensation') > 0 || c.num('elefant_foot_layers_density') / 100 < 1);

  const have_raft = c.num('raft_layers') > 0;
  const have_support_material = c.bool('enable_support') || have_raft;

  const support_is_auto = c.oneOf('support_type', AUTO_SUPPORT_TYPES);
  const have_support_interface = c.num('support_interface_top_layers') > 0 || c.num('support_interface_bottom_layers') > 0;
  const have_support_soluble = have_support_material && c.num('support_top_z_distance') === 0;
  for (const el of ['support_style', 'support_base_pattern',
    'support_base_pattern_spacing', 'support_expansion', 'support_angle',
    'support_interface_pattern', 'support_interface_top_layers', 'support_interface_bottom_layers',
    'bridge_no_support', 'max_bridge_length', 'support_top_z_distance', 'support_bottom_z_distance',
    'support_type', 'support_on_build_plate_only', 'support_critical_regions_only', 'support_interface_not_for_body',
    'support_object_xy_distance', 'support_object_first_layer_gap', 'independent_support_layer_height'])
    t.field(el, have_support_material);
  t.field('support_threshold_angle', have_support_material && support_is_auto);
  t.field('support_threshold_overlap', c.num('support_threshold_angle') === 0 && have_support_material && support_is_auto);

  const support_is_tree = c.bool('enable_support') && c.oneOf('support_type', TREE_SUPPORT_TYPES);
  const support_is_organic = support_is_tree && (c.is('support_style', 'organic') || c.is('support_style', 'default'));
  const support_is_normal_tree = support_is_tree && !support_is_organic;

  // hide settings that are not used by tree supports
  t.line('support_threshold_overlap', !support_is_tree); // ORCA: tree supports do not use Threshold Overlap
  // settings specific to normal trees
  for (const el of ['tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_auto_brim', 'tree_support_brim_width'])
    t.line(el, support_is_normal_tree);
  // settings specific to organic trees
  for (const el of ['tree_support_branch_angle_organic', 'tree_support_branch_distance_organic', 'tree_support_branch_diameter_organic', 'tree_support_angle_slow', 'tree_support_tip_diameter', 'tree_support_top_rate', 'tree_support_branch_diameter_angle'])
    t.line(el, support_is_organic);
  // ORCA: Independent support layer height is not compatible with organic tree supports,
  // as they rely on the support layers being the same as the object layers to determine where to place branches.
  t.line('independent_support_layer_height', have_support_material && !support_is_organic);

  t.field('tree_support_brim_width', support_is_tree && !c.bool('tree_support_auto_brim'));
  // tree support use max_bridge_length instead of bridge_no_support
  t.line('max_bridge_length', support_is_tree);
  t.line('bridge_no_support', !support_is_tree);
  t.line('support_critical_regions_only', support_is_auto && support_is_tree);

  for (const el of ['support_interface_filament',
    'support_interface_loop_pattern', 'support_bottom_interface_spacing'])
    t.field(el, have_support_material && have_support_interface);

  const can_ironing_support = have_raft || (have_support_material && c.num('support_interface_top_layers') > 0);
  t.field('support_ironing', can_ironing_support);
  const has_support_ironing = can_ironing_support && c.bool('support_ironing');
  for (const el of ['support_ironing_pattern', 'support_ironing_flow', 'support_ironing_spacing'])
    t.line(el, has_support_ironing);
  // Orca: Force solid support interface when using support ironing
  t.field('support_interface_spacing', have_support_material && have_support_interface && !has_support_ironing);

  // Orca:
  for (const el of ['small_support_perimeter_speed', 'small_support_perimeter_threshold'])
    t.field(el, c.bool('enable_support'));

  t.field('inner_wall_line_width', have_perimeters || have_skirt || have_brim);
  t.field('support_filament', have_support_material || have_skirt);

  t.line('raft_contact_distance', have_raft && !have_support_soluble);

  // Orca: First-layer density is available for supports broadly.
  t.field('raft_first_layer_density', have_support_material);
  // Orca: For regular tree (Slim/Strong) without raft, hide first-layer expansion.
  // Keep it enabled for non-tree supports, organic tree, hybrid tree, and any raft case.
  t.field('raft_first_layer_expansion',
    have_support_material && ((!support_is_normal_tree || c.is('support_style', 'tree_hybrid')) || have_raft));

  const has_ironing = !c.is('ironing_type', 'no ironing');
  for (const el of ['ironing_pattern', 'ironing_flow', 'ironing_spacing', 'ironing_angle', 'ironing_inset', 'ironing_angle_fixed'])
    t.line(el, has_ironing);
  const has_rectilinear_ironing = c.is('ironing_pattern', 'rectilinear');
  for (const el of ['ironing_angle', 'ironing_angle_fixed'])
    t.field(el, has_ironing && has_rectilinear_ironing);

  t.line('ironing_speed', has_ironing || has_support_ironing);

  const has_zaa = c.bool('zaa_enabled');
  for (const el of ['zaa_minimize_perimeter_height', 'zaa_min_z', 'zaa_dont_alternate_fill_direction', 'ironing_expansion'])
    t.line(el, has_zaa);

  const have_sequential_printing = c.is('print_sequence', 'by object');
  t.field('print_order', !have_sequential_printing);

  // A printer option: on the print tab the call finds no field, as in Orca.
  t.field('single_extruder_multi_material', !x.isBbl);

  const bSEMM = c.bool('single_extruder_multi_material');
  const supports_wipe_tower_2 = !x.isBbl && c.is('wipe_tower_type', 'type2');

  t.field('ooze_prevention', !bSEMM);
  const have_ooze_prevention = c.bool('ooze_prevention');
  t.line('standby_temperature_delta', have_ooze_prevention);
  t.line('preheat_time', have_ooze_prevention);
  const preheat_steps = c.num('preheat_steps');
  t.line('preheat_steps', have_ooze_prevention && preheat_steps > 0);

  const have_prime_tower = c.bool('enable_prime_tower');
  for (const el of ['prime_tower_width', 'prime_tower_brim_width', 'prime_tower_skip_points', 'wipe_tower_wall_type', 'prime_tower_infill_gap', 'prime_tower_enable_framework', 'enable_tower_interface_features'])
    t.line(el, have_prime_tower);

  t.line('enable_tower_interface_cooldown_during_tower',
    have_prime_tower && c.bool('enable_tower_interface_features'));

  const purge_in_primetower = c.bool('purge_in_prime_tower');

  for (const el of ['wipe_tower_rotation_angle', 'wipe_tower_cone_angle',
    'wipe_tower_extra_spacing', 'wipe_tower_max_purge_speed',
    'wipe_tower_bridging', 'wipe_tower_extra_flow'])
    t.line(el, have_prime_tower && supports_wipe_tower_2);

  // Orca: both tower generators skip sparse layers, so this is not a wipe tower 2 exclusive.
  t.line('wipe_tower_no_sparse_layers', have_prime_tower);

  const have_rib_wall = c.is('wipe_tower_wall_type', 'rib') && have_prime_tower;
  t.line('wipe_tower_cone_angle', have_prime_tower && supports_wipe_tower_2 && c.is('wipe_tower_wall_type', 'cone'));
  t.line('wipe_tower_extra_rib_length', have_rib_wall);
  t.line('wipe_tower_rib_width', have_rib_wall);
  t.line('wipe_tower_fillet_wall', have_rib_wall);
  t.field('prime_tower_width', have_prime_tower && !have_rib_wall);

  t.line('single_extruder_multi_material_priming', !bSEMM && have_prime_tower && supports_wipe_tower_2);

  const use_cyclic_ordering = c.is('toolchange_ordering', 'cyclic');
  t.line('toolchange_cyclic_order', use_cyclic_ordering);
  t.line('toolchange_cyclic_first_layer', use_cyclic_ordering);

  t.line('prime_volume', have_prime_tower && (!purge_in_primetower || !bSEMM));

  for (const el of ['flush_into_infill', 'flush_into_support', 'flush_into_objects'])
    t.field(el, have_prime_tower);

  const have_avoid_crossing_perimeters = c.bool('reduce_crossing_wall');
  t.line('max_travel_detour_distance', have_avoid_crossing_perimeters);

  const has_set_other_flow_ratios = c.bool('set_other_flow_ratios');
  for (const el of ['first_layer_flow_ratio', 'outer_wall_flow_ratio', 'inner_wall_flow_ratio', 'overhang_flow_ratio', 'sparse_infill_flow_ratio', 'internal_solid_infill_flow_ratio', 'gap_fill_flow_ratio', 'support_flow_ratio', 'support_interface_flow_ratio'])
    t.line(el, has_set_other_flow_ratios);

  const has_overhang_speed = c.bool('enable_overhang_speed');
  for (const el of ['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed'])
    t.line(el, has_overhang_speed);

  t.line('slowdown_for_curled_perimeters', has_overhang_speed);

  t.line('flush_into_objects', !x.isGlobal);

  t.line('support_interface_not_for_body', c.num('support_interface_filament') !== 0 && c.num('support_filament') === 0);

  // Get the current fuzzy skin state
  const has_fuzzy_skin = !c.is('fuzzy_skin', 'disabled_fuzzy');

  // Show fuzzy skin options when fuzzy skin is not disabled
  for (const el of ['fuzzy_skin_mode', 'fuzzy_skin_noise_type', 'fuzzy_skin_point_distance', 'fuzzy_skin_thickness', 'fuzzy_skin_first_layer'])
    t.line(el, has_fuzzy_skin);

  // Show noise type specific options with the same logic
  const is_ripple = c.is('fuzzy_skin_noise_type', 'ripple');
  t.line('fuzzy_skin_scale', !c.is('fuzzy_skin_noise_type', 'classic') && has_fuzzy_skin && !is_ripple);
  t.line('fuzzy_skin_octaves', !c.is('fuzzy_skin_noise_type', 'classic') && !c.is('fuzzy_skin_noise_type', 'voronoi') && has_fuzzy_skin && !is_ripple);
  t.line('fuzzy_skin_persistence', (c.is('fuzzy_skin_noise_type', 'perlin') || c.is('fuzzy_skin_noise_type', 'billow')) && has_fuzzy_skin && !is_ripple);
  t.line('fuzzy_skin_ripples_per_layer', is_ripple && has_fuzzy_skin);
  t.line('fuzzy_skin_ripple_offset', is_ripple && has_fuzzy_skin);
  t.line('fuzzy_skin_layers_between_ripple_offset', is_ripple && has_fuzzy_skin);

  const have_arachne = c.is('wall_generator', 'arachne');
  for (const el of ['wall_transition_length', 'wall_transition_filter_deviation', 'wall_transition_angle', 'min_feature_size', 'min_length_factor',
    'min_bead_width', 'wall_distribution_count', 'initial_layer_min_bead_width', 'wall_maximum_resolution', 'wall_maximum_deviation'])
    t.line(el, have_arachne);
  t.field('detect_thin_wall', !have_arachne);

  // Orca
  const is_role_based_wipe_speed = c.bool('role_based_wipe_speed');
  t.field('wipe_speed', !is_role_based_wipe_speed);

  const have_wipe_inward = c.bool('wipe_inward');
  t.line('wipe_inward_distance', have_wipe_inward);

  for (const el of ['accel_to_decel_enable', 'accel_to_decel_factor'])
    t.line(el, gcf_is_klipper);
  if (gcf_is_klipper)
    t.field('accel_to_decel_factor', c.bool('accel_to_decel_enable'));

  const have_make_overhang_printable = c.bool('make_overhang_printable');
  t.line('make_overhang_printable_angle', have_make_overhang_printable);
  t.line('make_overhang_printable_hole_size', have_make_overhang_printable);

  // Orca: the one-wall options act on top/bottom surfaces, which exist only with a shell. An unfilled surface
  // (0% surface density) is still a surface, so these are gated on the layer counts alone.
  t.line('only_one_wall_first_layer', has_bottom_shell);
  t.line('only_one_wall_top', has_top_shell_layers);
  t.line('min_width_top_surface', (has_top_shell_layers && c.bool('only_one_wall_top')) || ((c.num('min_length_factor') > 0.5) && have_arachne)); // 0.5 is default value

  for (const el of ['hole_to_polyhole_threshold', 'hole_to_polyhole_twisted', 'hole_to_polyhole_max_edges'])
    t.line(el, c.bool('hole_to_polyhole'));

  const has_detect_overhang_wall = c.bool('detect_overhang_wall');
  const has_overhang_reverse = c.bool('overhang_reverse');
  const allow_overhang_reverse = !has_spiral_vase;
  t.line('unsupported_wall_last', has_detect_overhang_wall);
  t.line('overhang_reverse', allow_overhang_reverse);
  t.line('overhang_reverse_internal_only', allow_overhang_reverse && has_overhang_reverse);
  const has_overhang_reverse_internal_only = c.bool('overhang_reverse_internal_only');
  // (Orca sets overhang_reverse_threshold to 0% here when internal only: see printFffRewrites.)
  t.line('overhang_reverse_threshold', has_detect_overhang_wall && allow_overhang_reverse && has_overhang_reverse && !has_overhang_reverse_internal_only);
  t.line('timelapse_type', x.isBbl);

  const have_small_area_infill_flow_compensation = c.bool('small_area_infill_flow_compensation');
  t.line('small_area_infill_flow_compensation_model', have_small_area_infill_flow_compensation);

  t.field('seam_slope_type', !has_spiral_vase);
  const has_seam_slope = !has_spiral_vase && !c.is('seam_slope_type', 'none');
  t.line('seam_slope_conditional', has_seam_slope);
  t.line('seam_slope_start_height', has_seam_slope);
  t.line('seam_slope_entire_loop', has_seam_slope);
  t.line('seam_slope_min_length', has_seam_slope);
  t.line('seam_slope_steps', has_seam_slope);
  t.line('seam_slope_inner_walls', has_seam_slope);
  t.line('scarf_joint_speed', has_seam_slope);
  t.line('scarf_joint_flow_ratio', has_seam_slope);
  t.field('seam_slope_min_length', !c.bool('seam_slope_entire_loop'));
  t.line('scarf_angle_threshold', has_seam_slope && c.bool('seam_slope_conditional'));
  t.line('scarf_overhang_threshold', has_seam_slope && c.bool('seam_slope_conditional'));

  const use_beam_interlocking = c.bool('interlocking_beam');
  t.line('mmu_segmented_region_interlocking_depth', !use_beam_interlocking);
  t.line('interlocking_beam_width', use_beam_interlocking);
  t.line('interlocking_orientation', use_beam_interlocking);
  t.line('interlocking_beam_layer_count', use_beam_interlocking);
  t.line('interlocking_depth', use_beam_interlocking);
  t.line('interlocking_boundary_avoidance', use_beam_interlocking);

  const lattice_options = c.is('sparse_infill_pattern', 'lateral-lattice');
  for (const el of ['lateral_lattice_angle_1', 'lateral_lattice_angle_2'])
    t.line(el, lattice_options);

  const lightning_options = c.is('sparse_infill_pattern', 'lightning');
  for (const el of ['lightning_overhang_angle', 'lightning_prune_angle', 'lightning_straightening_angle'])
    t.line(el, lightning_options);

  // Adaptative Cubic and support cubic infill patterns do not support infill rotation.
  const FillAdaptive = c.is('sparse_infill_pattern', 'adaptivecubic') || c.is('sparse_infill_pattern', 'supportcubic');

  //Orca: disable infill_direction/solid_infill_direction if sparse_infill_rotate_template/solid_infill_rotate_template is not empty value and adaptive cubic/support cubic infill pattern is not selected
  t.field('sparse_infill_rotate_template', !FillAdaptive);
  t.field('infill_direction', c.text('sparse_infill_rotate_template') === '' && !FillAdaptive);
  t.field('solid_infill_direction', c.text('solid_infill_rotate_template') === '');

  t.line('infill_overhang_angle', c.is('sparse_infill_pattern', 'lateral-honeycomb'));

  t.line('enable_wrapping_detection', x.supportsWrappingDetection);
}

// TabPrint::toggle_options: toggle_print_fff_options, then the two enum filters.
// The support styles each support type can use (also update_print_fff_config's reset).
const SUPPORT_STYLES_NORMAL = enumList('support_style', ['default', 'grid', 'snug']);
const SUPPORT_STYLES_TREE = enumList('support_style', ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic']);

function tabPrintToggleOptions(x: Ctx, t: Toggles): void {
  togglePrintFffOptions(x, t);
  const { c } = x;
  t.enumOnly('support_style', c.oneOf('support_type', TREE_SUPPORT_TYPES) ? SUPPORT_STYLES_TREE : SUPPORT_STYLES_NORMAL);

  // BBL printers do not support cone wipe tower
  const enum_set_bbl = enumList('wipe_tower_wall_type', ['rectangle', 'rib']);
  const enum_set_none_bbl = enumList('wipe_tower_wall_type', ['rectangle', 'cone', 'rib']);
  t.enumOnly('wipe_tower_wall_type', x.isBbl ? enum_set_bbl : enum_set_none_bbl);
}

// ---------------------------------------------------------------------------------------------
// Process checks: ConfigManipulation::update_print_fff_config and check_layer_height, plus the
// silent rewrites of toggle_print_fff_options
// ---------------------------------------------------------------------------------------------

const PROCESS = 'process' as const;
const FILAMENT = 'filament' as const;
const MACHINE = 'machine' as const;

const SPIRAL_VASE_REQUIREMENTS: Record<string, string> = {
  wall_loops: '1',
  top_shell_layers: '0',
  sparse_infill_density: '0%',
  enable_support: '0',
  enforce_support_layers: '0',
  detect_thin_wall: '0',
  overhang_reverse: '0',
  timelapse_type: '0',
  enable_wrapping_detection: '0',
};

// Reset filament overrides pointing at a slot that no longer exists. (Orca also rejects mixed
// filament slots for the first three; the web slicer has no mixed filaments.)
const FILAMENT_ID_KEYS = readKeys([
  'support_filament', 'support_interface_filament', 'wipe_tower_filament',
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id', 'internal_solid_filament_id',
  'top_surface_filament_id', 'bottom_surface_filament_id',
]);
// The filament ids the plater's config holds (Plater::priv::priv in Plater.cpp).
const PLATER_FILAMENT_ID_KEYS: ReadonlySet<string> = new Set([
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id',
  'support_filament', 'support_interface_filament', 'wipe_tower_filament',
]);

/**
 * check_layer_height: the printer's layer height limits. Orca checks them when layer_height is
 * edited (Tab::on_value_change, and the object settings), before update_print_fff_config runs.
 * True when it reports an issue.
 */
function checkLayerHeight(x: Ctx, issues: RuleIssue[]): boolean {
  const checkedOn = ['layer_height'];
  if (!x.checksOn(checkedOn)) return false;
  const { c } = x;
  // layer_height_limits: the smallest minimum and the largest maximum over the extruders
  const min_layer_height = Math.min(...c.slots('min_layer_height').map(Number.parseFloat));
  const max_layer_height = Math.max(...c.slots('max_layer_height').map(Number.parseFloat));
  const layer_height = c.num('layer_height');
  const outOfRange = (clamp_to: number): RuleIssue => ({
    id: 'layer-height-limits',
    scope: PROCESS,
    key: 'layer_height',
    keys: ['layer_height', 'min_layer_height', 'max_layer_height'],
    severity: 'warning',
    message: 'Layer height is outside the limits set in Printer Settings -> Extruder -> Layer height limits, this may cause printing quality issues.',
    fix: { layer_height: orcaNumber(clamp_to) },
    fixLabel: `Adjust to ${orcaNumber(clamp_to)} mm`,
    checkedOn,
  });

  if (min_layer_height > EPSILON && layer_height < EPSILON) {
    issues.push({
      id: 'layer-height-limits',
      scope: PROCESS,
      key: 'layer_height',
      keys: ['layer_height', 'min_layer_height'],
      severity: 'error',
      message: `Layer height is too small. It will be set to the minimum (${orcaNumber(min_layer_height)} mm).`,
      fix: { layer_height: orcaNumber(min_layer_height) },
      fixLabel: 'Set to the minimum',
      checkedOn,
    });
    return true;
  }
  if (max_layer_height > EPSILON && layer_height > max_layer_height + EPSILON) {
    issues.push(outOfRange(max_layer_height));
    return true;
  }
  if (min_layer_height > EPSILON && layer_height < min_layer_height - EPSILON) {
    issues.push(outOfRange(min_layer_height));
    return true;
  }
  return false;
}

function updatePrintFffConfig(x: Ctx, issues: RuleIssue[]): void {
  const { c } = x;
  const is_object_config = !x.isGlobal && !x.isPlate;
  const reset = (id: string, key: string, message: string, value: string): RuleIssue => ({
    id, scope: PROCESS, key, keys: [key], severity: 'error', message, fix: { [key]: value }, fixLabel: `Reset to ${value}`,
  });

  // layer_height shouldn't be equal to zero. (When the user edits it to zero on a printer with a
  // minimum, check_layer_height has already set it to that minimum, so this one does not fire.)
  const layer_height = c.num('layer_height');
  const layerHeightChecked = checkLayerHeight(x, issues);
  if (layer_height < EPSILON && !layerHeightChecked)
    issues.push(reset('layer-height-zero', 'layer_height', 'Layer height too small. It has to be reset to 0.2.', '0.2'));

  //BBS: ironing_spacing shouldn't be too small or equal to zero
  if (c.num('ironing_spacing') < 0.05)
    issues.push(reset('ironing-spacing-small', 'ironing_spacing', 'Ironing spacing too small. It has to be reset to 0.1.', '0.1'));
  if (c.num('support_ironing_spacing') < 0.05)
    issues.push(reset('support-ironing-spacing-small', 'support_ironing_spacing', 'Ironing spacing too small. It has to be reset to 0.1.', '0.1'));

  if (c.num('initial_layer_print_height') < EPSILON)
    issues.push(reset('initial-layer-height-zero', 'initial_layer_print_height', 'Zero initial layer height is invalid. The first layer height has to be reset to 0.2.', '0.2'));

  const compensationMessage = 'This setting is only used for tuning model size by small amounts. For example, when the model size has small errors or when tolerances are incorrect. For large adjustments, please use the model scale function.';
  if (Math.abs(c.num('xy_hole_compensation')) > 2)
    issues.push(reset('xy-hole-compensation-large', 'xy_hole_compensation', compensationMessage, '0'));
  if (Math.abs(c.num('xy_contour_compensation')) > 2)
    issues.push(reset('xy-contour-compensation-large', 'xy_contour_compensation', compensationMessage, '0'));

  if (c.num('elefant_foot_compensation') > 1)
    issues.push(reset('elephant-foot-compensation-large', 'elefant_foot_compensation',
      'The elephant foot compensation value is too large. If there are significant elephant foot issues, please check other settings. The bed temperature may be too high, for example.', '0'));

  if (c.bool('enable_wrapping_detection') && !x.supportsWrappingDetection) {
    issues.push({
      id: 'wrapping-detection-unsupported', scope: PROCESS, key: 'enable_wrapping_detection', keys: ['enable_wrapping_detection'],
      severity: 'info', message: 'This printer has no clumping detection, so Orca turns it off.',
      fix: { enable_wrapping_detection: '0' }, fixLabel: 'Turn off', triggers: ['enable_wrapping_detection'],
    });
  }

  if (!x.isPlate &&
    c.bool('spiral_mode') &&
    !(c.num('wall_loops') === 1 &&
      c.num('top_shell_layers') === 0 &&
      c.num('sparse_infill_density') === 0 &&
      !c.bool('enable_support') &&
      c.num('enforce_support_layers') === 0 &&
      !c.bool('detect_thin_wall') &&
      !c.bool('overhang_reverse') &&
      c.is('timelapse_type', '0') &&
      !c.bool('enable_wrapping_detection'))) {
    // show_spiral_mode_settings_dialog: an object gets OK only, which applies the settings.
    let message = 'Spiral mode only works when wall loops is 1, support is disabled, clumping detection by probing is disabled, top shell layers is 0, sparse infill density is 0 and timelapse type is traditional.';
    if (c.is('printer_structure', 'i3')) message += ' But machines with I3 structure will not generate timelapse videos.';
    issues.push({
      id: 'spiral-vase', scope: PROCESS, key: 'spiral_mode', keys: ['spiral_mode', ...Object.keys(SPIRAL_VASE_REQUIREMENTS)],
      severity: 'warning', message, fix: { ...SPIRAL_VASE_REQUIREMENTS }, fixLabel: 'Change these settings',
      alternative: is_object_config ? undefined : { label: 'Turn off spiral mode', values: { spiral_mode: '0' } },
    });
  }

  if (c.bool('alternate_extra_wall') && c.is('ensure_vertical_shell_thickness', 'ensure_all')) {
    issues.push({
      id: 'alternate-extra-wall', scope: PROCESS, key: 'alternate_extra_wall', keys: ['alternate_extra_wall', 'ensure_vertical_shell_thickness'],
      severity: 'warning', message: "Alternate extra wall doesn't work well when ensure vertical shell thickness is set to All.",
      fix: { ensure_vertical_shell_thickness: 'ensure_moderate', alternate_extra_wall: '1' },
      fixLabel: 'Change ensure vertical shell thickness to Moderate',
      alternative: x.isGlobal ? { label: "Don't use alternate extra wall", values: { ensure_vertical_shell_thickness: 'ensure_all', alternate_extra_wall: '0' } } : undefined,
    });
  }

  // (The #if 0 prime tower / adaptive layer height block is not compiled in Orca.)

  // BBL printers do not support cone wipe tower
  if (c.bool('enable_prime_tower') && x.isBbl && c.is('wipe_tower_wall_type', 'cone')) {
    issues.push({
      id: 'wipe-tower-cone-bbl', scope: PROCESS, key: 'wipe_tower_wall_type', keys: ['wipe_tower_wall_type', 'enable_prime_tower'],
      severity: 'info', message: 'Bambu Lab printers do not support a cone wipe tower, so Orca uses a rectangle.',
      fix: { wipe_tower_wall_type: 'rectangle' }, fixLabel: 'Use a rectangle', triggers: ['enable_prime_tower', 'wipe_tower_wall_type'],
    });
  }

  // "enable_support" and "detect_overhang_wall": Orca asks only once, when support is turned on in
  // the global settings. That is an edit, so editEffects handles it.

  if (c.bool('enable_support')) {
    const set = c.oneOf('support_type', TREE_SUPPORT_TYPES) ? SUPPORT_STYLES_TREE : SUPPORT_STYLES_NORMAL;
    if (!set.includes(c.text('support_style'))) {
      issues.push({
        id: 'support-style-type', scope: PROCESS, key: 'support_style', keys: ['support_style', 'support_type', 'enable_support'],
        severity: 'info', message: 'This support style does not go with the support type, so Orca uses the default style.',
        fix: { support_style: 'default' }, fixLabel: 'Use the default style', triggers: ['enable_support', 'support_type'],
      });
    }
  }

  // BBS
  // Reset filament overrides pointing at a slot that no longer exists.
  for (const key of FILAMENT_ID_KEYS) {
    if (c.num(key) > x.filamentCount) {
      // Orca resets to the plater config's value of the key when that config has the key, else to 0.
      // In the global settings the plater config mirrors the settings being checked, so the port
      // uses 0 there. For an object or a plate it is the global value (0 when that is out of range
      // too, so that the fix does not bring the problem back).
      let new_value = 0;
      if (x.plater && PLATER_FILAMENT_ID_KEYS.has(key)) {
        const global_value = x.plater.num(key);
        if (global_value >= 0 && global_value <= x.filamentCount) new_value = global_value;
      }
      issues.push({
        id: 'filament-id-range', scope: PROCESS, key, keys: [key],
        severity: 'info',
        message: new_value === 0
          ? `Filament ${c.text(key)} does not exist in this project, so Orca uses the default filament.`
          : `Filament ${c.text(key)} does not exist in this project, so Orca uses filament ${new_value}, as the global settings do.`,
        fix: { [key]: String(new_value) }, fixLabel: new_value === 0 ? 'Use the default filament' : `Use filament ${new_value}`, triggers: [key],
      });
    }
  }

  // (The mixed colour sub-layer warning needs variable layer height profiles, which the web slicer
  // does not have.)

  // seam_slope_start_height is relative to layer_height when given in %
  const seam_slope_start_height = c.text('seam_slope_start_height').endsWith('%')
    ? (c.num('seam_slope_start_height') / 100) * layer_height
    : c.num('seam_slope_start_height');
  if (!c.is('seam_slope_type', 'none') && seam_slope_start_height >= layer_height)
    issues.push(reset('seam-slope-start-height', 'seam_slope_start_height', 'seam_slope_start_height needs to be smaller than layer_height.', '0'));

  const skin_depth = c.num('skin_infill_depth');
  if (c.num('infill_lock_depth') > skin_depth) {
    issues.push({
      ...reset('infill-lock-depth', 'infill_lock_depth', 'Lock depth should be smaller than skin depth.', orcaNumber(skin_depth / 2)),
      keys: ['infill_lock_depth', 'skin_infill_depth'], fixLabel: 'Reset to 50% of skin depth',
    });
  }

  const have_arachne = c.is('wall_generator', 'arachne');
  if (!c.is('fuzzy_skin_mode', 'displacement') && !have_arachne) {
    issues.push({
      id: 'fuzzy-skin-arachne', scope: PROCESS, key: 'fuzzy_skin_mode', keys: ['fuzzy_skin_mode', 'wall_generator'],
      severity: 'warning', message: 'Both [Extrusion] and [Combined] modes of Fuzzy Skin require the Arachne Wall Generator to be enabled.',
      fix: { wall_generator: 'arachne' }, fixLabel: 'Enable Arachne Wall Generator',
      alternative: { label: 'Use [Displacement] mode of the Fuzzy Skin', values: { fuzzy_skin_mode: 'displacement' } },
    });
  }
}

/** The value rewrites inside toggle_print_fff_options, which Orca makes silently. */
function printFffRewrites(x: Ctx, issues: RuleIssue[]): void {
  const { c } = x;
  if (c.num('max_volumetric_extrusion_rate_slope') > 0 && c.bool('enable_arc_fitting')) {
    issues.push({
      id: 'arc-fitting-with-smoothing', scope: PROCESS, key: 'enable_arc_fitting', keys: ['enable_arc_fitting', 'max_volumetric_extrusion_rate_slope'],
      severity: 'info', message: 'Arc fitting does not work with extrusion rate smoothing, so Orca turns it off.',
      fix: { enable_arc_fitting: '0' }, fixLabel: 'Turn off arc fitting', triggers: ['max_volumetric_extrusion_rate_slope'],
    });
  }
  if (c.num('max_volumetric_extrusion_rate_slope_segment_length') < 0.5) {
    issues.push({
      id: 'smoothing-segment-length', scope: PROCESS, key: 'max_volumetric_extrusion_rate_slope_segment_length',
      keys: ['max_volumetric_extrusion_rate_slope_segment_length'],
      severity: 'info', message: 'The smoothing segment length must be at least 0.5 mm, so Orca sets it to 1.',
      fix: { max_volumetric_extrusion_rate_slope_segment_length: '1' }, fixLabel: 'Set to 1',
      triggers: ['max_volumetric_extrusion_rate_slope_segment_length', 'max_volumetric_extrusion_rate_slope'],
    });
  }
  // If the infill pattern does not support multiline fill_multiline is changed to 1.
  // Necessary when the pattern contains params.multiline (for example, triangles because they belong to the rectilinear class)
  if (c.num('sparse_infill_density') > 0 && !c.oneOf('sparse_infill_pattern', MULTILINE_INFILL_PATTERNS) && c.num('fill_multiline') !== 1) {
    issues.push({
      id: 'fill-multiline-pattern', scope: PROCESS, key: 'fill_multiline', keys: ['fill_multiline', 'sparse_infill_pattern'],
      severity: 'info', message: 'This infill pattern does not support multiline infill, so Orca sets it to 1.',
      fix: { fill_multiline: '1' }, fixLabel: 'Set to 1', triggers: ['sparse_infill_pattern', 'sparse_infill_density', 'fill_multiline'],
    });
  }
  if (c.bool('overhang_reverse_internal_only') && c.num('overhang_reverse_threshold') !== 0) {
    issues.push({
      id: 'overhang-reverse-internal-only', scope: PROCESS, key: 'overhang_reverse_threshold',
      keys: ['overhang_reverse_threshold', 'overhang_reverse_internal_only'],
      severity: 'info', message: 'With "Reverse only internal perimeters" Orca sets the reversal threshold to 0%.',
      fix: { overhang_reverse_threshold: '0%' }, fixLabel: 'Set to 0%', triggers: ['overhang_reverse_internal_only'],
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Filament: TabFilament::toggle_options, update_filament_overrides_page and the check_* functions
// ---------------------------------------------------------------------------------------------

/** LongRectrationLevel::EnableFilament */
const LONG_RETRACTION_ENABLE_FILAMENT = 2;

// Orca shows one page at a time and toggles only the options of the page it shows; the port toggles
// every page (Cooling, Filament, Setting Overrides, Multimaterial) at once, in the same order.
function tabFilamentToggleOptions(x: Ctx, t: Toggles, issues: RuleIssue[]): void {
  const { c } = x;
  const is_BBL_printer = x.isBbl;

  // Cooling
  const has_enable_overhang_bridge_fan = c.bool('enable_overhang_bridge_fan', 0);
  for (const el of ['overhang_fan_speed', 'overhang_fan_threshold', 'internal_bridge_fan_speed']) // ORCA: Add support for separate internal bridge fan speed control
    t.field(el, has_enable_overhang_bridge_fan);

  // Orca: toggle dont slow down for external perimeters if
  const has_slow_down_for_layer_cooling = c.bool('slow_down_for_layer_cooling', 0);
  t.field('dont_slow_down_outer_wall', has_slow_down_for_layer_cooling);

  // ORCA: First layer fan speed override only makes sense when no layers are gated off ("No cooling for
  // the first" == 0). Otherwise the override would set layer 0 to a non-zero value while the gate forces
  // layers 1..N-1 to zero, producing a confusing non-monotonic profile. When the gate is active we both
  // grey out the UI line and force the underlying value to -1 so the cooling buffer never enters the
  // override branch.
  const close_fan_first_n = c.num('close_fan_the_first_x_layers', 0);
  const initial_layer_fan_speed_enabled = close_fan_first_n <= 0;
  t.line('initial_layer_fan_speed', initial_layer_fan_speed_enabled);
  // (The reset to -1 is a silent rewrite: an issue that editing close_fan_the_first_x_layers applies.)
  if (!initial_layer_fan_speed_enabled && c.slots('initial_layer_fan_speed').some((v) => Number.parseFloat(v) !== -1)) {
    issues.push({
      id: 'initial-layer-fan-speed', scope: FILAMENT, key: 'initial_layer_fan_speed', keys: ['initial_layer_fan_speed', 'close_fan_the_first_x_layers'],
      severity: 'info', message: 'The first layer fan speed is not used while the fan is off for the first layers, so Orca sets it to -1.',
      fix: { initial_layer_fan_speed: '-1' }, fixLabel: 'Set to -1', triggers: ['close_fan_the_first_x_layers'],
    });
  }

  t.line('additional_cooling_fan_speed', c.bool('auxiliary_fan'));

  const support_air_filtration = c.bool('support_air_filtration');
  for (const el of ['activate_air_filtration', 'during_print_exhaust_fan_speed', 'complete_print_exhaust_fan_speed'])
    t.line(el, support_air_filtration);

  if (support_air_filtration) {
    const activate_air_filtration = c.bool('activate_air_filtration', 0);
    t.field('activate_air_filtration_during_print', activate_air_filtration);
    t.field('during_print_exhaust_fan_speed', activate_air_filtration && c.bool('activate_air_filtration_during_print', 0));
    t.field('activate_air_filtration_on_completion', activate_air_filtration);
    t.field('complete_print_exhaust_fan_speed', activate_air_filtration && c.bool('activate_air_filtration_on_completion', 0));
  }

  // Filament
  {
    const pa = c.bool('enable_pressure_advance', 0);
    t.field('pressure_advance', pa);

    //Orca: Enable the plates that should be visible when multi bed support is enabled or a BBL printer is selected; otherwise, enable only the plate visible for the selected bed type.
    // (Orca reads curr_bed_type from the project config: here, the plate's bed type.)
    const bed_temp_1st_layer_key = getBedTemp1stLayerKey(c.text('curr_bed_type'));

    const bed_temp_keys = ['supertack_plate_temp_initial_layer', 'cool_plate_temp_initial_layer',
      'textured_cool_plate_temp_initial_layer', 'eng_plate_temp_initial_layer',
      'textured_plate_temp_initial_layer', 'hot_plate_temp_initial_layer'];

    const support_multi_bed_types = !bed_temp_keys.includes(bed_temp_1st_layer_key) ||
      is_BBL_printer || c.bool('support_multi_bed_types');

    for (const key of bed_temp_keys)
      t.line(key, support_multi_bed_types || bed_temp_1st_layer_key === key);

    // Orca: adaptive pressure advance and calibration model
    // If PA is not enabled, disable adaptive pressure advance and hide the model section
    // If adaptive PA is not enabled, hide the adaptive PA model section
    t.field('adaptive_pressure_advance', pa);
    t.field('adaptive_pressure_advance_overhangs', pa);
    const has_adaptive_pa = c.bool('adaptive_pressure_advance', 0);
    t.line('adaptive_pressure_advance_overhangs', has_adaptive_pa && pa);
    t.line('adaptive_pressure_advance_model', has_adaptive_pa && pa);
    t.line('adaptive_pressure_advance_bridges', has_adaptive_pa && pa);

    const is_pellet_printer = c.bool('pellet_modded_printer');
    t.line('pellet_flow_coefficient', is_pellet_printer);
    t.line('filament_diameter', !is_pellet_printer);

    t.line('activate_chamber_temp_control', c.bool('support_chamber_temp_control'));

    const variant_idx = 0; // the one variant the web slicer shows
    const volumetric_speed_cos = c.text('volumetric_speed_coefficients', variant_idx);
    const enable_fit = volumetric_speed_cos !== '0 0 0 0 0 0';
    t.field('filament_adaptive_volumetric_speed', enable_fit);
  }

  // Setting Overrides
  updateFilamentOverridesPage(x, t);

  // Multimaterial
  {
    // Orca: hide specific settings for BBL printers
    for (const el of ['filament_minimal_purge_on_wipe_tower', 'filament_loading_speed_start', 'filament_loading_speed',
      'filament_unloading_speed_start', 'filament_unloading_speed', 'filament_toolchange_delay', 'filament_cooling_moves',
      'filament_cooling_initial_speed', 'filament_cooling_final_speed'])
      t.field(el, !is_BBL_printer);

    const multitool_ramming = c.bool('filament_multitool_ramming', 0);
    t.field('filament_multitool_ramming_volume', multitool_ramming);
    t.field('filament_multitool_ramming_flow', multitool_ramming);

    const is_BBL_multi_extruder = is_BBL_printer && c.slots('nozzle_diameter').length > 1;
    const extruder_idx = 0;
    t.line('long_retractions_when_ec', is_BBL_multi_extruder);
    t.line('retraction_distances_when_ec', is_BBL_multi_extruder && c.bool('long_retractions_when_ec', extruder_idx));
  }
}

/**
 * update_filament_overrides_page: each override has an Override checkbox; an unchecked (nil)
 * override shows the printer's value (process ironing_* for the ironing ones) greyed out.
 */
function updateFilamentOverridesPage(x: Ctx, t: Toggles): void {
  const { c } = x;
  const opt_keys = readKeys([
    'filament_retraction_length',
    'filament_z_hop',
    'filament_z_hop_types',
    'filament_retract_lift_above',
    'filament_retract_lift_below',
    'filament_retract_lift_enforce',
    'filament_retraction_speed',
    'filament_deretraction_speed',
    'filament_retract_restart_extra',
    'filament_retract_length_toolchange',
    'filament_retract_restart_extra_toolchange',
    'filament_retraction_minimum_travel',
    'filament_retract_when_changing_layer',
    'filament_wipe',
    // BBS
    'filament_wipe_distance',
    'filament_retract_before_wipe',
    // Orca
    'filament_retract_after_wipe',
    // BBS
    'filament_long_retractions_when_cut',
    'filament_retraction_distances_when_cut',
    //SoftFever
    // "filament_seam_gap"
  ]);

  const extruder_idx = 0; // the one variant the web slicer shows

  const have_retract_length = c.isNil('filament_retraction_length', extruder_idx) ||
    c.num('filament_retraction_length', extruder_idx) > 0;

  for (const opt_key of opt_keys) {
    let is_checked = opt_key === 'filament_retraction_length' ? true : have_retract_length;
    t.overrideEnabled(opt_key, is_checked);

    is_checked &&= !c.isNil(opt_key, extruder_idx);
    // (An unchecked override shows the printer's value, <key without filament_>, greyed out.)

    if (opt_key === 'filament_long_retractions_when_cut') {
      const machine_enabled = c.num('enable_long_retraction_when_cut') === LONG_RETRACTION_ENABLE_FILAMENT;
      t.line(opt_key, machine_enabled);
      t.field(opt_key, is_checked && machine_enabled);
    } else if (opt_key === 'filament_retraction_distances_when_cut') {
      const machine_enabled = c.num('enable_long_retraction_when_cut') === LONG_RETRACTION_ENABLE_FILAMENT;
      // values[extruder_idx] == 1: a nil slot (255) is not 1
      const filament_enabled = !c.isNil('filament_long_retractions_when_cut', extruder_idx) && c.bool('filament_long_retractions_when_cut', extruder_idx);
      t.line(opt_key, filament_enabled && machine_enabled);
      t.field(opt_key, is_checked && filament_enabled && machine_enabled);
    } else {
      t.field(opt_key, is_checked);
    }
  }

  // Handle ironing overrides
  const ironing_opt_keys = readKeys([
    'filament_ironing_flow',
    'filament_ironing_spacing',
    'filament_ironing_inset',
    'filament_ironing_speed',
  ]);

  for (const opt_key of ironing_opt_keys) {
    const is_checked = !c.isNil(opt_key, extruder_idx);
    t.overrideEnabled(opt_key, true);
    // (Unchecked, it shows the process value, the key without filament_, greyed out.)
    t.field(opt_key, is_checked);
  }
}

/**
 * TabFilament::update: check_filament_max_volumetric_speed; and the checks the filament page's
 * m_on_change handlers make when one of their fields is edited (reported with `checkedOn`).
 */
function filamentChecks(x: Ctx, t: TabRules, issues: RuleIssue[]): void {
  const { c } = x;

  // check_filament_max_volumetric_speed: BBS: limite the min max_volumetric_speed
  if (c.num('filament_max_volumetric_speed') < 0.5) {
    issues.push({
      id: 'max-volumetric-speed-small', scope: FILAMENT, key: 'filament_max_volumetric_speed', keys: ['filament_max_volumetric_speed'],
      severity: 'error', message: 'Too small max volumetric speed. It has to be reset to 0.5.',
      fix: { filament_max_volumetric_speed: '0.5' }, fixLabel: 'Reset to 0.5',
    });
  }

  // get_temperature_range
  const temperature_range_low = c.num('nozzle_temperature_range_low', 0);
  const temperature_range_high = c.num('nozzle_temperature_range_high', 0);

  // check_nozzle_recommended_temperature_range, on an edit of the recommended range
  const recommendedOn = ['nozzle_temperature_range_low', 'nozzle_temperature_range_high'];
  if (x.checksOn(recommendedOn)) {
    // Get the selected filament type
    let filament_type = c.text('filament_type', 0);
    const material = materialType(filament_type);
    const min_recommended_temp = material ? material[1] : 190;
    const max_recommended_temp = material ? material[2] : 300;
    if (!material) filament_type = 'Unknown';
    const msg: string[] = [];
    if (temperature_range_low < min_recommended_temp)
      msg.push(`A minimum temperature above ${min_recommended_temp}\u2103 is recommended for ${filament_type}.`);
    if (temperature_range_high > max_recommended_temp)
      msg.push(`A maximum temperature below ${max_recommended_temp}\u2103 is recommended for ${filament_type}.`);
    if (temperature_range_low > temperature_range_high)
      msg.push('The recommended minimum temperature cannot be higher than the recommended maximum temperature.');
    if (msg.length) {
      issues.push({
        id: 'recommended-temperature-range', scope: FILAMENT, key: 'nozzle_temperature_range_low',
        keys: ['nozzle_temperature_range_low', 'nozzle_temperature_range_high', 'filament_type'],
        severity: 'warning', message: `${msg.join(' ')} Please check.`, checkedOn: recommendedOn,
      });
    }
  }

  // check_nozzle_temperature_range / check_nozzle_temperature_initial_layer_range, each on an edit
  // of its own temperature
  for (const key of readKeys(['nozzle_temperature', 'nozzle_temperature_initial_layer'])) {
    if (!x.checksOn([key])) continue;
    const temperature = c.num(key, 0);
    if (temperature < temperature_range_low || temperature > temperature_range_high) {
      issues.push({
        id: key === 'nozzle_temperature' ? 'nozzle-temperature-range' : 'nozzle-temperature-initial-layer-range',
        scope: FILAMENT, key, keys: [key, 'nozzle_temperature_range_low', 'nozzle_temperature_range_high'],
        severity: 'warning',
        message: 'The nozzle may become clogged when the temperature is out of the recommended range. Please make sure whether to use this temperature to print. ' +
          `The recommended nozzle temperature for this filament type is [${temperature_range_low}, ${temperature_range_high}] degrees Celsius.`,
        checkedOn: [key],
      });
    }
  }

  // check_adaptive_pressure_advance_model, on an edit of the model, which is only possible while it
  // is shown
  const modelOn = ['adaptive_pressure_advance_model'];
  if (x.checksOn(modelOn) && !isHidden(t, 'adaptive_pressure_advance_model')) {
    const error = validateAdaptivePaModel(c.slots('adaptive_pressure_advance_model').join(''));
    if (error) {
      issues.push({
        id: 'adaptive-pa-model', scope: FILAMENT, key: 'adaptive_pressure_advance_model', keys: ['adaptive_pressure_advance_model'],
        severity: 'warning', message: `Adaptive Pressure Advance model validation failed: ${error}`, checkedOn: modelOn,
      });
    }
  }

  // check_chamber_temperature, on an edit of the chamber temperature
  const chamberOn = ['chamber_temperature'];
  if (x.checksOn(chamberOn) && c.bool('support_chamber_temp_control')) {
    const material = materialType(c.text('filament_type', 0));
    if (material && material[4] < c.num('chamber_temperature', 0)) {
      issues.push({
        id: 'chamber-temperature-safe', scope: FILAMENT, key: 'chamber_temperature', keys: ['chamber_temperature', 'filament_type'],
        severity: 'warning',
        message: `Current chamber temperature is higher than the material's safe temperature; this may result in material softening and nozzle clogs. The maximum safe temperature for the material is ${material[4]}`,
        checkedOn: chamberOn,
      });
    }
  }

  // check_chamber_minimal_temperature, on an edit of either chamber temperature
  // Orca: the minimal chamber temperature is a "start printing" threshold that is passed to the
  // print start macro. It must not exceed the target chamber temperature, otherwise the macro
  // could wait forever for a temperature the heater is never asked to reach.
  const chamberMinimalOn = ['chamber_temperature', 'chamber_minimal_temperature'];
  const chamber_min_temp = c.num('chamber_minimal_temperature', 0);
  const chamber_target_temp = c.num('chamber_temperature', 0);
  if (x.checksOn(chamberMinimalOn) && chamber_min_temp > chamber_target_temp) {
    issues.push({
      id: 'chamber-minimal-temperature', scope: FILAMENT, key: 'chamber_minimal_temperature', keys: ['chamber_minimal_temperature', 'chamber_temperature'],
      severity: 'error',
      message: `The minimal chamber temperature (${chamber_min_temp}\u2103) is higher than the target chamber temperature (${chamber_target_temp}\u2103). ` +
        'The minimal value is the threshold at which printing starts while the chamber keeps heating toward the target, so it should not exceed it.',
      fix: { chamber_minimal_temperature: String(chamber_target_temp) }, fixLabel: 'Clamp to the target', checkedOn: chamberMinimalOn,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Printer: TabPrinter::toggle_options, update_input_shaper_menu, build_unregular_pages
// ---------------------------------------------------------------------------------------------

const MARLIN_LIKE_FLAVORS = enumValues('gcode_flavor', ['marlin', 'marlin2', 'klipper', 'reprapfirmware', 'repetier']);

/** build_unregular_pages: the Motion ability page exists only for these flavors. */
function isMarlinFlavor(c: Config): boolean {
  return c.oneOf('gcode_flavor', MARLIN_LIKE_FLAVORS);
}

/** input_shaper_types_for_flavor: the input shapers the firmware accepts, in menu order. */
function inputShaperTypesForFlavor(c: Config): readonly string[] {
  if (c.is('gcode_flavor', 'klipper'))
    return enumList('input_shaping_type', ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI', 'Disable']);
  if (c.is('gcode_flavor', 'reprapfirmware'))
    return enumList('input_shaping_type', ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA', 'Disable']);
  if (c.is('gcode_flavor', 'marlin2'))
    return enumList('input_shaping_type', ['ZV', 'Disable']);
  return enumList('input_shaping_type', ['Default', 'Disable']);
}

/**
 * update_input_shaper_menu: the input_shaping_type menu lists only the flavor's shapers, and Orca
 * silently resets any other value to the first of them. Orca runs it whenever gcode_flavor changes
 * (on_gcode_flavor_changed, for every flavor) and whenever the Motion ability page updates.
 */
function updateInputShaperMenu(x: Ctx, t: Toggles, issues: RuleIssue[]): void {
  const allowed = inputShaperTypesForFlavor(x.c);
  t.enumOnly('input_shaping_type', allowed);
  const current = x.c.text('input_shaping_type');
  const needs_reset = !allowed.includes(current);
  if (needs_reset) {
    issues.push({
      id: 'input-shaper-type', scope: MACHINE, key: 'input_shaping_type', keys: ['input_shaping_type', 'gcode_flavor'],
      severity: 'info', message: `This firmware does not support the ${current} input shaper, so Orca uses ${allowed[0]}.`,
      fix: { input_shaping_type: allowed[0] }, fixLabel: `Use ${allowed[0]}`, triggers: ['gcode_flavor'],
    });
  }
}

function tabPrinterToggleOptions(x: Ctx, t: Toggles, issues: RuleIssue[]): void {
  const { c } = x;
  //BBS: whether the preset is Bambu Lab printer
  const is_BBL_printer = x.isBbl;

  const have_multiple_extruders = true;

  // Basic information
  {
    // SoftFever: hide BBL specific settings
    for (const el of ['scan_first_layer', 'bbl_calib_mark_logo', 'bbl_use_printhost'])
      t.line(el, is_BBL_printer);

    // SoftFever: hide non-BBL settings
    for (const el of ['use_firmware_retraction', 'use_relative_e_distances', 'support_multi_bed_types', 'pellet_modded_printer', 'bed_mesh_max', 'bed_mesh_min', 'bed_mesh_probe_distance', 'adaptive_bed_mesh_margin', 'thumbnails'])
      t.line(el, !is_BBL_printer);

    const gcf_is_marlin_firmware = c.is('gcode_flavor', 'marlin2');
    t.line('enable_power_loss_recovery', is_BBL_printer || gcf_is_marlin_firmware);

    const support_parallel_printheads = c.bool('support_parallel_printheads');
    t.line('parallel_printheads_count', support_parallel_printheads);

    const exclusion_extruder_count = x.extruderCount; // get_printer_extruder_count()
    const collision_volumes_enabled = hasBedExcludeVolumes(c);
    const exclusion_mode = activeBedExcludeVolumeMode(c);
    // Legacy areas and collision volumes are additive. Keep the established
    // material keep-out editable while the opt-in motion constraints exist.
    t.field('bed_exclude_area', true);
    t.line('bed_exclude_volume_mode', collision_volumes_enabled && exclusion_extruder_count > 1);
    t.line('bed_exclude_volumes', exclusion_extruder_count <= 1 || exclusion_mode !== v('bed_exclude_volume_mode', 'per_extruder'));

    t.line('fan_direction', c.bool('auxiliary_fan'));

    // The cooling filter and air filtration are alternative accessories: show only the one the printer supports.
    t.line('support_air_filtration', !c.bool('support_cooling_filter'));
    t.line('cooling_filter_enabled', c.bool('support_cooling_filter'));
  }

  // Machine G-code
  t.line('wrapping_detection_gcode', x.supportsWrappingDetection);

  // Multimaterial
  {
    const supports_wipe_tower_2 = !is_BBL_printer && c.is('wipe_tower_type', 'type2');
    t.line('wipe_tower_type', !is_BBL_printer);
    // SoftFever: hide specific settings for BBL printer
    for (const el of [
      'enable_filament_ramming',
      'cooling_tube_retraction',
      'cooling_tube_length',
      'parking_pos_retraction',
      'extra_loading_move',
      'high_current_on_filament_swap',
    ])
      t.field(el, supports_wipe_tower_2);

    const bSEMM = c.bool('single_extruder_multi_material');
    if (!bSEMM && c.bool('manual_filament_change')) {
      issues.push({
        id: 'manual-filament-change-semm', scope: MACHINE, key: 'manual_filament_change', keys: ['manual_filament_change', 'single_extruder_multi_material'],
        severity: 'info', message: 'Manual filament change needs single extruder multi-material, so Orca turns it off.',
        fix: { manual_filament_change: '0' }, fixLabel: 'Turn off', triggers: ['single_extruder_multi_material'],
      });
    }
    t.field('extruders_count', !bSEMM);
    t.field('manual_filament_change', bSEMM);
    t.field('purge_in_prime_tower', bSEMM && supports_wipe_tower_2);

    // Orca: "Tool change on wipe tower" only makes sense for multi-extruder (multi-toolhead) printers
    // using a Type 2 wipe tower. SEMM already always travels to the tower as part of the purge,
    // so the option is irrelevant there.
    const extruders_count = c.slots('nozzle_diameter').length;
    t.field('tool_change_on_wipe_tower', !bSEMM && supports_wipe_tower_2 && extruders_count > 1);
    t.field('wait_for_temp_on_wipe_tower', !bSEMM && supports_wipe_tower_2 && extruders_count > 1);
  }

  // Extruder pages ("Extruder" or "Extruder 1".."Extruder N")
  let firmwareRetractionAsked = false;
  for (let i = 0; i < x.extruderCount; i++) {
    const variant_index = printerVariantIndex(c, i);
    const have_retract_length = c.num('retraction_length', variant_index) > 0;

    t.field('extruder_printable_area', false, i); // disable
    t.line('extruder_printable_area', x.extruderCount === 2, i); //hide
    const per_extruder_exclusions = hasBedExcludeVolumes(c) &&
      activeBedExcludeVolumeMode(c) === v('bed_exclude_volume_mode', 'per_extruder');
    t.line('extruder_bed_exclude_volumes', x.extruderCount > 1 && per_extruder_exclusions, i);
    t.field('extruder_printable_height', false, i);
    t.line('extruder_printable_height', x.extruderCount === 2, i);

    // when using firmware retraction, firmware decides retraction length
    const use_firmware_retraction = c.bool('use_firmware_retraction');
    // (Orca toggles "retract_length" here, which is not an option: see SKIPPED_CALL_SITES.)

    // user can customize travel length if we have retraction length or we"re using
    // firmware retraction
    t.field('retraction_minimum_travel', have_retract_length || use_firmware_retraction, i);

    // user can customize other retraction options if retraction is enabled
    //BBS
    const retraction = have_retract_length || use_firmware_retraction;
    for (const el of ['z_hop', 'retract_when_changing_layer'])
      t.field(el, retraction, i);

    // retract lift above / below + enforce only applies if using retract lift
    for (const el of ['retract_lift_above', 'retract_lift_below', 'retract_lift_enforce'])
      t.field(el, retraction && c.num('z_hop', i) > 0, i);

    // some options only apply when not using firmware retraction
    // (Orca's list also has "retract_length", which is not an option.)
    for (const el of ['retraction_speed', 'deretraction_speed', 'retract_before_wipe', 'retract_after_wipe',
      'retract_restart_extra', 'wipe_distance'])
      //BBS
      t.field(el, retraction && !use_firmware_retraction, i);

    const wipe = retraction && c.bool('wipe', variant_index);

    // Orca:
    const retract_before_wipe = c.num('retract_before_wipe', variant_index);
    const retract_after_wipe = c.num('retract_after_wipe', variant_index);

    t.field('retract_before_wipe', wipe && !isApprox(retract_after_wipe, 100), i);
    t.field('retract_after_wipe', wipe && !isApprox(retract_before_wipe, 100), i);

    if (use_firmware_retraction && wipe && retract_before_wipe < 100.0 && !firmwareRetractionAsked) {
      firmwareRetractionAsked = true;
      issues.push({
        id: 'firmware-retraction-wipe', scope: MACHINE, key: 'use_firmware_retraction', keys: ['use_firmware_retraction', 'wipe', 'retract_before_wipe'],
        severity: 'warning',
        message: 'The Retract before wipe option could be only 100% when using the Firmware Retraction mode. Set it to 100% in order to enable Firmware Retraction?',
        fix: { wipe: '0', retract_before_wipe: '100%' }, fixLabel: 'Turn off wipe and retract 100% before wipe',
        alternative: { label: 'Turn off firmware retraction', values: { use_firmware_retraction: '0' } },
      });
    }
    // BBS
    t.field('wipe_distance', wipe, i);

    t.field('retract_length_toolchange', have_multiple_extruders, i);

    const toolchange_retraction = c.num('retract_length_toolchange', variant_index) > 0;
    t.field('retract_restart_extra_toolchange', have_multiple_extruders && toolchange_retraction, i);

    t.field('long_retractions_when_cut', !use_firmware_retraction && c.num('enable_long_retraction_when_cut') !== 0, i);
    t.line('retraction_distances_when_cut', c.bool('long_retractions_when_cut', variant_index), i);

    t.field('travel_slope', !c.is('z_hop_types', 'Normal Lift', i), i);
  }

  // Motion ability. The page exists only for the Marlin-like flavors (build_unregular_pages), and
  // Orca toggles its options only then. update_input_shaper_menu runs first; it also runs on every
  // gcode_flavor change (on_gcode_flavor_changed), whatever the flavor, so it is outside the if.
  updateInputShaperMenu(x, t, issues);
  if (isMarlinFlavor(c)) {

    // Orca: use booleans to avoid repeated comparisons with enum values
    const gcf_is_marlin_legacy = c.is('gcode_flavor', 'marlin');
    const gcf_is_marlin_firmware = c.is('gcode_flavor', 'marlin2');
    const gcf_is_klipper = c.is('gcode_flavor', 'klipper');
    const gcf_is_reprap_firmware = c.is('gcode_flavor', 'reprapfirmware');

    const silent_mode = c.bool('silent_mode');
    const max_field = silent_mode ? 2 : 1;
    for (let i = 0; i < max_field; ++i)
      t.field('machine_max_acceleration_travel', !gcf_is_marlin_legacy && !gcf_is_klipper, i);
    t.line('machine_max_acceleration_travel', !gcf_is_marlin_legacy && !gcf_is_klipper);
    for (let i = 0; i < max_field; ++i)
      t.field('machine_max_junction_deviation', gcf_is_marlin_firmware, i);
    t.line('machine_max_junction_deviation', gcf_is_marlin_firmware);

    // Check if junction deviation value is non-zero and firmware is Marlin
    let enable_jerk = !gcf_is_marlin_firmware;
    if (gcf_is_marlin_firmware)
      enable_jerk = c.slots('machine_max_junction_deviation').every((val) => Number.parseFloat(val) === 0);
    for (let i = 0; i < max_field; ++i) {
      t.field('machine_max_jerk_x', enable_jerk, i);
      t.field('machine_max_jerk_y', enable_jerk, i);
      t.field('machine_max_jerk_z', enable_jerk, i);
      t.field('machine_max_jerk_e', enable_jerk, i);
    }

    const emittable_limits = gcf_is_marlin_legacy || gcf_is_marlin_firmware || gcf_is_reprap_firmware;
    t.field('emit_machine_limits_to_gcode', emittable_limits);

    const resonance_avoidance = c.bool('resonance_avoidance');
    t.field('min_resonance_avoidance_speed', resonance_avoidance);
    t.field('max_resonance_avoidance_speed', resonance_avoidance);

    const input_shaping_compatible = gcf_is_marlin_firmware || gcf_is_reprap_firmware;

    for (const is of ['input_shaping_emit', 'input_shaping_type', 'input_shaping_freq_x', 'input_shaping_freq_y',
      'input_shaping_damp_x', 'input_shaping_damp_y'])
      t.line(is, input_shaping_compatible);

    if (input_shaping_compatible) {
      const emit_machine_limits_to_gcode = c.bool('emit_machine_limits_to_gcode');
      t.field('input_shaping_emit', emit_machine_limits_to_gcode);
      const input_shaping_emit = emit_machine_limits_to_gcode && c.bool('input_shaping_emit');
      t.field('input_shaping_type', input_shaping_emit);
      t.field('input_shaping_freq_x', input_shaping_emit);
      t.field('input_shaping_freq_y', input_shaping_emit && !gcf_is_reprap_firmware);
      t.field('input_shaping_damp_x', input_shaping_emit);
      t.field('input_shaping_damp_y', input_shaping_emit && !gcf_is_reprap_firmware);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** All three tabs' display state and every current issue, for the effective configuration in `env`. */
export function evaluateRules(env: RulesEnv): RulesResult {
  const x = context(env);
  const issues: RuleIssue[] = [];

  // TabPrint::update: update_print_fff_config, then toggle_options
  updatePrintFffConfig(x, issues);
  const process = new Toggles();
  tabPrintToggleOptions(x, process);
  printFffRewrites(x, issues);

  // TabFilament::update: check_filament_max_volumetric_speed, then toggle_options
  const filament = new Toggles();
  tabFilamentToggleOptions(x, filament, issues);
  const filamentRules = filament.result();
  filamentChecks(x, filamentRules, issues);

  // TabPrinter::update_fff: toggle_options
  const machine = new Toggles();
  tabPrinterToggleOptions(x, machine, issues);

  return {
    process: process.result(),
    filament: filamentRules,
    machine: machine.result(),
    when: { marlinLikeFlavor: isMarlinFlavor(x.c) },
    issues,
  };
}

// ---------------------------------------------------------------------------------------------
// Edits: the on_value_change handlers and the silent rewrites an edit starts
// ---------------------------------------------------------------------------------------------

/** `view` with the values of `patch` in place of its own. */
function withValues(view: ConfigView, patch: Readonly<Record<string, string>>): ConfigView {
  return { get: (k) => (Object.hasOwn(patch, k) ? patch[k] : view.get(k)) };
}

const keep = (label: string): RuleFix => ({ label, values: {} });

/** The wipe percentages TabFilament/TabPrinter::on_value_change keep in range, per scope. */
const WIPE_PERCENT_KEYS = {
  filament: readKeys(['filament_retract_before_wipe', 'filament_retract_after_wipe']),
  machine: readKeys(['retract_before_wipe', 'retract_after_wipe']),
} as const;

/** GUI_App.cpp is_support_filament / is_soluble_filament / has_filaments for the project's filaments. */
const FILAMENT_FLAGS = readKeys(['filament_is_support', 'filament_soluble']);

/**
 * What Orca does when the user sets `key` (in `scope`) to `value`, in Orca's text form for the
 * whole option (`index` = the slot that changed, for a per-extruder value). `env` describes the
 * configuration before the edit.
 *
 * Apply `patch` together with the edit (one undo step): the values Orca writes itself, from its
 * on_value_change handlers and from the silent rewrites the edit starts (issues whose `triggers`
 * name `key`). Show `prompts`, Orca's questions about the edit; a choice's values are applied on
 * top. Never call this for values that change without the user (a preset load, a reset).
 */
export function editEffects(scope: RuleScope, key: string, value: string, env: RulesEnv, index = 0): EditEffects {
  const before = context(env);
  const x = context({ ...env, config: withValues(env.config, { [key]: value }) });
  const patch: Record<string, string> = {};
  const prompts: RulePrompt[] = [];
  const prompt = (id: string, message: string, choices: RuleFix[]) => prompts.push({ id, scope, key, message, choices });
  const { c } = x;

  // TabFilament::on_value_change / TabPrinter::on_value_change: keep the wipe retraction percentages
  // in 0..100 with after <= 100 - before.
  if (scope === 'filament' || scope === 'machine') {
    const [before_key, after_key] = WIPE_PERCENT_KEYS[scope];
    if (key === before_key || key === after_key) {
      const percent_value_clamp = (percent_value: number) => Math.min(100, Math.max(0, percent_value));
      const dvalue = c.num(key, index);
      const get_value_by_opt_key = (opt_key: string): number => {
        // Return the incoming value (if it is valid) if the opt_key equals the key of the changed option.
        if (opt_key === key && !Number.isNaN(dvalue)) return percent_value_clamp(dvalue);
        // Return the overridden value if the option value for the opt_key was overridden for the given filament.
        if (!c.isNil(opt_key, index)) return percent_value_clamp(c.num(opt_key, index));
        // Return the value of the option value for opt_key from the printer setting if it was not overridden for the filament.
        return percent_value_clamp(c.num(opt_key.replace(/^filament_/, ''), index));
      };
      const retract_before_wipe = get_value_by_opt_key(before_key);
      const retract_after_wipe = get_value_by_opt_key(after_key);
      // A NaN value is a nil slot (an unchecked filament override). Orca writes the clamped NaN
      // back, which leaves the slot nil; the port writes nothing, as 'NaN%' is not a value.
      if (!Number.isNaN(dvalue) && percent_value_clamp(dvalue) !== dvalue)
        patch[key] = c.withSlot(key, index, `${orcaNumber(percent_value_clamp(dvalue))}%`);
      if (retract_after_wipe > 100 - retract_before_wipe)
        patch[after_key] = c.withSlot(after_key, index, `${orcaNumber(100 - retract_before_wipe)}%`);
    }
  }

  // Tab::on_value_change, in Orca's order.
  // (gcode_flavor: on_gcode_flavor_changed resets input_shaping_type, the "input-shaper-type"
  // issue, applied below with the other silent rewrites.)

  // The two conversions divide by the edited value. Orca's fields only pass a number (0 allowed),
  // so a 0 there writes inf; the port writes nothing unless the result is a finite number.
  const finite = (n: number) => (Number.isFinite(n) ? orcaNumber(n) : undefined);

  if (key === 'pellet_flow_coefficient') {
    // Preset::convert_pellet_flow_to_filament_diameter
    const filament_diameter = finite(Math.sqrt(4 / (Math.PI * c.num('pellet_flow_coefficient'))));
    if (filament_diameter !== undefined) patch.filament_diameter = filament_diameter;
  }

  if (key === 'filament_diameter') {
    // Preset::convert_filament_diameter_to_pellet_flow
    const pellet_flow_coefficient = finite(4 / (c.num('filament_diameter') ** 2 * Math.PI));
    if (pellet_flow_coefficient !== undefined) patch.pellet_flow_coefficient = pellet_flow_coefficient;
  }

  if (key === 'enable_prime_tower') {
    const timelapse_enabled = c.is('timelapse_type', v('timelapse_type', '1'));
    const enabled = c.bool('enable_prime_tower');
    if (!enabled) {
      // Disabling the prime tower on a multi-nozzle printer degrades quality because nozzle changes rely
      // on it. Gate on any extruder having extruder_max_nozzle_count > 1 so single-nozzle and dual-extruder
      // (H2D, {1,1}) printers keep their exact existing behavior.
      const has_multiple_nozzle = c.slots('extruder_max_nozzle_count').some((n) => n !== 'nil' && Number.parseFloat(n) > 1);
      if (has_multiple_nozzle) {
        prompt('prime-tower-nozzle-change',
          'Prime tower is required for nozzle changing. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
          [keep('Disable'), { label: 'Keep the prime tower', values: { enable_prime_tower: '1' } }]);
      }
    }
    if (!enabled && timelapse_enabled) {
      prompt('prime-tower-smooth-timelapse',
        'A prime tower is required for smooth timelapse mode. There may be flaws on the model without a prime tower. Are you sure you want to disable the prime tower?',
        [keep('Disable'), { label: 'Keep the prime tower', values: { enable_prime_tower: '1' } }]);
      // (Orca asks this one only when the answer above kept the edit.)
      if (c.bool('enable_wrapping_detection')) {
        prompt('prime-tower-wrapping-detection',
          'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
          [keep('Disable'), { label: 'Keep the prime tower', values: { enable_prime_tower: '1' } }]);
      }
    }
    if (enabled && c.bool('precise_z_height')) {
      prompt('prime-tower-precise-z',
        'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable?',
        [keep('Enable'), { label: 'Cancel', values: { enable_prime_tower: '0' } }]);
    }
  }

  if (key === 'enable_wrapping_detection') {
    const wipe_tower_enabled = c.bool('enable_prime_tower');
    if (c.bool('enable_wrapping_detection') && !wipe_tower_enabled) {
      prompt('wrapping-detection-prime-tower',
        'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Do you still want to enable clumping detection?',
        [keep('Enable'), { label: 'Cancel', values: { enable_wrapping_detection: '0' } }]);
    }
  }

  if (key === 'precise_z_height') {
    const wipe_tower_enabled = c.bool('enable_prime_tower');
    if (c.bool('precise_z_height') && wipe_tower_enabled) {
      prompt('precise-z-prime-tower',
        'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable precise Z height?',
        [keep('Enable'), { label: 'Cancel', values: { precise_z_height: '0' } }]);
    }
  }

  if (key === 'timelapse_type') {
    // Smooth timelapse parks the nozzle on the prime tower every layer, so it needs a tower on
    // every layer. That is exactly what "No sparse layers" removes, and with both on the tower is
    // planned full height and then dropped on emission. Drop "No sparse layers" and tell the user.
    const smooth = c.is('timelapse_type', v('timelapse_type', '1'));
    if (smooth && c.bool('wipe_tower_no_sparse_layers')) {
      patch.wipe_tower_no_sparse_layers = '0';
      prompt('smooth-timelapse-sparse-layers',
        'Smooth timelapse needs a prime tower on every layer, which is not compatible with "No sparse layers". "No sparse layers" has been turned off.',
        [keep('OK')]);
    }
    const wipe_tower_enabled = c.bool('enable_prime_tower');
    if (!wipe_tower_enabled && smooth) {
      prompt('smooth-timelapse-prime-tower',
        'A prime tower is required for smooth timelapse mode. There may be flaws on the model without prime tower. Do you want to enable the prime tower?',
        [{ label: 'Enable the prime tower', values: { enable_prime_tower: '1' } }, keep('No')]);
    }
  }

  // Mirror of the timelapse_type branch above: enabling "No sparse layers" while smooth timelapse
  // is active would leave the tower on every layer anyway, so fall back to traditional timelapse.
  if (key === 'wipe_tower_no_sparse_layers' && c.bool('wipe_tower_no_sparse_layers')) {
    if (c.is('timelapse_type', v('timelapse_type', '1'))) {
      patch.timelapse_type = v('timelapse_type', '0');
      prompt('sparse-layers-smooth-timelapse',
        '"No sparse layers" is not compatible with smooth timelapse, which needs a prime tower on every layer. Timelapse has been switched to traditional mode.',
        [keep('OK')]);
    }
  }

  if (key === 'print_sequence' && c.is('print_sequence', 'by object')) {
    if (c.is('printer_structure', 'i3')) {
      prompt('by-object-i3',
        'The current printer does not support timelapse in Traditional Mode when printing By-Object. Still print by object?',
        [keep('Yes'), { label: 'No', values: { print_sequence: v('print_sequence', 'by layer') } }]);
    }
  }

  // BBS set support style to default when support type changes
  // Orca: do this only in simple mode
  if (key === 'support_type' && x.mode === 'simple') patch.support_style = v('support_style', 'default');

  // is_support_filament / is_soluble_filament / has_filaments for the project's filaments (the web
  // slicer has one, which every object uses; filament i reads slot i of the filament keys).
  // has_filaments: whether an object uses a filament of one of these types (none without objects).
  const [filament_is_support, filament_soluble] = FILAMENT_FLAGS;
  const has_filaments = (types: readonly string[]) => x.hasObjects && types.includes(c.text('filament_type', 0));
  const is_soluble_filament = (id: number) => id >= 0 && id < x.filamentCount && c.bool(filament_soluble, id);
  const is_support_filament = (id: number) => {
    if (id < 0 || id >= x.filamentCount) return false;
    const filament_type = c.text('filament_type', id);
    if (filament_type === 'PETG' && has_filaments(['PLA'])) return true;
    if (filament_type === 'PLA' && has_filaments(['PETG', 'TPU', 'TPU-AMS'])) return true;
    return c.bool(filament_is_support, id);
  };

  if (key === 'support_filament') {
    const filament_id = c.num('support_filament') - 1; // the displayed id is based from 1, while internal id is based from 0
    if (is_support_filament(filament_id) && !is_soluble_filament(filament_id) && !has_filaments(['TPU', 'TPU-AMS'])) {
      prompt('support-filament-not-soluble',
        'Non-soluble support materials are not recommended for support base. Are you sure to use them for support base?',
        [keep('Yes'), { label: 'No', values: { support_filament: '0' } }]);
    }
  }

  // BBS popup a message to ask the user to set optimum parameters for support interface if support materials are used
  if (key === 'support_interface_filament') {
    const filament_id = c.num('support_filament') - 1;
    const interface_filament_id = c.num('support_interface_filament') - 1; // the displayed id is based from 1, while internal id is based from 0
    if ((is_support_filament(interface_filament_id) &&
      !(c.num('support_top_z_distance') === 0 && c.num('support_interface_spacing') === 0 &&
        c.is('support_interface_pattern', 'rectilinear_interlaced'))) ||
      (is_soluble_filament(interface_filament_id) && !is_soluble_filament(filament_id))) {
      const values: Record<string, string> = {
        support_top_z_distance: '0',
        support_interface_spacing: '0',
        support_interface_pattern: v('support_interface_pattern', 'rectilinear_interlaced'),
        independent_support_layer_height: '0',
      };
      const filament_type = c.text('filament_type', Math.max(0, interface_filament_id));
      if ((filament_type === 'PLA' && has_filaments(['TPU', 'TPU-AMS'])) || (is_soluble_filament(interface_filament_id) && !is_soluble_filament(filament_id)))
        values.support_filament = String(interface_filament_id + 1);
      prompt('support-interface-filament',
        !is_soluble_filament(interface_filament_id)
          ? 'When using support material for the support interface, we recommend the following settings: 0 top Z distance, 0 interface spacing, interlaced rectilinear pattern and disable independent support layer height.'
          : 'When using soluble material for the support interface, we recommend the following settings: 0 top Z distance, 0 interface spacing, interlaced rectilinear pattern, disable independent support layer height and use soluble materials for both support interface and support base.',
        [{ label: 'Change these settings', values }, keep('Do not change them')]);
    }
  }

  if (key === 'make_overhang_printable' && c.bool('make_overhang_printable')) {
    prompt('make-overhang-printable',
      "Enabling this option will modify the model's shape. If your print requires precise dimensions or is part of an assembly, it's important to double-check whether this change in geometry impacts the functionality of your print. Are you sure you want to enable this option?",
      [keep('Enable'), { label: 'Cancel', values: { make_overhang_printable: '0' } }]);
  }

  if (key === 'sparse_infill_rotate_template') {
    // Orca: show warning dialog if rotate template for solid infill if not support
    let is_safe_to_rotate = c.is('sparse_infill_pattern', 'rectilinear') || c.is('sparse_infill_pattern', 'line') ||
      c.is('sparse_infill_pattern', 'zigzag') || c.is('sparse_infill_pattern', 'crosszag') ||
      c.is('sparse_infill_pattern', 'lockedzag');
    is_safe_to_rotate ||= value.trim() === '';
    const had_previous_value = before.c.text('sparse_infill_rotate_template') !== '';
    if (!is_safe_to_rotate && !had_previous_value) {
      prompt('sparse-infill-rotate-template',
        'Infill patterns are typically designed to handle rotation automatically to ensure proper printing and achieve their intended effects (e.g., Gyroid, Cubic). Rotating the current sparse infill pattern may lead to insufficient support. Please proceed with caution and thoroughly check for any potential printing issues. Are you sure you want to enable this option?',
        [keep('Enable'), { label: 'Cancel', values: { sparse_infill_rotate_template: '' } }]);
    }
  }

  // (layer_height: check_layer_height is the "layer-height-limits" issue, reported once the user
  // has set layer_height: see RulesEnv.edited.)

  if (key === 'long_retractions_when_cut' && c.bool('long_retractions_when_cut', index)) {
    prompt('long-retractions-when-cut',
      'Experimental feature: Retracting and cutting off the filament at a greater distance during filament changes to minimize flush. Although it can notably reduce flush, it may also elevate the risk of nozzle clogs or other printing complications.',
      [keep('OK')]);
  }

  if (key === 'filament_long_retractions_when_cut' && !c.isNil('filament_long_retractions_when_cut', index) &&
    c.bool('filament_long_retractions_when_cut', index)) {
    prompt('filament-long-retractions-when-cut',
      'Experimental feature: Retracting and cutting off the filament at a greater distance during filament changes to minimize flush. Although it can notably reduce flush, it may also elevate the risk of nozzle clogs or other printing complications. Please use with the latest printer firmware.',
      [keep('OK')]);
  }

  //Orca: disable purge_in_prime_tower if single_extruder_multi_material is disabled
  if (key === 'single_extruder_multi_material' && !c.bool('single_extruder_multi_material')) patch.purge_in_prime_tower = '0';

  // Orca: allow different layer height for non-bbl printers
  // (A Bambu Lab printer with several nozzles keeps one min/max layer height for all of them.)
  if (x.extruderCount > 1 && x.isBbl && (key === 'min_layer_height' || key === 'max_layer_height'))
    patch[key] = c.slots(key).map(() => c.text(key, index)).join(',');

  // A printer with parallel printheads takes its bed exclusion from the list, one entry per head count.
  if ((key === 'parallel_printheads_count' || key === 'parallel_printheads_bed_exclude_areas') && c.bool('support_parallel_printheads')) {
    const count = c.num('parallel_printheads_count');
    const areas = c.slots('parallel_printheads_bed_exclude_areas');
    patch.bed_exclude_area = count > 0 ? (areas[count - 1] ?? '') : '';
  }

  // update_print_fff_config: Check "enable_support" and "overhangs" relations only on global
  // settings level. Ask only once (while support stays on).
  // BBS: detect_overhang_wall is setting in develop mode. Enable it directly.
  if (key === 'enable_support' && x.isGlobal && c.bool('enable_support') && !before.c.bool('enable_support') && !c.bool('detect_overhang_wall'))
    patch.detect_overhang_wall = '1';

  // Orca's update() after the change makes its silent rewrites (update_print_fff_config,
  // toggle_options, update_input_shaper_menu): apply those this edit starts, until none is left.
  for (let pass = 0; pass < 4; pass++) {
    const edited = withValues(env.config, { [key]: value, ...patch });
    let changed = false;
    for (const issue of evaluateRules({ ...env, config: edited }).issues) {
      if (issue.scope !== scope || !issue.fix || !issue.triggers?.includes(key)) continue;
      for (const [k, fixed] of Object.entries(issue.fix)) {
        if ((k === key ? patch[k] ?? value : patch[k]) === fixed) continue;
        patch[k] = fixed;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { patch, prompts };
}

// ---------------------------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------------------------

/**
 * A ConfigView over layers of values, the first layer that has a key wins: e.g. an object's
 * settings, the plate's settings, the global overrides of each preset, then the three presets.
 */
export function layeredConfig(...layers: readonly (Readonly<Record<string, ConfigValue>> | null | undefined)[]): ConfigView {
  return {
    get(key) {
      for (const layer of layers) if (layer && Object.hasOwn(layer, key)) return layer[key];
      return undefined;
    },
  };
}

/** The display state of one preset's tab. */
export function tabRules(result: RulesResult, scope: RuleScope): TabRules {
  return result[scope];
}

/** The issues shown on the row of `key` (in `scope`), most severe first. */
export function issuesFor(result: RulesResult, scope: RuleScope, key: string): RuleIssue[] {
  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return result.issues.filter((i) => i.scope === scope && i.key === key).sort((a, b) => rank[a.severity] - rank[b.severity]);
}
