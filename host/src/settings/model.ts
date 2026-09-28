// The settings forms' view of the values: what each setting is without the user's changes (the preset's
// value, else Orca's default), what it is now (the user's override on top), the configuration Orca's rules
// read, and what an edit writes. Edits become overrides in Orca's text form (text.ts); an edit that gives
// back the preset's value removes the override.
//
// The global settings are the presets with the project-wide overrides. A plate can hold its own settings
// (curr_bed_type, print_sequence, spiral_mode); of those only the bed type feeds the global rules (the
// filament tab's bed temperature rows follow the active plate's type, as Orca's follow the project's).
//
// Provenance: ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D Technologies' own code:
// web/src/settings/model.ts); part of this repository and licensed like it (AGPL-3.0-only).
import type { SettingScope } from '../../../packages/protocol/src/catalogue.ts';
import type { Config, ConfigValue } from '../../../packages/protocol/src/data.ts';
import type { PanelMode } from '../../../packages/protocol/src/settings.ts';
import { settingDef } from './catalogue.ts';
import type { LayoutCatalogue, SlotResolver } from './layout.ts';
import { editEffects, evaluateRules, layeredConfig, type ConfigView, type RulePrompt, type RulesEnv, type RulesResult } from './rules.ts';
import { LIST_OPTIONS, baseText, overrideFor, sameSlot, slotValue, slotsOf, withSlot } from './text.ts';
import { VARIANT_KEYS, extruderVariantString, indexForExtruder } from './variants.ts';

export type PresetConfigs = Record<SettingScope, Config | null>;
export type OverrideMap = Record<SettingScope, Readonly<Record<string, string>>>;

export const SCOPES: readonly SettingScope[] = ['process', 'filament', 'machine'];

/** Everything a settings form reads its values from. */
export interface SettingsState {
  catalogue: LayoutCatalogue;
  /** The resolved presets (null: Orca's defaults). */
  configs: PresetConfigs;
  /** The user's project-wide changes, per preset. */
  overrides: OverrideMap;
  /** The active plate's own settings (curr_bed_type, print_sequence, spiral_mode). */
  plateSettings?: Readonly<Record<string, string>>;
  /** The printer's vendor folder ("BBL" is Bambu Lab, which some of Orca's rules check). */
  vendor?: string;
  mode?: PanelMode;
  /**
   * The printer's plate type: the one it uses unless the user picks one, and whether the user may (else
   * Orca always uses the default, whatever is stored).
   */
  bedType?: { defaultType: string; selectable: boolean };
  /** Filaments in the project (default 1). */
  filamentCount?: number;
  supportsWrappingDetection?: boolean;
}

/** The value without the user's change: the preset's, else Orca's default. */
export function baseOf(s: SettingsState, scope: SettingScope, key: string): string {
  const config = s.configs[scope];
  const value = config && Object.hasOwn(config, key) ? config[key] : undefined;
  return baseText(key, settingDef(s.catalogue, key), value);
}

