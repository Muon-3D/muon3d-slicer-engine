// Checks a built profile set (tools/profiles/build.ts) with no engine: every file the index names is there with
// its size and sha256, the bundles parse and agree with the index and the all-in-one file, every asset is there
// under its sha256, and flattenPreset (packages/protocol) gives OrcaSlicer's result for every selectable preset
// (the goldens). With --expect, the Muon3D presets and their compatibility must also match the committed record
// (test/profiles/muon3d.json): a change to what the M1 prints is then a reviewed change to that file.
//
//   node tools/profiles/check.ts <folder> [--expect test/profiles/muon3d.json] [--write-expect <file>]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { PresetScope } from '../../packages/protocol/src/data.ts';
import {
  PRESET_TYPES,
  PROFILE_SET_FORMAT,
  canonicalConfigJson,
  flattenPreset,
  type ProfileFileRef,
  type ProfileGoldens,
  type ProfileIndex,
  type VendorBundle,
} from '../../packages/protocol/src/profileSet.ts';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The committed record of the Muon3D presets (test/profiles/muon3d.json). */
export interface VendorExpectation {
  vendor: string;
  version: string;
  presets: Record<PresetScope, Record<string, string>>;
  compatibility: ProfileGoldens['compatibility'][string];
}

export interface CheckedSet {
  index: ProfileIndex;
  bundles: Map<string, VendorBundle>;
  goldens: ProfileGoldens | null;
  presets: number;
}

/** A gzip file's content (the client's rule: gzip when it starts with 1f 8b, else as it is). */
export function ungzip(data: Buffer): Buffer {
  return data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
}

export function checkProfileSet(folder: string, problems: string[]): CheckedSet | null {
  const fail = (message: string) => problems.push(message);
  const root = path.join(folder, 'profiles');
  const sets = existsSync(root) ? readdirSync(root).filter((d) => d !== 'assets') : [];
  if (sets.length !== 1) {
    fail(`${root}: expected one set folder beside assets/, found ${sets.join(', ') || 'none'}.`);
    return null;
  }
  const setDir = path.join(root, sets[0]);
  const indexFiles = readdirSync(setDir).filter((f) => /^index\.[0-9a-f]{16}\.json$/.test(f));
  if (indexFiles.length !== 1) {
    fail(`${setDir}: expected one index.<hash>.json, found ${indexFiles.length}.`);
    return null;
  }
  const indexBytes = readFileSync(path.join(setDir, indexFiles[0]));
  if (!indexFiles[0].includes(sha256(indexBytes).slice(0, 16))) fail(`${indexFiles[0]}: its name is not its sha256.`);
  const index = JSON.parse(indexBytes.toString('utf8')) as ProfileIndex;
  if (index.format !== PROFILE_SET_FORMAT) fail(`the index has format ${index.format}.`);
  if (index.set !== sets[0]) fail(`the index says set "${index.set}", its folder is "${sets[0]}".`);
  for (const type of PRESET_TYPES) if (!index.defaults?.[type] || Object.keys(index.defaults[type]).length < 100) fail(`the index has no ${type} defaults.`);
  const source = path.join(setDir, 'SOURCE.json');
  if (!existsSync(source)) fail('SOURCE.json is missing.');
  else if (JSON.parse(readFileSync(source, 'utf8')).commit !== index.source.commit) fail('SOURCE.json and the index name different commits.');

  const read = (ref: ProfileFileRef, what: string): Buffer | null => {
    const file = path.join(setDir, ref.path);
    if (!existsSync(file)) {
      fail(`${what}: ${ref.path} is missing.`);
      return null;
    }
    const data = readFileSync(file);
    if (data.length !== ref.bytes) fail(`${what}: ${ref.path} has ${data.length} bytes, the index says ${ref.bytes}.`);
    if (sha256(data) !== ref.sha256) fail(`${what}: ${ref.path}'s sha256 is not the index's.`);
    if (!ref.path.includes(ref.sha256.slice(0, 16))) fail(`${what}: ${ref.path} is not named after its sha256.`);
    if (data[0] !== 0x1f || data[1] !== 0x8b) fail(`${what}: ${ref.path} is not gzip.`);
    return data;
  };
  const asset = (rel: string, what: string) => {
    const m = /^\.\.\/assets\/([0-9a-f]{64})\.(stl|svg|png|webp|jpg|jpeg)$/.exec(rel);
    if (!m) return fail(`${what}: asset path ${rel} is not ../assets/<sha256>.<ext>.`);
    const file = path.join(root, 'assets', `${m[1]}.${m[2]}`);
    if (!existsSync(file)) return fail(`${what}: ${rel} is missing.`);
    if (sha256(readFileSync(file)) !== m[1]) fail(`${what}: ${rel} is not named after its sha256.`);
  };

  const bundles = new Map<string, VendorBundle>();
  for (const v of index.vendors) {
    const data = read(v.bundle, v.id);
    if (!data) continue;
    const bundle = JSON.parse(ungzip(data).toString('utf8')) as VendorBundle;
    bundles.set(v.id, bundle);
    if (bundle.format !== PROFILE_SET_FORMAT || bundle.vendor.id !== v.id || bundle.vendor.version !== v.version) fail(`${v.id}: the bundle does not match its index entry.`);
    for (const p of v.printers) {
      if (bundle.presets.machine[p.name]?.instantiation !== 'true') fail(`${v.id}: the index lists printer "${p.name}", which the bundle has not as a selectable preset.`);
    }
    for (const m of v.models) {
      if (!bundle.models[m.name]) fail(`${v.id}: the index lists model "${m.name}", which the bundle has not.`);
      if (m.cover) asset(m.cover, `${v.id} ${m.name}`);
    }
    for (const [file, rel] of Object.entries(bundle.assets)) asset(rel, `${v.id} ${file}`);
  }
  const allData = read(index.all, 'all');
  if (allData) {
    const all = JSON.parse(ungzip(allData).toString('utf8')) as { format: number; vendors: VendorBundle[] };
    if (all.vendors.length !== bundles.size || all.vendors.some((b) => JSON.stringify(b) !== JSON.stringify(bundles.get(b.vendor.id)))) {
      fail('the all-in-one file does not hold the same bundles.');
    }
  }
  const library = bundles.get(index.library) ?? null;
  if (!library) fail(`the set has no ${index.library}.`);

  // Every selectable preset, flattened from the bundles, against OrcaSlicer's own (the goldens).
  const goldensFile = path.join(folder, 'goldens.json.gz');
  const goldens = existsSync(goldensFile) ? (JSON.parse(ungzip(readFileSync(goldensFile)).toString('utf8')) as ProfileGoldens) : null;
  if (!goldens) fail('goldens.json.gz is missing.');
  let presets = 0;
  for (const [id, bundle] of bundles) {
    for (const type of PRESET_TYPES) {
      for (const [name, file] of Object.entries(bundle.presets[type])) {
        if (file.instantiation !== 'true') continue;
        presets++;
        const expected = goldens?.presets[id]?.[type]?.[name];
        if (!expected) {
          fail(`${id} ${type} "${name}" has no golden.`);
          continue;
        }
        try {
          const flat = flattenPreset(type, name, { vendor: bundle, library, defaults: index.defaults });
          if (sha256(canonicalConfigJson(flat)) !== expected) fail(`${id} ${type} "${name}": flattened from the set, it is not what OrcaSlicer's loader makes of it.`);
        } catch (err) {
          fail(`${id} ${type} "${name}": ${(err as Error).message}`);
        }
      }
    }
    if (goldens) {
      for (const type of PRESET_TYPES) {
        for (const name of Object.keys(goldens.presets[id]?.[type] ?? {})) {
          if (bundle.presets[type][name]?.instantiation !== 'true') fail(`${id} ${type} "${name}" has a golden but is not a selectable preset of the bundle.`);
        }
      }
    }
  }
  return { index, bundles, goldens, presets };
}

