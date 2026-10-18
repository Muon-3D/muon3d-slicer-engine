// Loads the MT engine (no slice) and prints the C strings at the given static addresses.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, engine, ...addrs] = process.argv.slice(2);
const bridge = await import(pathToFileURL(path.join(path.resolve(root), 'host/src/bridge.ts')).href);
const { engine: m } = await bridge.loadEngine(pathToFileURL(path.resolve(engine) + path.sep).href, 'mt');
const u8 = new Uint8Array(m.wasmMemory.buffer);
for (const a of addrs.map(Number)) {
  let s = a; while (s > 0 && u8[s - 1] && a - s < 300) s--; let e = a; while (u8[e] && e - a < 300) e++;
  console.log(a, JSON.stringify(Buffer.from(u8.slice(s, e)).toString('latin1')));
}
process.exit(0);
