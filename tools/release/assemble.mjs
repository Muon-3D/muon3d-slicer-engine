// Assembles the runtime of a release (or of the rolling `edge` prerelease) from a built dist/ folder: the host,
// both engine variants with their .br/.gz copies, the notices, a SOURCE.md that names this build's sources, and
// manifest.json with the release fields (EngineManifest in packages/protocol: version, protocol, Orca, build,
// source, and the sha256 of every file). docs/RELEASING.md describes the whole release.
//
//   node tools/release/assemble.mjs --dist dist --out out/muon3d-slicer-engine-0.1.0 --version 0.1.0 \
//     --tag v0.1.0 --sources out/sources.json
//
// Options:
//   --dist <dir>       a dist/ with manifest.json naming the host and both variants (npm run build, or
//                      tools/release/merge-dist.mjs + npm run build:host)
//   --out <dir>        the runtime folder to write (must not exist)
//   --version <v>      the release version, e.g. 0.1.0 (a release) or 0.1.0-edge.<commit> (a prerelease)
//   --tag <tag>        the release tag (v0.1.0); a release must be built from one clean commit
//   --sources <file>   sources.json from tools/release/source-bundles.sh: the source assets of this release
//   --repository <url> default https://github.com/Muon-3D/muon3d-slicer-engine
//   --commit <sha>     this repository's commit (default: git rev-parse HEAD)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string' },
    out: { type: 'string' },
    version: { type: 'string' },
    tag: { type: 'string' },
    sources: { type: 'string' },
    repository: { type: 'string', default: 'https://github.com/Muon-3D/muon3d-slicer-engine' },
    commit: { type: 'string' },
  },
});
for (const required of ['dist', 'out', 'version']) {
  if (!opts[required]) {
    console.error(`assemble: --${required} is required (see the top of tools/release/assemble.mjs)`);
    process.exit(2);
  }
}

const fail = (message) => {
  console.error(`assemble: ${message}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** A shell-style assignment NAME=value from one of this repository's scripts. */
function scriptValue(file, name) {
  const match = new RegExp(`^${name}=(\\S+)`, 'm').exec(fs.readFileSync(path.join(repo, file), 'utf8'));
  if (!match) fail(`no ${name}= in ${file}`);
  return match[1];
}

const dist = path.resolve(opts.dist);
const out = path.resolve(opts.out);
const release = Boolean(opts.tag);
const commit = opts.commit ?? execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (!manifest.host) fail(`${dist}/manifest.json names no host (npm run build:host)`);
for (const variant of ['st', 'mt']) if (!manifest.variants?.[variant]) fail(`${dist}/manifest.json has no ${variant} engine`);

// ---- What was built, and from what -------------------------------------------------------------------------
const engineCommits = new Set([manifest.host.engineCommit, ...Object.values(manifest.variants).map((v) => v.engineCommit)]);
for (const c of engineCommits) {
  if (!c || c === 'unknown' || c.endsWith('-dirty') || c.endsWith('-dev')) fail(`a part of ${dist} was built from "${c}", not from a commit`);
}
if (manifest.orcaCommit.endsWith('-dirty')) fail(`the engine was built from a modified Orca tree (${manifest.orcaCommit})`);
if (release && (engineCommits.size !== 1 || !engineCommits.has(commit))) {
  fail(`a release is built from one commit (${commit}); ${dist} has ${[...engineCommits].join(', ')}`);
}
if (release && opts.version !== JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version) {
  fail(`--version ${opts.version} is not package.json's version`);
}

// ---- The runtime files ---------------------------------------------------------------------------------------
if (fs.existsSync(out)) fail(`${out} exists already`);
fs.mkdirSync(out, { recursive: true });
const precompressed = (file) => [file, `${file}.br`, `${file}.gz`];
const files = [
  ...precompressed(manifest.host.file),
  ...Object.values(manifest.variants).flatMap((v) => [...precompressed(v.mjs), ...precompressed(v.wasm)]),
];
for (const name of files) {
  if (!fs.existsSync(path.join(dist, name))) fail(`${name} is missing from ${dist}`);
  fs.copyFileSync(path.join(dist, name), path.join(out, name));
}
for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) fs.copyFileSync(path.join(repo, name), path.join(out, name));

