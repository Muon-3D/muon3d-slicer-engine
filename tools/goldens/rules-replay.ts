// Replays the settings-rules goldens: every preset case of test/goldens/settings/presets.json through
// Orca's settings rules (host/src/settings/rules.ts evaluateRules), and every scripted edit of
// scenarios.ts through the edit handlers (editEffects), in the global, object and plate contexts.
// record-rules.ts writes the result to test/goldens/settings/rules.json; test/goldens/rules.test.ts
// replays it and requires the same result.
//
// The replay is deliberately plain: it layers the values the way the rules read them (an object's
// settings, the plate's, the global overrides, then the presets) and applies each edit's patch, so
// the goldens describe the rules alone. The settings service's own planning (which override text an
// edit writes) has goldens of its own (test/goldens/settings/views.json).
import { createHash } from 'node:crypto';
import type { Config, ConfigValue } from '../../packages/protocol/src/data.ts';
import type { ConfigPatch } from '../../packages/protocol/src/data.ts';
import {
  editEffects,
  evaluateRules,
  layeredConfig,
  type EditEffects,
  type RulesEnv,
  type RulesResult,
  type TabRules,
} from '../../host/src/settings/rules.ts';
import {
  GLOBAL_SCRIPTS,
  OBJECT_SCRIPTS,
  PLATE_SCRIPTS,
  resolveCase,
  type PanelMode,
  type PresetCase,
  type PresetScope,
} from './scenarios.ts';

export interface PresetsFile {
  format: 1;
  cases: PresetCase[];
  presets: Record<string, Config>;
}

export interface CaseConfigs {
  machine: Config;
  process: Config;
  filament: Config;
  isBbl: boolean;
}

export function caseConfigs(file: PresetsFile, c: PresetCase): CaseConfigs {
  return { machine: file.presets[c.machine], process: file.presets[c.process], filament: file.presets[c.filament], isBbl: c.vendor === 'BBL' };
}

type Overrides = Record<PresetScope, Record<string, string>>;
const noOverrides = (): Overrides => ({ process: {}, filament: {}, machine: {} });

const nozzles = (machine: Config) => {
  const value = machine.nozzle_diameter;
  return Math.max(1, Array.isArray(value) ? value.length : String(value ?? '').split(',').length);
};

function globalEnv(configs: CaseConfigs, overrides: Overrides, mode: PanelMode, plate: ConfigPatch | undefined): RulesEnv {
  const bed = plate?.curr_bed_type !== undefined ? { curr_bed_type: plate.curr_bed_type } : null;
  return {
    config: layeredConfig(bed, overrides.process, overrides.filament, overrides.machine, configs.process, configs.filament, configs.machine),
    context: 'global',
    isBbl: configs.isBbl,
    extruderCount: nozzles(configs.machine),
    mode,
    edited: new Set([...Object.keys(overrides.process), ...Object.keys(overrides.filament), ...Object.keys(overrides.machine)]),
  };
}

// ---- Serialisation: sets sorted, results shared by content -------------------------------------------------

const sorted = (set: ReadonlySet<string>) => [...set].sort();

function tabJson(tab: TabRules) {
  return {
    hidden: sorted(tab.hidden),
    disabled: sorted(tab.disabled),
    labels: Object.fromEntries([...tab.labels].sort(([a], [b]) => a.localeCompare(b))),
    enumFilters: Object.fromEntries([...tab.enumFilters].sort(([a], [b]) => a.localeCompare(b))),
    lockedOverrides: sorted(tab.lockedOverrides),
  };
}

export function rulesJson(result: RulesResult) {
  return { process: tabJson(result.process), filament: tabJson(result.filament), machine: tabJson(result.machine), when: result.when, issues: result.issues };
}

export function effectsJson(effects: EditEffects) {
  return { patch: effects.patch, prompts: effects.prompts };
}

/** Results by a short hash of their JSON: most cases share them. */
class Table {
  readonly entries: Record<string, unknown> = {};
  put(value: unknown): string {
    const text = JSON.stringify(value);
    const id = createHash('sha256').update(text).digest('hex').slice(0, 12);
    this.entries[id] ??= JSON.parse(text);
    return id;
  }
}

// ---- The replay --------------------------------------------------------------------------------------------

