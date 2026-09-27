// Generates THIRD-PARTY-NOTICES.md: every third-party component built into the engine (engine-st.wasm,
// engine-mt.wasm and their .mjs loaders) or bundled into the host, with its version, licence and the licence
// and copyright texts taken from its own source. The list of dependency libraries is read from
// engine/deps/fetch-deps.sh, so a library added there without an entry here stops the generator.
//
//   node tools/release/third-party-notices.mjs            # writes THIRD-PARTY-NOTICES.md
//   node tools/release/third-party-notices.mjs --check    # fails if THIRD-PARTY-NOTICES.md is not up to date
//
// Reads the dependency sources in $ORCA_WASM_ROOT/deps-src (bash engine/deps/fetch-deps.sh), the emsdk
// ($ORCA_EMSDK, default $ORCA_WASM_ROOT/emsdk) and its ports cache ($EM_CACHE, default the emsdk's; filled by
// engine/deps/build-deps.sh), the orca/ submodule, and the host's bundle (HOST_METAFILE, from host/build.mjs;
// without it the host's inputs are listed from a fresh esbuild run).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = process.env.ORCA_WASM_ROOT ?? path.join(os.homedir(), 'OrcaWasm');
const emscripten = path.join(process.env.ORCA_EMSDK ?? path.join(root, 'emsdk'), 'upstream/emscripten');
const emCache = process.env.EM_CACHE ?? path.join(emscripten, 'cache');
const depsSrc = path.join(root, 'deps-src');
const orca = path.join(repo, 'orca');
const OUTPUT = path.join(repo, 'THIRD-PARTY-NOTICES.md');

const read = (file) => {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
};

// ---- Where each component's notices are ----------------------------------------------------------------------
// text: a file's whole text; head: its leading comment block; from: the lines starting at the first match.
const whole = (file) => ({ file, mode: 'whole' });
const head = (file) => ({ file, mode: 'head' });
const excerpt = (file, from, lines) => ({ file, mode: 'excerpt', from, lines });
const lgpl21 = { file: path.join(repo, 'LICENSES/LGPL-2.1-or-later.txt'), mode: 'whole', label: 'LICENSES/LGPL-2.1-or-later.txt (the licence text)' };

/** Libraries built by engine/deps/build-deps.sh, by their name in fetch-deps.sh. */
const DEPS = {
  boost: { title: 'Boost', license: 'BSL-1.0', files: ['LICENSE_1_0.txt'].map(whole) },
  oneTBB: {
    title: 'oneTBB',
    license: 'Apache-2.0',
    in: 'mt',
    files: ['LICENSE.txt', 'third-party-programs.txt'].map(whole),
  },
  CGAL: {
    title: 'CGAL',
    license: 'GPL-3.0-or-later AND LGPL-3.0-or-later AND BSL-1.0 (per package; see LICENSE)',
    note: 'Header-only. Linked under the open-source licences; the commercial licence file in the archive does not apply.',
    files: ['LICENSE', 'LICENSE.BSL', 'LICENSE.LGPL', 'LICENSE.GPL'].map(whole),
  },
  eigen: {
    title: 'Eigen',
    license: 'MPL-2.0 (some files BSD-3-Clause, Apache-2.0 or MINPACK; see COPYING.README)',
    note: 'Header-only. Its source is unmodified and available from the third-party source mirror (SOURCE.md).',
    files: ['COPYING.README', 'COPYING.MPL2', 'COPYING.BSD', 'COPYING.APACHE', 'COPYING.MINPACK'].map(whole),
  },
  cereal: {
    title: 'cereal',
    license: 'BSD-3-Clause (bundled RapidJSON: MIT; RapidXml: BSL-1.0 or MIT)',
    files: [whole('LICENSE'), head('include/cereal/external/rapidjson/rapidjson.h'), whole('include/cereal/external/rapidxml/license.txt')],
  },
  nlopt: {
    title: 'NLopt',
    license: 'LGPL-2.1-or-later AND MIT (and the licences of its algorithms; see COPYING)',
    files: [
      whole('COPYING'),
      whole('COPYRIGHT'),
      ...['ags/COPYRIGHT', 'bobyqa/COPYRIGHT', 'cobyla/COPYRIGHT', 'direct/COPYING', 'esch/COPYRIGHT', 'luksan/COPYRIGHT',
        'newuoa/COPYRIGHT', 'slsqp/COPYRIGHT', 'stogo/COPYRIGHT'].map((f) => whole(`src/algs/${f}`)),
      lgpl21,
    ],
  },
  libnoise: {
    title: 'libnoise',
    license: 'LGPL-2.1-or-later',
    note: "OrcaSlicer's copy (SoftFever/Orca-deps-libnoise). The archive has no licence file; the notice is in each source file.",
    files: [head('src/latlon.cpp'), lgpl21],
  },
  qhull: {
    title: 'Qhull',
    license: 'Qhull',
    note: 'Qhull is available free of charge from http://www.qhull.org, and its source from the third-party source mirror named in SOURCE.md.',
    files: ['COPYING.txt'].map(whole),
  },
  'libjpeg-turbo': {
    title: 'libjpeg-turbo',
    license: 'IJG AND BSD-3-Clause AND Zlib',
    note: 'This software is based in part on the work of the Independent JPEG Group.',
    files: ['LICENSE.md', 'README.ijg'].map(whole),
  },
};
/** Optional libraries in fetch-deps.sh that the default build does not link. */
const NOT_LINKED = new Set(['gmp', 'mpfr']);

