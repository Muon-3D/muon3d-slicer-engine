// `npm run test:engine`: the engine tests (engine/test/engine.test.ts) against the published engine,
// once per variant. Unlike a bare `node --test engine/test/engine.test.ts`, a variant that is not built
// fails instead of skipping its suite.
//
//   npm run test:engine             # st, then mt
//   npm run test:engine:mt          # one variant (also: npm run test:engine -- mt)
//
// ENGINE_DIR, ORCA_RESOURCES and ENGINE_TEST_OUT pass through (engine/test/fixtures.ts); the tests need
// the Orca checkout's resources for the presets (default ~/OrcaWasm/orca/resources).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engineDir = path.resolve(process.env.ENGINE_DIR ?? path.join(repo, 'web/public/engine'));
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
  const result = spawnSync(process.execPath, ['--test', ...testOptions, 'engine/test/engine.test.ts'], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, ENGINE_VARIANT: variant },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
