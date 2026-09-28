#!/usr/bin/env node
// OrcaSlicer's settings from the command line, through the engine host's settings service (settings.view,
// settings.edit; protocol v2): validate a preset, or print a settings form as text, with Orca's rules applied
// (rows hidden or greyed for the current values, narrowed choices, Orca's warnings). No app, no wasm: the
// settings service needs neither.
//
//   node examples/settings-cli/settings.mjs --validate                          # the M1 presets
//   node examples/settings-cli/settings.mjs --presets my.json --validate
//   node examples/settings-cli/settings.mjs --scope process --mode expert        # print the Process tab
//   node examples/settings-cli/settings.mjs --set process.layer_height=0 --set process.spiral_mode=1
//   node examples/settings-cli/settings.mjs --scope object --object layer_height=0.12 --object wall_loops=5
//
// Options:
//   --presets <file>          flattened presets: { "machine": {...}, "process": {...}, "filaments": [{...}] }
//                             (default test/fixtures/presets/muon3d-m1-0.4.json)
//   --validate                print Orca's errors and warnings for the three presets; exit 1 on an error
//   --scope <scope>           the form to print: process, filament, machine, object or plate (default process)
//   --mode <mode>             simple, advanced or expert (default advanced)
//   --set <scope.key=value>   an edit, as a user makes it (Orca's edit handlers run); repeatable, in order
//   --object <key=value>      the object's own settings (scope object); repeatable
//   --plate <key=value>       the plate's own settings; repeatable
//   --extruder <n>            the nozzle whose values per-nozzle-variant rows show (default 0)
//   --vendor <name>           the printer's vendor folder in Orca's profiles (BBL turns on Bambu's rules)
//   --json                    print the settings.view document as JSON instead
//   --dist <folder>           the built host (default dist/ of this repository; else the host's sources)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SettingsClient } from '../../packages/protocol/src/index.ts';
import { startHost } from '../start-host.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values: opts } = parseArgs({
  options: {
    presets: { type: 'string', default: path.join(repo, 'test/fixtures/presets/muon3d-m1-0.4.json') },
    validate: { type: 'boolean' },
    scope: { type: 'string', default: 'process' },
    mode: { type: 'string', default: 'advanced' },
    set: { type: 'string', multiple: true, default: [] },
    object: { type: 'string', multiple: true, default: [] },
    plate: { type: 'string', multiple: true, default: [] },
    extruder: { type: 'string', default: '0' },
    vendor: { type: 'string' },
    json: { type: 'boolean' },
    dist: { type: 'string', default: path.join(repo, 'dist') },
    help: { type: 'boolean', short: 'h' },
  },
});

function usage(message) {
  if (message) console.error(`settings: ${message}`);
  console.error('usage: node examples/settings-cli/settings.mjs [--presets <json>] [--validate] [--scope <scope>] [--mode <mode>] [--set scope.key=value ...] [--object key=value ...] [--plate key=value ...] [--json]');
  process.exit(message ? 2 : 0);
}
if (opts.help) usage();
if (!['process', 'filament', 'machine', 'object', 'plate'].includes(opts.scope)) usage('--scope must be process, filament, machine, object or plate');
if (!['simple', 'advanced', 'expert'].includes(opts.mode)) usage('--mode must be simple, advanced or expert');

const pairs = (list, what) =>
  Object.fromEntries(
    list.map((item) => {
      const at = item.indexOf('=');
      if (at <= 0) usage(`${what} needs key=value (got "${item}")`);
      return [item.slice(0, at), item.slice(at + 1)];
    }),
  );

const file = JSON.parse(fs.readFileSync(opts.presets, 'utf8'));
const presets = { machine: file.machine, process: file.process, filament: file.filaments?.[0] };
for (const [k, v] of Object.entries(presets)) if (!v) usage(`${opts.presets} has no ${k === 'filament' ? 'filaments' : k}`);
const env = { mode: opts.mode, extruder: Number(opts.extruder), ...(opts.vendor ? { vendor: opts.vendor } : {}) };
const overrides = { process: {}, filament: {}, machine: {} };
let object = pairs(opts.object, '--object');
let plate = pairs(opts.plate, '--plate');

const host = await startHost(path.resolve(opts.dist));
const settings = new SettingsClient(host.connection);
const input = () => ({ presets, overrides, plate, object, env });
let exitCode = 0;

