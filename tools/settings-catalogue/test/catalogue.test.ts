// The committed settings catalogue (data/settings-catalogue.json): its layout against its
// definitions, and (when a built engine and the Orca sources are on this machine) that
// `npm run gen:settings` reproduces it byte for byte and that every option key Orca's tab code names
// is placed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RULES_PORTED_FROM } from '../../../host/src/settings/rules.ts';
import { findPlacement, lineLabel, lineMode, loadCatalogue, settingDef, shownInMode } from '../catalogue.ts';
import {
  CATALOGUE_PATH,
  LAYOUT_FUNCTIONS,
  defaultPaths,
  generate,
  literalKeysIn,
  readEngineDefinitions,
  readOrcaSources,
  sourcesAvailable,
} from '../generate.ts';
import type { LayoutLine, SettingsCatalogue } from '../types.ts';

const catalogue = await loadCatalogue();
const paths = defaultPaths();
const MANIFEST = fileURLToPath(new URL('manifest.json', `file:///${paths.engineDir.replace(/\\/g, '/')}/`));
const haveSources = sourcesAvailable(paths);

function* rows(c: SettingsCatalogue): Generator<{ tab: string; page: string; line: LayoutLine; other: boolean }> {
  for (const tab of c.tabs) {
    // Orca's pages first, so the "Other" check below sees everything Orca places.
    const pages = [...tab.pages.filter((p) => !p.other), ...tab.pages.filter((p) => p.other)];
    for (const page of pages) for (const group of page.groups) for (const line of group.lines) yield { tab: tab.id, page: page.title, line, other: page.other === true };
  }
}

describe('settings catalogue', () => {
  it('places every option once, with a definition from the tab\'s own preset', () => {
    // Orca's tabs place each option at most once. The generated "Other" pages list, per scope, what no
    // Orca tab places, so a key every preset stores (inherits) is on each of them.
    const seen = new Map<string, string>();
    for (const { tab, page, line, other } of rows(catalogue)) {
      assert.ok(line.options.length > 0, `an empty row on ${tab}/${page}`);
      for (const { key } of line.options) {
        const def = settingDef(catalogue, key);
        assert.ok(def, `${tab}/${page} places "${key}" without a definition`);
        assert.ok(def.synthetic || def.scopes?.includes(tab as 'process'), `${tab}/${page} places "${key}", stored in ${def.scopes}`);
        if (other) {
          assert.ok(!seen.has(key), `"${key}" is on ${tab}/Other, but Orca places it on ${seen.get(key)}`);
          continue;
        }
        assert.ok(!seen.has(key), `"${key}" is placed on ${seen.get(key)} and on ${tab}/${page}`);
        seen.set(key, `${tab}/${page}`);
      }
    }
    // Orca's own tabs (the generated "Other" pages aside) and the plate dialog.
    const orcaPlaced = (id: string) => catalogue.tabs.find((t) => t.id === id)!.pages.filter((p) => !p.other)
      .flatMap((p) => p.groups.flatMap((g) => g.lines.flatMap((l) => l.options))).length;
    assert.deepEqual([orcaPlaced('process'), orcaPlaced('filament'), orcaPlaced('machine')], [365, 121, 127]);
    assert.deepEqual(catalogue.plate.map((l) => l.options[0].key), [
      'curr_bed_type', 'skirt_start_angle', 'print_sequence', 'spiral_mode', 'first_layer_sequence_choice', 'other_layers_sequence_choice',
    ]);
    for (const line of catalogue.plate) assert.ok(settingDef(catalogue, line.options[0].key));
    assert.deepEqual(Object.keys(catalogue.excluded), ['printer_agent'], 'only the desktop printer agent is left out');
    assert.ok(!seen.has('printer_agent'));
  });

  it('keeps Orca\'s page order and page conditions', () => {
    assert.deepEqual(catalogue.tabs.map((t) => [t.id, t.pages.map((p) => p.title)]), [
      ['process', ['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others', 'Other']],
      ['filament', ['Filament', 'Cooling', 'Setting Overrides', 'Advanced', 'Multimaterial', 'Dependencies', 'Notes', 'Other']],
      ['machine', ['Basic information', 'Machine G-code', 'Multimaterial', 'Extruder', 'Motion ability', 'Notes', 'Other']],
    ]);
    const machine = catalogue.tabs[2].pages;
    assert.equal(machine.find((p) => p.title === 'Extruder')!.repeat, 'extruder');
    assert.deepEqual(machine.find((p) => p.title === 'Motion ability')!.when, {
      key: 'gcode_flavor', oneOf: ['marlin', 'marlin2', 'klipper', 'reprapfirmware', 'repetier'],
    });
    for (const tab of catalogue.tabs) {
      const ids = tab.pages.flatMap((p) => [p.id, ...p.groups.map((g) => g.id)]);
      assert.equal(new Set(ids).size, ids.length, `ids are unique in ${tab.id}`);
    }
  });

  it('describes rows like Orca: several options, overrides, machine limits, widgets', () => {
    const at = (key: string) => findPlacement(catalogue, key)!;
    assert.deepEqual(at('overhang_2_4_speed').line.options.map((o) => o.key), ['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed']);
    assert.equal(lineLabel(catalogue, at('overhang_1_4_speed').line), 'Overhang speed');
    assert.deepEqual(at('chamber_temperature').line.options.map((o) => o.label), ['Target', 'Minimal']);
    assert.deepEqual(at('filament_retraction_length').line.overrideOf, { scope: 'machine', key: 'retraction_length' });
    assert.deepEqual(at('filament_ironing_flow').line.overrideOf, { scope: 'process', key: 'ironing_flow' });
    assert.equal(at('machine_max_speed_x').line.modeColumns, true);
    assert.equal(at('printable_area').line.widget, 'bedShape');
    assert.deepEqual(at('retraction_length').line.options, [{ key: 'retraction_length', index: 'extruder' }]);
    assert.equal(at('machine_start_gcode').line.options[0].code, true);
    assert.equal(lineMode(catalogue, at('layer_height').line), 'simple');
    assert.ok(shownInMode('advanced', 'expert') && !shownInMode('develop', 'expert'));
  });

  it('describes Orca only: format 2 carries no app policy', () => {
    assert.equal(catalogue.format, 2);
    assert.ok(!('server' in catalogue));
    for (const [key, def] of Object.entries(catalogue.options)) {
      for (const field of ['readOnly', 'note', 'engineOnly', 'engineOnlyValues']) assert.ok(!(field in def), `${key}.${field}`);
    }
    // The "Other" pages hold every option of the scope no Orca tab places, bookkeeping keys included.
    const other = catalogue.tabs.find((t) => t.id === 'machine')!.pages.find((p) => p.other)!;
    const keys = other.groups.flatMap((g) => g.lines.map((l) => l.options[0].key));
    assert.ok(keys.includes('printer_model') && keys.includes('inherits'), 'bookkeeping keys are listed');
    assert.equal(catalogue.options.extruders_count.synthetic, true);
  });

  it('has enum defaults among the enum values', () => {
    for (const [key, def] of Object.entries(catalogue.options)) {
      if (def.enumValues && (def.type === 'enum' || def.type === 'enums')) {
        for (const value of [def.default ?? []].flat()) assert.ok(def.enumValues.includes(value) || (value === 'nil' && def.nullable), `${key}: ${value}`);
      }
      if (def.enumLabels) assert.equal(def.enumLabels.length, def.enumValues?.length, key);
    }
  });

  it('fingerprints the functions the settings rules port as rules.ts does', () => {
    // Regenerating the catalogue against a newer Orca changes these; rules.ts must then be re-ported.
    assert.deepEqual(catalogue.ruleSources, Object.fromEntries(Object.entries(RULES_PORTED_FROM).sort(([a], [b]) => (a < b ? -1 : 1))));
    assert.ok(Object.values(catalogue.sources).every((h) => /^sha256:[0-9a-f]{64}$/.test(h)));
  });

  // A manifest with no engine in it (npm run build:host alone) names no Orca build.
  const built = existsSync(MANIFEST) && (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { orcaCommit?: string }).orcaCommit !== undefined;
  it('comes from the Orca build the engine was built from', { skip: !built && `no built engine (${MANIFEST})` }, () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { orcaCommit: string; orcaVersion: string };
    assert.equal(catalogue.orca.commit, manifest.orcaCommit, 'the engine was rebuilt from another Orca: run npm run gen:settings');
    assert.equal(catalogue.orca.version, manifest.orcaVersion);
  });

  it('loads once', async () => {
    assert.equal(await loadCatalogue(), catalogue);
    assert.deepEqual(catalogue, JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')));
  });
});

