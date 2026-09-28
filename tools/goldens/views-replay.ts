// Replays the settings-view goldens (test/goldens/settings/views.json) through the settings service
// (host/src/settings/service.ts, the code behind settings.view and settings.edit): the settings forms of
// every preset case, of the VIEW_CASES in every mode and for every nozzle (with values), and every scripted
// edit of scenarios.ts in the global, object and plate scopes, with what each writes, asks and says.
//
// The goldens were first recorded from the Muon3D Slicer app's own settings code (its settings panel,
// object settings list and plate settings), before that code moved into this service; the service
// reproduces them exactly. Each document is reduced to a projection: what a renderer shows (pages, groups,
// rows and their labels, cells with slot, label, greyed state, narrowed enums, values), and the issues.
import { createHash } from 'node:crypto';
import type { Config, ConfigPatch } from '../../packages/protocol/src/data.ts';
import type { SettingsEditResult, SettingsForm, SettingsView } from '../../packages/protocol/src/settings.ts';
import type { SettingsService } from '../../host/src/settings/service.ts';
import type { PresetsFile } from './rules-replay.ts';
import { GLOBAL_SCRIPTS, OBJECT_SCRIPTS, PLATE_SCRIPTS, VIEW_CASES, resolveCase, type PanelMode, type PresetCase, type PresetScope } from './scenarios.ts';

export const TAB_SCOPES: readonly PresetScope[] = ['process', 'filament', 'machine'];
export const MODES: readonly PanelMode[] = ['simple', 'advanced', 'expert'];

/** JSON with object keys sorted and undefined dropped: projections compare by it. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export class Table {
  readonly entries: Record<string, unknown> = {};
  put(value: unknown): string {
    const text = canonical(value);
    const id = createHash('sha256').update(text).digest('hex').slice(0, 12);
    this.entries[id] ??= JSON.parse(text);
    return id;
  }
}

// ---- Projections ---------------------------------------------------------------------------------------------

export function projectTab(doc: SettingsView, form: SettingsForm) {
  const lines = new Map(form.pages!.flatMap((p) => p.groups.flatMap((g) => g.lines.map((l) => [l.id, l] as const))));
  return {
    pages: doc.tab!.pages.map((p) => ({
      id: p.id,
      title: p.title,
      extruder: p.extruder,
      picker: p.nozzlePicker === true,
      issues: (p.issues ?? 0) > 0,
      groups: p.groups.map((g) => ({
        id: g.id,
        lines: g.lines.map((l) => {
          const fl = lines.get(l.id)!;
          return {
            label: l.label ?? fl.label,
            locked: l.locked === true || undefined,
            cells: l.cells.map((c) => ({
              key: c.key,
              index: c.index,
              label: c.label ?? fl.options.find((o) => o.key === c.key)!.label,
              disabled: c.disabled === true || undefined,
              choices: c.choices,
              value: c.value,
              inherited: c.inherited,
            })),
          };
        }),
      })),
    })),
    issues: doc.issues,
  };
}

export function projectObject(doc: SettingsView, form: SettingsForm) {
  const object = doc.object!;
  return {
    groups: object.groups.map((g) => ({
      title: g.title,
      rows: g.rows.map((r) =>
        r.unknown
          ? { key: r.key, unknown: true, value: r.value }
          : { key: r.key, label: r.label ?? form.options[r.key]?.label ?? r.key, disabled: r.disabled, choices: r.choices, value: r.value, inherited: r.inherited },
      ),
    })),
    add: object.add,
    limits: object.limits.layerHeight,
    issues: doc.issues,
  };
}

export function projectEdit(result: Pick<SettingsEditResult, 'writes' | 'prompts' | 'notices' | 'objects'>) {
  return { writes: result.writes, objects: result.objects, prompts: result.prompts, notices: result.notices };
}

// ---- The replay ----------------------------------------------------------------------------------------------

export interface ViewGoldenOptions {
  /** The keys the recording app never shows (its policy). */
  omit: string[];
  /** The recording app's frequent object settings. */
  frequent: string[];
}

const refs = (file: PresetsFile, c: PresetCase) => ({
  machine: { hash: c.machine, config: file.presets[c.machine] as Config },
  process: { hash: c.process, config: file.presets[c.process] as Config },
  filament: { hash: c.filament, config: file.presets[c.filament] as Config },
});
const vendorEnv = (c: PresetCase) => (c.vendor === 'BBL' ? { vendor: 'BBL' } : {});
const nozzles = (config: Config) => (Array.isArray(config.nozzle_diameter) ? config.nozzle_diameter.length : String(config.nozzle_diameter ?? '').split(',').length) || 1;

