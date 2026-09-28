// One object's own settings (Orca's object settings, ModelObject::config), the object-scope part of
// Orca's TabPrintModel: which settings an object can have and under which of Orca's categories, labels
// that stand on their own, the add-setting list, the value each setting has without the object's own (the
// plate's, else the global one), the printer's layer height limits, Orca's rules evaluated for the
// object's effective configuration, and what an edit writes.
//
// As in Orca, an object's setting stays its own until the user takes it off: a setting added to the
// object is stored at once with the value it has now, and an edit back to the global value is kept (Orca's
// object list keeps both). Only keys an object can have are ever written: a value Orca changes along with
// an edit, or a rule's fix, that touches another key is left to the global settings.
//
// Provenance: ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D Technologies' own code:
// web/src/components/objectSettingsModel.ts and the category table of shared/objectSettings.ts); part of
// this repository and licensed like it (AGPL-3.0-only). Changed here: the settings an object can have are
// read from the catalogue (its per-object options) instead of a generated table.
import type { OrcaOptionType, SettingsCatalogue } from '../../../packages/protocol/src/catalogue.ts';
import type { PanelMode } from '../../../packages/protocol/src/settings.ts';
import { settingDef } from './catalogue.ts';
import { keyPlace, readableLabel } from './layout.ts';
import { currentOf, editedKeys, envOptions, extruderCount, type SettingsState } from './model.ts';
import { editEffects, evaluateRules, layeredConfig, orcaNumber, type ConfigView, type RuleIssue, type RulePrompt, type RulesEnv, type RulesResult } from './rules.ts';
import { readNumber, sameText, slotsOf } from './text.ts';

/** Writes for one object: the setting's text, or null to remove the object's own value. */
export type ObjectWrites = Record<string, string | null>;

const EPSILON = 1e-4;

// ---------------------------------------------------------------------------------------------
// Which settings an object can have
// ---------------------------------------------------------------------------------------------

/** Orca's categories of the per-object options, in the order the object's settings list them. */
export const OBJECT_SETTING_CATEGORIES = ['Quality', 'Strength', 'Speed', 'Support', 'Others', 'Advanced', 'Layers and Perimeters'] as const;
/** The categories Orca offers only with several filaments (is_improper_category), and the flush options. */
const MULTI_FILAMENT_CATEGORIES = ['Extruders', 'Flush options'] as const;
/** Which filament prints the support: only a choice with several filaments. */
const FILAMENT_CHOICES: ReadonlySet<string> = new Set(['support_filament', 'support_interface_filament']);

/**
 * Orca's frequent object settings (GUI_Factories.cpp FREQ_SETTINGS_BUNDLE_FFF): the add-setting list's
 * first group. The flush options come only with several filaments.
 */
export const FREQUENT_OBJECT_SETTINGS: readonly string[] = [
  'layer_height',
  'wall_loops', 'top_shell_layers', 'bottom_shell_layers',
  'sparse_infill_density', 'sparse_infill_pattern',
  'enable_support', 'support_type', 'support_threshold_angle', 'support_threshold_overlap', 'support_base_pattern',
  'support_on_build_plate_only', 'support_critical_regions_only', 'support_remove_small_overhang', 'support_base_pattern_spacing',
  'support_expansion',
];
const FREQUENT_FLUSH: readonly string[] = ['flush_into_infill', 'flush_into_objects', 'flush_into_support'];

export interface ObjectKeys {
  /** Category -> keys, in the categories' order (keys in the catalogue's key order). */
  categories: Array<{ title: string; keys: string[] }>;
  keys: ReadonlySet<string>;
  frequent: readonly string[];
}

const objectKeys = new WeakMap<SettingsCatalogue, Map<boolean, ObjectKeys>>();

/**
 * Every setting an object can have, by Orca category: the options an object (PrintObjectConfig) or a part
 * (PrintRegionConfig) can override, as Orca's object list offers them (get_full_settings_hierarchy), without
 * those that are not settings of an object here: options without a category, the options the filament
 * preset stores (filament_ironing_*), and with one filament the categories Orca hides then (Extruders,
 * Wipe options), the flush options and the filament choices.
 */