/** Libraries from Orca's deps_src/ that the engine compiles (engine/cmake/Dependencies.cmake), plus stb_truetype. */
const ORCA_BUNDLED = [
  { dir: 'Shiny', title: 'Shiny (headers only; its macros are empty in this build)', license: 'MIT', files: [head('Shiny/Shiny.h')] },
  { dir: 'admesh', title: 'ADMesh', license: 'GPL-2.0-or-later', files: [head('admesh/stl.h')] },
  { dir: 'agg', title: 'Anti-Grain Geometry', license: 'AGG (permissive)', files: [whole('agg/copying')] },
  { dir: 'ankerl', title: 'ankerl::unordered_dense', license: 'MIT', files: [head('ankerl/unordered_dense.h')] },
  { dir: 'clipper', title: 'Clipper', license: 'BSL-1.0', files: [head('clipper/clipper.hpp')] },
  { dir: 'clipper2', title: 'Clipper2', license: 'BSL-1.0', files: [head('clipper2/Clipper2Lib/include/clipper2/clipper.core.h')] },
  { dir: 'earcut', title: 'earcut.hpp', license: 'ISC', files: [whole('earcut/LICENSE')] },
  { dir: 'expat', title: 'Expat', license: 'MIT', files: [whole('expat/COPYING')] },
  { dir: 'fast_float', title: 'fast_float', license: 'MIT OR Apache-2.0 OR BSL-1.0', files: [head('fast_float/fast_float.h')] },
  { dir: 'glu-libtess', title: 'GLU libtess (SGI)', license: 'SGI-B-2.0', files: [head('glu-libtess/include/glu-libtess.h')] },
  { dir: 'libigl', title: 'libigl (the parts OrcaSlicer carries)', license: 'MPL-2.0', files: [head('libigl/igl/AABB.cpp')] },
  { dir: 'libnest2d', title: 'libnest2d', license: 'LGPL-3.0-only', files: [whole('libnest2d/LICENSE.txt')] },
  { dir: 'mcut', title: 'MCUT', license: 'GPL-3.0-or-later (dual-licensed; used under the GPL)', files: [whole('mcut/LICENSE.txt')] },
  { dir: 'miniz', title: 'miniz', license: 'MIT', files: [whole('miniz/LICENSE')] },
  { dir: 'nanosvg', title: 'NanoSVG', license: 'Zlib', files: [head('nanosvg/nanosvg.h')] },
  { dir: 'nlohmann', title: 'JSON for Modern C++ (nlohmann/json)', license: 'MIT', files: [head('nlohmann/json.hpp')] },
  { dir: 'qhull', title: "Qhull (OrcaSlicer's build files; the library is Qhull 8.0.2 above)", license: 'Qhull', files: [whole('qhull/COPYING.txt')] },
  { dir: 'qoi', title: 'QOI', license: 'MIT', files: [excerpt('qoi/qoi.h', /^-- LICENSE: The MIT License/, 22)] },
  { dir: 'semver', title: 'semver.c', license: 'MIT', files: [head('semver/semver.c')] },
  { dir: 'imgui', title: 'stb_truetype (deps_src/imgui/imstb_truetype.h, used by Emboss.cpp)', license: 'MIT OR Unlicense', files: [excerpt('imgui/imstb_truetype.h', /^This software is available under 2 licenses/, 40)] },
];

