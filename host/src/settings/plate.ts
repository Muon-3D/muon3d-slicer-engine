// Orca's guards on a plate's own settings (its plate settings dialog):
//   - turning spiral vase on for a plate asks first (PartPlate::set_spiral_vase_mode ->
//     show_spiral_mode_settings_dialog), and Yes gives the plate's objects the settings spiral vase needs
//     (PartPlate::set_vase_mode_related_object_config);
//   - spiral vase with more than one object needs the "By object" print sequence, or Orca refuses to slice
//     (Print::validate);
//   - the questions Orca asks about a plate's print sequence (rules.ts editEffects, plate context).
//
// Provenance: ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D Technologies' own code:
// web/src/settings/plateGuards.ts); part of this repository and licensed like it (AGPL-3.0-only).
import type { ConfigValue } from '../../../packages/protocol/src/data.ts';
import type { SettingsState } from './model.ts';
import { editEffects, layeredConfig, type RulePrompt, type RulesEnv } from './rules.ts';

/** show_spiral_mode_settings_dialog(false): the question, with its two answers. */
export function spiralQuestion(i3: boolean): string {
  let text =
    'Spiral mode only works when wall loops is 1, support is disabled, clumping detection by probing is disabled, top shell layers is 0, sparse infill density is 0 and timelapse type is traditional.';
  if (i3) text += ' But machines with I3 structure will not generate timelapse videos.';
  return `${text} Change these settings automatically?`;
}

export const SPIRAL_YES = 'Change these settings and turn on spiral vase';
export const SPIRAL_NO = 'Cancel turning on spiral mode';

/** Print::validate's refusal of spiral vase with several objects printed layer by layer. */
export const SPIRAL_NEEDS_BY_OBJECT = 'Please select "By object" print sequence to print multiple objects in spiral vase mode.';

/** Whether Orca refuses the plate: spiral vase, more than one object, not printed by object. */
export function spiralNeedsByObject(spiral: boolean, printSequence: string, objectCount: number): boolean {
  return spiral && objectCount > 1 && printSequence !== 'by object';
}

/** set_vase_mode_related_object_config: what each object on the plate gets. */
export const VASE_OBJECT_SETTINGS: Readonly<Record<string, string>> = {
  wall_loops: '1',
  top_shell_layers: '0',
  sparse_infill_density: '0%',
  enable_support: '0',
  enforce_support_layers: '0',
  detect_thin_wall: '0',
  timelapse_type: '0',
  overhang_reverse: '0',
};

const same = (a: string | undefined, b: string) => a !== undefined && (a === b || Number.parseFloat(a) === Number.parseFloat(b));

/**
 * The per-object settings set_vase_mode_related_object_config writes: for each object, each vase setting
 * the global value or the object's own value differs from. Only the keys objects can hold (`objectKeys`);
 * the rest stay global. `global` reads the global value of a process key.
 */
export function vaseObjectWrites(
  objects: readonly { id: string; settings?: Readonly<Record<string, string>> }[],
  global: (key: string) => string | undefined,
  objectKeys: ReadonlySet<string>,
): { id: string; key: string; value: string }[] {
  const out: { id: string; key: string; value: string }[] = [];
  for (const o of objects) {
    for (const [key, value] of Object.entries(VASE_OBJECT_SETTINGS)) {
      if (!objectKeys.has(key)) continue;
      const own = o.settings?.[key];
      if (own !== undefined ? !same(own, value) : !same(global(key), value)) out.push({ id: o.id, key, value });
    }
  }
  return out;
}

/** The rules environment of a plate's settings: its own settings on top of the global ones. */
export function plateRulesEnv(state: SettingsState, plateSettings: Readonly<Record<string, string>>, objectCount: number): RulesEnv {
  const { overrides, configs } = state;
  const view = (c: Record<string, ConfigValue> | null) => c;
  return {
    config: layeredConfig(plateSettings, overrides.process, overrides.filament, overrides.machine, view(configs.process), view(configs.filament), view(configs.machine)),
    context: 'plate',
    isBbl: state.vendor === 'BBL',
    hasObjects: objectCount > 0,
    edited: new Set(Object.keys(plateSettings)),
    globalConfig: layeredConfig(overrides.process, overrides.filament, overrides.machine, view(configs.process), view(configs.filament), view(configs.machine)),
  };
}

/** Orca's questions about setting a plate's `key` to `value` (editEffects in the plate context). */
export function plateEditPrompts(key: string, value: string, env: RulesEnv): RulePrompt[] {
  return editEffects('process', key, value, env).prompts;
}
