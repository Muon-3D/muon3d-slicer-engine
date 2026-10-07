// `npm run test:engine`: the engine tests (test/engine.test.ts, test/settingsOverrides.e2e.test.ts and the
// protocol conformance suite, test/conformance/conformance.test.ts, whose engine part needs the build)
// against the built engine, once per variant. Unlike a bare `node --test test/engine.test.ts`, a variant
// that is not built fails instead of skipping its suite.
//
//   npm run test:engine             # st, then mt
//   npm run test:engine:mt          # one variant (also: npm run test:engine -- mt)
//
// ENGINE_DIR (default dist/), ENGINE_TEST_OUT and ENGINE_TEST_BENCHY pass through (test/fixtures.ts).
// The presets are committed fixtures (test/fixtures/presets), so no Orca checkout is needed.
//
// The tests run with --disallow-code-generation-from-strings, which refuses eval and new Function as a
// Content-Security-Policy without 'unsafe-eval' does in a browser (WebAssembly still compiles): an engine whose
// glue makes code from text fails every test (engine/cmake/Engine.cmake, EMBIND_AOT and DYNAMIC_EXECUTION=0).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engineDir = path.resolve(process.env.ENGINE_DIR ?? path.join(repo, 'dist'));
const TESTS = ['test/engine.test.ts', 'test/settingsOverrides.e2e.test.ts', 'test/conformance/conformance.test.ts'];
const args = process.argv.slice(2);
// Options (e.g. --test-name-pattern=Benchy) go to node --test; the rest name variants.
const testOptions = args.filter((arg) => arg.startsWith('--'));
const variants = args.filter((arg) => !arg.startsWith('--'));
if (variants.length === 0) variants.push('st', 'mt');

let failed = false;
for (const variant of variants) {
  if (variant !== 'st' && variant !== 'mt') {
    console.error(`usage: npm run test:engine [-- st|mt ...] (got "${variant}")`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(engineDir, `engine-${variant}.mjs`))) {
    console.error(`engine-${variant}.mjs is not in ${engineDir}: build it first (npm run build:engine -- ${variant}).`);
    failed = true;
    continue;
  }
  console.log(`# engine tests: ${variant} (${engineDir})`);
  const result = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--test', ...testOptions, ...TESTS], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, ENGINE_DIR: engineDir, ENGINE_VARIANT: variant, ENGINE_TEST_REQUIRE: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
