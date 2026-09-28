// The settings service (settings.view and settings.edit) reproduces its goldens exactly
// (test/goldens/settings/views.json.gz, recorded from the Muon3D Slicer app's own settings code before it
// moved here; tools/goldens/views-replay.ts): the tabs of every preset case, the VIEW_CASES in every mode and
// for every nozzle, and the scripted edits in the global, object and plate scopes.
//
//   node --test test/goldens/views.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { SettingsService } from '../../host/src/settings/service.ts';
import type { PresetsFile } from '../../tools/goldens/rules-replay.ts';
import { canonical, replayViews } from '../../tools/goldens/views-replay.ts';

const presets = JSON.parse(readFileSync(new URL('./settings/presets.json', import.meta.url), 'utf8')) as PresetsFile;
const expected = JSON.parse(gunzipSync(readFileSync(new URL('./settings/views.json.gz', import.meta.url))).toString('utf8')) as ReturnType<typeof replayViews>;

test('the settings service reproduces its view goldens', () => {
  const actual = replayViews(presets, new SettingsService(), { omit: expected.omit, frequent: expected.frequent });
  const same = (a: unknown, b: unknown, what: string) => {
    if (canonical(a) !== canonical(b)) assert.deepEqual(JSON.parse(canonical(a)), JSON.parse(canonical(b)), what);
  };
  for (const [id, byScope] of Object.entries(expected.cases)) {
    for (const [scope, result] of Object.entries(byScope)) same(actual.results[actual.cases[id][scope]], expected.results[result], `case ${id}, ${scope}`);
  }
  for (const [id, byView] of Object.entries(expected.views)) {
    for (const [view, result] of Object.entries(byView)) same(actual.results[actual.views[id][view]], expected.results[result], `view case ${id}, ${view}`);
  }
  for (const part of ['global', 'object', 'plate'] as const) {
    for (const [id, steps] of Object.entries(expected[part])) {
      (steps as Array<{ view?: string }>).forEach((step, i) => {
        const got = (actual[part][id] as Array<{ view?: string }>)[i];
        const { view, ...rest } = step;
        const { view: gotView, ...gotRest } = got;
        same(gotRest, rest, `${part} script ${id}, step ${i + 1}`);
        if (view) same(actual.results[gotView!], expected.results[view], `${part} script ${id}, document after step ${i + 1}`);
      });
    }
  }
});
