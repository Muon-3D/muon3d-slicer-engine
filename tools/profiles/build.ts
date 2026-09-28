// Builds a profile set (docs/PROFILES.md): OrcaSlicer's vendor profiles at the pin (orca/resources/profiles) with
// the Muon3D overlay (profiles/muon3d/) in place of Orca's Muon3D folder, normalised and flattened by the engine
// itself (the profile ops: OrcaSlicer's own preset code), packed for a static site.
//
//   node tools/profiles/build.ts --out <folder> [--set <name>] [--vendors Muon3D,...]
//
// Writes into <folder>:
//   profiles/<set>/index.<hash>.json            the vendors, their printers and models, the type defaults
//   profiles/<set>/vendors/<id>.<hash>.json.gz  one bundle per vendor, inheritance kept (VendorBundle)
//   profiles/<set>/all.<hash>.json.gz           every bundle in one file
//   profiles/<set>/SOURCE.json                  where the source is: this repository, the Orca commit, the overlay
//   profiles/assets/<sha256>.<ext>              bed models, bed textures, covers (PNG covers as WebP)
//   goldens.json.gz                             what Orca's loader makes of every selectable preset (hashes)
//   report.json                                 what normalising changed, the validator's verdict, the sizes
//   README.md, LICENSE
//
// It fails when OrcaSlicer's profile validator finds an error anywhere in the tree, when an overlay file holds a
// key the engine does not read as it is (legacy, unknown, misplaced or substituted), or when the reference
// flattening (flattenPreset) with the recorded adjustments does not give Orca's result for every preset.
//
// Environment: ENGINE_DIR (the built engine, default dist/), ORCA_SRC (default the orca/ submodule).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import type { Config, PresetScope } from '../../packages/protocol/src/data.ts';
import {
  PRESET_TYPES,
  PROFILE_SET_FORMAT,
  canonicalConfigJson,
  flattenPreset,
  type ProfileFileRef,
  type ProfileGoldens,
  type ProfileIndex,
  type ProfileIndexVendor,
  type VendorBundle,
} from '../../packages/protocol/src/profileSet.ts';
import type { NormalizedPreset, ProfilesResolveResult } from '../../packages/protocol/src/profiles.ts';
import { ProfileEngine } from './engine.ts';
import { DEFAULT_OVERLAY, LIBRARY, defaultOrcaProfiles, listOf, readTree, repoRoot, treeDigest, type VendorSource } from './tree.ts';

const REPOSITORY = 'https://github.com/Muon-3D/muon3d-slicer-engine';

export interface BuildOptions {
  out: string;
  set: string;
  vendors?: string[];
  log?: (line: string) => void;
}

export interface VendorReport {
  files: number;
  selectable: Record<PresetScope, number>;
  renamed: Record<string, string>;
  dropped: Record<string, number>;
  misplaced: Record<string, number>;
  substituted: number;
  adjusted: number;
  loaderErrors: string[];
  missingAssets: string[];
}

export interface BuildResult {
  index: ProfileIndex;
  indexPath: string;
  goldens: ProfileGoldens;
  report: {
    set: string;
    validator: { ok: boolean; errors: string[]; warnings: string[] };
    vendors: Record<string, VendorReport>;
    sizes: Record<string, number>;
  };
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** gzip -9 with a fixed header (no time; OS "Unix"), so the bytes do not depend on where it runs. */
export function gzip(data: string | Uint8Array): Buffer {
  const out = gzipSync(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { level: 9 });
  out.writeUInt32LE(0, 4);
  out[9] = 3;
  return out;
}

/** A name that JavaScript would reorder as an object key (an array index) breaks the load order a bundle keeps. */
const reorderedKey = (name: string) => /^(0|[1-9]\d*)$/.test(name) && Number(name) < 2 ** 32 - 1;

function scriptValue(file: string, name: string): string {
  const m = new RegExp(`^${name}=(\\S+)`, 'm').exec(readFileSync(path.join(repoRoot, file), 'utf8'));
  if (!m) throw new Error(`${file} has no ${name}=`);
  return m[1];
}

/** This repository's commit, from git or from a source bundle's SOURCE_COMMITS; "-dirty" with uncommitted profile changes. */
function sourceCommit(): string {
  const commits = path.join(repoRoot, 'SOURCE_COMMITS');
  if (!existsSync(path.join(repoRoot, '.git')) && existsSync(commits)) {
    const m = /^engine=(\S+)/m.exec(readFileSync(commits, 'utf8'));
    if (m) return m[1];
  }
  try {
    const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'profiles', 'tools/profiles'], { encoding: 'utf8' }).trim();
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return 'unknown';
  }
}

