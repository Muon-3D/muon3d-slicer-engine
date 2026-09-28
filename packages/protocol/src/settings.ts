// SPDX-License-Identifier: Apache-2.0
// `settings.view` and `settings.edit`: the settings forms of OrcaSlicer (the process, filament and printer
// tabs, an object's own settings, a plate's settings) as documents a generic renderer draws, and edits
// as store writes. The host evaluates Orca's rules, layout and edit handlers; the client keeps the values
// (its presets, its overrides) and sends them with each request. Configs travel once, then by hash.
//
// The document has two parts: the static `form` (labels, tooltips, units, enum labels, the layout), which
// depends only on the engine build, the scope and the client's `omit` list, and the dynamic state (which
// pages, rows and cells show now, greyed cells, narrowed enums, issues). A client caches the form under
// its `formId` and passes that id back as `form`: the host then leaves the form out, so a per-edit
// response carries only the dynamic state. docs/PROTOCOL.md, "Settings", describes the whole flow.
import type { OrcaOptionType, SettingMode, SlotKind } from './catalogue.ts';
import type { Config, ConfigPatch, PresetScope } from './data.ts';

/** SettingsView.format and SettingsForm.format of the shapes below. */
export const SETTINGS_VIEW_FORMAT = 1;

/** Which form: a preset's tab, one object's own settings, or one plate's settings. */
export type SettingsScope = PresetScope | 'object' | 'plate';

/** The modes a settings form offers (Orca's; develop options appear in Expert's generated "Other" page). */
export type PanelMode = 'simple' | 'advanced' | 'expert';

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * A config the host caches by `hash`: send `config` the first time (or after error NotCached), then the
 * hash alone. `hash` is any string the client derives from the content (configHash() in this package);
 * two different configs must never share one.
 */
export interface ConfigRef {
  hash: string;
  config?: Config;
}

/** What every settings request describes: the values in effect, and the environment. */
export interface SettingsInput {
  /** The three flattened presets (the filament of slot 0: the settings forms show one filament). */
  presets: { machine: ConfigRef; process: ConfigRef; filament: ConfigRef };
  /** The user's project-wide changes per preset, in Orca's serialized text (comma-separated slots for a vector). */
  overrides?: Partial<Record<PresetScope, ConfigPatch>>;
  /** The active plate's own settings (curr_bed_type, print_sequence, spiral_mode, ...). */
  plate?: ConfigPatch;
  /** Scope 'object': the object's own settings. */
  object?: ConfigPatch;
  /** Scope 'plate': the plate's objects, with their own settings (spiral vase gives each what it needs). */
  objects?: Array<{ id: string; settings?: ConfigPatch }>;
  env?: SettingsEnv;
}

export interface SettingsEnv {
  /** Default 'advanced'. Rows show at their first option's mode and above. */
  mode?: PanelMode;
  /** The printer's vendor folder in Orca's profiles; "BBL" (Bambu Lab) turns on Orca's Bambu-only rules. */
  vendor?: string;
  /** Filaments in the project. Default 1. */
  filamentCount?: number;
  /** Bambu's device database: the printer detects clumping (wrapping). Default false. */
  supportsWrappingDetection?: boolean;
  /** The printer's plate type: the one it uses unless the user picks one, and whether the user may pick. */
  bedType?: { default: string; selectable: boolean };
  /** Scope 'plate': how many objects the plate has (default: `objects`' length). */
  objectCount?: number;
  /** The nozzle (0-based) whose values the rows of per-nozzle-variant settings show. Default 0. */
  extruder?: number;
  /** Scope 'object': the "Frequent" group of the add-setting list; default Orca's frequent settings. */
  frequent?: string[];
}

/** What the client wants in the document besides the dynamic state. */
export interface ViewOptions {
  /** Option keys the client never shows (its own policy): left out of the form and the state. Part of the form's id. */
  omit?: string[];
  /** The formId the client holds: the form is left out of the document when it is still that one. */
  form?: string;
  /** Include each cell's value text (and the inherited value of a filament override or an object's setting). */
  values?: boolean;
}