try {
  // ---- Edits, in order, as a user makes them ----------------------------------------------------------
  for (const item of opts.set) {
    const m = /^(process|filament|machine|object|plate)\.([A-Za-z0-9_]+)=(.*)$/s.exec(item);
    if (!m) usage(`--set needs scope.key=value (got "${item}")`);
    const [, scope, key, value] = m;
    const result = await settings.edit({ ...input(), scope, edit: { set: key, value } });
    const apply = (own) => {
      const next = { ...own };
      for (const [k, v] of Object.entries(result.writes)) if (v === null) delete next[k];
      else next[k] = v;
      return next;
    };
    if (scope === 'object') object = apply(object);
    else if (scope === 'plate') plate = apply(plate);
    else overrides[scope] = apply(overrides[scope]);
    console.log(`set ${scope}.${key} = ${JSON.stringify(value)}: writes ${JSON.stringify(result.writes)}`);
    for (const notice of result.notices) console.log(`  note: ${notice}`);
    for (const prompt of result.prompts) {
      console.log(`  ${prompt.blocking ? 'question (nothing changed yet)' : 'question'}: ${prompt.message}`);
      for (const choice of prompt.choices) console.log(`    - ${choice.label}${Object.keys(choice.values).length ? ` ${JSON.stringify(choice.values)}` : ''}`);
    }
  }

  // ---- Validate ---------------------------------------------------------------------------------------
  if (opts.validate) {
    let count = 0;
    for (const scope of ['process', 'filament', 'machine']) {
      const view = await settings.view({ ...input(), scope });
      for (const issue of view.issues.filter((i) => i.severity !== 'info')) {
        count++;
        if (issue.severity === 'error') exitCode = 1;
        const label = view.form.options[issue.key]?.label ?? issue.key;
        console.log(`${issue.severity.toUpperCase()} ${scope} › ${label} (${issue.key}): ${issue.message}`);
        if (issue.fix) console.log(`  fix${issue.fixLabel ? ` "${issue.fixLabel}"` : ''}: ${JSON.stringify(issue.fix)}`);
      }
    }
    console.log(count === 0 ? 'OK: Orca raises no error or warning for these presets.' : `${count} issue(s).`);
  } else {
    // ---- Print the form ---------------------------------------------------------------------------------
    const view = await settings.view({ ...input(), scope: opts.scope, values: true });
    if (opts.json) console.log(JSON.stringify(view, null, 2));
    else printView(view);
  }
} finally {
  host.close();
}
process.exitCode = exitCode;

function valueText(option, value) {
  if (value === undefined) return '';
  if (option?.control === 'bool') return value === '1' ? 'on' : 'off';
  const label = option?.enum?.find((e) => e.value === value)?.label;
  const shown = (label ?? value).replace(/\s*\n\s*/g, ' ↵ ');
  const unit = option?.unit && !option.enum && !shown.endsWith('%') ? ` ${option.unit}` : '';
  return shown.length > 60 ? `${shown.slice(0, 57)}...` : `${shown}${unit}`;
}

function printIssues(issues, keys) {
  for (const issue of issues.filter((i) => keys.includes(i.key) && i.severity !== 'info')) console.log(`      ! ${issue.severity}: ${issue.message}`);
}

function printView(view) {
  const { form } = view;
  if (view.tab) {
    const lines = new Map(form.pages.flatMap((p) => p.groups.flatMap((g) => g.lines.map((l) => [l.id, l]))));
    const groups = new Map(form.pages.flatMap((p) => p.groups.map((g) => [`${p.id}/${g.id}`, g])));
    console.log(`${opts.scope} (${opts.mode}; ${view.tab.extruders} nozzle(s), showing nozzle ${view.tab.extruder + 1})`);
    for (const page of view.tab.pages) {
      console.log(`\n${page.title}${page.issues ? `  [${page.issues} issue(s)]` : ''}${page.nozzlePicker ? '  (nozzle picker)' : ''}`);
      for (const group of page.groups) {
        console.log(`  ${groups.get(`${page.page}/${group.id}`)?.title ?? group.id}`);
        for (const line of group.lines) {
          const fl = lines.get(line.id);
          const cells = line.cells.map((c) => {
            const option = form.options[c.key];
            const name = line.cells.length > 1 ? `${c.label ?? fl.options.find((o) => o.key === c.key)?.label}: ` : '';
            const flags = [c.disabled ? 'greyed' : '', c.choices ? `choices ${c.choices.join('|')}` : '', c.value === 'nil' && c.inherited !== undefined ? `inherits ${c.inherited}` : '']
              .filter(Boolean)
              .join('; ');
            return `${name}${valueText(option, c.value)}${flags ? ` (${flags})` : ''}`;
          });
          console.log(`    ${line.label ?? fl.label}: ${cells.join(', ')}`);
          printIssues(view.issues, line.cells.map((c) => c.key));
        }
      }
    }
  } else if (view.object) {
    console.log(`object settings (${opts.mode})`);
    for (const group of view.object.groups) {
      console.log(`  ${group.title}`);
      for (const row of group.rows) {
        const option = form.options[row.key];
        const flags = [row.disabled ? `greyed: ${row.disabled}` : '', row.choices ? `choices ${row.choices.join('|')}` : ''].filter(Boolean).join('; ');
        console.log(`    ${row.label ?? option?.label ?? row.key}: ${valueText(option, row.value)} (global ${valueText(option, row.inherited)})${flags ? ` (${flags})` : ''}`);
        printIssues(view.issues, [row.key]);
      }
    }
    const lh = view.object.limits.layerHeight;
    console.log(`  layer height limits: ${lh.min ?? '-'} to ${lh.max ?? '-'} mm`);
    console.log(`  can add: ${view.object.add.map((g) => `${g.title} (${g.keys.length})`).join(', ')}`);
  } else if (view.plate) {
    console.log('plate settings');
    for (const row of view.plate.rows) {
      const option = form.options[row.key];
      console.log(`  ${option?.label ?? row.key}: ${row.value !== undefined ? valueText(option, row.value) : `same as global (${valueText(option, row.global)})`}`);
    }
    for (const issue of view.issues) console.log(`  ! ${issue.severity}: ${issue.message}`);
  }
}
