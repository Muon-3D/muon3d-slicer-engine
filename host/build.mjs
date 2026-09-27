// `npm run build:host`: bundles the worker host (host/src/worker.ts) with esbuild into
// dist/host.<hash>.js, an ES module worker script, and records it in dist/manifest.json. It also
// copies LICENSE, NOTICE and SOURCE.md into dist/, so they are served next to the object code.
//
//   npm run build:host                 # dist/host.<content hash>.js (+ .br/.gz)
//   npm run build:host -- --watch      # dist/host.dev.js, rebuilt on every change (for a client's dev loop)
//
// The host keeps its licence banner (/*! @license ... */, which minifiers keep) and reports its canary
// (host/src/canary.ts) in `ready`. The output depends only on the sources, the esbuild version
// (package-lock.json) and the commit named in the banner.
//
// Environment:
//   ENGINE_DIST  output folder, default dist/ in this repository (as engine/scripts/build.sh)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.ENGINE_DIST ?? path.join(repo, 'dist'));
const watch = process.argv.includes('--watch');
const SOURCE_URL = 'https://github.com/Muon-3D/muon3d-slicer-engine';
const PROTOCOL = 1;

/** This repository's commit, "-dirty" when the host or the protocol types have uncommitted changes. */
function engineCommit() {
  try {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'host/src', 'packages/protocol/src'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

const canary = /HOST_CANARY = '([^']+)'/.exec(fs.readFileSync(path.join(repo, 'host/src/canary.ts'), 'utf8'))?.[1];
if (!canary) throw new Error('host/src/canary.ts: no HOST_CANARY');

function banner(commit) {
  return [
    '/*! @license AGPL-3.0-only',
    ' * Muon3D Slicer Engine (based on OrcaSlicer): worker host.',
    ' * Copyright (C) the OrcaSlicer authors; modifications Copyright (C) 2026 Muon 3D Technologies Limited.',
    ' * Free software under the GNU Affero General Public License, version 3: see LICENSE and NOTICE next to',
    ' * this file.',
    ` * @source ${SOURCE_URL} (commit ${commit})`,
    ' */',
  ].join('\n');
}

const options = (commit) => ({
  absWorkingDir: repo,
  entryPoints: ['host/src/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'inline',
  banner: { js: banner(commit) },
  logLevel: 'warning',
  // The engine module is imported at run time by URL (loadEngine), never bundled.
  write: false,
});

/** Merges the host entry into manifest.json (engine/scripts/build.sh keeps it when it adds a variant). */
function writeManifest(host) {
  const file = path.join(dist, 'manifest.json');
  let manifest = { variants: {} };
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No engine built yet: engine/scripts/build.sh fills in the rest.
  }
  manifest.host = host;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

function copyNotices() {
  for (const name of ['LICENSE', 'NOTICE', 'SOURCE.md']) fs.copyFileSync(path.join(repo, name), path.join(dist, name));
}

function removeOldHosts(keep) {
  for (const name of fs.readdirSync(dist)) {
    if (/^host\.[0-9a-f]+\.js(\.br|\.gz)?$/.test(name) && !name.startsWith(keep)) fs.rmSync(path.join(dist, name));
  }
}

fs.mkdirSync(dist, { recursive: true });
copyNotices();

if (watch) {
  const commit = `${engineCommit().replace(/-dirty$/, '')}-dev`;
  const context = await esbuild.context({
    ...options(commit),
    write: true,
    outfile: path.join(dist, 'host.dev.js'),
    plugins: [
      {
        name: 'manifest',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length) return;
            const text = fs.readFileSync(path.join(dist, 'host.dev.js'));
            writeManifest({ file: 'host.dev.js', sha256: createHash('sha256').update(text).digest('hex'), protocol: PROTOCOL, canary, engineCommit: commit });
            console.log(`host.dev.js rebuilt (${text.length.toLocaleString('en')} bytes)`);
          });
        },
      },
    ],
  });
  await context.watch();
  console.log(`watching host/src and packages/protocol/src; writing ${path.join(dist, 'host.dev.js')}`);
} else {
  const commit = engineCommit();
  const result = await esbuild.build(options(commit));
  const text = result.outputFiles[0].contents;
  const sha256 = createHash('sha256').update(text).digest('hex');
  const name = `host.${sha256.slice(0, 16)}.js`;
  removeOldHosts(name);
  fs.writeFileSync(path.join(dist, name), text);
  execFileSync(process.execPath, [path.join(repo, 'engine/scripts/compress.mjs'), path.join(dist, name)], { stdio: 'inherit' });
  writeManifest({ file: name, sha256, protocol: PROTOCOL, canary, engineCommit: commit });
  console.log(`OK: ${path.join(dist, name)} (${text.length.toLocaleString('en')} bytes, protocol v${PROTOCOL}, commit ${commit})`);
}
