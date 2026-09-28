// Records the presets of the settings goldens: test/goldens/settings/presets.json, the flattened
// presets of every case in scenarios.ts (presetCases), read from the Orca checkout's profiles. The
// file is committed, so the golden tests run without the checkout.
//
//   node tools/goldens/record-presets.ts            # ORCA_SRC, default the orca/ submodule
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../packages/protocol/src/data.ts';
import { ProfileTree, type PresetType } from './profiles.ts';
import { presetCases } from './scenarios.ts';
import { writeGoldens } from './write-json.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const orca = path.resolve(process.env.ORCA_SRC ?? path.join(repo, 'orca'));
const tree = new ProfileTree(path.join(orca, 'resources/profiles'));
const cases = presetCases(tree);

const presets: Record<string, Config> = {};
for (const c of cases) {
  for (const id of [c.machine, c.process, c.filament]) {
    if (presets[id]) continue;
    const [type, vendor, ...name] = id.split('/');
    presets[id] = tree.flatten(type as PresetType, vendor, name.join('/'));
  }
}
const sorted = Object.fromEntries(Object.keys(presets).sort().map((id) => [id, presets[id]]));
const out = path.join(repo, 'test/goldens/settings/presets.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
writeGoldens(out, { format: 1, cases, presets: sorted }, ['presets']);
console.log(`OK: ${out}: ${cases.length} cases, ${Object.keys(sorted).length} presets (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
