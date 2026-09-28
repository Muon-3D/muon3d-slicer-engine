// The engine as the profile tools use it, in this process: the built wasm (ENGINE_DIR, default dist/), driven
// through the same code the host runs for the profile ops (host/src/profiles.ts).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Variant } from '../../packages/protocol/src/envelope.ts';
import type { EngineManifest } from '../../packages/protocol/src/manifest.ts';
import type {
  ProfileFolder,
  ProfilesNormalizeResult,
  ProfilesResolveParams,
  ProfilesResolveResult,
  ProfilesValidateParams,
  ProfilesValidateResult,
  PresetFile,
} from '../../packages/protocol/src/profiles.ts';
import { loadEngine, type OrcaEngineModule } from '../../host/src/bridge.ts';
import { readConfigDefinitions } from '../../host/src/configDefinitions.ts';
import { hasProfiles, profilesRequest, runProfiles } from '../../host/src/profiles.ts';
import { repoRoot } from './tree.ts';

export class ProfileEngine {
  readonly module: OrcaEngineModule;
  readonly manifest: EngineManifest;
  readonly variant: Variant;

  private constructor(module: OrcaEngineModule, manifest: EngineManifest, variant: Variant) {
    this.module = module;
    this.manifest = manifest;
    this.variant = variant;
  }

  /** Loads the built engine (st unless ENGINE_VARIANT says mt: the profile ops are single-threaded anyway). */
  static async load(dir = path.resolve(process.env.ENGINE_DIR ?? path.join(repoRoot, 'dist'))): Promise<ProfileEngine> {
    const variant = (process.env.ENGINE_VARIANT ?? 'st') as Variant;
    const manifestPath = path.join(dir, 'manifest.json');
    if (!existsSync(path.join(dir, `engine-${variant}.mjs`)) || !existsSync(manifestPath)) {
      throw new Error(`No ${variant} engine in ${dir}: build it (npm run build:engine -- ${variant}) or set ENGINE_DIR.`);
    }
    const { engine } = await loadEngine(pathToFileURL(dir + path.sep).href, variant);
    if (!hasProfiles(engine)) throw new Error(`The engine in ${dir} has no profile functions: it predates 0.3.0. Rebuild it.`);
    return new ProfileEngine(engine, JSON.parse(readFileSync(manifestPath, 'utf8')) as EngineManifest, variant);
  }

  normalize(presets: PresetFile[]): ProfilesNormalizeResult {
    return runProfiles(this.module, 'profiles.normalize', profilesRequest('profiles.normalize', { presets }));
  }

  resolve(params: ProfilesResolveParams): ProfilesResolveResult {
    return runProfiles(this.module, 'profiles.resolve', profilesRequest('profiles.resolve', params));
  }

  validate(params: ProfilesValidateParams): ProfilesValidateResult {
    return runProfiles(this.module, 'profiles.validate', profilesRequest('profiles.validate', params));
  }

  /** sha256 (hex) of config.definitions' result as JSON text: ProfileIndex.engine.optionsHash. */
  optionsHash(): string {
    return createHash('sha256').update(JSON.stringify(readConfigDefinitions(this.module))).digest('hex');
  }

  orca(): { version: string; commit: string } {
    const v = this.module.version();
    return { version: v.orcaVersion, commit: v.orcaCommit };
  }
}

export type { ProfileFolder };
