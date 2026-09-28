// Records the settings-view goldens: test/goldens/settings/views.json.gz (gzip: about 5 MB of JSON), from
// the presets in presets.json replayed through the settings service (views-replay.ts). The `omit` and
// `frequent` lists (the recording app's policy: keys it never shows, its frequent object settings) are kept
// from the existing file, or read from --options <json> the first time. Run it only when a change to the
// settings service is meant to change its documents; test/goldens/views.test.ts fails on any difference.
//
//   node tools/goldens/record-views.ts [--options options.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SettingsService } from '../../host/src/settings/service.ts';
import type { PresetsFile } from './rules-replay.ts';
import { replayViews, type ViewGoldenOptions } from './views-replay.ts';
import { writeGoldens } from './write-json.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(repo, 'test/goldens/settings');
const out = path.join(dir, 'views.json.gz');
const { values: args } = parseArgs({ options: { options: { type: 'string' } } });

let options: ViewGoldenOptions;
if (args.options) {
  options = JSON.parse(fs.readFileSync(args.options, 'utf8')) as ViewGoldenOptions;
} else if (fs.existsSync(out)) {
  const { omit, frequent } = JSON.parse(gunzipSync(fs.readFileSync(out)).toString('utf8')) as ViewGoldenOptions;
  options = { omit, frequent };
} else {
  console.error('record-views: no views.json.gz yet: give --options <json> with { omit, frequent }');
  process.exit(2);
}

const presets = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8')) as PresetsFile;
const goldens = replayViews(presets, new SettingsService(), options);
const tmp = path.join(dir, 'views.json.tmp');
writeGoldens(tmp, goldens, ['cases', 'views', 'results']);
fs.writeFileSync(out, gzipSync(fs.readFileSync(tmp), { level: 9 }));
fs.rmSync(tmp);
console.log(`OK: ${out}: ${Object.keys(goldens.results).length} distinct documents (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
