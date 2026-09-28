// The settings rules reproduce their goldens exactly (test/goldens/settings/rules.json, recorded by
// tools/goldens/record-rules.ts from the rules as first moved into this repository): every preset case
// of presets.json evaluated, and every scripted edit of tools/goldens/scenarios.ts in the global, object
// and plate contexts. A difference fails with the first differing case.
//
//   node --test test/goldens/rules.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { replayRules, type PresetsFile } from '../../tools/goldens/rules-replay.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./settings/${name}`, import.meta.url), 'utf8'));

test('the settings rules reproduce their goldens', () => {
  const presets = read('presets.json') as PresetsFile;
  const expected = read('rules.json') as ReturnType<typeof replayRules>;
  const actual = replayRules(presets);
  assert.equal(Object.keys(actual.cases).length, presets.cases.length);
  for (const [id, result] of Object.entries(expected.cases)) {
    assert.deepEqual(actual.results[actual.cases[id]], expected.results[result], `case ${id}`);
  }
  for (const part of ['global', 'object', 'plate'] as const) {
    for (const [id, steps] of Object.entries(expected[part])) {
      const got = actual[part][id] as Array<{ after: string }>;
      (steps as Array<{ after: string }>).forEach((step, i) => {
        const { after, ...rest } = step;
        const { after: gotAfter, ...gotRest } = got[i];
        assert.deepEqual(gotRest, rest, `${part} script ${id}, step ${i + 1}`);
        assert.deepEqual(actual.results[gotAfter], expected.results[after], `${part} script ${id}, rules after step ${i + 1}`);
      });
    }
  }
});
