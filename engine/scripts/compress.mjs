// Precompresses published engine files: writes <file>.br (brotli, quality 11, 16 MiB window) and
// <file>.gz (gzip -9) next to each one, which a web server can send as they are instead of
// compressing 10 MB of wasm on every request (brotli-11 is also about a quarter smaller than what
// a server compresses on the fly).
//
//   node engine/scripts/compress.mjs dist/engine-st.mjs dist/engine-st.wasm
//   node engine/scripts/compress.mjs dist          # every engine-*.mjs / .wasm in it
//
// scripts/build.sh runs it on the variant it publishes. Each file is written under a temporary name
// and renamed into place, after the file it compresses, so a server never sees a partial or stale
// sibling (it also ignores a sibling older than its file). Output is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** The files a folder argument stands for: the engine modules and binaries. */
const ENGINE_FILE_RE = /^engine-[^/\\]*\.(mjs|wasm)$/;

function inputs(args) {
  return args.flatMap((arg) => {
    if (!fs.statSync(arg).isDirectory()) return [arg];
    return fs
      .readdirSync(arg)
      .filter((name) => ENGINE_FILE_RE.test(name))
      .sort()
      .map((name) => path.join(arg, name));
  });
}

async function writeAtomically(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, data);
  await fs.promises.rename(temp, file);
}

async function compress(file) {
  const data = await fs.promises.readFile(file);
  const started = performance.now();
  const [br, gz] = await Promise.all([
    brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        // 24 is the largest window every browser decodes (RFC 7932); the default 22 (4 MiB) finds
        // fewer of the repeats in a 10 MB wasm.
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
    gzip(data, { level: 9 }),
  ]);
  await writeAtomically(`${file}.br`, br);
  await writeAtomically(`${file}.gz`, gz);
  const pct = (n) => `${((100 * n) / data.length).toFixed(0)}%`;
  console.log(
    `compressed ${path.basename(file)}: ${data.length} B -> br ${br.length} B (${pct(br.length)}), ` +
      `gz ${gz.length} B (${pct(gz.length)}) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
}

const files = inputs(process.argv.slice(2));
if (files.length === 0) {
  console.error('usage: node engine/scripts/compress.mjs <file or folder>...');
  process.exit(2);
}
// In parallel: zlib runs on libuv's thread pool, so the files compress side by side.
await Promise.all(files.map(compress));
