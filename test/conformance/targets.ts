// The hosts the conformance suite runs against, each through a different transport, all with the same
// client (EngineConnection of packages/protocol):
//   in-process    the host core (createHost) in this thread; messages structured-cloned, as postMessage does
//   byte-stream   the host core behind a byte stream: every message framed (framing.ts), split in chunks
//   node-worker   host/src/worker.ts (the sources) in a Node worker_threads Worker
//   built-host    dist/host.<hash>.js (npm run build:host), the file a browser starts, in a Node worker
// The engine files come from ENGINE_DIR (default dist/).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { EngineConnection } from '../../packages/protocol/src/connection.ts';
import type { HostState } from '../../packages/protocol/src/envelope.ts';
import type { EngineManifest } from '../../packages/protocol/src/manifest.ts';
import { byteChannelPair, byteStreamTransport, nodeWorkerTransport, type NodeMessageEndpoint, type Transport } from '../../packages/protocol/src/transport.ts';
import { createHost, serve } from '../../host/src/core.ts';
import { engineDir, repoRoot } from '../fixtures.ts';

export interface Connected {
  connection: EngineConnection;
  /** Every state message the host sent. */
  states: HostState[];
  close(): Promise<void>;
}

export interface Target {
  name: string;
  /** Why this target cannot run here, or false. */
  skip: string | false;
  connect(): Promise<Connected>;
}

const engineBase = pathToFileURL(engineDir + path.sep).href;
const manifestPath = path.join(engineDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as EngineManifest) : null;

function connectWith(transport: Transport, close: () => Promise<void>): Connected {
  const states: HostState[] = [];
  const connection = new EngineConnection(transport, { onState: (s) => states.push(s) });
  return { connection, states, close };
}

/** Two in-memory transports: what one sends, the other receives (structured-cloned, a macrotask later, as postMessage). */
function clonePair(): [Transport, Transport] {
  type Listener = (m: unknown) => void;
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()];
  const end = (self: 0 | 1): Transport => ({
    send: (message, transfer = []) => {
      const copy = structuredClone(message, { transfer: [...transfer] });
      setImmediate(() => {
        for (const l of listeners[1 - self]) l(copy);
      });
    },
    listen: (onMessage) => {
      listeners[self].add(onMessage);
      return () => listeners[self].delete(onMessage);
    },
    close: () => undefined,
  });
  return [end(0), end(1)];
}

function worker(url: URL, workerData?: unknown): Connected {
  const w = new Worker(url, workerData ? { workerData } : {});
  return connectWith(nodeWorkerTransport(w as unknown as NodeMessageEndpoint), async () => {
    await w.terminate();
  });
}

export const TARGETS: readonly Target[] = [
  {
    name: 'in-process',
    skip: false,
    async connect() {
      const [hostSide, clientSide] = clonePair();
      const host = createHost({ base: engineBase, environment: { kind: 'node' }, send: (m, t) => hostSide.send(m, t) });
      hostSide.listen((m) => host.receive(m));
      return connectWith(clientSide, async () => undefined);
    },
  },
  {
    name: 'byte-stream',
    skip: false,
    async connect() {
      const [hostSide, clientSide] = byteChannelPair();
      serve(byteStreamTransport(hostSide), { base: engineBase, environment: { kind: 'other' } });
      return connectWith(byteStreamTransport(clientSide), async () => clientSide.close());
    },
  },
  {
    name: 'node-worker',
    skip: false,
    async connect() {
      return worker(new URL(pathToFileURL(path.join(repoRoot, 'host/src/worker.ts'))), { engineBase });
    },
  },
  {
    name: 'built-host',
    skip: manifest?.host?.protocol === 2 ? false : `${manifestPath} names no protocol 2 host: npm run build:host`,
    async connect() {
      return worker(new URL(pathToFileURL(path.join(engineDir, manifest!.host!.file))));
    },
  },
];
