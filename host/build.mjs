// `npm run build:host`: bundles the engine host (host/src/worker.ts, protocol v2) with esbuild into dist/:
// host.<hash>.js, the ES module a client starts (a Web Worker, or a Node worker_threads Worker), and the
// chunks it loads on demand (host-service.<hash>.js: the settings service with the settings catalogue,
// loaded on the first settings op). It records them in dist/manifest.json (`host`: the file, its sha256,
// the protocol, the canary, and `chunks`), and copies LICENSE, NOTICE, THIRD-PARTY-NOTICES.md and SOURCE.md
// into dist/, so they are served next to the object code.
//
//   npm run build:host                 # dist/host.<hash>.js, dist/host-*.<hash>.js (+ .br/.gz)
//   npm run build:host -- --watch      # dist/host.dev.js (+ chunks), rebuilt on every change (a client's dev loop)
//
// Every file keeps the licence banner (/*! @license ... */, which minifiers keep). The host reports its
// canary (host/src/canary.ts) and what `hello` says about the build (version, commit, source, Orca), which
// this script fills in (host/src/info.ts). The output depends only on the sources, the esbuild version
// (package-lock.json) and the commit named in the banner.
//
// Environment:
//   ENGINE_DIST    output folder, default dist/ in this repository (as engine/scripts/build.sh)
//   HOST_METAFILE  also write esbuild's metafile (every bundled input) there; the release notices use it
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
const PROTOCOL = 2;

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** This repository's commit, "-dirty" when the host or the protocol package have uncommitted changes. */
function engineCommit() {
  // A release's source bundle is not a git checkout: it names its commit in SOURCE_COMMITS.
  if (!fs.existsSync(path.join(repo, '.git'))) {
    const named = /^engine=(\S+)$/m.exec(readOptional(path.join(repo, 'SOURCE_COMMITS')))?.[1];
    return named ?? 'unknown';
  }
  try {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'host/src', 'packages/protocol/src', 'data'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

const canary = /HOST_CANARY = '([^']+)'/.exec(fs.readFileSync(path.join(repo, 'host/src/canary.ts'), 'utf8'))?.[1];
if (!canary) throw new Error('host/src/canary.ts: no HOST_CANARY');

/** What `hello` says about this build (host/src/info.ts BuildInfo). */
function buildInfo(commit) {
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const catalogue = JSON.parse(fs.readFileSync(path.join(repo, 'data/settings-catalogue.json'), 'utf8'));
  const pin = readOptional(path.join(repo, 'engine/scripts/orca/pin.sh'));
  const orcaRepository = (/^ORCA_REPO=(\S+)/m.exec(pin)?.[1] ?? 'https://github.com/Muon-3D/OrcaSlicer').replace(/\.git$/, '').replace(/^["']|["']$/g, '');
  const memory = /-sMAXIMUM_MEMORY=(\d+)(GB|MB)/.exec(readOptional(path.join(repo, 'engine/cmake/Engine.cmake')));
  const maxHeapBytes = memory ? Number(memory[1]) * 1024 ** (memory[2] === 'GB' ? 3 : 2) : 4 * 1024 ** 3;
  const clean = commit.replace(/-(dirty|dev)$/, '');
  return {
    version,
    commit,
    source: /^[0-9a-f]{40}$/.test(clean) ? `${SOURCE_URL}/tree/${clean}` : SOURCE_URL,
    orca: { version: catalogue.orca.version, commit: catalogue.orca.commit, repository: orcaRepository },
    maxHeapBytes,
  };
}

function banner(commit) {
  return [
    '/*! @license AGPL-3.0-only',
    ' * Muon3D Slicer Engine (based on OrcaSlicer): engine host.',
    ' * Copyright (C) the OrcaSlicer authors; modifications Copyright (C) 2026 Muon 3D Technologies Limited.',
    ' * Free software under the GNU Affero General Public License, version 3: see LICENSE and NOTICE next to',
    ' * this file.',
    ` * @source ${SOURCE_URL} (commit ${commit})`,
    ' */',
  ].join('\n');
}

const options = (commit, names) => ({
  absWorkingDir: repo,
  entryPoints: ['host/src/worker.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'inline',
  banner: { js: banner(commit) },
  define: { __ENGINE_BUILD__: JSON.stringify(buildInfo(commit)) },
  // Node's modules are imported only when the host runs in a Node worker thread (worker.ts, core.ts).
  external: ['node:*'],
  outdir: dist,
  entryNames: names.entry,
  chunkNames: names.chunk,
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
  for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'SOURCE.md']) fs.copyFileSync(path.join(repo, name), path.join(dist, name));
}

const HOST_FILE = /^host(\.|-)[^/]*\.js(\.br|\.gz)?$/;

/** Host files of earlier builds go (the new ones are `keep`). */
function removeOldHosts(keep) {
  for (const name of fs.readdirSync(dist)) {
    if (HOST_FILE.test(name) && !keep.some((k) => name === k || name === `${k}.br` || name === `${k}.gz`)) fs.rmSync(path.join(dist, name));
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Writes the build's files and returns the manifest entry: the entry script and its chunks. */
function writeOutputs(outputFiles, commit, compress) {
  const files = outputFiles.map((f) => ({ name: path.basename(f.path), contents: f.contents }));
  const entry = files.find((f) => /^host\.[^-]*\.js$/.test(f.name) || f.name === 'host.dev.js');
  if (!entry) throw new Error(`no host entry among ${files.map((f) => f.name).join(', ')}`);
  removeOldHosts(files.map((f) => f.name));
  for (const f of files) {
    fs.writeFileSync(path.join(dist, f.name), f.contents);
    if (compress) execFileSync(process.execPath, [path.join(repo, 'engine/scripts/compress.mjs'), path.join(dist, f.name)], { stdio: 'inherit' });
  }
  const chunks = files.filter((f) => f !== entry).map((f) => ({ file: f.name, sha256: sha256(f.contents) }));
  return { file: entry.name, sha256: sha256(entry.contents), protocol: PROTOCOL, canary, engineCommit: commit, chunks };
}

fs.mkdirSync(dist, { recursive: true });
copyNotices();

if (watch) {
  const commit = `${engineCommit().replace(/-dirty$/, '')}-dev`;
  const context = await esbuild.context({
    ...options(commit, { entry: 'host.dev', chunk: 'host-[name].dev' }),
    plugins: [
      {
        name: 'write',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length || !result.outputFiles) return;
            const host = writeOutputs(result.outputFiles, commit, false);
            writeManifest(host);
            console.log(`${host.file} rebuilt (${host.chunks.length} chunks)`);
          });
        },
      },
    ],
  });
  await context.watch();
  console.log(`watching host/src and packages/protocol/src; writing ${path.join(dist, 'host.dev.js')}`);
} else {
  const commit = engineCommit();
  const result = await esbuild.build({ ...options(commit, { entry: 'host.[hash]', chunk: 'host-[name].[hash]' }), metafile: Boolean(process.env.HOST_METAFILE) });
  if (process.env.HOST_METAFILE) fs.writeFileSync(process.env.HOST_METAFILE, JSON.stringify(result.metafile, null, 2) + '\n');
  const host = writeOutputs(result.outputFiles, commit, true);
  writeManifest(host);
  const bytes = (name) => fs.statSync(path.join(dist, name)).size.toLocaleString('en');
  console.log(`OK: ${path.join(dist, host.file)} (${bytes(host.file)} bytes, protocol v${PROTOCOL}, commit ${commit})`);
  for (const chunk of host.chunks) console.log(`    ${chunk.file} (${bytes(chunk.file)} bytes, loaded on demand)`);
}