// ---- Sources -----------------------------------------------------------------------------------------------
const orca = {
  version: manifest.orcaVersion,
  commit: manifest.orcaCommit,
  tag: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_TAG'),
  repository: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_REPO').replace(/\.git$/, ''),
  base: {
    repository: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_BASE_REPO').replace(/\.git$/, ''),
    ref: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_BASE_REF'),
    commit: scriptValue('engine/scripts/orca/pin.sh', 'ORCA_BASE_COMMIT'),
  },
};
const source = { url: opts.repository, ...(release ? { tag: opts.tag } : {}), commit };
if (opts.sources) {
  const assets = JSON.parse(fs.readFileSync(opts.sources, 'utf8'));
  const base = `${opts.repository}/releases/download/${opts.tag}/`;
  for (const key of ['bundle', 'orca', 'thirdParty']) {
    if (!assets[key]) fail(`${opts.sources} has no "${key}"`);
    source[key] = { file: assets[key].file, url: base + assets[key].file, sha256: assets[key].sha256, bytes: assets[key].bytes };
  }
} else if (release) {
  fail('a release needs --sources (tools/release/source-bundles.sh)');
}

const emsdk = scriptValue('tools/ci/setup-toolchain.sh', 'EMSDK_VERSION');
const describeSource = (file) => `[\`${file.file}\`](${file.url}) (sha256 \`${file.sha256}\`)`;
const thisBuild = [
  '',
  '## This build',
  '',
  `Muon3D Slicer Engine ${opts.version}${release ? `, release [\`${opts.tag}\`](${opts.repository}/releases/tag/${opts.tag})` : ' (a prerelease)'}.`,
  '',
  `- **This repository:** commit [\`${commit}\`](${opts.repository}/tree/${commit})` +
    (source.bundle ? `; the source bundle ${describeSource(source.bundle)}.` : '.'),
  `- **OrcaSlicer:** ${orca.version} at commit [\`${orca.commit}\`](${orca.repository}/tree/${orca.commit}), tag \`${orca.tag}\` of ${orca.repository}` +
    (source.orca ? `; the source ${describeSource(source.orca)}.` : '.'),
  '- **Third-party sources:** the archives in `engine/deps/SHA256SUMS` and the Emscripten ports zlib and libpng' +
    (source.thirdParty
      ? `, mirrored in ${describeSource(source.thirdParty)}.`
      : `; mirrored copies are attached to the releases at ${opts.repository}/releases.`),
  `- **Toolchain:** Emscripten ${emsdk}, on Linux (the canonical build; see \`docs/BUILD.md\`).`,
  '',
  '`manifest.json` lists the sha256 of every file here. A rebuild from these sources gives byte-identical',
  '`engine-st.wasm`, `engine-mt.wasm` and their `.mjs` loaders.',
  '',
].join('\n');
fs.writeFileSync(path.join(out, 'SOURCE.md'), fs.readFileSync(path.join(repo, 'SOURCE.md'), 'utf8').trimEnd() + '\n' + thisBuild);

// ---- manifest.json -------------------------------------------------------------------------------------------
const fileEntries = {};
for (const name of fs.readdirSync(out).sort()) {
  fileEntries[name] = { sha256: sha256(path.join(out, name)), bytes: fs.statSync(path.join(out, name)).size };
}
const released = {
  manifest: 2,
  name: 'muon3d-slicer-engine',
  version: opts.version,
  protocol: { major: manifest.host.protocol, minor: 0 },
  license: 'AGPL-3.0-only',
  orcaVersion: manifest.orcaVersion,
  orcaCommit: manifest.orcaCommit,
  builtAt: manifest.builtAt,
  orca,
  build: { engineCommit: commit, emsdk, builtAt: manifest.builtAt },
  source,
  host: manifest.host,
  variants: manifest.variants,
  files: fileEntries,
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(released, null, 2) + '\n');
console.log(`OK: ${out} (${Object.keys(fileEntries).length + 1} files, Orca ${orca.version} @ ${orca.commit.slice(0, 10)}, engine @ ${commit.slice(0, 10)})`);