// ---- Reading the notices -------------------------------------------------------------------------------------
function leadingComment(text, file) {
  const lines = text.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (inBlock) {
      out.push(line);
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('#!')) out.push(line);
    else if (t.startsWith('/*')) {
      out.push(line);
      inBlock = !t.includes('*/', 2);
    } else if (t === '' && out.length === 0) continue;
    else if (t === '' && out.length > 0) out.push(line);
    else break;
  }
  while (out.length && out.at(-1).trim() === '') out.pop();
  if (!out.length) throw new Error(`${file}: no leading comment`);
  return out.join('\n');
}

function noticeText(base, spec) {
  const file = path.isAbsolute(spec.file) ? spec.file : path.join(base, spec.file);
  const text = read(file);
  if (spec.mode === 'whole') return text.trimEnd();
  if (spec.mode === 'head') return leadingComment(text, file);
  const lines = text.split('\n');
  const start = lines.findIndex((line) => spec.from.test(line));
  if (start < 0) throw new Error(`${file}: no line matching ${spec.from}`);
  return lines.slice(start, start + spec.lines).join('\n').trimEnd();
}

const seen = new Map(); // text hash -> where it was printed first
function block(label, text) {
  const hash = createHash('sha256').update(text).digest('hex');
  if (seen.has(hash)) return `**${label}**: the same text as ${seen.get(hash)} above.\n`;
  seen.set(hash, `\`${label}\``);
  const fence = text.includes('```') ? '~~~~' : '```';
  return `**${label}**\n\n${fence}text\n${text}\n${fence}\n`;
}

function section({ title, version, license, used, source, note, texts }) {
  return [
    `### ${title}${version ? ` ${version}` : ''}`,
    '',
    `- Licence: ${license}`,
    `- In: ${used}`,
    `- Source: ${source}`,
    ...(note ? [`- Note: ${note}`] : []),
    '',
    ...texts.map(([label, text]) => block(label, text)),
  ].join('\n');
}

const usedIn = (variant) => (variant === 'mt' ? '`engine-mt.wasm` only' : '`engine-st.wasm` and `engine-mt.wasm`');

// ---- 1. Dependency libraries (engine/deps) -------------------------------------------------------------------
const fetchDeps = read(path.join(repo, 'engine/deps/fetch-deps.sh'));
const depLines = [...fetchDeps.matchAll(/^\s*"([^|"]+)\|([^|"]+)\|([^|"]+)\|[^"]*"/gm)].map((m) => ({ name: m[1], version: m[2], url: m[3] }));
if (depLines.length === 0) throw new Error('no dependencies found in engine/deps/fetch-deps.sh');
const sections = { deps: [], ports: [], emscripten: [], orca: [], host: [] };
const summary = [];
for (const dep of depLines) {
  if (NOT_LINKED.has(dep.name)) continue;
  const meta = DEPS[dep.name];
  if (!meta) throw new Error(`engine/deps/fetch-deps.sh lists ${dep.name}, which has no entry in tools/release/third-party-notices.mjs`);
  const dir = path.join(depsSrc, `${dep.name}-${dep.version}`);
  sections.deps.push(section({
    title: meta.title,
    version: dep.version,
    license: meta.license,
    used: usedIn(meta.in),
    source: `<${dep.url}> (sha256 in engine/deps/SHA256SUMS; mirrored with each release)`,
    note: meta.note,
    texts: meta.files.map((spec) => [spec.label ?? `${meta.title} ${spec.file}${spec.mode === 'head' ? ' (header)' : ''}`, noticeText(dir, spec)]),
  }));
  summary.push([meta.title, dep.version, meta.license.replace(/ \(.*$/, ''), meta.in === 'mt' ? 'mt' : 'st, mt']);
}

// ---- 2. Emscripten ports -----------------------------------------------------------------------------------------
for (const name of ['zlib', 'libpng']) {
  const py = read(path.join(emscripten, 'tools/ports', `${name}.py`));
  const version = /^(?:VERSION|TAG) = '([^']+)'/m.exec(py)[1];
  const license = name === 'zlib' ? 'Zlib' : 'libpng-2.0';
  const dir = path.join(emCache, 'ports', name, `${name}-${version}`);
  sections.ports.push(section({
    title: name,
    version,
    license,
    used: usedIn('both'),
    source: `the Emscripten port (emsdk \`tools/ports/${name}.py\`, sha512-pinned); mirrored with each release`,
    texts: [[`${name} LICENSE`, noticeText(dir, whole('LICENSE'))]],
  }));
  summary.push([name, version, license, 'st, mt']);
}