export function objectSettingKeys(catalogue: SettingsCatalogue, filamentCount = 1): ObjectKeys {
  const several = filamentCount > 1;
  let byCount = objectKeys.get(catalogue);
  if (!byCount) objectKeys.set(catalogue, (byCount = new Map()));
  let found = byCount.get(several);
  if (!found) {
    const titles: string[] = [...OBJECT_SETTING_CATEGORIES, ...(several ? MULTI_FILAMENT_CATEGORIES : [])];
    const byCategory = new Map<string, string[]>(titles.map((t) => [t, []]));
    for (const key of Object.keys(catalogue.options).sort()) {
      const def = catalogue.options[key];
      if (!def.perObject || !def.category || def.scopes?.includes('filament')) continue;
      if (!several && FILAMENT_CHOICES.has(key)) continue;
      byCategory.get(def.category)?.push(key);
    }
    const categories = titles.map((title) => ({ title, keys: byCategory.get(title)! })).filter((c) => c.keys.length > 0);
    found = {
      categories,
      keys: new Set(categories.flatMap((c) => c.keys)),
      frequent: several ? [...FREQUENT_OBJECT_SETTINGS, ...FREQUENT_FLUSH] : FREQUENT_OBJECT_SETTINGS,
    };
    byCount.set(several, found);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** What a setting of these keys is, for labels Orca leaves to the group heading ("Outer wall" under "Speed"). */
const KEY_NOUNS: readonly [RegExp, string][] = [
  [/(^|_)speed$/, 'speed'],
  [/_acceleration$/, 'acceleration'],
  [/_jerk$/, 'jerk'],
  [/(^|_)line_width$/, 'line width'],
];

/** The feature a setting of these keys belongs to, for labels its settings page gives ("Type" on the Support page). */
const KEY_FEATURES: readonly [prefix: string, feature: string, word: string][] = [
  ['tree_support_', 'Tree support', 'support'],
  ['support_', 'Support', 'support'],
  ['raft_', 'Raft', 'raft'],
  ['lightning_', 'Lightning', 'lightning'],
  ['fuzzy_skin_', 'Fuzzy skin', 'fuzzy'],
  ['scarf_', 'Scarf', 'scarf'],
  ['zaa_', 'Z contouring', 'contouring'],
];

/** Orca's Title Case words in lower case ("Tip Diameter" -> "tip diameter"); "Z" and "X-Y" stay. */
const lowerWords = (text: string) => text.replace(/\b[A-Z][a-z'’]+\b/g, (w) => w.toLowerCase());

/**
 * A per-object setting's label where the settings page around it is missing, from Orca's `label`: with
 * the row label of a row of several options ("Bridge" + "External"), the kind of value its key names
 * ("Outer wall" speed, acceleration, jerk or line width), the feature its key belongs to ("Type" of
 * support) and "(organic)" for the organic tree support twin of an option.
 */
export function composeObjectLabel(key: string, label: string, type?: OrcaOptionType, line?: string): string {
  let text = readableLabel(key, label);
  if (line && line !== text) text = /^\d/.test(text) ? `${line} ${text}` : `${text} ${lowerWords(line)}`;
  const noun = type === 'bool' || type === 'bools' ? undefined : KEY_NOUNS.find(([re]) => re.test(key))?.[1];
  if (noun && !text.toLowerCase().includes(noun)) text = `${text} ${noun}`;
  const feature = KEY_FEATURES.find(([prefix]) => key.startsWith(prefix));
  if (feature && !text.toLowerCase().includes(feature[2])) text = `${feature[1]} ${lowerWords(text)}`;
  if (key.endsWith('_organic')) text = `${text} (organic)`;
  return text;
}

const labels = new WeakMap<SettingsCatalogue, Map<string, string>>();

/** The label of a per-object setting: Orca's (full) label, made to stand on its own (composeObjectLabel). */
export function objectSettingLabel(catalogue: SettingsCatalogue, key: string): string {
  let cache = labels.get(catalogue);
  if (!cache) labels.set(catalogue, (cache = new Map()));
  let label = cache.get(key);
  if (label === undefined) {
    const def = settingDef(catalogue, key);
    label = def ? composeObjectLabel(key, def.fullLabel ?? def.label, def.type, keyPlace(catalogue, key)?.line.label) : key;
    cache.set(key, label);
  }
  return label;
}

/** Whether a setting is one of the support settings, which do nothing while the object has no supports. */
export function isSupportSetting(key: string): boolean {
  return (key.startsWith('support_') || key.startsWith('tree_support_')) && key !== 'enable_support';
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface RowGroup {
  title: string;
  keys: string[];
}

const layoutOrders = new WeakMap<SettingsCatalogue, Map<string, number>>();

/** Where each option comes in Orca's settings tabs (process first), so rows follow the settings tabs. */
function layoutOrder(catalogue: SettingsCatalogue): Map<string, number> {
  let order = layoutOrders.get(catalogue);
  if (!order) {
    order = new Map();
    for (const tab of catalogue.tabs) {
      for (const page of tab.pages) {
        for (const group of page.groups) {
          for (const line of group.lines) for (const option of line.options) if (!order.has(option.key)) order.set(option.key, order.size);
        }
      }
    }
    layoutOrders.set(catalogue, order);
  }
  return order;
}

/** `keys` in the settings tabs' order. */
export function inPanelOrder(keys: readonly string[], catalogue: SettingsCatalogue): string[] {
  const order = layoutOrder(catalogue);
  const at = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return [...keys].sort((a, b) => at(a) - at(b) || a.localeCompare(b));
}

/**
 * The rows of an object's settings: by Orca category (the categories' order), each in the settings tabs'
 * order, then keys an object cannot have here (from a newer version of an app) under "Other".
 */
export function objectSettingRows(settings: Readonly<Record<string, string>> | undefined, catalogue: SettingsCatalogue, filamentCount = 1): RowGroup[] {
  const own = new Set(Object.keys(settings ?? {}));
  const { categories, keys: known } = objectSettingKeys(catalogue, filamentCount);
  const groups: RowGroup[] = [];
  for (const category of categories) {
    const keys = category.keys.filter((k) => own.has(k));
    if (keys.length > 0) groups.push({ title: category.title, keys: inPanelOrder(keys, catalogue) });
  }
  const other = [...own].filter((k) => !known.has(k));
  if (other.length > 0) groups.push({ title: 'Other', keys: other });
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** The value `key` has for an object without its own: the plate's setting, else the global value. */
export function inheritedValue(state: SettingsState, key: string): string {
  const plate = state.plateSettings;
  return plate && Object.hasOwn(plate, key) ? plate[key] : currentOf(state, 'process', key);
}

/** The configuration an object without settings of its own slices with: the plate, the overrides, the presets. */
export function plateConfigView(state: SettingsState): ConfigView {
  const c = state.configs;
  return layeredConfig(state.plateSettings, state.overrides.process, state.overrides.filament, state.overrides.machine, c.process, c.filament, c.machine);
}

/** The object's effective configuration: its own settings on top of the plate's. */
export function objectConfigView(state: SettingsState, settings: Readonly<Record<string, string>> | undefined): ConfigView {
  const plate = plateConfigView(state);
  return { get: (key) => (settings && Object.hasOwn(settings, key) ? settings[key] : plate.get(key)) };
}

/** Orca's rules environment for an object's settings (TabPrintModel: is_global_config false). */
export function objectRulesEnv(state: SettingsState, settings: Readonly<Record<string, string>> | undefined): RulesEnv {
  const edited = editedKeys(state);
  for (const key of Object.keys(state.plateSettings ?? {})) edited.add(key);
  for (const key of Object.keys(settings ?? {})) edited.add(key);
  return {
    config: objectConfigView(state, settings),
    context: 'object',
    ...envOptions(state),
    extruderCount: extruderCount(state),
    mode: state.mode ?? 'advanced',
    edited,
    globalConfig: plateConfigView(state),
  };
}

const issueId = (i: RuleIssue) => `${i.id}\n${i.key}\n${i.message}`;

export interface ObjectRules {
  env: RulesEnv;
  result: RulesResult;
  /**
   * Orca's warnings and errors about the object's settings: those shown on one of its settings (about its
   * own value), and those that involve one of them and that the plate without them does not have (e.g.
   * spiral vase mode with more than one wall). Orca's silent rewrites (severity info) are applied on edit
   * instead, as in the global settings.
   */
  issues: RuleIssue[];
}

/** Orca's rules for the object's effective configuration. */
export function evaluateObject(state: SettingsState, settings: Readonly<Record<string, string>> | undefined): ObjectRules {
  const env = objectRulesEnv(state, settings);
  const result = evaluateRules(env);
  const own = Object.keys(settings ?? {});
  if (own.length === 0) return { env, result, issues: [] };
  const baseline = new Set(evaluateRules(objectRulesEnv(state, undefined)).issues.map(issueId));
  const issues = result.issues.filter(
    (i) => i.scope === 'process' && i.severity !== 'info' && (own.includes(i.key) || (i.keys.some((k) => own.includes(k)) && !baseline.has(issueId(i)))),
  );
  return { env, result, issues };
}

/**
 * The printer's layer height range (Orca's layer_height_limits: the smallest minimum and the largest
 * maximum of the nozzles). Without a maximum the nozzle diameter is the limit, which Orca's validation
 * also enforces. Undefined bounds are not limited here.
 */
export function layerHeightLimits(state: SettingsState): { min?: number; max?: number } {
  const numbers = (key: string) =>
    slotsOf(key, currentOf(state, 'machine', key))
      .map((s) => readNumber(s)?.n)
      .filter((n): n is number => n !== undefined && n > EPSILON);
  const mins = numbers('min_layer_height');
  const maxes = numbers('max_layer_height');
  const nozzles = numbers('nozzle_diameter');
  const limits: { min?: number; max?: number } = {};
  if (mins.length > 0) limits.min = Math.min(...mins);
  if (maxes.length > 0) limits.max = Math.max(...maxes);
  else if (nozzles.length > 0) limits.max = Math.min(...nozzles);
  return limits;
}

/**
 * Orca's handling of a layer height typed for an object (ConfigManipulation::check_layer_height, then
 * update_print_fff_config), as in the global settings: 0 becomes the printer's minimum layer height, or
 * 0.2 when the printer has none, and `notice` says so. Any other value is kept; one outside the printer's
 * range raises Orca's "layer-height-limits" warning with its "Adjust to ..." fix (evaluateObject).
 */
export function objectLayerHeight(state: SettingsState, text: string): { text: string; notice?: string } {
  const n = readNumber(text)?.n;
  if (n === undefined || n >= EPSILON) return { text };
  const { min } = layerHeightLimits(state);
  if (min !== undefined) {
    const minimum = orcaNumber(min);
    return { text: minimum, notice: `Layer height is too small. It has been set to the minimum (${minimum} mm).` };
  }
  return { text: '0.2', notice: 'Layer height is too small. It has been reset to 0.2 mm.' };
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/** Writes that would not change the object's settings are left out. */
export function effectiveObjectWrites(settings: Readonly<Record<string, string>> | undefined, writes: ObjectWrites): ObjectWrites {
  const out: ObjectWrites = {};
  for (const [key, value] of Object.entries(writes)) {
    const before = settings && Object.hasOwn(settings, key) ? settings[key] : null;
    if (before !== value) out[key] = value;
  }
  return out;
}

/** What adding setting `key` to the object writes: its value now (the plate's, else the global one). Nothing when it has it. */
export function planObjectAdd(state: SettingsState, settings: Readonly<Record<string, string>> | undefined, key: string, known: ReadonlySet<string>): ObjectWrites {
  if (!known.has(key) || (settings && Object.hasOwn(settings, key))) return {};
  return { [key]: inheritedValue(state, key) };
}

export interface ObjectEdit {
  writes: ObjectWrites;
  /** Orca's questions about the edit: the edit is made, and an answer writes its choice's values. */
  prompts: RulePrompt[];
}

/**
 * What setting `key` of the object to `text` writes: the setting itself (also when it equals the global
 * value), and the object settings Orca changes along with it (its on_value_change handlers and the silent
 * rewrites the edit starts): one the object has follows, one it has not is set only where Orca's value
 * differs from the inherited one. Changes to keys an object cannot have are left out. `env` is the
 * object's rules environment before the edit.
 */
export function planObjectEdit(
  state: SettingsState,
  settings: Readonly<Record<string, string>> | undefined,
  key: string,
  text: string,
  env: RulesEnv,
  known: ReadonlySet<string>,
): ObjectEdit {
  const effects = editEffects('process', key, text, env);
  const writes: ObjectWrites = {};
  for (const [k, value] of Object.entries(effects.patch)) {
    if (k === key || !known.has(k)) continue;
    const own = settings !== undefined && Object.hasOwn(settings, k);
    if (own || !sameText(k, value, inheritedValue(state, k))) writes[k] = value;
  }
  writes[key] = Object.hasOwn(effects.patch, key) ? effects.patch[key] : text;
  return { writes: effectiveObjectWrites(settings, writes), prompts: effects.prompts };
}

/**
 * The writes that apply a rule's fix (whole values) to the object, or null when the fix touches a setting
 * an object cannot have (the fix then belongs to the global settings).
 */
export function planObjectValues(settings: Readonly<Record<string, string>> | undefined, values: Readonly<Record<string, string>>, known: ReadonlySet<string>): ObjectWrites | null {
  const writes: ObjectWrites = {};
  for (const [key, text] of Object.entries(values)) {
    if (!known.has(key)) return null;
    writes[key] = text;
  }
  return effectiveObjectWrites(settings, writes);
}

// ---------------------------------------------------------------------------------------------
// The add-setting list
// ---------------------------------------------------------------------------------------------

/**
 * The add-setting list: the frequent settings, then every setting an object can have by Orca category (as
 * Orca's object menu has its frequent bundles and its full categories), each category in the settings
 * tabs' order. Develop-mode options are offered in Expert mode only, as in the settings tabs.
 */
export function addGroups(catalogue: SettingsCatalogue, mode: PanelMode, frequent: readonly string[], filamentCount = 1): Array<{ title: string; keys: string[] }> {
  const offered = (key: string) => {
    const def = settingDef(catalogue, key);
    return !!def && (def.mode !== 'develop' || mode === 'expert');
  };
  const out: Array<{ title: string; keys: string[] }> = [];
  const first = frequent.filter(offered);
  if (first.length > 0) out.push({ title: 'Frequent', keys: first });
  for (const category of objectSettingKeys(catalogue, filamentCount).categories) {
    const keys = inPanelOrder(category.keys, catalogue).filter(offered);
    if (keys.length > 0) out.push({ title: category.title, keys });
  }
  return out;
}