/** The record of one vendor from a set's goldens (for test/profiles/muon3d.json). */
export function expectation(set: CheckedSet, vendor: string): VendorExpectation | null {
  const bundle = set.bundles.get(vendor);
  if (!bundle || !set.goldens) return null;
  return { vendor, version: bundle.vendor.version, presets: set.goldens.presets[vendor], compatibility: set.goldens.compatibility[vendor] };
}

export function compareExpectation(actual: VendorExpectation | null, expected: VendorExpectation, problems: string[]): void {
  const where = `${expected.vendor} (against the committed record)`;
  if (!actual) {
    problems.push(`${where}: the set has no ${expected.vendor}.`);
    return;
  }
  if (actual.version !== expected.version) problems.push(`${where}: version ${actual.version}, recorded ${expected.version}.`);
  for (const type of PRESET_TYPES) {
    const names = new Set([...Object.keys(actual.presets[type] ?? {}), ...Object.keys(expected.presets[type] ?? {})]);
    for (const name of names) {
      const a = actual.presets[type]?.[name];
      const e = expected.presets[type]?.[name];
      if (!a) problems.push(`${where}: ${type} "${name}" is gone.`);
      else if (!e) problems.push(`${where}: ${type} "${name}" is new.`);
      else if (a !== e) problems.push(`${where}: ${type} "${name}" flattens to other settings than recorded.`);
    }
  }
  if (JSON.stringify(actual.compatibility) !== JSON.stringify(expected.compatibility)) problems.push(`${where}: the processes or filaments offered with its printers changed.`);
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { expect: { type: 'string' }, 'write-expect': { type: 'string' } } });
  if (positionals.length !== 1) {
    console.error('usage: node tools/profiles/check.ts <set folder> [--expect <file>] [--write-expect <file>]');
    process.exit(2);
  }
  const problems: string[] = [];
  const set = checkProfileSet(positionals[0], problems);
  if (set && values.expect) {
    const expected = JSON.parse(readFileSync(values.expect, 'utf8')) as VendorExpectation;
    compareExpectation(expectation(set, expected.vendor), expected, problems);
  }
  if (set && values['write-expect']) {
    const record = expectation(set, 'Muon3D');
    if (!record) problems.push('the set has no Muon3D to record.');
    else writeFileSync(values['write-expect'], `${JSON.stringify(record, null, 2)}\n`);
  }
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in the profile set:\n  ${problems.slice(0, 200).join('\n  ')}`);
    process.exit(1);
  }
  console.log(`OK: set ${set!.index.set}, ${set!.bundles.size} vendors, ${set!.presets} selectable presets flatten to OrcaSlicer's result`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