/** The whole value an edit of slot `index` gives, from the value in effect (a preset array or override text). */
function wholeValue(current: ConfigValue | undefined, value: string, index: number | undefined): string {
  if (index === undefined) return value;
  const slots = Array.isArray(current) ? [...current] : typeof current === 'string' && current.includes(',') ? current.split(',') : [current ?? value];
  while (slots.length <= index) slots.push(slots[0] ?? value);
  slots[index] = value;
  return slots.every((s) => s === slots[0]) ? String(slots[0]) : slots.join(',');
}

export function replayRules(file: PresetsFile) {
  const table = new Table();
  const cases: Record<string, string> = {};
  for (const c of file.cases) cases[c.id] = table.put(rulesJson(evaluateRules(globalEnv(caseConfigs(file, c), noOverrides(), 'advanced', undefined))));

  const global: Record<string, unknown[]> = {};
  for (const script of GLOBAL_SCRIPTS) {
    const configs = caseConfigs(file, resolveCase(file.cases, script.case));
    const overrides = noOverrides();
    const mode = script.mode ?? 'advanced';
    global[script.id] = script.steps.map((step) => {
      const env = globalEnv(configs, overrides, mode, script.plate);
      const text = wholeValue(env.config.get(step.key), step.value, step.index);
      const effects = editEffects(step.scope, step.key, text, env, step.index ?? 0);
      overrides[step.scope][step.key] = effects.patch[step.key] ?? text;
      for (const [k, v] of Object.entries(effects.patch)) overrides[step.scope][k] = v;
      return { step, effects: effectsJson(effects), after: table.put(rulesJson(evaluateRules(globalEnv(configs, overrides, mode, script.plate)))) };
    });
  }

  const object: Record<string, unknown[]> = {};
  for (const script of OBJECT_SCRIPTS) {
    const configs = caseConfigs(file, resolveCase(file.cases, script.case));
    const overrides = { ...noOverrides(), ...structuredClone(script.overrides ?? {}) } as Overrides;
    const plate = script.plate ?? {};
    const settings: Record<string, string> = { ...(script.settings ?? {}) };
    const mode = script.mode ?? 'advanced';
    const env = (): RulesEnv => {
      const g = globalEnv(configs, overrides, mode, undefined);
      const plateView = layeredConfig(plate, overrides.process, overrides.filament, overrides.machine, configs.process, configs.filament, configs.machine);
      return {
        ...g,
        config: layeredConfig(settings, plate, overrides.process, overrides.filament, overrides.machine, configs.process, configs.filament, configs.machine),
        context: 'object',
        globalConfig: plateView,
        edited: new Set([...g.edited!, ...Object.keys(plate), ...Object.keys(settings)]),
      };
    };
    object[script.id] = script.steps.map((step) => {
      let effects: EditEffects | null = null;
      if ('add' in step) {
        const value = env().config.get(step.add);
        settings[step.add] = Array.isArray(value) ? value.join(',') : (value ?? '');
      } else if ('remove' in step) {
        delete settings[step.remove];
      } else {
        effects = editEffects('process', step.set, step.value, env());
        settings[step.set] = effects.patch[step.set] ?? step.value;
      }
      return { step, effects: effects && effectsJson(effects), settings: { ...settings }, after: table.put(rulesJson(evaluateRules(env()))) };
    });
  }

  const plate: Record<string, unknown[]> = {};
  for (const script of PLATE_SCRIPTS) {
    const configs = caseConfigs(file, resolveCase(file.cases, script.case));
    const overrides = { ...noOverrides(), ...structuredClone(script.overrides ?? {}) } as Overrides;
    const settings: Record<string, string> = { ...(script.settings ?? {}) };
    const env = (): RulesEnv => {
      const g = globalEnv(configs, overrides, 'advanced', undefined);
      return {
        config: layeredConfig(settings, overrides.process, overrides.filament, overrides.machine, configs.process, configs.filament, configs.machine),
        context: 'plate',
        isBbl: configs.isBbl,
        hasObjects: script.objects.length > 0,
        edited: new Set(Object.keys(settings)),
        globalConfig: g.config,
      };
    };
    plate[script.id] = script.steps.map((step) => {
      const effects = step.value === null ? null : editEffects('process', step.key, step.value, env());
      if (step.value === null) delete settings[step.key];
      else settings[step.key] = step.value;
      return { step, effects: effects && effectsJson(effects), after: table.put(rulesJson(evaluateRules(env()))) };
    });
  }

  return { format: 1, cases, global, object, plate, results: table.entries };
}
