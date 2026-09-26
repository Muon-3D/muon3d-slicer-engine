// The committed settings catalogue (catalogue.json, optionTypes.ts): its layout against its
// definitions, the policy marks, and (when the engine, the Orca sources and the server CLI's Orca
// are on this machine) that `npm run gen:settings` reproduces it byte for byte and that every
// option key Orca's tab code names is placed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CATALOGUE_PATH,
  LAYOUT_FUNCTIONS,
  OPTION_TYPES_PATH,
  defaultPaths,
  generate,
  literalKeysIn,
  readEngineDefinitions,
  readOrcaSources,
  sourcesAvailable,
} from '../../scripts/orca-settings/generate.ts';
import { RULES_PORTED_FROM } from '../../web/src/settings/rules.ts';
import { DENIED_KEYS, PROTECTED_KEYS } from '../overrides.ts';
import { findPlacement, lineLabel, lineMode, loadCatalogue, settingDef, shownInMode } from './index.ts';
import { LIST_OPTIONS, NULLABLE_OPTIONS, OPTION_TYPES, SERIALIZED_OPTIONS } from './optionTypes.ts';
import type { LayoutLine, SettingsCatalogue } from './types.ts';

const catalogue = await loadCatalogue();
const MANIFEST = fileURLToPath(new URL('../../web/public/engine/manifest.json', import.meta.url));
const paths = defaultPaths();
const haveSources = sourcesAvailable(paths);

function* rows(c: SettingsCatalogue): Generator<{ tab: string; page: string; line: LayoutLine }> {
  for (const tab of c.tabs) for (const page of tab.pages) for (const group of page.groups) for (const line of group.lines) yield { tab: tab.id, page: page.title, line };
}

