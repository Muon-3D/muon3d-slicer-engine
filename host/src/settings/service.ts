// The settings service: the ops settings.catalogue, settings.view and settings.edit. Stateless between
// requests except for two caches: configs by the hash the client names them by (the last CONFIG_CACHE_SIZE),
// and the static forms (form.ts). Needs no wasm; the host loads this module on the first settings op.
import type { SettingsCatalogue } from '../../../packages/protocol/src/catalogue.ts';
import type { Config, ConfigPatch, PresetScope } from '../../../packages/protocol/src/data.ts';
import type {
  ConfigRef,
  SettingsEdit,
  SettingsEditParams,
  SettingsEditResult,
  SettingsEnv,
  SettingsInput,
  SettingsScope,
  SettingsView,
  SettingsViewParams,
  ViewOptions,
} from '../../../packages/protocol/src/settings.ts';
import { CATALOGUE } from './catalogue.ts';
import { SettingsRequestError, planSettingsEdit } from './edit.ts';
import { setHostBuild, settingsForm } from './form.ts';
import { layoutCatalogue } from './layout.ts';
import type { SettingsState } from './model.ts';
import { objectView, plateView, tabView } from './view.ts';

export { SettingsRequestError };

const BAD_REQUEST = 5;
const NOT_CACHED = 8;
export const CONFIG_CACHE_SIZE = 32;

const SCOPES: readonly SettingsScope[] = ['process', 'filament', 'machine', 'object', 'plate'];
const PRESETS: readonly PresetScope[] = ['machine', 'process', 'filament'];
const MODES = ['simple', 'advanced', 'expert'];

const bad = (message: string, detail?: string) => new SettingsRequestError(BAD_REQUEST, message, detail);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function patch(value: unknown, what: string): ConfigPatch | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw bad(`${what} must be a map of setting keys to text.`);
  for (const [k, v] of Object.entries(value)) if (typeof v !== 'string') throw bad(`${what}: the value of "${k}" must be text.`);
  return value as ConfigPatch;
}

function config(value: unknown, what: string): Config {
  if (!isObject(value)) throw bad(`${what} must be a preset: a map of setting keys to text or lists of text.`);
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) throw bad(`${what}: the value of "${k}" must be text or a list of text.`);
  }
  return value as Config;
}

export class SettingsService {
  private readonly configs = new Map<string, Config>();
  readonly catalogue: SettingsCatalogue;

  constructor(options: { build?: string; catalogue?: SettingsCatalogue } = {}) {
    this.catalogue = options.catalogue ?? CATALOGUE;
    if (options.build) setHostBuild(options.build);
  }

  /** settings.catalogue: the catalogue, format 2 (locales other than English are not available yet). */
  catalogueDocument(): SettingsCatalogue {
    return this.catalogue;
  }

  view(params: SettingsViewParams): SettingsView {
    const scope = this.scope(params);
    const input = this.input(params, params);
    return this.document(scope, input, params, params.version);
  }

  edit(params: SettingsEditParams): SettingsEditResult {
    const scope = this.scope(params);
    const viewOptions: ViewOptions | undefined = params.view === true ? {} : isObject(params.view) ? (params.view as ViewOptions) : undefined;
    const input = this.input(params, viewOptions ?? {});
    const edit = this.editOf(params.edit);
    const planned = planSettingsEdit(scope, edit, { state: input.state, object: input.object, objects: input.objects });
    const result: SettingsEditResult = { version: params.version ?? null, ...planned };
    if (viewOptions) result.view = this.document(scope, applied(scope, input, planned), viewOptions, params.version);
    return result;
  }

  // ---- Decoding --------------------------------------------------------------------------------------------

  private scope(params: { scope?: unknown }): SettingsScope {
    if (!SCOPES.includes(params.scope as SettingsScope)) throw bad(`"scope" must be one of ${SCOPES.join(', ')}.`);
    return params.scope as SettingsScope;
  }

  private editOf(edit: unknown): SettingsEdit {
    if (!isObject(edit)) throw bad('"edit" must be one of { set, value, index? }, { apply }, { reset }, { add }.');
    if (typeof edit.set === 'string') {
      if (typeof edit.value !== 'string') throw bad('"edit.value" must be text.');
      if (edit.index !== undefined && !(Number.isInteger(edit.index) && (edit.index as number) >= 0)) throw bad('"edit.index" must be a slot number.');
      return edit as SettingsEdit;
    }
    if (edit.apply !== undefined) {
      patch(edit.apply, '"edit.apply"');
      if (edit.objects !== undefined) {
        if (!Array.isArray(edit.objects)) throw bad('"edit.objects" must be a list.');
        for (const o of edit.objects) {
          if (!isObject(o) || typeof o.id !== 'string') throw bad('each of "edit.objects" needs an "id".');
          patch(o.values, `"edit.objects" ${o.id}`);
        }
      }
      return edit as SettingsEdit;
    }
    if (Array.isArray(edit.reset)) {
      for (const r of edit.reset) if (!isObject(r) || typeof r.key !== 'string') throw bad('each of "edit.reset" needs a "key".');
      return edit as SettingsEdit;
    }
    if (typeof edit.add === 'string') return edit as SettingsEdit;
    throw bad('"edit" must be one of { set, value, index? }, { apply }, { reset }, { add }.');
  }

