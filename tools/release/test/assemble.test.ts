// tools/release/assemble.mjs on the host that `npm run build:host` builds from this checkout, with stand-ins for the
// two engine variants: the runtime's manifest.json names the protocol the host was built with, PROTOCOL of
// packages/protocol, major and minor. (Releases up to 0.4.0 wrote minor 0 whatever the host spoke.)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from '../../../packages/protocol/src/envelope.ts';
import type { EngineManifest } from '../../../packages/protocol/src/manifest.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const ASSEMBLE = path.join(repo, 'tools/release/assemble.mjs');
// One commit for every part: assemble.mjs refuses parts built from a modified tree, as a working copy with
// changes in host/src would make the host.
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

let work = '';
let dist = '';

/** Runs assemble.mjs on `dist` into `<work>/<name>`, as the edge prerelease does (no tag, no sources). */
function assemble(name: string) {
  const out = path.join(work, name);
  const run = spawnSync(process.execPath, [ASSEMBLE, '--dist', dist, '--out', out, '--version', '0.0.0-test', '--commit', COMMIT], {
    encoding: 'utf8',
  });
  return { out, status: run.status, stderr: run.stderr };
}

const readManifest = (dir: string): EngineManifest => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const writeManifest = (manifest: EngineManifest) => fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'muon3d-assemble-'));
  dist = path.join(work, 'dist');
  execFileSync(process.execPath, [path.join(repo, 'host/build.mjs')], { env: { ...process.env, ENGINE_DIST: dist }, stdio: 'pipe' });
  // What engine/scripts/build.sh adds for each variant, with placeholder files.
  const manifest = readManifest(dist);
  for (const variant of ['st', 'mt'] as const) {
    for (const ext of ['mjs', 'wasm']) {
      for (const suffix of ['', '.br', '.gz']) fs.writeFileSync(path.join(dist, `engine-${variant}.${ext}${suffix}`), `${variant} ${ext}${suffix}\n`);
    }
    manifest.variants[variant] = { mjs: `engine-${variant}.mjs`, wasm: `engine-${variant}.wasm`, wasmBytes: 8, engineCommit: COMMIT };
  }
  Object.assign(manifest, { orcaVersion: '2.5.0-test', orcaCommit: 'f'.repeat(40), builtAt: '2026-01-01T00:00:00Z' });
  manifest.host!.engineCommit = COMMIT;
  writeManifest(manifest);
});

after(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('assemble.mjs', () => {
  it('the host build records the protocol it was built with', () => {
    const { host } = readManifest(dist);
    assert.equal(host?.protocol, PROTOCOL.major);
    assert.equal(host?.protocolMinor, PROTOCOL.minor);
  });

  it("the runtime's manifest.json names PROTOCOL, major and minor", () => {
    const run = assemble('runtime');
    assert.equal(run.status, 0, run.stderr);
    const released = readManifest(run.out);
    assert.deepEqual(released.protocol, { major: PROTOCOL.major, minor: PROTOCOL.minor });
    assert.equal(released.host?.protocolMinor, PROTOCOL.minor);
  });

  it('refuses a host entry with no protocol minor (a host built before it was recorded)', () => {
    const manifest = readManifest(dist);
    delete manifest.host!.protocolMinor;
    writeManifest(manifest);
    const run = assemble('old-host');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /names no protocol major and minor/);
    assert.equal(fs.existsSync(run.out), false);
  });
});