/** The Orca checkout's commit, when it is a git checkout. */
function orcaCheckoutCommit(): string | null {
  try {
    return execFileSync('git', ['-C', path.dirname(path.dirname(defaultOrcaProfiles())), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function count(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

const listHash = (names: string[]) => sha256([...names].sort().join('\n'));

class AssetStore {
  readonly files = new Map<string, Buffer>();
  private readonly bySource = new Map<string, string>();

  /** Adds a vendor file; covers (PNG) become WebP. Returns the path relative to profiles/: assets/<sha256>.<ext>. */
  async add(file: string, kind: 'cover' | 'model' | 'texture'): Promise<string> {
    const known = this.bySource.get(file);
    if (known) return known;
    let data = readFileSync(file);
    let ext = path.extname(file).slice(1).toLowerCase();
    if (kind === 'cover' && ext === 'png') {
      data = await sharp(data).webp({ quality: 80, alphaQuality: 100, effort: 4 }).toBuffer();
      ext = 'webp';
    }
    const name = `assets/${sha256(data)}.${ext}`;
    this.files.set(name, data);
    this.bySource.set(file, name);
    return name;
  }
}

export async function buildProfileSet(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  sharp.concurrency(1);
  const engine = await ProfileEngine.load();
  const orca = engine.orca();
  const checkout = orcaCheckoutCommit();
  if (checkout && checkout !== orca.commit) {
    throw new Error(`The engine is built from Orca ${orca.commit}, but ${defaultOrcaProfiles()} is at ${checkout}: a set is built from the tree the engine is built from.`);
  }

  // The whole tree for the validator (its reference checks look across every vendor); the chosen vendors for the set.
  const tree = readTree();
  const chosen = options.vendors ? new Set([LIBRARY, ...options.vendors]) : null;
  for (const id of chosen ?? []) if (!tree.some((v) => v.folder.id === id)) throw new Error(`No vendor "${id}" in the tree.`);
  const vendors = tree.filter((v) => !chosen || chosen.has(v.folder.id));

  log(`OrcaSlicer ${orca.version} @ ${orca.commit.slice(0, 10)}; ${tree.length} vendors (overlay: ${tree.filter((v) => v.overlay).map((v) => v.folder.id).join(', ') || 'none'}); set ${options.set}: ${vendors.length} vendors`);
  let started = performance.now();
  const validator = engine.validate({ vendors: tree.map((v) => v.folder) });
  log(`OrcaSlicer's profile validator: ${validator.ok ? 'OK' : `${validator.errors.length} errors`} (${Math.round(performance.now() - started)} ms)`);
  const problems: string[] = [];
  if (!validator.ok) problems.push(...validator.errors.map((e) => `validator: ${e.trim()}`));

  const library = tree.find((v) => v.folder.id === LIBRARY)!;
  const bundles = new Map<string, VendorBundle>();
  const resolvedBy = new Map<string, ProfilesResolveResult>();
  const reports: Record<string, VendorReport> = {};
  const assets = new AssetStore();
  const indexVendors: ProfileIndexVendor[] = [];
  const goldens: ProfileGoldens = { format: PROFILE_SET_FORMAT, set: options.set, presets: {}, compatibility: {}, printRestricted: {} };
  let defaults: ProfileIndex['defaults'] | null = null;

  started = performance.now();
  for (const source of vendors) {
    const { folder, dir, overlay } = source;
    const id = folder.id;
    const report: VendorReport = {
      files: 0, selectable: { machine: 0, process: 0, filament: 0 }, renamed: {}, dropped: {}, misplaced: {}, substituted: 0, adjusted: 0, loaderErrors: [], missingAssets: [],
    };
    reports[id] = report;
    const fail = (message: string) => problems.push(`${id}: ${message}`);

    // Every preset file, normalised by Orca's own loader.
    const entries = PRESET_TYPES.flatMap((type) => listOf(folder.index, type).map((e) => ({ type, ...e })));
    const normalized = engine.normalize(entries.map((e) => ({ type: e.type, config: folder.files[e.subPath] as Config })));
    const presets: VendorBundle['presets'] = { machine: {}, process: {}, filament: {} };
    normalized.presets.forEach((result, i) => {
      const { type, name, subPath } = entries[i];
      report.files++;
      if ('error' in result) return fail(`${subPath}: ${result.error}`);
      const n = result as NormalizedPreset;
      if (reorderedKey(name)) fail(`${type} "${name}": a name that is a number cannot keep its place in a bundle.`);
      if (presets[type][name]) fail(`${type} "${name}" is listed twice.`);
      if (n.config.name !== undefined && n.config.name !== name) fail(`${subPath}: its name is "${String(n.config.name)}", the index says "${name}".`);
      presets[type][name] = n.config;
      for (const [from, to] of n.renamed) report.renamed[from] = to;
      for (const key of n.dropped) count(report.dropped, key);
      for (const key of n.misplaced) count(report.misplaced, key);
      report.substituted += n.substituted.length;
      if (overlay) {
        // The overlay is ours: every key in it must be one the engine reads as it is.
        const issues = [
          ...n.renamed.map(([a, b]) => `legacy key ${a} (Orca reads ${b})`),
          ...n.dropped.map((k) => `${k}, which Orca ignores`),
          ...n.misplaced.map((k) => `${k}, a setting of another preset type`),
          ...n.substituted.map((s) => `${s.key} = "${s.value}", which Orca reads as "${s.replacement}"`),
          ...n.added.map((k) => `a legacy value that sets ${k}`),
        ];
        for (const issue of issues) fail(`${subPath}: ${issue}`);
      }
    });

    // Printer models and their files.
    const models: VendorBundle['models'] = {};
    const bundleAssets: Record<string, string> = {};
    const indexModels: ProfileIndexVendor['models'] = [];
    for (const { name, subPath } of listOf(folder.index, 'machine_model')) {
      const model = folder.files[subPath] as Record<string, unknown>;
      const strings: Record<string, string> = {};
      for (const [k, v] of Object.entries(model)) if (typeof v === 'string') strings[k] = v;
      models[name] = strings;
      const refs: Array<[string, 'model' | 'texture' | 'cover']> = [];
      if (strings.bed_model) refs.push([strings.bed_model, 'model']);
      if (strings.bed_texture) refs.push([strings.bed_texture, 'texture']);
      const cover = `${name}_cover.png`;
      if (existsSync(path.join(dir, cover))) refs.push([cover, 'cover']);
      for (const [file, kind] of refs) {
        const on = path.join(dir, file);
        if (file.includes('/') || file.includes('\\') || !existsSync(on)) {
          report.missingAssets.push(file);
          if (overlay) fail(`the model "${name}" names ${file}, which is not in the folder.`);
          continue;
        }
        bundleAssets[file] = `../${await assets.add(on, kind)}`;
      }
      indexModels.push({
        name,
        ...(strings.family ? { family: strings.family } : {}),
        nozzle: (strings.nozzle_diameter ?? '').split(';').map((s) => s.trim()).filter(Boolean),
        ...(bundleAssets[cover] ? { cover: bundleAssets[cover] } : {}),
      });
    }

    // Orca's own flattening of every selectable preset, and its compatibility rules.
    const resolved = engine.resolve({ vendor: folder, library: id === LIBRARY ? null : library.folder, compatibility: true });
    resolvedBy.set(id, resolved);
    report.loaderErrors = resolved.errors;
    if (resolved.errors.length > 0) (overlay ? fail : (m: string) => log(`  ${id}: ${m}`))(`Orca's loader: ${resolved.errors.join('; ')}`);
    if (!defaults) {
      defaults = { machine: {}, process: {}, filament: {} };
      for (const type of PRESET_TYPES) defaults[type] = resolved.defaults[type];
    }

    const bundle: VendorBundle = {
      format: PROFILE_SET_FORMAT,
      vendor: {
        id,
        name: typeof folder.index.name === 'string' && folder.index.name.trim() ? folder.index.name.trim() : id,
        version: String(folder.index.version ?? ''),
        ...(typeof folder.index.description === 'string' && folder.index.description ? { description: folder.index.description } : {}),
      },
      models,
      presets,
      adjust: {},
      renamed: { machine: {}, process: {}, filament: {} },
      assets: bundleAssets,
      report: { renamed: report.renamed, dropped: report.dropped, misplaced: report.misplaced, substituted: report.substituted },
    };
    bundles.set(id, bundle);
    const libraryBundle = bundles.get(LIBRARY) ?? null;

    const vendorGoldens: Record<PresetScope, Record<string, string>> = { machine: {}, process: {}, filament: {} };
    for (const preset of resolved.presets) {
      const { type, name } = preset;
      report.selectable[type]++;
      for (const old of preset.renamedFrom) {
        if (old === name || presets[type][old]) continue;
        const taken = bundle.renamed[type][old];
        if (taken && taken !== name) fail(`${type} "${old}" is an old name of both "${taken}" and "${name}".`);
        else bundle.renamed[type][old] = name;
      }
      const expected = canonicalConfigJson(preset.config);
      vendorGoldens[type][name] = sha256(expected);
      // What merging the chain gives, against what Orca holds: the difference is the preset's `adjust`.
      let mine: Config;
      try {
        mine = flattenPreset(type, name, { vendor: bundle, library: libraryBundle, defaults: defaults! });
      } catch (err) {
        fail(`${type} "${name}": ${(err as Error).message}`);
        continue;
      }
      const theirs = preset.config;
      const adjust: Config = {};
      for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
        if (key === 'name' || key === 'from' || key === 'type' || key === 'version') continue;
        if (!(key in theirs)) {
          fail(`${type} "${name}": merging its chain gives ${key}, which Orca's preset does not have.`);
          continue;
        }
        if (JSON.stringify(mine[key]) !== JSON.stringify(theirs[key])) adjust[key] = theirs[key];
      }
      if (Object.keys(adjust).length > 0) {
        (bundle.adjust[type] ??= {})[name] = adjust;
        report.adjusted++;
      }
      const check = flattenPreset(type, name, { vendor: bundle, library: libraryBundle, defaults: defaults! });
      if (canonicalConfigJson(check) !== expected) fail(`${type} "${name}": the adjusted flattening still differs from Orca's.`);
    }
    goldens.presets[id] = vendorGoldens;
    goldens.compatibility[id] = Object.fromEntries(
      (resolved.compatibility ?? []).map((c) => [c.printer, { processes: listHash(c.processes), filaments: listHash(c.filaments), counts: [c.processes.length, c.filaments.length] as [number, number] }]),
    );
    goldens.printRestricted[id] = Object.fromEntries((resolved.printRestricted ?? []).map((r) => [r.filament, r.processes]));

    const printers = resolved.presets
      .filter((p) => p.type === 'machine')
      .map((p) => {
        const text = (v: Config[string] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
        const nozzle = Array.isArray(p.config.nozzle_diameter) ? p.config.nozzle_diameter : [text(p.config.nozzle_diameter)];
        return { name: p.name, model: text(p.config.printer_model), variant: text(p.config.printer_variant), nozzle };
      })
      .sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }) || Number.parseFloat(a.nozzle[0]) - Number.parseFloat(b.nozzle[0]) || a.name.localeCompare(b.name, 'en', { numeric: true }));
    indexVendors.push({
      id,
      name: bundle.vendor.name,
      version: bundle.vendor.version,
      ...(bundle.vendor.description ? { description: bundle.vendor.description } : {}),
      bundle: { path: '', bytes: 0, sha256: '' },
      printers,
      models: indexModels,
    });
    if (overlay || id === LIBRARY || resolved.presets.length > 1000) {
      const a = report.selectable;
      log(`  ${id}: ${report.files} files; selectable ${a.machine} printers, ${a.process} processes, ${a.filament} filaments; ${report.adjusted} adjusted`);
    }
  }
  log(`Normalised and flattened ${vendors.length} vendors in ${Math.round(performance.now() - started)} ms`);
  if (problems.length > 0) throw new Error(`The profile set cannot be built:\n  ${problems.join('\n  ')}`);

  // Files.
  const out = path.resolve(options.out);
  rmSync(out, { recursive: true, force: true });
  const setDir = path.join(out, 'profiles', options.set);
  mkdirSync(path.join(setDir, 'vendors'), { recursive: true });
  mkdirSync(path.join(out, 'profiles', 'assets'), { recursive: true });
  const writeHashed = (dirRel: string, stem: string, ext: string, data: Buffer): ProfileFileRef => {
    const hash = sha256(data);
    const rel = `${dirRel ? `${dirRel}/` : ''}${stem}.${hash.slice(0, 16)}.${ext}`;
    writeFileSync(path.join(setDir, rel), data);
    return { path: rel, bytes: data.length, sha256: hash };
  };
  const sizes: Record<string, number> = {};
  for (const v of indexVendors) {
    const data = gzip(JSON.stringify(bundles.get(v.id)));
    v.bundle = writeHashed('vendors', v.id, 'json.gz', data);
    sizes[`bundle:${v.id}`] = data.length;
  }
  const all = writeHashed('', 'all', 'json.gz', gzip(JSON.stringify({ format: PROFILE_SET_FORMAT, vendors: indexVendors.map((v) => bundles.get(v.id)) })));
  for (const [rel, data] of assets.files) writeFileSync(path.join(out, 'profiles', rel), data);

  const commit = sourceCommit();
  const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version as string;
  const index: ProfileIndex = {
    format: PROFILE_SET_FORMAT,
    set: options.set,
    engine: { version, orca, optionsHash: engine.optionsHash() },
    source: { repository: REPOSITORY, commit },
    library: LIBRARY,
    defaults: defaults!,
    vendors: indexVendors,
    all,
  };
  const indexText = JSON.stringify(index);
  const indexRef = writeHashed('', 'index', 'json', Buffer.from(indexText, 'utf8'));
  const overlays = tree.filter((v) => v.overlay).map((v) => v.folder.id);
  const source = {
    format: 1,
    set: options.set,
    license: 'AGPL-3.0-only',
    about:
      "OrcaSlicer's vendor profiles, normalised and packed by the Muon3D Slicer Engine's tools/profiles. Their source is the " +
      'per-file JSON of the OrcaSlicer tree at `orca.commit` (resources/profiles), with the vendors of `overlay` in place of ' +
      "OrcaSlicer's, and the build scripts, all in `repository` at `commit`.",
    repository: REPOSITORY,
    commit,
    ...(/^\d+\.\d+\.\d+$/.test(options.set) ? { tag: `v${options.set}` } : {}),
    builder: 'tools/profiles/build.ts',
    orca: {
      repository: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_REPO').replace(/\.git$/, ''),
      commit: orca.commit,
      tag: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_TAG'),
      version: orca.version,
      profiles: 'resources/profiles',
    },
    overlay: { path: path.relative(repoRoot, DEFAULT_OVERLAY).replace(/\\/g, '/'), vendors: overlays, sha256: treeDigest(DEFAULT_OVERLAY, (rel) => rel.endsWith('.md')) },
    engine: index.engine,
  };
  writeFileSync(path.join(setDir, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
  writeFileSync(path.join(out, 'goldens.json.gz'), gzip(JSON.stringify(goldens)));
  copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(out, 'LICENSE'));
  writeFileSync(path.join(out, 'README.md'), readme(options.set, indexRef.path, commit));

  // Sizes: the whole library against Muon3D only (index + Muon3D + the library its filaments inherit from).
  sizes.index = indexRef.bytes;
  sizes.indexGzip = gzip(indexText).length;
  sizes.all = all.bytes;
  sizes.bundles = indexVendors.reduce((n, v) => n + v.bundle.bytes, 0);
  sizes.assets = [...assets.files.values()].reduce((n, d) => n + d.length, 0);
  sizes.assetFiles = assets.files.size;
  const muon = indexVendors.find((v) => v.id === 'Muon3D');
  if (muon) {
    sizes.muon3dDefaultSet = sizes.indexGzip + muon.bundle.bytes + (indexVendors.find((v) => v.id === LIBRARY)?.bundle.bytes ?? 0);
    sizes.muon3dAssets = Object.values(bundles.get('Muon3D')!.assets).reduce((n, rel) => n + (assets.files.get(rel.replace(/^\.\.\//, ''))?.length ?? 0), 0);
  }
  const report = { set: options.set, validator: { ok: validator.ok, errors: validator.errors, warnings: validator.warnings }, vendors: reports, sizes };
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  log(`Wrote ${out}: index ${kb(sizes.index)} (${kb(sizes.indexGzip)} gzip), bundles ${kb(sizes.bundles)} gzip, all-in-one ${kb(sizes.all)}, ${sizes.assetFiles} assets ${kb(sizes.assets)}`);
  if (muon) log(`Muon3D only: index + Muon3D + ${LIBRARY} = ${kb(sizes.muon3dDefaultSet)} gzip, M1 assets ${kb(sizes.muon3dAssets!)}`);
  return { index, indexPath: path.join(setDir, indexRef.path), goldens, report };
}

function readme(set: string, index: string, commit: string): string {
  return `# Muon3D Slicer profile set ${set}

OrcaSlicer's printer, process and filament presets for the Muon3D Slicer Engine, packed for a static site by the
engine's \`tools/profiles\`: every vendor of the OrcaSlicer tree the engine is built from, with the Muon3D vendor from
the engine repository's \`profiles/muon3d\`. Each file was read with OrcaSlicer's own loader (legacy keys translated,
values in OrcaSlicer's text), and inheritance is kept.

- \`profiles/${set}/${index}\`: the index (vendors, printers, models, the type defaults). Paths in it are relative to it.
- \`profiles/${set}/vendors/*.json.gz\`: one bundle per vendor; \`all.*.json.gz\`: all of them in one file.
- \`profiles/assets/\`: bed models, bed textures and printer pictures, named by their sha256.
- \`profiles/${set}/SOURCE.json\`: where the source of these files is.
- \`goldens.json.gz\`: sha256 of every selectable preset as OrcaSlicer flattens it, for testing a client (not served).
- \`report.json\`: what normalising changed, OrcaSlicer's validator, the sizes.

Serve \`profiles/\` as it is. The formats and the way to flatten a preset are in \`docs/PROFILES.md\` of
https://github.com/Muon-3D/muon3d-slicer-engine (commit ${commit}), and the types in its protocol package.

Licence: AGPL-3.0-only (\`LICENSE\`), as OrcaSlicer's profiles are distributed. The source is the per-file JSON of the
OrcaSlicer tree and of \`profiles/muon3d\` at the commits \`SOURCE.json\` names, and the build scripts.
`;
}

async function main() {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, set: { type: 'string' }, vendors: { type: 'string' } },
  });
  if (!values.out) {
    console.error('usage: node tools/profiles/build.ts --out <folder> [--set <name>] [--vendors Muon3D,...]');
    process.exit(2);
  }
  const set = values.set ?? JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  await buildProfileSet({ out: values.out, set, ...(values.vendors ? { vendors: values.vendors.split(',').map((s) => s.trim()).filter(Boolean) } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export type { VendorSource };
