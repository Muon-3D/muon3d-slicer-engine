// SPDX-License-Identifier: Apache-2.0
// The result of `settings.catalogue` (format 2): every option of the engine's OrcaSlicer (labels, tooltips,
// units, limits, enum values and labels, defaults, modes), laid out in the pages, groups and rows of Orca's
// settings tabs. Values use Orca's text encoding throughout: what a preset JSON holds (a string, or an
// array of strings for a vector option). It describes Orca only; what one app lets its users edit is that
// app's own policy, applied on top.
//
// Format 2 is format 1 without the fields that were one app's policy (readOnly, note) or compared against
// one app's older CLI (server, engineOnly, engineOnlyValues).

/** Orca's ConfigOptionType, without the `co` prefix. */
export type OrcaOptionType =
  | 'float' | 'floats' | 'int' | 'ints' | 'string' | 'strings' | 'percent' | 'percents'
  | 'floatOrPercent' | 'floatsOrPercents' | 'point' | 'points' | 'point3' | 'bool' | 'bools'
  | 'enum' | 'enums' | 'pointsGroups' | 'intsGroups';

/** Orca's modes: a line shows at its first option's mode and above; develop needs developer mode. */
export type SettingMode = 'simple' | 'advanced' | 'expert' | 'develop';

/** The preset a setting is stored in (the app's PresetType). */
export type SettingScope = 'process' | 'filament' | 'machine';

/** What the entries of a vector option stand for. */
export type SlotKind =
  /** one per nozzle (extruder_option_keys) */
  | 'extruder'
  /** one per extruder variant (print/filament/printer options_with_variant) */
  | 'variant'
  /** [normal, silent] machine limits */
  | 'machineLimits'
  /** one per filament */
  | 'filament'
  /** a list value (a polygon, a list of names, …) */
  | 'list';

/** One Orca option (ConfigOptionDef), trimmed: absent fields are Orca's empty/false/default. */
export interface SettingDef {
  type: OrcaOptionType;
  /** The presets that store it (Preset.cpp); absent for plate, project and state options. */
  scopes?: SettingScope[];
  /** Orca's label, else its full label, else the key. */
  label: string;
  /** The stand-alone label (search, per-object lists), when it differs from `label`. */
  fullLabel?: string;
  tooltip?: string;
  /** Orca's sidetext: the unit, e.g. "mm/s" or "mm or %". */
  unit?: string;
  /** Orca's category (its per-object "Add settings" menu groups by it). */
  category?: string;
  mode: SettingMode;
  /** Orca's default in its JSON encoding: a string, or an array for a vector ("nil" = unset slot). */
  default?: string | string[];
  min?: number;
  max?: number;
  /** floatOrPercent: an absolute value above this is probably a forgotten "%" (Orca warns). */
  maxLiteral?: number;
  /** floatOrPercent: the option a percentage is taken of. */
  ratioOver?: string;
  /** The values the drop-down lists (enum keys; suggestions for open enums). */
  enumValues?: string[];
  /** Their labels, index for index, when any differs from the value. */
  enumLabels?: string[];
  /** Typed values beyond `enumValues` are allowed (Orca's i_enum_open, f_enum_open, select_open). */
  openEnum?: true;
  /** A special control: colour picker, one-line text for a list, slider, plugin pickers. */
  gui?: 'color' | 'one_string' | 'slider' | 'legend' | 'plugin_picker' | 'plugin_config';
  /** A strings option Orca edits as one ";"-separated text (gui_flags "serialized"). */
  serialized?: true;
  multiline?: true;
  /** Monospace G-code or code-like text. */
  code?: true;
  fullWidth?: true;
  /** Text box height in Orca's GUI units (lines, roughly). */
  height?: number;
  /** Orca itself shows it read-only. */
  orcaReadOnly?: true;
  /** Vector slots may be "nil": unset, the value comes from elsewhere (filament overrides). */
  nullable?: true;
  /** Vector options: what the slots are. */
  slots?: SlotKind;
  /** An object may override it (object: PrintObjectConfig) or a part too (region: PrintRegionConfig). */
  perObject?: 'object' | 'region';
  /** Old names Orca still reads for it. */
  aliases?: string[];
  /** Not an Orca option: a control Tab.cpp builds itself (extruders_count). */
  synthetic?: true;
}

/** One option in a settings row. */
export interface LayoutOption {
  key: string;
  /**
   * The vector slot the row edits: a number, or 'extruder' = the slot of the page's extruder (on
   * a page with `repeat: 'extruder'`). Absent: the option as a whole (slot 0 of a vector).
   */
  index?: number | 'extruder';
  /** Orca labels it differently in this row (e.g. "Target" and "Minimal"). */
  label?: string;
  tooltip?: string;
  fullWidth?: true;
  code?: true;
  multiline?: true;
  height?: number;
}

/** One row of a settings group. */
export interface LayoutLine {
  /** The row label of a line of several options (a single option uses its own label). */
  label?: string;
  tooltip?: string;
  options: LayoutOption[];
  /** Orca shows a custom control here (bed shape dialog, ramming dialog, compatible presets list). */
  widget?: 'bedShape' | 'excludeArea' | 'ramming' | 'compatible' | 'custom';
  /**
   * A filament "Setting Overrides" row: the option is nullable, and an unset (nil) slot uses the
   * value of `key` in the `scope` preset (the printer's retraction, the process's ironing).
   */
  overrideOf?: { scope: 'machine' | 'process'; key: string };
  /** A machine limit: slot 0 is the normal mode, slot 1 the silent mode (when silent_mode is on). */
  modeColumns?: true;
}

export interface LayoutGroup {
  /** Unique in its tab, stable across regenerations while the titles stay. */
  id: string;
  title: string;
  lines: LayoutLine[];
}

export interface LayoutPage {
  /** Unique in its tab. */
  id: string;
  title: string;
  groups: LayoutGroup[];
  /** Built once per nozzle ("Extruder", or "Extruder 1", "Extruder 2", … with several). */
  repeat?: 'extruder';
  /** Orca shows the page only when the option `key` has one of these values. */
  when?: { key: string; oneOf: string[] };
  /**
   * Generated, not in Orca's tabs: the scope's options that no Orca tab shows. Show it in Expert
   * mode, whatever its options' own modes.
   */
  other?: true;
}

export interface LayoutTab {
  id: SettingScope;
  title: string;
  pages: LayoutPage[];
}

export interface SettingsCatalogue {
  format: 2;
  /** The Orca build the definitions and layout come from (the engine's). */
  orca: { version: string; commit: string };
  /**
   * Fingerprints of the Orca functions the catalogue was read from ("<file>#<function>" ->
   * "sha256:<hex>", the format of tools/settings-catalogue/rulesSource.ts cppFunctionHash).
   */
  sources: Record<string, string>;
  /** The same fingerprints of the functions the settings rules port (host/src/settings/rules.ts). */
  ruleSources: Record<string, string>;
  /** Every FFF and common option (plus the synthetic ones), by key. */
  options: Record<string, SettingDef>;
  /** Process, filament and printer tabs, in Orca's page order. */
  tabs: LayoutTab[];
  /** Orca's plate settings dialog (TabPrintPlate): rows of process and plate options. */
  plate: LayoutLine[];
  /** Options Tab.cpp places that the catalogue leaves out, with the reason. */
  excluded: Record<string, string>;
}