describe('settings catalogue generator', { skip: !haveSources && 'no built st engine or no Orca sources on this machine' }, () => {
  it('regenerates the committed file byte for byte, twice', async () => {
    const first = await generate(paths);
    const second = await generate(paths);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.files[CATALOGUE_PATH], readFileSync(CATALOGUE_PATH, 'utf8'), 'data/settings-catalogue.json is out of date: run npm run gen:settings');
  });

  it('lists only enum values Orca can read back', async () => {
    const defs = await readEngineDefinitions(paths.engineDir);
    for (const [key, def] of Object.entries(catalogue.options)) {
      const keysMap = defs.options[key]?.enumKeys;
      if (keysMap && def.enumValues) for (const value of def.enumValues) assert.ok(Object.hasOwn(keysMap, value), `${key}: "${value}"`);
    }
    // Orca lists "Default" in its drop-down but cannot read it.
    assert.deepEqual(catalogue.options.filament_map_mode.enumValues, ['Auto For Flush', 'Auto For Match', 'Manual', 'Nozzle Manual']);
  });

  it('places or excludes every option key the tab functions name', () => {
    const orca = readOrcaSources(paths.orcaRoot);
    const placed = new Set([...rows(catalogue)].flatMap(({ line }) => line.options.map((o) => o.key)));
    for (const line of catalogue.plate) placed.add(line.options[0].key);
    const isKey = (key: string) => Object.hasOwn(catalogue.options, key);
    let named = 0;
    for (const fn of Object.values(LAYOUT_FUNCTIONS)) {
      for (const [key, line] of literalKeysIn(orca.tab, fn, isKey)) {
        named++;
        assert.ok(placed.has(key) || Object.hasOwn(catalogue.excluded, key), `Tab.cpp:${line} (${fn}) names "${key}"`);
      }
    }
    assert.ok(named > 400, `${named} keys named`);
  });
});
