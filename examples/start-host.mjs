// Starts the engine host in a Node worker thread and connects to it with the protocol package's client:
// what a web page does with a Web Worker, over Node's worker_threads instead (the protocol is the same).
//
//   the built host (dist/host.<hash>.js, the very file a browser starts), when `dist` has one;
//   else the host's sources (host/src/worker.ts; Node runs TypeScript), with the engine files of `dist`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { EngineConnection, nodeWorkerTransport } from '../packages/protocol/src/index.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `dist`: a folder with manifest.json (npm run build, or a release's runtime folder). Returns the
 * connection (hello done) and the worker; `onState` sees the host's state messages.
 */
export async function startHost(dist, { source = false, onState } = {}) {
  const manifestFile = path.join(dist, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const built = !source && manifest?.host?.protocol === 2;
  const worker = built
    ? new Worker(pathToFileURL(path.join(dist, manifest.host.file)))
    : new Worker(pathToFileURL(path.join(repo, 'host/src/worker.ts')), { workerData: { engineBase: pathToFileURL(dist + path.sep).href } });
  const connection = new EngineConnection(nodeWorkerTransport(worker), { onState });
  const hello = await connection.open({ name: 'muon3d-slicer-engine examples', version: '2' });
  return { connection, hello, manifest, worker, built, close: () => connection.close() };
}
