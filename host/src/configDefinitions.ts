// What the engine's configDefinitions() returns (engine/bridge/config_def.cpp): OrcaSlicer's option
// table (print_config_def, SLA options left out) and the key sets libslic3r defines, taken from
// the very build that slices, for the settings catalogue generator. Values are Orca's text
// encoding, as in presets: a scalar's default is serialize(), a vector's the array of
// vserialize(). Everything is sorted (options by key, every key list alphabetically), so the same
// engine always gives the same text.
import type { OrcaEngineModule } from './worker.ts';

/** ConfigDefinitions.format of the shape below. */
export const CONFIG_DEFINITIONS_FORMAT = 1;

/** Orca's ConfigOptionType. */
export type OrcaOptionType =
  | 'float' | 'floats' | 'int' | 'ints' | 'string' | 'strings' | 'percent' | 'percents'
  | 'floatOrPercent' | 'floatsOrPercents' | 'point' | 'points' | 'point3' | 'bool' | 'bools'
  | 'enum' | 'enums' | 'pointsGroups' | 'intsGroups' | 'none';

/** Orca's ConfigOptionMode: the GUI shows an option at this mode and above; 'develop' needs developer mode. */
export type OrcaOptionMode = 'simple' | 'advanced' | 'expert' | 'develop';

/** ConfigOptionDef::GUIType; '' when undefined (the control follows from the type). */
export type OrcaGuiType =
  | '' | 'i_enum_open' | 'f_enum_open' | 'color' | 'select_open' | 'slider' | 'legend' | 'one_string'
  | 'plugin_picker' | 'plugin_config' | 'printer_agent_select';

/** One ConfigOptionDef. Strings Orca leaves empty are ''; absent fields are noted. */
export interface OrcaOptionDefinition {
  type: OrcaOptionType;
  /** 'any' for the common options (init_common_params), 'fff' for the FFF ones. */
  technology: 'any' | 'fff';
  /** Present (true) only for nullable options, whose values may be "nil" (inherit). */
  nullable?: true;
  /** Short label (in a group of several); '' for some develop and metadata options. */
  label: string;
  /** Stand-alone label (object settings list, search); '' when the same as `label`. */
  fullLabel: string;
  tooltip: string;
  /** Unit or text right of the field, e.g. "mm", "mm/s or %". */
  sidetext: string;
  /** GUI category, e.g. "Quality", "Strength", "Support" (Orca's per-object "Add settings" menu). */
  category: string;
  mode: OrcaOptionMode;
  /** Absent when Orca sets no limit (±FLT_MAX); the shortest decimal of Orca's float. */
  min?: number;
  max?: number;
  /** floatOrPercent: values above it without '%' are probably a missing '%' (Field.cpp); default 1. */
  maxLiteral: number;
  /** floatOrPercent: the option a percentage is taken of; '' if none. */
  ratioOver: string;
  /** Combo box values (enums; open enums of ints/floats too) and their labels (may be [], then show the values). */
  enumValues: string[];
  enumLabels: string[];
  /** Enums only: every name deserialize() accepts, with its C++ value (can hold names the combo box does not list). */
  enumKeys?: Record<string, number>;
  guiType: OrcaGuiType;
  /** "serialized" (a vector edited as one string) and/or "show_value"; '' usually. */
  guiFlags: string;
  /** Plugin-backed options only: the plugin capability type. */
  pluginType?: string;
  multiline: boolean;
  fullWidth: boolean;
  isCode: boolean;
  readonly: boolean;
  /** Text box height / field width in GUI units, only where Orca sets one. */
  height?: number;
  width?: number;
  /** Legacy names Orca still reads for this option. */
  aliases: string[];
  /** Options this one sets in one go (e.g. a "solid_layers" style shortcut). */
  shortcut: string[];
  /** Whether Orca's command line accepts it as --<key>. */
  cli: boolean;
  /**
   * Orca's default in its JSON encoding; absent when the option has none. Enums are by name (one of
   * enumKeys; "nil" in a nullable vector). Groups are arrays of '#'-joined text too.
   */
  default?: string | string[];
}

export interface ConfigDefinitions {
  format: number;
  /** SoftFever_VERSION and the Orca commit the engine was built from (as version()). */
  orcaVersion: string;
  orcaCommit: string;
  /** Every FFF and common option, by key. */
  options: Record<string, OrcaOptionDefinition>;
  /**
   * Which preset stores each key (Preset.cpp): process = print_options(), filament =
   * filament_options(), machine = printer_options() (its own keys, the machine limits and the
   * per-nozzle keys), machineLimits = machine_limits_options(). A few keys are in two scopes
   * (compatible_printers*, inherits).
   */
  presetKeys: { process: string[]; filament: string[]; machine: string[]; machineLimits: string[] };
  /** Vectors with one value per nozzle (PrintConfigDef::extruder_option_keys). */
  extruderKeys: string[];
  /** The extruder retraction keys (PrintConfigDef::extruder_retract_keys). */
  extruderRetractKeys: string[];
  /** Filament keys overriding the printer's retraction per filament (filament_extruder_override_keys; nullable). */
  filamentOverrideKeys: string[];
  /** Vectors with one value per extruder variant (print_options_with_variant and the others, PrintConfig.cpp). */
  variantKeys: { print: string[]; filament: string[]; printer1: string[]; printer2: string[] };
  /** Keys an object can override (PrintObjectConfig) and a part or modifier can (PrintRegionConfig). */
  objectKeys: string[];
  regionKeys: string[];
}

/**
 * Calls the engine's configDefinitions() and parses it. Throws when the engine predates the export
 * ("rebuild the engine"), when it reports an error, or when the format is not this module's.
 */
export function readConfigDefinitions(engine: Pick<OrcaEngineModule, 'configDefinitions'>): ConfigDefinitions {
  if (typeof engine.configDefinitions !== 'function') {
    throw new Error('This engine build has no configDefinitions(): rebuild the engine (engine/scripts/build.sh).');
  }
  const parsed = JSON.parse(engine.configDefinitions()) as Partial<ConfigDefinitions> & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.format !== CONFIG_DEFINITIONS_FORMAT || typeof parsed.options !== 'object' || parsed.options === null) {
    throw new Error(`The engine's option definitions have format ${String(parsed.format)}; this code reads format ${CONFIG_DEFINITIONS_FORMAT}.`);
  }
  return parsed as ConfigDefinitions;
}
