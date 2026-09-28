// Records the settings-rules goldens: test/goldens/settings/rules.json, from the presets recorded in
// presets.json (record-presets.ts) replayed through rules-replay.ts. Run it only when a change to the
// rules is meant to change their results; test/goldens/rules.test.ts fails on any difference.
//
//   node tools/goldens/record-rules.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayRules, type PresetsFile } from './rules-replay.ts';
import { writeGoldens } from './write-json.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(repo, 'test/goldens/settings');
const presets = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8')) as PresetsFile;
const goldens = replayRules(presets);
const out = path.join(dir, 'rules.json');
writeGoldens(out, goldens, ['cases', 'results']);
const steps = [goldens.global, goldens.object, goldens.plate].reduce((n, s) => n + Object.values(s).flat().length, 0);
console.log(`OK: ${out}: ${Object.keys(goldens.cases).length} cases, ${steps} scripted steps, ${Object.keys(goldens.results).length} distinct results (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