export function overrideOf(s: SettingsState, scope: SettingScope, key: string): string | undefined {
  const map = s.overrides[scope];
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The value in effect: the user's change, else the base value. */
export function currentOf(s: SettingsState, scope: SettingScope, key: string): string {
  return overrideOf(s, scope, key) ?? baseOf(s, scope, key);
}

/** Slot `index` of `text`; a list option (a polygon, names) is one value as a whole. */
function slotOf(key: string, text: string, index?: number): string {
  return LIST_OPTIONS.has(key) ? text : slotValue(slotsOf(key, text), index ?? 0);
}

/** Slot `index` of the value in effect (undefined = the option as a whole, i.e. its first slot). */
export function currentSlot(s: SettingsState, scope: SettingScope, key: string, index?: number): string {
  return slotOf(key, currentOf(s, scope, key), index);
}

export function baseSlot(s: SettingsState, scope: SettingScope, key: string, index?: number): string {
  return slotOf(key, baseOf(s, scope, key), index);
}

/** Whether the user changed this setting (or this slot of it) from the preset. */
export function isModified(s: SettingsState, scope: SettingScope, key: string, index?: number): boolean {
  const override = overrideOf(s, scope, key);
  if (override === undefined) return false;
  if (index === undefined || LIST_OPTIONS.has(key)) return true;
  const def = settingDef(s.catalogue, key);
  return !sameSlot(def?.type, slotOf(key, override, index), baseSlot(s, scope, key, index));
}

/** Nozzles of the printer: the slots of its nozzle_diameter. */
export function extruderCount(s: SettingsState): number {
  return Math.max(1, slotsOf('nozzle_diameter', currentOf(s, 'machine', 'nozzle_diameter')).length);
}

/** Slots the base value has (an edit of one slot keeps the others). */
export function slotCount(s: SettingsState, scope: SettingScope, key: string): number {
  return slotsOf(key, baseOf(s, scope, key)).length;
}

// ---------------------------------------------------------------------------------------------
// Nozzle variants (variants.ts)
// ---------------------------------------------------------------------------------------------

/**
 * The nozzle variant of extruder `extruder` (0-based) as the engine slices with it: the printer's
 * extruder_type with a Standard nozzle (the engine has no nozzle volume type option, so it slices with
 * Standard nozzles).
 */
export function nozzleVariant(s: SettingsState, extruder: number): string {
  const types = slotsOf('extruder_type', currentOf(s, 'machine', 'extruder_type'));
  return extruderVariantString(slotValue(types, extruder) || 'Direct Drive', 'Standard');
}

/** How many variant slots `scope`'s preset has (its print/filament/printer_extruder_variant). */
export function variantCount(s: SettingsState, scope: SettingScope): number {
  const key = VARIANT_KEYS[scope].variant;
  return slotsOf(key, currentOf(s, scope, key)).length;
}

/**
 * The slot of per-variant option `key` of `scope` that belongs to nozzle `extruder` (0-based), times
 * `stride` (2 for the machine limits' normal/silent pairs): get_index_for_extruder. undefined when the
 * option is not stored per variant or the preset has no slot for the nozzle.
 */
export function variantSlot(s: SettingsState, scope: SettingScope, key: string, extruder: number, stride = 1): number | undefined {
  if (settingDef(s.catalogue, key)?.slots !== 'variant') return undefined;
  const keys = VARIANT_KEYS[scope];
  const index = indexForExtruder(
    {
      variants: slotsOf(keys.variant, currentOf(s, scope, keys.variant)),
      ids: keys.id ? slotsOf(keys.id, currentOf(s, scope, keys.id)) : null,
      extruderVariantList: slotsOf('extruder_variant_list', currentOf(s, 'machine', 'extruder_variant_list')),
    },
    extruder + 1,
    nozzleVariant(s, extruder),
    stride,
  );
  return index >= 0 ? index : undefined;
}

/**
 * The form's slots (layout.ts SlotResolver): an option stored per nozzle variant edits the slot of the
 * nozzle shown (an Extruder page's own, else the one picked for the page); the machine limits'
 * normal/silent pairs are two slots per variant. Rules keep the layout's slots (the nozzle of an Extruder
 * page), as Orca toggles them.
 */
export function slotResolver(s: SettingsState, scope: SettingScope): SlotResolver {
  return (key, def, layoutIndex, extruder, line) => {
    const ruleIndex = layoutIndex === 'extruder' ? extruder : layoutIndex;
    if (def.slots !== 'variant') return { index: ruleIndex, ruleIndex };
    // Tab::update_extruder_variants: every slot the layout names (Tab.cpp builds the Speed page with
    // "outer_wall_speed#0") becomes the slot of the nozzle shown.
    const variant = variantSlot(s, scope, key, extruder, line.modeColumns ? 2 : 1);
    // A preset without a slot for the nozzle: the layout's slot, as before the nozzle was known.
    return { index: variant ?? ruleIndex, ruleIndex };
  };
}

/** The effective values Orca's rules read: plate bed type, overrides, then the presets. */
export function configView(s: SettingsState): ConfigView {
  // The plate type in effect: the plate's own, the global choice, the printer's default; a printer whose
  // plate type cannot be picked always uses its default.
  const bed = s.bedType && !s.bedType.selectable ? s.bedType.defaultType : s.plateSettings?.curr_bed_type;
  return layeredConfig(
    bed !== undefined ? { curr_bed_type: bed } : null,
    s.overrides.process,
    s.overrides.filament,
    s.overrides.machine,
    s.configs.process as Record<string, ConfigValue> | null,
    s.configs.filament as Record<string, ConfigValue> | null,
    s.configs.machine as Record<string, ConfigValue> | null,
    s.bedType ? { curr_bed_type: s.bedType.defaultType } : null,
  );
}

/** The keys the user has set (Orca checks some values only when the user edits them). */
export function editedKeys(s: SettingsState): Set<string> {
  const keys = new Set<string>();
  for (const scope of SCOPES) for (const key of Object.keys(s.overrides[scope])) keys.add(key);
  return keys;
}

/** The environment options every rules environment of this state shares. */
export function envOptions(s: SettingsState): Pick<RulesEnv, 'isBbl' | 'filamentCount' | 'supportsWrappingDetection'> {
  return {
    isBbl: s.vendor === 'BBL',
    ...(s.filamentCount !== undefined ? { filamentCount: s.filamentCount } : {}),
    ...(s.supportsWrappingDetection !== undefined ? { supportsWrappingDetection: s.supportsWrappingDetection } : {}),
  };
}

export function rulesEnv(s: SettingsState): RulesEnv {
  return {
    config: configView(s),
    context: 'global',
    ...envOptions(s),
    extruderCount: extruderCount(s),
    mode: s.mode ?? 'advanced',
    edited: editedKeys(s),
  };
}

export function evaluate(s: SettingsState): { env: RulesEnv; result: RulesResult } {
  const env = rulesEnv(s);
  return { env, result: evaluateRules(env) };
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/** Writes for one preset: the override text of each key, or null to remove the override. */
export type Writes = Record<string, string | null>;

export interface EditPlan {
  scope: SettingScope;
  writes: Writes;
  /** Orca's questions about the edit (rules.ts editEffects). */
  prompts: RulePrompt[];
  /** What Orca told the user about a value it changed at once (its OK-only dialogs). */
  notice?: string;
}

const EPSILON = 1e-4;
/** A number as the forms write it (12 significant digits; the rules' orcaNumber is Orca's 6). */
const formNumber = (n: number) => String(Number(n.toPrecision(12)));

/**
 * check_layer_height's first case (ConfigManipulation.cpp): a layer height of 0 is set to the printer's
 * minimum at once, and Orca says so. (Outside the printer's limits Orca keeps the value and asks whether
 * to adjust it: the rules' "layer-height-limits" issue.)
 */
export function zeroLayerHeight(s: SettingsState, scope: SettingScope, key: string, text: string): { text: string; notice: string } | null {
  if (scope !== 'process' || key !== 'layer_height') return null;
  const n = Number.parseFloat(text);
  if (!(Math.abs(n) < EPSILON)) return null;
  // layer_height_limits: the smallest minimum over the extruders.
  const min = Math.min(...slotsOf('min_layer_height', currentOf(s, 'machine', 'min_layer_height')).map(Number.parseFloat));
  if (!(min > EPSILON)) return null;
  return { text: formNumber(min), notice: `Layer height is too small. It will be set to the minimum (${formNumber(min)} mm).` };
}

/** The override (or null) that makes `key` hold the whole value `text`. */
export function writeFor(s: SettingsState, scope: SettingScope, key: string, text: string): string | null {
  return overrideFor(key, text, baseOf(s, scope, key));
}

/**
 * `key`'s whole value with slot `index` set to `slot` (undefined index = the option as a whole). A value
 * that stands for every slot is first spread over all of them: the nozzles, or for an option stored per
 * nozzle variant, the preset's variants.
 */
export function valueWithSlot(s: SettingsState, scope: SettingScope, key: string, index: number | undefined, slot: string): string {
  const current = currentOf(s, scope, key);
  const variants = settingDef(s.catalogue, key)?.slots === 'variant' ? variantCount(s, scope) : 0;
  return withSlot(key, current, index ?? 0, slot, Math.max(slotCount(s, scope, key), slotsOf(key, current).length, variants));
}

/**
 * What setting slot `index` of `key` to `slot` writes: the setting itself, plus the values Orca changes
 * together with it (its on_value_change handlers and the silent rewrites the edit starts), and the
 * questions Orca asks about it. `env` is the rules environment before the edit.
 */
export function planEdit(s: SettingsState, scope: SettingScope, key: string, index: number | undefined, slot: string, env: RulesEnv): EditPlan {
  const zero = zeroLayerHeight(s, scope, key, slot);
  const text = valueWithSlot(s, scope, key, index, zero?.text ?? slot);
  const writes: Writes = {};
  const effects = editEffects(scope, key, text, env, index ?? 0);
  for (const [k, value] of Object.entries(effects.patch)) if (k !== key) writes[k] = writeFor(s, scope, k, value);
  writes[key] = writeFor(s, scope, key, Object.hasOwn(effects.patch, key) ? effects.patch[key] : text);
  return zero ? { scope, writes, prompts: effects.prompts, notice: zero.notice } : { scope, writes, prompts: effects.prompts };
}

/** The writes that give several keys of one preset these whole values (a rule's fix, an answer). */
export function planValues(s: SettingsState, scope: SettingScope, values: Readonly<Record<string, string>>): Writes {
  const writes: Writes = {};
  for (const [key, text] of Object.entries(values)) writes[key] = writeFor(s, scope, key, text);
  return writes;
}

/** The write that puts slot `index` of `key` (or the whole setting) back to the preset's value. */
export function planReset(s: SettingsState, scope: SettingScope, key: string, index?: number): Writes {
  if (index === undefined || overrideOf(s, scope, key) === undefined) return { [key]: null };
  return { [key]: writeFor(s, scope, key, valueWithSlot(s, scope, key, index, baseSlot(s, scope, key, index))) };
}

/**
 * The writes that put several slots back to the preset's values (a row of several options, or both
 * machine-limit columns of one setting): each reset sees the ones before it.
 */
export function planResetAll(s: SettingsState, scope: SettingScope, items: readonly { key: string; index?: number }[]): Writes {
  const overrides = { ...s.overrides[scope] };
  const view: SettingsState = { ...s, overrides: { ...s.overrides, [scope]: overrides } };
  const writes: Writes = {};
  for (const { key, index } of items) {
    const value = planReset(view, scope, key, index)[key];
    writes[key] = value;
    if (value === null) delete overrides[key];
    else overrides[key] = value;
  }
  return writes;
}

/** Writes that change nothing are left out (so an edit that keeps a value does not touch the store). */
export function effectiveWrites(s: SettingsState, scope: SettingScope, writes: Writes): Writes {
  const out: Writes = {};
  for (const [key, value] of Object.entries(writes)) {
    const before = overrideOf(s, scope, key) ?? null;
    if (before !== value) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filament "Setting Overrides"
// ---------------------------------------------------------------------------------------------

/** Whether a nullable slot is unset ("nil": the value comes from the printer or process). */
export const isNil = (slot: string) => slot.trim() === 'nil';

/** The value an unset filament override slot uses: that slot of the printer's or process's setting. */
export function inheritedSlot(s: SettingsState, from: { scope: SettingScope; key: string }, index = 0): string {
  return currentSlot(s, from.scope, from.key, index);
}