// ---- 3. Emscripten's runtime and system libraries ----------------------------------------------------------------
const emVersion = read(path.join(emscripten, 'emscripten-version.txt')).replace(/["\s]/g, '');
const emParts = [
  { title: 'Emscripten (the JavaScript runtime in the .mjs loaders, embind, libc glue)', license: 'MIT OR NCSA', files: [whole('LICENSE')] },
  { title: 'musl libc', version: read(path.join(emscripten, 'system/lib/libc/musl/VERSION')).trim(), license: 'MIT', files: [whole('system/lib/libc/musl/COPYRIGHT')] },
  { title: 'libc++', license: 'Apache-2.0 WITH LLVM-exception', files: [whole('system/lib/libcxx/LICENSE.TXT')] },
  { title: 'libc++abi', license: 'Apache-2.0 WITH LLVM-exception', files: [whole('system/lib/libcxxabi/LICENSE.TXT')] },
  { title: 'libunwind', license: 'Apache-2.0 WITH LLVM-exception', files: [whole('system/lib/libunwind/LICENSE.TXT')] },
  { title: 'compiler-rt', license: 'Apache-2.0 WITH LLVM-exception', files: [whole('system/lib/compiler-rt/LICENSE.TXT')] },
  { title: 'dlmalloc', license: 'CC0-1.0', in: 'st', files: [excerpt('system/lib/dlmalloc.c', /^\s*This is a version \(aka dlmalloc\)/, 6)] },
  { title: 'mimalloc', license: 'MIT', in: 'mt', files: [whole('system/lib/mimalloc/LICENSE')] },
];
for (const part of emParts) {
  sections.emscripten.push(section({
    title: part.title,
    version: part.version,
    license: part.license,
    used: part.in === 'st' ? '`engine-st.wasm` only' : usedIn(part.in),
    source: `Emscripten ${emVersion} (<https://github.com/emscripten-core/emscripten/tree/${emVersion}>)`,
    texts: part.files.map((spec) => [`Emscripten ${spec.file}`, noticeText(emscripten, spec)]),
  }));
}
summary.push([`Emscripten ${emVersion} runtime and system libraries (musl, libc++, libc++abi, libunwind, compiler-rt, dlmalloc/mimalloc)`, emVersion, 'MIT, NCSA, Apache-2.0 WITH LLVM-exception, CC0-1.0', 'st, mt']);

// ---- 4. Libraries OrcaSlicer carries in deps_src -------------------------------------------------------------------
for (const lib of ORCA_BUNDLED) {
  sections.orca.push(section({
    title: lib.title,
    license: lib.license,
    used: usedIn('both'),
    source: `\`orca/deps_src/${lib.dir}\` (the OrcaSlicer source)`,
    texts: lib.files.map((spec) => [`orca/deps_src/${spec.file}${spec.mode === 'head' ? ' (header)' : ''}`, noticeText(path.join(orca, 'deps_src'), spec)]),
  }));
}
summary.push([`Libraries OrcaSlicer carries in deps_src (${ORCA_BUNDLED.map((l) => l.dir).join(', ')})`, 'OrcaSlicer\'s copies', 'see section 4', 'st, mt']);

// ---- 5. The host bundle ----------------------------------------------------------------------------------------------
let metafile;
if (process.env.HOST_METAFILE) metafile = JSON.parse(read(process.env.HOST_METAFILE));
else {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({ absWorkingDir: repo, entryPoints: ['host/src/worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true, logLevel: 'silent' });
  metafile = result.metafile;
}
const npmPackages = [...new Set(Object.keys(metafile.inputs).map((f) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f)?.[1]).filter(Boolean))].sort();
for (const pkg of npmPackages) {
  const dir = path.join(repo, 'node_modules', pkg);
  const json = JSON.parse(read(path.join(dir, 'package.json')));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  if (!licenseFile) throw new Error(`${pkg}: no licence file`);
  sections.host.push(section({ title: pkg, version: json.version, license: json.license, used: '`host.<hash>.js`', source: `npm package ${pkg}@${json.version}; mirrored with each release`, texts: [[`${pkg} ${licenseFile}`, read(path.join(dir, licenseFile)).trimEnd()]] }));
  summary.push([pkg, json.version, json.license, 'host']);
}
const esbuildPkg = JSON.parse(read(path.join(repo, 'node_modules/esbuild/package.json')));
sections.host.push(section({
  title: 'esbuild (the bundler; any small runtime helpers it emits)',
  version: esbuildPkg.version,
  license: esbuildPkg.license,
  used: '`host.<hash>.js`',
  source: `npm package esbuild@${esbuildPkg.version} (<https://github.com/evanw/esbuild>)`,
  texts: [['esbuild LICENSE.md', read(path.join(repo, 'node_modules/esbuild/LICENSE.md')).trimEnd()]],
}));

// ---- The document -------------------------------------------------------------------------------------------------------
const table = [
  '| Component | Version | Licence | In |',
  '|---|---|---|---|',
  ...summary.map((row) => `| ${row.join(' | ')} |`),
].join('\n');
const doc = [
  '# Third-party notices',
  '',
  '<!-- Generated by tools/release/third-party-notices.mjs from engine/deps/fetch-deps.sh and the sources it names.',
  '     Do not edit: run `node tools/release/third-party-notices.mjs` (docs/RELEASING.md). -->',
  '',
  "The Muon3D Slicer Engine (`engine-st.wasm`, `engine-mt.wasm`, their `.mjs` loaders and `host.<hash>.js`) is",
  "free software under the GNU Affero General Public License, version 3 (`LICENSE`, `NOTICE`). It is built from",
  'OrcaSlicer, whose own notices are kept in its source, and from the third-party software below. Each part keeps',
  'its own licence; all of them are compatible with the AGPL-3.0. Their source code, as built, is listed in',
  '`SOURCE.md` and attached to every release.',
  '',
  table,
  '',
  `The host bundles ${npmPackages.length ? `these npm packages: ${npmPackages.join(', ')}` : 'no npm package: only this repository\'s own code (and whatever small helpers esbuild emits)'}.`,
  '',
  '## 1. Libraries built for the engine (engine/deps)',
  '',
  ...sections.deps,
  '## 2. Emscripten ports',
  '',
  ...sections.ports,
  '## 3. Emscripten runtime and system libraries',
  '',
  ...sections.emscripten,
  "## 4. Libraries in OrcaSlicer's deps_src",
  '',
  ...sections.orca,
  '## 5. The worker host',
  '',
  ...sections.host,
].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (current !== doc) {
    const out = path.join(os.tmpdir(), 'THIRD-PARTY-NOTICES.generated.md');
    fs.writeFileSync(out, doc);
    console.error(`THIRD-PARTY-NOTICES.md is out of date: regenerate it (node tools/release/third-party-notices.mjs); generated copy in ${out}`);
    process.exit(1);
  }
  console.log('OK: THIRD-PARTY-NOTICES.md is up to date');
} else {
  fs.writeFileSync(OUTPUT, doc);
  console.log(`OK: ${OUTPUT} (${doc.length.toLocaleString('en')} characters, ${summary.length} rows)`);
}