export interface SettingsViewParams extends SettingsInput, ViewOptions {
  scope: SettingsScope;
  /** The client's revision of the values in this request; echoed as SettingsView.version. */
  version?: number;
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export interface SettingsView {
  format: 1;
  scope: SettingsScope;
  /** The request's version, or null. */
  version: number | null;
  /** The form this state belongs to. */
  formId: string;
  /** Absent when the request named this formId. */
  form?: SettingsForm;
  /** Scopes 'process', 'filament', 'machine'. */
  tab?: TabView;
  /** Scope 'object'. */
  object?: ObjectView;
  /** Scope 'plate'. */
  plate?: PlateView;
  /** Orca's warnings and checks for the scope, in Orca's order (see SettingIssue). */
  issues: SettingIssue[];
}

/** The static part: text and layout. Depends on the engine build, the scope and `omit` only. */
export interface SettingsForm {
  format: 1;
  id: string;
  scope: SettingsScope;
  /** The keys left out (ViewOptions.omit), sorted. */
  omit: string[];
  /** Every option the form's rows use, by key. */
  options: Record<string, FormOption>;
  /** Preset scopes: the tab's pages in Orca's order, every mode (the state says which show). */
  pages?: FormPage[];
  /** Scope 'object': every setting an object can have, by Orca category, each in the tab's order. */
  categories?: Array<{ title: string; keys: string[] }>;
  /** Scope 'object': Orca's frequent object settings (the add-setting list's first group). */
  frequent?: string[];
  /** Scope 'plate': Orca's plate settings dialog, one row per option. */
  lines?: FormLine[];
}

/** The control a cell edits one slot of an option with. */
export type ControlKind =
  | 'number'
  /** a number or a percentage ("mm or %") */
  | 'floatOrPercent'
  | 'bool'
  | 'enum'
  /** a text box with suggestions: values beyond `enum` are allowed (Orca's open enums) */
  | 'suggest'
  | 'text'
  /** multi-line text: G-code, notes */
  | 'code'
  | 'color'
  | 'point';

export interface FormOption {
  key: string;
  type: OrcaOptionType;
  control: ControlKind;
  /** The label for this form (for an object's settings: one that stands on its own, "Outer wall speed"). */
  label: string;
  /** Orca's stand-alone label, when it differs from `label`. */
  fullLabel?: string;
  tooltip?: string;
  /** Orca's sidetext: the unit, e.g. "mm/s" or "mm/s or %". */
  unit?: string;
  mode: SettingMode;
  /** Orca's category (its per-object settings group by it). */
  category?: string;
  min?: number;
  max?: number;
  /** floatOrPercent: an absolute value above this is probably a forgotten "%". */
  maxLiteral?: number;
  /** floatOrPercent: the option a percentage is taken of. */
  ratioOver?: string;
  /** The values a drop-down lists, with Orca's labels. */
  enum?: Array<{ value: string; label: string }>;
  /** Typed values beyond `enum` are allowed. */
  openEnum?: true;
  multiline?: true;
  code?: true;
  /** A strings option edited as one ";"-separated text. */
  serialized?: true;
  /** Vector slots may be "nil" (unset: a filament override then uses the printer's or process's value). */
  nullable?: true;
  /** Vector options: what the slots are. */
  slots?: SlotKind;
  /** Orca itself shows it read-only. */
  readOnly?: true;
  /** Orca's default in its JSON encoding. */
  default?: string | string[];
}

export interface FormPage {
  /** Unique in the form. */
  id: string;
  title: string;
  groups: FormGroup[];
  /** Built once per nozzle ("Extruder 1", "Extruder 2", ...). */
  repeat?: 'extruder';
  /** Shown only while option `key` has one of these values (e.g. the G-code flavor). */
  when?: { key: string; oneOf: string[] };
  /** Generated, not one of Orca's pages: the scope's options no page shows. Expert mode only. */
  other?: true;
}

export interface FormGroup {
  /** Unique in its page. */
  id: string;
  title: string;
  lines: FormLine[];
}

export interface FormLine {
  /** Unique in the form: "<page>/<group>/<n>". */
  id: string;
  /** The row's label (for one option, the option's). */
  label: string;
  tooltip?: string;
  /** The row shows at this mode and above (its first option's). */
  mode: SettingMode;
  options: FormLineOption[];
  /** Orca shows its own control here (bed shape dialog, ramming dialog, compatible presets list). */
  widget?: 'bedShape' | 'excludeArea' | 'ramming' | 'compatible' | 'custom';
  /** A filament "Setting Overrides" row: an unset (nil) slot uses `key` of the `scope` preset. */
  overrideOf?: { scope: 'machine' | 'process'; key: string };
  /** A machine limit: slot 0 the normal mode, slot 1 the silent mode (when silent_mode is on). */
  modeColumns?: true;
}

export interface FormLineOption {
  key: string;
  /** Its label inside a row of several options ("Target", "10%"). */
  label: string;
  /** The slot the layout names: a number, or 'extruder' (the page's nozzle). Absent: the option as a whole. */
  index?: number | 'extruder';
  tooltip?: string;
}

// ---- Preset tabs ----------------------------------------------------------------------------

export interface TabView {
  /** The page strip: the pages that show now, in order (an Extruder page once per nozzle). */
  pages: ViewPage[];
  /** Form pages that do not show for this printer (their `when` fails), for a search to explain. */
  inactivePages: string[];
  /** The printer's nozzles. */
  extruders: number;
  /** The nozzle whose values rows of per-variant settings show (SettingsEnv.extruder, clamped). */
  extruder: number;
}

export interface ViewPage {
  /** Unique in the tab: the form page's id, or "<page>#<n>" for nozzle n's Extruder page. */
  id: string;
  /** The form page. */
  page: string;
  title: string;
  /** The nozzle an Extruder page edits. */
  extruder?: number;
  /** The page has rows of per-variant settings and the printer has several nozzles: show a nozzle picker. */
  nozzlePicker?: true;
  /** Issues (warnings and errors) about settings on this page. */
  issues?: number;
  groups: ViewGroup[];
  /** Rows of this page Orca's rules hide now (in the mode): a search shows them greyed. */
  hiddenLines?: string[];
}

export interface ViewGroup {
  /** The form group. */
  id: string;
  lines: ViewLine[];
}

export interface ViewLine {
  /** The form line. */
  id: string;
  /** Orca renamed the row for the current values. */
  label?: string;
  cells: ViewCell[];
  /** Filament override row: the Override checkbox is greyed out. */
  locked?: true;
}

/** One control of a row: one slot of an option. */
export interface ViewCell {
  key: string;
  /** The vector slot the cell edits; absent: the option as a whole (slot 0 of a vector). */
  index?: number;
  /** Its label in a row of several cells ("Normal"/"Silent" for the machine limits' two columns). */
  label?: string;
  /** Orca greys it out for the current values. */
  disabled?: true;
  /** The enum values offered now, in this order (Orca narrowed the list). */
  choices?: string[];
  /** ViewOptions.values: the slot's text in effect. */
  value?: string;
  /** ViewOptions.values, filament override rows: the value an unset (nil) slot uses. */
  inherited?: string;
}

// ---- An object's settings -------------------------------------------------------------------

export interface ObjectView {
  /** The object's own settings by category (the form's order), keys an object cannot have last ("Other"). */
  groups: Array<{ title: string; rows: ObjectRow[] }>;
  /** The add-setting list: "Frequent", then every category, without develop options below Expert. */
  add: Array<{ title: string; keys: string[] }>;
  /** The printer's layer height range (a hint for layer_height). */
  limits: { layerHeight: { min?: number; max?: number } };
}

export interface ObjectRow {
  key: string;
  /** Not a setting an object can have (from a newer app, or another engine): show it by key, removable. */
  unknown?: true;
  /** Orca renamed it for the current values. */
  label?: string;
  /** Greyed out: 'rules' (Orca's rules for the object's values), 'support' (a support setting while supports are off). */
  disabled?: 'rules' | 'support';
  /** The enum values offered now. */
  choices?: string[];
  /** ViewOptions.values: the object's value, and the value it has without it (the plate's, else the global one). */
  value?: string;
  inherited?: string;
}

// ---- A plate's settings ---------------------------------------------------------------------

export interface PlateView {
  rows: PlateRow[];
}

export interface PlateRow {
  key: string;
  /** The plate's own value; absent: the plate uses the global one. */
  value?: string;
  /** The global value (what "Same as global" means). */
  global: string;
  /** The enum values offered now. */
  choices?: string[];
}

// ---- Issues ---------------------------------------------------------------------------------

/**
 * A check of Orca's about the current values, shown next to the setting: its dialogs (a refused value,
 * a warning), and its silent rewrites (severity 'info': applied by settings.edit when the user edits
 * one of `triggers`). None of them blocks slicing.
 */
export interface SettingIssue {
  /** Stable id of the check ("spiral-vase", "layer-height-limits", ...): an open set. */
  id: string;
  /** The preset the keys (and the fix) belong to. */
  scope: PresetScope;
  /** The row the issue is shown on. */
  key: string;
  /** Every key involved, `key` first. */
  keys: string[];
  severity: 'error' | 'warning' | 'info';
  /** Orca's English text. */
  message: string;
  /** What Orca's "Yes" (or its automatic reset) writes: apply it with settings.edit { apply }. */
  fix?: ConfigPatch;
  fixLabel?: string;
  /** Orca's "No", when it also changes values. */
  alternative?: { label: string; values: ConfigPatch };
  /** A silent rewrite: editing one of these keys applies `fix`. */
  triggers?: string[];
  /** A check Orca makes only when one of these keys is edited: reported while one of them is set. */
  checkedOn?: string[];
  /** Scope 'object': false when the fix touches settings an object cannot have (it belongs to the global settings). */
  fixable?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

export type SettingsEdit =
  /** The user set slot `index` of `key` (absent: the whole setting) to `value`: Orca's edit handlers run. */
  | { set: string; value: string; index?: number }
  /** A fix's, an answer's or a choice's whole values (and a choice's values for other objects): no handlers run. */
  | { apply: ConfigPatch; objects?: Array<{ id: string; values: ConfigPatch }> }
  /** Back to the preset's value (preset scopes), or the object's or plate's own value removed. */
  | { reset: Array<{ key: string; index?: number }> }
  /** Scope 'object': add a setting with the value it has now (the plate's, else the global one). */
  | { add: string };

export interface SettingsEditParams extends SettingsInput {
  scope: SettingsScope;
  edit: SettingsEdit;
  /** The client's revision the edit was made on; echoed. */
  version?: number;
  /** Also return the document after the edit (the writes applied): true, or the view options. */
  view?: boolean | ViewOptions;
}

export interface SettingsEditResult {
  version: number | null;
  /**
   * The store writes, all in the edited scope's store: text to set, or null to remove. Preset scopes:
   * the preset's overrides (null: back to the preset's value). 'object': the object's settings. 'plate':
   * the plate's settings. Empty when nothing changes (or the edit waits for a blocking prompt).
   */
  writes: Record<string, string | null>;
  /** Scope 'plate': writes to the plate's objects' own settings. */
  objects?: Array<{ id: string; writes: Record<string, string | null> }>;
  /** Orca's questions about the edit, in Orca's order. */
  prompts: SettingPrompt[];
  /** What Orca told the user about a value it changed at once (its OK-only dialogs). */
  notices: string[];
  /** SettingsEditParams.view: the document with the writes applied. */
  view?: SettingsView;
}

/**
 * A question Orca asks about an edit. The edit is already in `writes` and the first choice is Orca's
 * default, unless `blocking`: then nothing was written, and a choice (settings.edit { apply }) makes it.
 */
export interface SettingPrompt {
  id: string;
  scope: PresetScope;
  key: string;
  message: string;
  choices: Array<{ label: string; values: ConfigPatch; objects?: Array<{ id: string; values: ConfigPatch }> }>;
  blocking?: true;
}
