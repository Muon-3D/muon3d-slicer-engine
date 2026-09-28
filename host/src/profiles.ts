// The profile ops (protocol 2.1: profiles.normalize, profiles.resolve, profiles.validate): their params checked
// before the engine loads (a bad request should not cost a download), the bridge called (engine/bridge/profiles.cpp:
// OrcaSlicer's own preset code does the work), and the results shaped as the protocol's.
import type { Config, PresetScope } from '../../packages/protocol/src/data.ts';
import type {
  ProfileFolder,
  ProfilesNormalizeParams,
  ProfilesNormalizeResult,
  ProfilesResolveParams,
  ProfilesResolveResult,
  ProfilesValidateParams,
  ProfilesValidateResult,
} from '../../packages/protocol/src/profiles.ts';
import { EngineJobError, type OrcaEngineModule } from './bridge.ts';
import { BadRequest } from './ops.ts';

export type ProfileOp = 'profiles.normalize' | 'profiles.resolve' | 'profiles.validate';

const TYPES: readonly PresetScope[] = ['machine', 'process', 'filament'];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPresetType = (v: unknown): v is PresetScope => typeof v === 'string' && (TYPES as readonly string[]).includes(v);

function folder(value: unknown, what: string): ProfileFolder {
  if (!isObject(value)) throw new BadRequest(`${what} must be a profile folder: { id, index, files }.`);
  if (typeof value.id !== 'string' || value.id === '' || /[\\/:]|^\.\.?$/.test(value.id)) {
    throw new BadRequest(`${what}.id must be the vendor's folder name, e.g. "Muon3D".`);
  }
  if (!isObject(value.index)) throw new BadRequest(`${what}.index must be the vendor's index file (${value.id}.json) as an object.`);
  if (!isObject(value.files)) throw new BadRequest(`${what}.files must map each sub_path of the index to its file's content.`);
  for (const [path, file] of Object.entries(value.files)) {
    if (!isObject(file)) throw new BadRequest(`${what}.files["${path}"] must be the file's JSON object.`);
    if (path === '' || path.startsWith('/') || /\\|:|(^|\/)\.\.?(\/|$)|\/\//.test(path)) {
      throw new BadRequest(`${what}.files has an unusable path "${path}" (relative, '/'-separated, no "..").`);
    }
  }
  return value as unknown as ProfileFolder;
}

/** The request as the bridge takes it (JSON text); throws BadRequest for a malformed one. */
export function profilesRequest(op: ProfileOp, params: unknown): string {
  if (!isObject(params)) throw new BadRequest(`${op} needs an object of params.`);
  if (op === 'profiles.normalize') {
    const p = params as unknown as ProfilesNormalizeParams;
    if (!Array.isArray(p.presets)) throw new BadRequest('profiles.normalize needs { presets: [{ type, config }] }.');
    p.presets.forEach((item, i) => {
      if (!isObject(item) || !isPresetType(item.type) || !isObject(item.config)) {
        throw new BadRequest(`"presets[${i}]" must be { type: machine | process | filament, config: <the preset file> }.`);
      }
    });
    return JSON.stringify({ presets: p.presets.map(({ type, config }) => ({ type, config })) });
  }
  if (op === 'profiles.resolve') {
    const p = params as unknown as ProfilesResolveParams;
    const vendor = folder(p.vendor, '"vendor"');
    const library = p.library === undefined || p.library === null ? null : folder(p.library, '"library"');
    if (p.presets !== undefined) {
      if (!Array.isArray(p.presets) || p.presets.some((x) => !isObject(x) || !isPresetType(x.type) || typeof x.name !== 'string')) {
        throw new BadRequest('"presets" must list { type: machine | process | filament, name }.');
      }
    }
    const compatibility = p.compatibility;
    if (compatibility !== undefined && typeof compatibility !== 'boolean' && !(Array.isArray(compatibility) && compatibility.every((n) => typeof n === 'string'))) {
      throw new BadRequest('"compatibility" must be true or list printer names.');
    }
    return JSON.stringify({
      vendor,
      library,
      ...(p.presets ? { presets: p.presets.map(({ type, name }) => ({ type, name })) } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
    });
  }
  const p = params as unknown as ProfilesValidateParams;
  if (!Array.isArray(p.vendors) || p.vendors.length === 0) {
    throw new BadRequest('profiles.validate needs { vendors: [profile folders] }: every vendor to load, the filament library among them.');
  }
  const vendors = p.vendors.map((v, i) => folder(v, `"vendors[${i}]"`));
  if (p.vendor !== undefined && (typeof p.vendor !== 'string' || !vendors.some((v) => v.id === p.vendor))) {
    throw new BadRequest('"vendor" must name one of "vendors" (the vendor to validate; absent: all).');
  }
  if (p.checkFilamentSubtypes !== undefined && typeof p.checkFilamentSubtypes !== 'boolean') {
    throw new BadRequest('"checkFilamentSubtypes" must be true or false.');
  }
  return JSON.stringify({ vendors, ...(p.vendor !== undefined ? { vendor: p.vendor } : {}), ...(p.checkFilamentSubtypes !== undefined ? { checkFilamentSubtypes: p.checkFilamentSubtypes } : {}) });
}

type ProfilesResult<K extends ProfileOp> = K extends 'profiles.normalize'
  ? ProfilesNormalizeResult
  : K extends 'profiles.resolve'
    ? ProfilesResolveResult
    : ProfilesValidateResult;

const BRIDGE = {
  'profiles.normalize': 'profilesNormalize',
  'profiles.resolve': 'profilesResolve',
  'profiles.validate': 'profilesValidate',
} as const;

/** Whether this engine build has the profile functions (builds before 0.3.0 do not). */
export function hasProfiles(engine: OrcaEngineModule): boolean {
  return typeof engine.profilesNormalize === 'function' && typeof engine.profilesResolve === 'function' && typeof engine.profilesValidate === 'function';
}

/** Runs a profile op on the engine: `request` from profilesRequest. Throws EngineJobError for a request Orca refused. */
export function runProfiles<K extends ProfileOp>(engine: OrcaEngineModule, op: K, request: string): ProfilesResult<K> {
  const fn = engine[BRIDGE[op]];
  if (typeof fn !== 'function') throw new EngineJobError({ code: 4, message: `This engine build has no ${op}: it predates protocol 2.1.` });
  const out = fn.call(engine, request);
  if (typeof out !== 'string') throw new EngineJobError(out.error);
  const result = JSON.parse(out) as ProfilesResult<K>;
  if (op === 'profiles.resolve') {
    // The bridge writes each preset as Orca saves it (name, from, version and the settings); the type makes it a
    // preset slice takes as it is, and a filament's id (Orca keeps it beside the config, and writes it into the
    // G-code's filament_ids) goes with it as a preset file carries it.
    for (const preset of (result as ProfilesResolveResult).presets) {
      const config = preset.config as Config;
      config.type = preset.type;
      if (preset.filamentId) config.filament_id = preset.filamentId;
    }
    for (const type of TYPES) {
      const defaults = (result as ProfilesResolveResult).defaults[type];
      delete defaults.name;
      delete defaults.from;
      delete defaults.version;
    }
  }
  return result;
}
