// The engine tests' presets (test/fixtures/presets/*.json), flattened by OrcaSlicer's own loader through the engine
// (profiles.resolve) from the tree a profile set is built from: OrcaSlicer's profiles at the pin, with the Muon3D
// overlay. Each fixture names its vendor and presets (`names`); the rest is regenerated.
//
// Also the profile fixtures the conformance suite runs the profile ops on without an Orca checkout
// (test/fixtures/profiles/): the part of OrcaFilamentLibrary the Muon3D overlay needs (the parents of its filaments
// and the model's default materials, with their parents), and one Anycubic process file with legacy keys, with the
// wall order OrcaSlicer's loader gives that preset.
//
//   node tools/profiles/fixtures.ts            rewrites the fixtures
//   node tools/profiles/fixtures.ts --check    fails when a fixture differs from a fresh run
//
// Environment: ENGINE_DIR (the built engine, default dist/), ORCA_SRC (default the orca/ submodule).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Config } from '../../packages/protocol/src/data.ts';
import type { ProfileFolder } from '../../packages/protocol/src/profiles.ts';
import { ProfileEngine } from './engine.ts';
import { LIBRARY, listOf, readTree, repoRoot } from './tree.ts';

export const FIXTURES = path.join(repoRoot, 'test/fixtures/presets');
export const PROFILE_FIXTURES = path.join(repoRoot, 'test/fixtures/profiles');
/** A process file with legacy keys (wall_infill_order among them), for the normalize test. */
export const LEGACY_PROCESS = { vendor: 'Anycubic', name: '0.20mm Standard @Anycubic Kobra Neo 0.4 nozzle' };

export interface PresetFixture {
  names: { vendor: string; machine: string; process: string; filament: string };
  machine: Config;
  process: Config;
  filaments: Config[];
}

export interface LegacyProcessFixture {
  about: string;
  type: 'process';
  config: Config;
  orca: { wall_sequence: string };
}

const jsonText = (value: unknown, indent: number) => `${JSON.stringify(value, null, indent)}\n`;

/** Fresh fixtures for every file of test/fixtures/presets, by file name. */
export async function regenerate(engine?: ProfileEngine): Promise<Map<string, PresetFixture>> {
  const e = engine ?? (await ProfileEngine.load());
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  const fixtures = files.map((file) => ({ file, names: (JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as PresetFixture).names }));
  const tree = readTree({ vendors: [...new Set(fixtures.map((f) => f.names.vendor))] });
  const folder = (id: string) => tree.find((v) => v.folder.id === id)!.folder;
  const out = new Map<string, PresetFixture>();
  for (const { file, names } of fixtures) {
    const resolved = e.resolve({
      vendor: folder(names.vendor),
      library: names.vendor === LIBRARY ? null : folder(LIBRARY),
      presets: [
        { type: 'machine', name: names.machine },
        { type: 'process', name: names.process },
        { type: 'filament', name: names.filament },
      ],
    });
    if (resolved.missing.length > 0) throw new Error(`${file}: ${resolved.missing.map((m) => `${m.type} "${m.name}"`).join(', ')} not found.`);
    const get = (type: 'machine' | 'process' | 'filament', name: string) => resolved.presets.find((p) => p.type === type && p.name === name)!.config;
    out.set(file, { names, machine: get('machine', names.machine), process: get('process', names.process), filaments: [get('filament', names.filament)] });
  }
  return out;
}

export const fixtureText = (fixture: PresetFixture) => jsonText(fixture, 2);

/** The profile fixtures (file name in test/fixtures/profiles -> content), from the tree. */
export async function profileFixtures(engine?: ProfileEngine): Promise<Map<string, unknown>> {
  const e = engine ?? (await ProfileEngine.load());
  const tree = readTree({ vendors: ['Muon3D', LEGACY_PROCESS.vendor] });
  const find = (id: string) => tree.find((v) => v.folder.id === id)!.folder;
  const library = find(LIBRARY);
  const muon = find('Muon3D');

  // The library filaments the overlay names, with their parents.
  const byName = new Map(listOf(library.index, 'filament').map((x) => [x.name, x]));
  const wanted = new Set<string>();
  const add = (name: string) => {
    let at: string | undefined = name;
    while (at && byName.has(at) && !wanted.has(at)) {
      wanted.add(at);
      const inherits: unknown = library.files[byName.get(at)!.subPath].inherits;
      at = typeof inherits === 'string' ? inherits : undefined;
    }
  };
  for (const { subPath } of listOf(muon.index, 'filament')) add(String(muon.files[subPath].inherits ?? ''));
  for (const { subPath } of listOf(muon.index, 'machine_model')) {
    for (const name of String(muon.files[subPath].default_materials ?? '').split(';')) add(name.trim());
  }
  const entries = listOf(library.index, 'filament').filter((x) => wanted.has(x.name));
  const subset: ProfileFolder = {
    id: LIBRARY,
    index: { name: library.index.name, version: library.index.version, filament_list: entries.map((x) => ({ name: x.name, sub_path: x.subPath })) },
    files: Object.fromEntries(entries.map((x) => [x.subPath, library.files[x.subPath]])),
  };

  const anycubic = find(LEGACY_PROCESS.vendor);
  const entry = listOf(anycubic.index, 'process').find((x) => x.name === LEGACY_PROCESS.name)!;
  const resolved = e.resolve({ vendor: anycubic, library, presets: [{ type: 'process', name: LEGACY_PROCESS.name }] });
  const legacy: LegacyProcessFixture = {
    about: `${LEGACY_PROCESS.vendor}/${entry.subPath} of OrcaSlicer's profiles, and the wall order OrcaSlicer's loader gives the preset (profiles.resolve on the whole vendor).`,
    type: 'process',
    config: anycubic.files[entry.subPath] as Config,
    orca: { wall_sequence: String(resolved.presets[0].config.wall_sequence) },
  };
  return new Map<string, unknown>([
    ['OrcaFilamentLibrary-muon3d.json', subset],
    ['legacy-process.json', legacy],
  ]);
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  const engine = await ProfileEngine.load();
  const fresh = await regenerate(engine);
  const profiles = await profileFixtures(engine);
  const targets: Array<[string, string]> = [
    ...[...fresh].map(([file, fixture]): [string, string] => [path.join(FIXTURES, file), fixtureText(fixture)]),
    ...[...profiles].map(([file, content]): [string, string] => [path.join(PROFILE_FIXTURES, file), jsonText(content, 1)]),
  ];
  let differ = 0;
  for (const [target, text] of targets) {
    const same = existsSync(target) && readFileSync(target, 'utf8') === text;
    if (same) continue;
    const rel = path.relative(repoRoot, target).replace(/\\/g, '/');
    if (values.check) {
      differ++;
      console.error(`${rel} differs from what profiles.resolve makes now: run node tools/profiles/fixtures.ts`);
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
      console.log(`wrote ${rel}`);
    }
  }
  if (differ > 0) process.exit(1);
  console.log(values.check ? `OK: the ${targets.length} fixtures are what profiles.resolve makes` : `${targets.length} fixtures up to date`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