  private preset(ref: unknown, which: PresetScope): Config {
    if (!isObject(ref) || typeof ref.hash !== 'string' || ref.hash === '') throw bad(`"presets.${which}" must be { hash, config? }.`);
    const { hash } = ref as unknown as ConfigRef;
    if (ref.config !== undefined) {
      const value = config(ref.config, `"presets.${which}.config"`);
      this.configs.delete(hash);
      this.configs.set(hash, value);
      while (this.configs.size > CONFIG_CACHE_SIZE) this.configs.delete(this.configs.keys().next().value!);
      return value;
    }
    const cached = this.configs.get(hash);
    if (!cached) throw new SettingsRequestError(NOT_CACHED, `The ${which} preset ${hash} is not cached here: send it with its config.`, hash);
    // Most recently used last.
    this.configs.delete(hash);
    this.configs.set(hash, cached);
    return cached;
  }

  private input(params: SettingsInput, view: ViewOptions): Input {
    if (!isObject(params.presets)) throw bad('"presets" must name the machine, process and filament presets.');
    const presets = Object.fromEntries(PRESETS.map((p) => [p, this.preset((params.presets as Record<string, unknown>)[p], p)])) as Record<PresetScope, Config>;
    const overrides: Record<string, unknown> | null = isObject(params.overrides) ? params.overrides : params.overrides === undefined ? {} : null;
    if (!overrides) throw bad('"overrides" must be a map of presets to overrides.');
    if (params.env !== undefined && !isObject(params.env)) throw bad('"env" must be an object.');
    const env: SettingsEnv = params.env ?? {};
    if (env.mode !== undefined && !MODES.includes(env.mode)) throw bad(`"env.mode" must be one of ${MODES.join(', ')}.`);
    if (view.omit !== undefined && !(Array.isArray(view.omit) && view.omit.every((k) => typeof k === 'string'))) throw bad('"omit" must be a list of setting keys.');
    const objects = params.objects;
    if (objects !== undefined && !(Array.isArray(objects) && objects.every((o) => isObject(o) && typeof o.id === 'string'))) {
      throw bad('"objects" must be a list of { id, settings? }.');
    }
    const state: SettingsState = {
      catalogue: layoutCatalogue(this.catalogue, view.omit),
      configs: presets,
      overrides: {
        process: patch(overrides.process, '"overrides.process"') ?? {},
        filament: patch(overrides.filament, '"overrides.filament"') ?? {},
        machine: patch(overrides.machine, '"overrides.machine"') ?? {},
      },
      mode: env.mode ?? 'advanced',
    };
    const plate = patch(params.plate, '"plate"');
    if (plate) state.plateSettings = plate;
    if (typeof env.vendor === 'string') state.vendor = env.vendor;
    if (isObject(env.bedType)) state.bedType = { defaultType: String(env.bedType.default), selectable: env.bedType.selectable === true };
    if (typeof env.filamentCount === 'number') state.filamentCount = env.filamentCount;
    if (typeof env.supportsWrappingDetection === 'boolean') state.supportsWrappingDetection = env.supportsWrappingDetection;
    return {
      state,
      env,
      object: patch(params.object, '"object"'),
      objects: objects?.map((o) => ({ id: o.id, ...(o.settings ? { settings: patch(o.settings, `object ${o.id}`)! } : {}) })),
    };
  }

  // ---- The document ------------------------------------------------------------------------------------------

  private document(scope: SettingsScope, input: Input, options: ViewOptions, version: number | undefined): SettingsView {
    const { state, env } = input;
    const form = settingsForm(state.catalogue, scope, state.filamentCount ?? 1);
    const values = options.values === true;
    const doc: SettingsView = { format: 1, scope, version: version ?? null, formId: form.id, issues: [] };
    if (options.form !== form.id) doc.form = form;
    if (scope === 'object') {
      const { object, issues } = objectView(state, input.object, env, values);
      doc.object = object;
      doc.issues = issues;
    } else if (scope === 'plate') {
      const objectCount = env.objectCount ?? input.objects?.length ?? 0;
      const { plate, issues } = plateView(state, state.plateSettings ?? {}, objectCount);
      doc.plate = plate;
      doc.issues = issues;
    } else {
      const { tab, issues } = tabView(state, scope, env, values);
      doc.tab = tab;
      doc.issues = issues;
    }
    return doc;
  }
}

interface Input {
  state: SettingsState;
  env: SettingsEnv;
  object?: ConfigPatch;
  objects?: Array<{ id: string; settings?: ConfigPatch }>;
}

const withWrites = (own: Readonly<Record<string, string>> | undefined, writes: Record<string, string | null>) => {
  const out = { ...own };
  for (const [k, v] of Object.entries(writes)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};

/** The input with an edit's writes applied (for the document after the edit). */
function applied(scope: SettingsScope, input: Input, result: Omit<SettingsEditResult, 'version' | 'view'>): Input {
  const state = { ...input.state };
  if (scope === 'object') return { ...input, object: withWrites(input.object, result.writes) };
  if (scope === 'plate') {
    state.plateSettings = withWrites(state.plateSettings, result.writes);
    const objects = input.objects?.map((o) => {
      const w = result.objects?.find((x) => x.id === o.id);
      return w ? { ...o, settings: withWrites(o.settings, w.writes) } : o;
    });
    return { ...input, state, objects };
  }
  state.overrides = { ...state.overrides, [scope]: withWrites(state.overrides[scope as PresetScope], result.writes) };
  return { ...input, state };
}
