// The host core of protocol v2: it takes messages from a transport and answers them. Op dispatch, the
// engine's lifecycle (loaded lazily, on the first op that needs it), request queues, cancellation, progress
// and the host's state. It knows nothing of how messages travel: serve() connects it to any Transport of
// packages/protocol (a Web Worker's global scope, a Node worker_threads port, a byte stream such as a
// WebSocket), and worker.ts does that for the host file a page or a Node program starts.
//
// Requests run in two lanes, each in order, one at a time: the engine lane (load, slice, check,
// config.definitions) and the settings lane (settings.*, which never load the engine). hello, status and
// cancel are answered at once. A slice blocks the host's thread while it runs, so nothing is answered
// during it; a queued request can be cancelled, a running one cannot (the client ends the host instead).
import { ErrorCode, PROTOCOL, type EngineError, type HostState, type Response, type Variant } from '../../packages/protocol/src/envelope.ts';
import { transferablesOf } from '../../packages/protocol/src/helpers.ts';
import type { EngineManifest } from '../../packages/protocol/src/manifest.ts';
import { Capability, OPS, type HelloResult, type LoadParams, type LoadResult, type OpName } from '../../packages/protocol/src/ops.ts';
import type { Transport } from '../../packages/protocol/src/transport.ts';
import {
  EngineJobError,
  engineFailure,
  engineHeap,
  loadEngine as defaultLoadEngine,
  runCheck,
  runSlice,
  startFailure,
  type LoadEngineOptions,
  type LoadedEngine,
  type OrcaEngineModule,
} from './bridge.ts';
import { readConfigDefinitions } from './configDefinitions.ts';
import { BUILD, engineInfo, type BuildInfo } from './info.ts';
import { BadRequest, checkJob, checkResult, sliceJob, sliceResult } from './ops.ts';

export interface HostEnvironment {
  kind: 'browser' | 'node' | 'other';
  /** 'mt' can run: SharedArrayBuffer is available (a cross-origin isolated page, or Node). */
  threads: boolean;
  hardwareConcurrency: number;
}

/** The settings service module (host/src/settings/service.ts), loaded on the first settings op. */
export interface SettingsModule {
  SettingsService: new (options?: { build?: string }) => {
    catalogueDocument(): unknown;
    view(params: never): unknown;
    edit(params: never): unknown;
  };
  SettingsRequestError: new (...args: never[]) => Error & { code: number; detail?: string };
}

export interface HostOptions {
  send(message: Response, transfer?: ArrayBuffer[]): void;
  /** URL of the folder with engine-<variant>.mjs/.wasm and manifest.json (ends with '/'). */
  base: string;
  environment?: Partial<HostEnvironment>;
  build?: BuildInfo;
  /** manifest.json of `base`, or null (default: fetched, or read from disk under Node). */
  readManifest?: (base: string) => Promise<EngineManifest | null>;
  /** Instantiates the engine (default bridge.ts loadEngine; the tests pass a fake). */
  loadEngine?: (base: string, variant: Variant, options: LoadEngineOptions) => Promise<LoadedEngine>;
  loadSettings?: () => Promise<SettingsModule>;
}

export interface Host {
  receive(message: unknown): void;
  state(): HostState;
}

interface Job {
  id: number;
  run: () => Promise<void> | void;
}

/** Requests of one lane, in order, one at a time. */
class Lane {
  private readonly queue: Job[] = [];
  private busy = false;
  running: number | null = null;

  push(job: Job): void {
    this.queue.push(job);
    if (!this.busy) void this.drain();
  }

  /** Takes a queued (not yet running) request out of the lane. */
  remove(id: number): boolean {
    const i = this.queue.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  private async drain(): Promise<void> {
    this.busy = true;
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      this.running = job.id;
      try {
        await job.run();
      } catch (err) {
        console.error('Engine host:', err);
      }
      this.running = null;
    }
    this.busy = false;
  }
}

