// SPDX-License-Identifier: Apache-2.0
// The profile operations of protocol 2.1 (profiles.normalize, profiles.resolve, profiles.validate): OrcaSlicer's
// vendor profiles handled by OrcaSlicer's own code in the engine. docs/PROTOCOL.md ("Profiles") describes them.
import type { Config, PresetScope } from './data.ts';

/**
 * One vendor's profile folder, as OrcaSlicer's resources/profiles holds it: the index `<id>.json` and every
 * file its lists name.
 */
export interface ProfileFolder {
  /** The folder's name, which is also the vendor's id: "Muon3D", "BBL", "OrcaFilamentLibrary". */
  id: string;
  /**
   * `<id>.json`: `name`, `version` and the lists `machine_model_list`, `machine_list`, `process_list` and
   * `filament_list`, each of `{ name, sub_path }`. Presets load in list order: a parent comes before its children.
   */
  index: Record<string, unknown>;
  /** Each `sub_path` of the lists ('/'-separated, relative) -> the file's JSON. */
  files: Record<string, Record<string, unknown>>;
}

/** A preset file of one type, as a vendor folder holds it. */
export interface PresetFile {
  type: PresetScope;
  config: Config;
}

// ---------------------------------------------------------------------------------------------
// profiles.normalize
// ---------------------------------------------------------------------------------------------

export interface ProfilesNormalizeParams {
  presets: PresetFile[];
}

/** One file as OrcaSlicer reads it, and what reading it changed. */
export interface NormalizedPreset {
  /**
   * The file's metadata (`name`, `inherits`, `from`, `instantiation`, `setting_id`, `filament_id`, `renamed_from`,
   * `description`, `type`, `version`) as given, then every setting it holds as Orca stores it: legacy keys under
   * their current names, values in Orca's own text (a vector option as a list), settings of another preset type
   * removed.
   */
  config: Config;
  /** Legacy keys Orca reads under another name: [the file's key, the key it becomes]. */
  renamed: Array<[string, string]>;
  /** Keys Orca ignores: unknown or retired settings, and values it cannot read (not a string or a list of strings). */
  dropped: string[];
  /** Settings of another preset type, which Orca removes from a vendor preset. */
  misplaced: string[];
  /** Values Orca could not read and replaced (an unknown enum value becomes the option's default). */
  substituted: Array<{ key: string; value: string; replacement: string }>;
  /** Settings Orca derived from the file that it does not name (a legacy value can set another key). */
  added: string[];
}

export interface ProfilesNormalizeResult {
  /** In the order of the request: each file normalized, or why Orca could not read it. */
  presets: Array<NormalizedPreset | { error: string }>;
}

// ---------------------------------------------------------------------------------------------
// profiles.resolve
// ---------------------------------------------------------------------------------------------

export interface ProfilesResolveParams {
  /** The vendor to load. */
  vendor: ProfileFolder;
  /** OrcaFilamentLibrary, which filaments of every vendor may inherit from. Absent: none. */
  library?: ProfileFolder | null;
  /** The presets to return. Absent: every selectable preset of `vendor`. May name library presets. */
  presets?: Array<{ type: PresetScope; name: string }>;
  /** Also the processes and filaments Orca offers with each printer: true for every printer of `vendor`, or a list. */
  compatibility?: boolean | string[];
}

/** A selectable preset as OrcaSlicer holds it once loaded. */
export interface ResolvedPreset {
  type: PresetScope;
  name: string;
  /** The folder it came from. */
  vendor: string;
  /**
   * The flattened preset, ready for `slice` and `settings.*`: every setting of its type (inherited, the type's
   * defaults for the rest, and Orca's adjustments), with `name`, `from: "system"`, `type`, `version` (the vendor's)
   * and `inherits: ""`; a filament also with its `filament_id` (when it has one).
   */
  config: Config;
  /** Orca's alias: the name up to its '@' (unless the file sets `alias`). */
  alias: string;
  /** Older names that still find this preset (the file's `renamed_from`, or Orca's alias-derived name). */
  renamedFrom: string[];
  settingId: string;
  /** Filaments: the id Orca matches filament spools by (inherited when the file has none). */
  filamentId?: string;
}

export interface ProfilesResolveResult {
  presets: ResolvedPreset[];
  /** Presets the request named that the folders do not hold as selectable presets. */
  missing: Array<{ type: PresetScope; name: string }>;
  /** Each type's default preset: where every inheritance chain starts (a printer's: the FFF one). */
  defaults: Record<PresetScope, Config>;
  /**
   * With `compatibility`: per printer, the selectable processes and filaments (the vendor's and the library's) that
   * Orca finds compatible with it (compatible_printers, compatible_printers_condition, and the library filaments a
   * printer's own filament of the same alias replaces), in Orca's order.
   */
  compatibility?: Array<{ printer: string; processes: string[]; filaments: string[] }>;
  /** With `compatibility`: filaments that suit only some processes (compatible_prints, compatible_prints_condition), and which. */
  printRestricted?: Array<{ filament: string; processes: string[] }>;
  /** What Orca's loader logged as errors (a missing parent, a key in the wrong preset type, ...). */
  errors: string[];
}

// ---------------------------------------------------------------------------------------------
// profiles.validate
// ---------------------------------------------------------------------------------------------

export interface ProfilesValidateParams {
  /** Every vendor folder to load, OrcaFilamentLibrary among them. References are checked across all of them. */
  vendors: ProfileFolder[];
  /** Validate this vendor (and the library) only, as the validator's -v does. Absent: all. */
  vendor?: string;
  /** Also flag printers with two compatible filaments sharing a filament_id. Default true, as the validator. */
  checkFilamentSubtypes?: boolean;
}

export interface ProfilesValidateResult {
  /** OrcaSlicer_profile_validator's verdict: the folders loaded in validation mode, with no errors. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Selectable presets loaded, per vendor. */
  counts: Record<string, Record<PresetScope, number>>;
}