describe('settings catalogue', () => {
  it('places every option once, with a definition from the tab\'s own preset', () => {
    const seen = new Map<string, string>();
    for (const { tab, page, line } of rows(catalogue)) {
      assert.ok(line.options.length > 0, `an empty row on ${tab}/${page}`);
      for (const { key } of line.options) {
        const def = settingDef(catalogue, key);
        assert.ok(def, `${tab}/${page} places "${key}" without a definition`);
        assert.ok(def.synthetic || def.scopes?.includes(tab as 'process'), `${tab}/${page} places "${key}", stored in ${def.scopes}`);
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

  it('marks the web slicer\'s read-only and hidden settings', () => {
    for (const key of DENIED_KEYS) if (catalogue.options[key]) assert.equal(catalogue.options[key].readOnly, 'denied', key);
    for (const key of PROTECTED_KEYS) if (catalogue.options[key]) assert.equal(catalogue.options[key].readOnly, 'protected', key);
    for (const key of ['printable_area', 'printable_height', 'bed_exclude_area', 'bed_exclude_volumes', 'extruder_printable_area', 'nozzle_diameter']) {
      assert.equal(catalogue.options[key].readOnly, 'geometry', key);
      assert.ok(catalogue.options[key].note, key);
    }
    assert.equal(catalogue.options.extruders_count.readOnly, 'synthetic');
    assert.equal(catalogue.options.compatible_printers.readOnly, 'dependencies');
    assert.equal(catalogue.options.layer_height.readOnly, undefined);
    // The generated "Other" pages hold no hidden setting.
    for (const tab of catalogue.tabs) {
      for (const page of tab.pages.filter((p) => p.other)) {
        for (const g of page.groups) for (const l of g.lines) assert.ok(!['denied', 'protected', 'metadata', 'unused'].includes(catalogue.options[l.options[0].key].readOnly ?? ''), l.options[0].key);
      }
    }
  });

  it('flags what the server CLI lacks', () => {
    assert.equal(catalogue.options.wipe_inward.engineOnly, true);
    assert.equal(catalogue.options.bed_exclude_volumes.engineOnly, true);
    assert.equal(catalogue.options.layer_height.engineOnly, undefined);
    assert.deepEqual(catalogue.options.print_order.engineOnlyValues, ['best_of', 'snake']);
    assert.deepEqual(catalogue.options.top_surface_pattern.engineOnlyValues, ['spiralinset']);
  });

  it('has enum defaults among the enum values', () => {
    for (const [key, def] of Object.entries(catalogue.options)) {
      if (def.enumValues && (def.type === 'enum' || def.type === 'enums')) {
        for (const value of [def.default ?? []].flat()) assert.ok(def.enumValues.includes(value) || (value === 'nil' && def.nullable), `${key}: ${value}`);
      }
      if (def.enumLabels) assert.equal(def.enumLabels.length, def.enumValues?.length, key);
    }
  });

  it('matches its option types module (the one shared/overrides.ts reads)', () => {
    const real = Object.entries(catalogue.options).filter(([, d]) => !d.synthetic);
    assert.deepEqual(OPTION_TYPES, Object.fromEntries(real.map(([k, d]) => [k, d.type])));
    assert.deepEqual([...NULLABLE_OPTIONS], real.filter(([, d]) => d.nullable).map(([k]) => k));
    assert.deepEqual([...SERIALIZED_OPTIONS], real.filter(([, d]) => d.serialized).map(([k]) => k));
    assert.deepEqual([...LIST_OPTIONS], real.filter(([, d]) => d.slots === 'list').map(([k]) => k));
  });

  it('fingerprints the functions the settings rules port as rules.ts does', () => {
    // Regenerating the catalogue against a newer Orca changes these; rules.ts must then be re-ported.
    assert.deepEqual(catalogue.ruleSources, Object.fromEntries(Object.entries(RULES_PORTED_FROM).sort(([a], [b]) => (a < b ? -1 : 1))));
    assert.ok(Object.values(catalogue.sources).every((h) => /^sha256:[0-9a-f]{64}$/.test(h)));
  });

  it('comes from the Orca build the published engine was built from', { skip: !existsSync(MANIFEST) && 'no built engine (web/public/engine/manifest.json)' }, () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { orcaCommit: string; orcaVersion: string };
    assert.equal(catalogue.orca.commit, manifest.orcaCommit, 'the engine was rebuilt from another Orca: run npm run gen:settings');
    assert.equal(catalogue.orca.version, manifest.orcaVersion);
  });

  it('loads once', async () => {
    assert.equal(await loadCatalogue(), catalogue);
    assert.deepEqual(catalogue, JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')));
  });
});

describe('settings catalogue generator', { skip: !haveSources && 'the engine, the Orca sources or the server CLI\'s Orca is not on this machine' }, () => {
  it('regenerates the committed files byte for byte, twice', async () => {
    const first = await generate(paths);
    const second = await generate(paths);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.files[CATALOGUE_PATH], readFileSync(CATALOGUE_PATH, 'utf8'), 'catalogue.json is out of date: run npm run gen:settings');
    assert.equal(first.files[OPTION_TYPES_PATH], readFileSync(OPTION_TYPES_PATH, 'utf8'), 'optionTypes.ts is out of date: run npm run gen:settings');
  });

  it('lists only enum values Orca can read back', async () => {
    const defs = await readEngineDefinitions(paths.engineDir);
    for (const [key, def] of Object.entries(catalogue.options)) {
      const keysMap = defs.options[key]?.enumKeys;
      if (keysMap && def.enumValues) for (const value of def.enumValues) assert.ok(Object.hasOwn(keysMap, value), `${key}: "${value}"`);
    }
    // Orca lists "Default" in its drop-down but cannot read it.
    assert.deepEqual(catalogue.options.filament_map_mode.enumValues, ['Auto For Flush', 'Auto For Match', 'Manual', 'Nozzle Manual']);
    assert.equal(catalogue.options.filament_map_mode.engineOnlyValues, undefined);
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