const ENGINE_OPS: ReadonlySet<string> = new Set(['load', 'slice', 'check', 'config.definitions']);
const SETTINGS_OPS: ReadonlySet<string> = new Set(['settings.catalogue', 'settings.view', 'settings.edit']);
const CAPABILITIES = [...OPS, Capability.toolpathsV1, Capability.toolpathExtras, Capability.indexedMeshes, Capability.settingsViewV1];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Caps the pthread pool and TBB at `threads` (Emscripten sizes its pool from navigator.hardwareConcurrency). */
function limitThreads(threads: number): void {
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: Math.max(1, Math.floor(threads)), configurable: true });
  } catch {
    // Not overridable here: every core is used.
  }
}

async function defaultReadManifest(base: string): Promise<EngineManifest | null> {
  try {
    const url = new URL('manifest.json', base);
    if (url.protocol === 'file:') {
      const fs = await import('node:fs/promises');
      return JSON.parse(await fs.readFile(url, 'utf8')) as EngineManifest;
    }
    const response = await fetch(url, { credentials: 'same-origin' });
    return response.ok ? ((await response.json()) as EngineManifest) : null;
  } catch {
    return null;
  }
}

export function createHost(options: HostOptions): Host {
  const env: HostEnvironment = {
    kind: options.environment?.kind ?? 'other',
    threads: options.environment?.threads ?? typeof SharedArrayBuffer === 'function',
    hardwareConcurrency: options.environment?.hardwareConcurrency ?? (globalThis.navigator?.hardwareConcurrency || 1),
  };
  const build = options.build ?? BUILD;
  const load = options.loadEngine ?? defaultLoadEngine;
  const lanes = { engine: new Lane(), settings: new Lane() };

  let state: HostState = { state: 'idle' };
  let engine: OrcaEngineModule | null = null;
  let memory: WebAssembly.Memory | null = null;
  let loaded: LoadResult | null = null;
  let loading: Promise<LoadResult> | null = null;
  /** Set once the engine could not load or crashed: every later engine op fails with it. */
  let dead: EngineError | null = null;
  let manifest: Promise<EngineManifest | null> | null = null;
  let settings: Promise<{ service: InstanceType<SettingsModule['SettingsService']>; Failure: SettingsModule['SettingsRequestError'] }> | null = null;

  const send = (message: Response, transfer: ArrayBuffer[] = []) => {
    try {
      options.send(message, transfer);
    } catch (err) {
      console.error('Engine host: a message could not be sent:', err);
    }
  };
  const result = (id: number, value: unknown, transfer: ArrayBuffer[] = []) => send({ v: 2, id, kind: 'result', result: value }, transfer);
  const error = (id: number, e: EngineError) => send({ v: 2, id, kind: 'error', error: e });
  const setState = (next: HostState) => {
    state = next;
    send({ v: 2, id: 0, kind: 'state', state: next });
  };
  const heap = () => engineHeap(engine, memory);
  const readManifest = () => (manifest ??= (options.readManifest ?? defaultReadManifest)(options.base));

  async function builtVariants(): Promise<Variant[]> {
    const m = await readManifest();
    const built = m?.variants ? (Object.keys(m.variants) as Variant[]) : (['st', 'mt'] as Variant[]);
    return (['st', 'mt'] as Variant[]).filter((v) => built.includes(v) && (v === 'st' || env.threads));
  }

  async function hello(params: unknown): Promise<HelloResult> {
    const p = params as { protocol?: { major?: unknown } } | undefined;
    const major = p?.protocol?.major;
    if (major !== PROTOCOL.major) {
      throw Object.assign(new Error(`This engine host speaks protocol ${PROTOCOL.major}; the client asked for ${String(major)}.`), {
        code: ErrorCode.ProtocolMismatch,
        detail: String(PROTOCOL.major),
      });
    }
    return {
      protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor },
      engine: engineInfo(options.base, build),
      capabilities: CAPABILITIES,
      variants: await builtVariants(),
      limits: { maxThreads: env.hardwareConcurrency, maxHeapBytes: build.maxHeapBytes },
      formats: { definitions: 1, catalogue: 2, toolpaths: 1, settingsView: 1 },
    };
  }

  function status(): HostState {
    if (state.state !== 'ready') return state;
    const h = heap();
    return h ? { ...state, heapBytes: h.bytes, ...(h.maxBytes ? { maxHeapBytes: h.maxBytes } : {}) } : state;
  }

  /** Loads the engine once (later calls share the load); 'auto' is 'mt' where it can run and is built. */
  async function ensureEngine(params: LoadParams = {}): Promise<LoadResult> {
    if (dead) throw dead;
    const requested = params.variant ?? 'auto';
    if (requested !== 'auto' && requested !== 'st' && requested !== 'mt') throw new BadRequest(`"variant" must be st, mt or auto.`);
    if (loaded) {
      if (requested !== 'auto' && requested !== loaded.variant) {
        throw new BadRequest(`The engine is already loaded as ${loaded.variant}: start a new host for ${requested}.`);
      }
      return loaded;
    }
    if (loading) return loading;
    loading = (async () => {
      const variants = await builtVariants();
      if (requested === 'mt' && !env.threads) throw new BadRequest("'mt' needs SharedArrayBuffer (a cross-origin isolated page).");
      const variant: Variant = requested === 'auto' ? (variants.includes('mt') ? 'mt' : 'st') : requested;
      const base = params.base ?? options.base;
      const wasmBytes = (await readManifest())?.variants?.[variant]?.wasmBytes;
      setState({ state: 'loading', variant, loadedBytes: 0, totalBytes: wasmBytes ?? 0 });
      if (variant === 'mt' && params.threads) limitThreads(params.threads);
      try {
        const l = await load(base, variant, {
          ...(wasmBytes ? { wasmBytes } : {}),
          onDownload: (loadedBytes, totalBytes, done) => setState({ state: 'loading', variant, loadedBytes, totalBytes, ...(done ? { done } : {}) }),
        });
        engine = l.engine;
        memory = l.memory;
        loaded = { variant, initMs: l.initMs };
        const h = heap();
        setState({ state: 'ready', variant, initMs: l.initMs, ...(h ? { heapBytes: h.bytes, ...(h.maxBytes ? { maxHeapBytes: h.maxBytes } : {}) } : {}) });
        return loaded;
      } catch (err) {
        const failure = startFailure(err);
        dead = { code: ErrorCode.NotLoaded, message: `The slicing engine could not start: ${failure.message}`, ...(failure.detail ? { detail: failure.detail } : {}) };
        setState({ state: 'fatal', ...failure });
        throw dead;
      }
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  /** Runs one engine job; a crash (not Orca refusing the job) kills the engine for good. */
  function engineJob<T>(run: (engine: OrcaEngineModule) => T): T {
    try {
      return run(engine!);
    } catch (err) {
      if (err instanceof EngineJobError || err instanceof BadRequest) throw err;
      dead = engineFailure(err, heap());
      setState({ state: 'fatal', code: dead.code, message: dead.message, ...(dead.detail ? { detail: dead.detail } : {}) });
      throw dead;
    }
  }

  async function engineOp(id: number, op: OpName, params: unknown): Promise<void> {
    if (op === 'load') {
      result(id, await ensureEngine((params ?? {}) as LoadParams));
      return;
    }
    // Checked before the engine loads: a bad request should not cost a download.
    const job = op === 'slice' ? sliceJob(params as never) : op === 'check' ? checkJob(params as never) : null;
    await ensureEngine();
    if (op === 'config.definitions') {
      result(id, engineJob((e) => readConfigDefinitions(e)));
    } else if (op === 'slice') {
      let percent = 0;
      const output = engineJob((e) =>
        runSlice(
          e,
          job as ReturnType<typeof sliceJob>,
          (p, message) => {
            percent = Math.max(percent, p);
            send({ v: 2, id, kind: 'progress', progress: { percent, message } });
          },
          (warning) => send({ v: 2, id, kind: 'warning', warning }),
        ),
      );
      const value = sliceResult(output, heap()?.bytes);
      result(id, value, transferablesOf(value));
    } else {
      const output = engineJob((e) => runCheck(e, job as ReturnType<typeof checkJob>));
      const value = checkResult(output, heap()?.bytes);
      result(id, value, transferablesOf(value));
    }
  }

  async function settingsOp(id: number, op: OpName, params: unknown): Promise<void> {
    settings ??= (options.loadSettings ?? (() => import('./settings/service.ts') as Promise<unknown> as Promise<SettingsModule>))().then((m) => ({
      service: new m.SettingsService({ build: `${build.version}|${build.commit}` }),
      Failure: m.SettingsRequestError,
    }));
    let s: Awaited<typeof settings>;
    try {
      s = await settings;
    } catch (err) {
      settings = null;
      error(id, { code: ErrorCode.Internal, message: 'The settings service could not be loaded.', detail: messageOf(err) });
      return;
    }
    try {
      const value = op === 'settings.catalogue' ? s.service.catalogueDocument() : op === 'settings.view' ? s.service.view(params as never) : s.service.edit(params as never);
      // Settings documents hold no binary data: nothing to transfer.
      result(id, value);
    } catch (err) {
      if (err instanceof s.Failure) error(id, { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      else error(id, { code: ErrorCode.Internal, message: `The settings service failed: ${messageOf(err)}` });
    }
  }

  /** The error response for an exception an op threw. */
  function failed(id: number, err: unknown): void {
    if (err instanceof EngineJobError) error(id, err.error);
    else if (err instanceof BadRequest) error(id, { code: ErrorCode.BadRequest, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    else if (err && typeof err === 'object' && 'code' in err && typeof (err as EngineError).code === 'number' && 'message' in err) {
      const e = err as EngineError;
      error(id, { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}), ...(e.objects ? { objects: e.objects } : {}) });
    } else error(id, { code: ErrorCode.Internal, message: messageOf(err) });
  }

  function receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const m = message as { v?: unknown; id?: unknown; op?: unknown; params?: unknown };
    const id = m.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      console.warn('Engine host: a message without a request id was ignored.');
      return;
    }
    if (m.v !== 2) {
      error(id, { code: ErrorCode.ProtocolMismatch, message: `This engine host speaks protocol ${PROTOCOL.major}.`, detail: String(PROTOCOL.major) });
      return;
    }
    const op = m.op;
    const params = m.params ?? {};
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
      error(id, { code: ErrorCode.Unsupported, message: `This engine host has no op "${String(op)}".` });
      return;
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      error(id, { code: ErrorCode.BadRequest, message: `"params" of ${op} must be an object.` });
      return;
    }
    switch (op as OpName) {
      case 'hello':
        hello(params).then((r) => result(id, r), (err) => failed(id, err));
        return;
      case 'status':
        result(id, status());
        return;
      case 'cancel': {
        const target = (params as { target?: unknown }).target;
        if (typeof target !== 'number') {
          error(id, { code: ErrorCode.BadRequest, message: 'cancel needs { target: <request id> }.' });
          return;
        }
        const accepted = lanes.engine.remove(target) || lanes.settings.remove(target);
        if (accepted) error(target, { code: ErrorCode.Cancelled, message: 'Cancelled.' });
        result(id, { accepted });
        return;
      }
    }
    if (ENGINE_OPS.has(op)) {
      lanes.engine.push({ id, run: () => engineOp(id, op as OpName, params).catch((err) => failed(id, err)) });
    } else if (SETTINGS_OPS.has(op)) {
      lanes.settings.push({ id, run: () => settingsOp(id, op as OpName, params) });
    }
  }

  return { receive, state: status };
}

/** Serves the host core over a transport: every message it receives is a request, every answer goes back on it. */
export function serve(transport: Transport, options: Omit<HostOptions, 'send'>): Host {
  const host = createHost({ ...options, send: (message, transfer) => transport.send(message, transfer) });
  transport.listen((message) => host.receive(message));
  return host;
}