type Overrides = Record<PresetScope, Record<string, string>>;
function withWrites(own: Record<string, string>, writes: Record<string, string | null>): Record<string, string> {
  const out = { ...own };
  for (const [k, v] of Object.entries(writes)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function replayViews(file: PresetsFile, service: SettingsService, options: ViewGoldenOptions) {
  const table = new Table();
  const { omit, frequent } = options;
  const form = (doc: SettingsView, cache: Map<string, SettingsForm>) => {
    if (doc.form) cache.set(doc.formId, doc.form);
    return cache.get(doc.formId)!;
  };
  const forms = new Map<string, SettingsForm>();

  // Every case, every tab, Expert, the first nozzle, without values.
  const cases: Record<string, Record<string, string>> = {};
  for (const c of file.cases) {
    const out: Record<string, string> = {};
    for (const scope of TAB_SCOPES) {
      const doc = service.view({ scope, presets: refs(file, c), omit, env: { mode: 'expert', ...vendorEnv(c) } });
      out[scope] = table.put(projectTab(doc, form(doc, forms)));
    }
    cases[c.id] = out;
  }

  // The view cases: every mode, every nozzle; the values in Expert (the modes only show fewer rows).
  const views: Record<string, Record<string, string>> = {};
  for (const id of VIEW_CASES) {
    const c = resolveCase(file.cases, id);
    const out: Record<string, string> = {};
    const count = nozzles(file.presets[c.machine] as Config);
    for (const scope of TAB_SCOPES) {
      for (const mode of MODES) {
        for (let extruder = 0; extruder < count; extruder++) {
          const doc = service.view({ scope, presets: refs(file, c), omit, values: mode === 'expert', env: { mode, extruder, ...vendorEnv(c) } });
          out[`${scope}/${mode}/${extruder}`] = table.put(projectTab(doc, form(doc, forms)));
        }
      }
    }
    views[c.id] = out;
  }

  const global: Record<string, unknown[]> = {};
  for (const script of GLOBAL_SCRIPTS) {
    const c = resolveCase(file.cases, script.case);
    let overrides: Overrides = { process: {}, filament: {}, machine: {} };
    const env = { mode: script.mode ?? 'advanced', ...vendorEnv(c) };
    global[script.id] = script.steps.map((step) => {
      const result = service.edit({
        scope: step.scope,
        presets: refs(file, c),
        overrides,
        ...(script.plate ? { plate: script.plate } : {}),
        env,
        edit: { set: step.key, value: step.value, ...(step.index !== undefined ? { index: step.index } : {}) },
      });
      overrides = { ...overrides, [step.scope]: withWrites(overrides[step.scope], result.writes) };
      const doc = service.view({ scope: step.scope, presets: refs(file, c), overrides, ...(script.plate ? { plate: script.plate } : {}), omit, env });
      return { step, edit: projectEdit(result), view: table.put(projectTab(doc, form(doc, forms))) };
    });
  }

  const object: Record<string, unknown[]> = {};
  for (const script of OBJECT_SCRIPTS) {
    const c = resolveCase(file.cases, script.case);
    const overrides = { process: {}, filament: {}, machine: {}, ...structuredClone(script.overrides ?? {}) } as Overrides;
    let settings: Record<string, string> = { ...(script.settings ?? {}) };
    const env = { mode: script.mode ?? 'advanced', frequent, ...vendorEnv(c) };
    const base = { scope: 'object' as const, presets: refs(file, c), overrides, ...(script.plate ? { plate: script.plate } : {}), env };
    object[script.id] = script.steps.map((step) => {
      const edit = 'add' in step ? { add: step.add } : 'remove' in step ? { reset: [{ key: step.remove }] } : { set: step.set, value: step.value };
      const result = service.edit({ ...base, object: settings, edit });
      settings = withWrites(settings, result.writes);
      const doc = service.view({ ...base, object: settings, omit, values: true });
      return { step, edit: projectEdit(result), view: table.put(projectObject(doc, form(doc, forms))) };
    });
  }

  const plate: Record<string, unknown[]> = {};
  for (const script of PLATE_SCRIPTS) {
    const c = resolveCase(file.cases, script.case);
    const overrides = { process: {}, filament: {}, machine: {}, ...structuredClone(script.overrides ?? {}) } as Overrides;
    let settings: ConfigPatch = { ...(script.settings ?? {}) };
    let objects = script.objects.map((o) => ({ id: o.id, settings: { ...(o.settings ?? {}) } }));
    const base = () => ({ scope: 'plate' as const, presets: refs(file, c), overrides, plate: settings, objects, env: vendorEnv(c) });
    const apply = (result: SettingsEditResult) => {
      settings = withWrites(settings, result.writes);
      objects = objects.map((o) => {
        const w = result.objects?.find((x) => x.id === o.id);
        return w ? { ...o, settings: withWrites(o.settings, w.writes) } : o;
      });
    };
    plate[script.id] = script.steps.map((step) => {
      const result = service.edit({ ...base(), edit: step.value === null ? { reset: [{ key: step.key }] } : { set: step.key, value: step.value } });
      apply(result);
      const blocking = result.prompts.find((p) => p.blocking);
      let answer: ReturnType<typeof projectEdit> | undefined;
      if (blocking) {
        // The user answers Orca's question with its first choice.
        const [yes] = blocking.choices;
        const answered = service.edit({ ...base(), edit: { apply: yes.values, ...(yes.objects ? { objects: yes.objects } : {}) } });
        apply(answered);
        answer = projectEdit(answered);
      }
      const doc = service.view({ ...base(), omit });
      return {
        step,
        edit: projectEdit(result),
        answer,
        settings: { ...settings },
        objects: objects.map((o) => ({ id: o.id, settings: o.settings })),
        needsByObject: doc.issues.some((i) => i.id === 'spiral-vase-by-object'),
      };
    });
  }

  return { format: 1, omit, frequent, cases, views, global, object, plate, results: table.entries };
}
