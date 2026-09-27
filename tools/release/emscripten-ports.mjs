// The Emscripten ports built into the engine (zlib and libpng, -sUSE_ZLIB=1 -sUSE_LIBPNG=1) are downloaded by
// emcc at build time, from the URLs and sha512 hashes in the emsdk's tools/ports/<name>.py. This script
//   collect: puts those archives into a folder (from the Emscripten cache when there, else downloaded), checked
//            against the emsdk's hashes, for the release's third-party source mirror;
//   seed:    unpacks mirrored archives into an Emscripten ports folder the way emcc does, so a build needs no
//            network (tools/release/rebuild-offline.sh).
//
//   node tools/release/emscripten-ports.mjs collect <emscripten dir> <out dir>
//   node tools/release/emscripten-ports.mjs seed <emscripten dir> <archives dir> <ports dir, e.g. $EM_CACHE/ports>
//
// <emscripten dir> is the emsdk's upstream/emscripten. The cache is $EM_CACHE (default: <emscripten dir>/cache).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORTS = ['zlib', 'libpng'];

/** name, url and sha512 of one port, read from its tools/ports/<name>.py. */
function port(emscripten, name) {
  const py = fs.readFileSync(path.join(emscripten, 'tools/ports', `${name}.py`), 'utf8');
  const constants = Object.fromEntries([...py.matchAll(/^([A-Z_]+) = '([^']*)'/gm)].map((m) => [m[1], m[2]]));
  const call = new RegExp(`fetch_project\\('${name}', f?'([^']+)'`).exec(py);
  if (!call || !constants.HASH) throw new Error(`tools/ports/${name}.py: no fetch_project URL or HASH`);
  const url = call[1].replace(/\{([A-Z_]+)\}/g, (_, key) => constants[key] ?? `{${key}}`);
  if (url.includes('{')) throw new Error(`tools/ports/${name}.py: cannot resolve ${call[1]}`);
  const urlName = url.split('/').pop();
  return {
    name,
    url,
    sha512: constants.HASH,
    version: constants.VERSION ?? constants.TAG,
    // What emcc calls the downloaded archive in the ports folder: <name>.<URL file name after its first dot>.
    cacheName: `${name}.${urlName.split('.').slice(1).join('.')}`,
    // The name in the mirror: the URL's file name, prefixed with the port's name when it lacks it (v1.3.2.tar.gz).
    mirrorName: urlName.startsWith(name) ? urlName : `${name}-${urlName}`,
  };
}

const sha512 = (data) => createHash('sha512').update(data).digest('hex');

async function collect(emscripten, outDir) {
  const cache = process.env.EM_CACHE ?? path.join(emscripten, 'cache');
  const portsDir = process.env.EM_PORTS ?? path.join(cache, 'ports');
  fs.mkdirSync(outDir, { recursive: true });
  const listed = [];
  for (const name of PORTS) {
    const p = port(emscripten, name);
    const cached = path.join(portsDir, p.cacheName);
    let data = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
    if (!data || sha512(data) !== p.sha512) {
      console.log(`downloading ${p.url}`);
      const response = await fetch(p.url);
      if (!response.ok) throw new Error(`${p.url}: HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
    }
    if (sha512(data) !== p.sha512) throw new Error(`${p.name}: sha512 of ${p.url} is not the emsdk's ${p.sha512}`);
    fs.writeFileSync(path.join(outDir, p.mirrorName), data);
    console.log(`[ok] ${p.name} ${p.version}: ${p.mirrorName} (sha512 as in tools/ports/${name}.py)`);
    listed.push({ name: p.name, version: p.version, file: p.mirrorName, url: p.url, sha512: p.sha512 });
  }
  fs.writeFileSync(path.join(outDir, 'PORTS.json'), JSON.stringify(listed, null, 2) + '\n');
}

function seed(emscripten, archives, portsDir) {
  for (const name of PORTS) {
    const p = port(emscripten, name);
    const archive = path.join(archives, p.mirrorName);
    const data = fs.readFileSync(archive);
    if (sha512(data) !== p.sha512) throw new Error(`${archive}: sha512 is not the emsdk's ${p.sha512}`);
    // What emcc's Ports.fetch_project leaves behind: the archive, its unpacked tree, and a marker naming the URL.
    const target = path.join(portsDir, name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(portsDir, p.cacheName), data);
    execFileSync('tar', ['-xzf', archive, '-C', target], { stdio: 'inherit' });
    fs.writeFileSync(path.join(target, '.emscripten_url'), p.url + '\n');
    console.log(`[seeded] ${p.name} ${p.version} -> ${target}`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'collect' && args.length === 2) await collect(...args);
else if (command === 'seed' && args.length === 3) seed(...args);
else {
  console.error('usage: emscripten-ports.mjs collect <emscripten dir> <out dir> | seed <emscripten dir> <archives dir> <ports dir>');
  process.exit(2);
}
