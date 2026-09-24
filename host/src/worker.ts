// Web Worker hosting the slicing engine: OrcaSlicer's libslic3r compiled to WebAssembly
// (engine/, API in engine/bridge/engine.cpp). Implements the EngineRequest/EngineResponse protocol
// of ./protocol.ts; web/src/engine/client.ts is the only sender.
//
// One job at a time: a slice blocks this thread until it is done, so requests simply queue. Every
// typed array in a result is transferred, not copied. Cancelling a slice means terminating this
// worker (client.ts); the engine has no way to receive a message while it slices.
//
// The functions below the message handler are exported so the Node tests (engine/test) run the
// exact code the browser runs; the handler itself is only installed inside a worker.
import type {
  CheckJob,
  CheckOutput,
  EngineError,
  EngineRequest,
  EngineResponse,
  EngineVariant,
  EngineWarning,
  SliceJob,
  SliceOutput,
} from './protocol.ts';

// ---------------------------------------------------------------------------
// The engine module (engine/bridge/engine.cpp)
// ---------------------------------------------------------------------------

/** One plate object as the engine takes it. */
export interface EngineMeshInput {
  name: string;
  positions: Float32Array;
}

type EngineResult<T> = T | { error: EngineError };

/** What `await createOrcaEngine()` resolves to. */
export interface OrcaEngineModule {
  version(): { orcaVersion: string; orcaCommit: string };
  slice(
    machineJson: string,
    processJson: string,
    filamentJsons: string[],
    objects: EngineMeshInput[],
    toolpaths: boolean,
    onProgress: (percent: number, message: string) => void,
    onWarning: (warning: EngineWarning) => void,
  ): EngineResult<SliceOutput>;
  check(machineJson: string, processJson: string, filamentJsons: string[], objects: EngineMeshInput[]): EngineResult<CheckOutput>;
  /** Makes a running slice stop at Orca's next cancellation point (needs a second thread to call it). */
  requestCancel(): void;
  /** Orca's log verbosity: 0 off, 1 errors (default) … 5 trace. */
  setLogLevel(level: number): void;
}

/** The module factory the build exports (-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createOrcaEngine). */
export type OrcaEngineFactory = (options?: { locateFile?: (path: string, prefix: string) => string }) => Promise<OrcaEngineModule>;

/** An EngineError reported by the engine for a job (as opposed to the engine itself failing). */
export class EngineJobError extends Error {
  readonly error: EngineError;
  constructor(error: EngineError) {
    super(error.message);
    this.name = 'EngineJobError';
    this.error = error;
  }
}

const now = () => performance.now();

/**
 * Imports `engine-<variant>.mjs` from `baseUrl` (a folder URL ending in '/') and instantiates it.
 * The .wasm (and anything else the module asks for) is loaded from the same folder.
 */
export async function loadEngine(baseUrl: string, variant: EngineVariant): Promise<{ engine: OrcaEngineModule; initMs: number }> {
  const started = now();
  const moduleUrl = new URL(`engine-${variant}.mjs`, baseUrl).href;
  const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown; createOrcaEngine?: unknown };
  const factory = (imported.default ?? imported.createOrcaEngine) as OrcaEngineFactory | undefined;
  if (typeof factory !== 'function') throw new Error(`${moduleUrl} does not export the engine factory.`);
  const engine = await factory({ locateFile: (path) => new URL(path, baseUrl).href });
  return { engine, initMs: now() - started };
}

/** Callbacks the engine calls while it slices; an exception thrown by one must not unwind through wasm. */
function guarded<A extends unknown[]>(callback: ((...args: A) => void) | undefined): (...args: A) => void {
  return (...args: A) => {
    try {
      callback?.(...args);
    } catch (err) {
      console.error('Engine progress callback failed:', err);
    }
  };
}

const presetJson = (config: object) => JSON.stringify(config);

function meshInputs(objects: SliceJob['objects']): EngineMeshInput[] {
  return objects.map((object) => ({ name: object.name, positions: object.positions }));
}

/**
 * Slices a plate. Throws EngineJobError when Orca rejects the job (bad preset, object outside the
 * plate, …); any other exception means the engine itself failed (see engineFailure).
 */
export function runSlice(
  engine: OrcaEngineModule,
  job: SliceJob,
  onProgress?: (percent: number, message: string) => void,
  onWarning?: (warning: EngineWarning) => void,
): SliceOutput {
  const started = now();
  const result = engine.slice(
    presetJson(job.machine),
    presetJson(job.process),
    job.filaments.map(presetJson),
    meshInputs(job.objects),
    job.toolpaths ?? true,
    guarded(onProgress),
    guarded(onWarning),
  );
  if ('error' in result) throw new EngineJobError(result.error);
  // The engine times its own stages; the total also covers the conversions on this side.
  return { ...result, timings: { ...result.timings, total: now() - started } };
}

/** Runs Orca's placement checks for a plate. Throws like runSlice. */
export function runCheck(engine: OrcaEngineModule, job: CheckJob): CheckOutput {
  const result = engine.check(presetJson(job.machine), presetJson(job.process), job.filaments.map(presetJson), meshInputs(job.objects));
  if ('error' in result) throw new EngineJobError(result.error);
  return result;
}

// Messages of the ways a wasm engine runs out of memory: Emscripten's abort text when the heap cannot
// grow, and the browsers' RangeErrors for failed (Shared)ArrayBuffer/Memory allocations.
const OUT_OF_MEMORY = /\bOOM\b|out of memory|cannot enlarge memory|allocation failed|could not allocate memory|maximum memory size exceeded/i;

/**
 * Turns an exception thrown by the engine itself (a wasm trap, abort(), a failed allocation) into
 * the protocol's code 2 (out of memory) or 1 (crash). After either, the module is unusable.
 */
export function engineFailure(err: unknown): EngineError {
  const detail = err instanceof Error ? err.message : String(err);
  if (OUT_OF_MEMORY.test(detail)) return { code: 2, message: `The slicing engine ran out of memory (${detail}).` };
  return { code: 1, message: `The slicing engine crashed: ${detail}` };
}

/** The buffers of a slice result, for a zero-copy postMessage. */
export function sliceTransferables(output: SliceOutput): Transferable[] {
  const arrays: ArrayBufferView[] = [output.gcode];
  const paths = output.toolpaths;
  if (paths) {
    arrays.push(
      paths.layerZ,
      paths.extrusions.positions,
      paths.extrusions.layerStart,
      paths.extrusions.roleIndex,
      paths.extrusions.width,
      paths.travels.positions,
      paths.travels.layerStart,
    );
  }
  const extras = output.toolpathExtras;
  if (extras) arrays.push(extras.feedrate, extras.fanSpeed, extras.temperature, extras.time, extras.height);
  return uniqueBuffers(arrays);
}

export function checkTransferables(output: CheckOutput): Transferable[] {
  return uniqueBuffers(output.objects.flatMap((object) => object.exclusionHits.map((hit) => hit.triangles)));
}

// Only plain ArrayBuffers can be transferred (never the shared wasm heap), and each only once.
function uniqueBuffers(arrays: ArrayBufferView[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const array of arrays) if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  return [...buffers];
}

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

interface WorkerScope {
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
}

/**
 * Caps the pthread pool and TBB at `threads`: Emscripten sizes its pool from
 * navigator.hardwareConcurrency when the module starts, and TBB asks the same value.
 */
function limitThreads(threads: number): void {
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: Math.max(1, Math.floor(threads)), configurable: true });
  } catch {
    // Not overridable in this browser: use every core.
  }
}

function startWorker(scope: WorkerScope): void {
  let engine: OrcaEngineModule | null = null;
  let ready: Extract<EngineResponse, { type: 'ready' }> | null = null;
  /** Set once the engine has crashed: the module is dead and every later job fails. */
  let crashed: EngineError | null = null;
  let queue: Promise<void> = Promise.resolve();

  const post = (message: EngineResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

  async function init(request: Extract<EngineRequest, { type: 'init' }>): Promise<void> {
    if (ready) {
      post(ready);
      return;
    }
    try {
      if (request.variant === 'mt' && request.threads) limitThreads(request.threads);
      const loaded = await loadEngine(request.baseUrl, request.variant);
      const version = loaded.engine.version();
      engine = loaded.engine;
      ready = { type: 'ready', variant: request.variant, orcaVersion: version.orcaVersion, orcaCommit: version.orcaCommit, initMs: loaded.initMs };
      post(ready);
    } catch (err) {
      const failure = engineFailure(err);
      post({
        type: 'fatal',
        message: failure.code === 2 ? failure.message : `The slicing engine could not be started: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function runJob(request: Extract<EngineRequest, { type: 'slice' | 'check' }>): void {
    const { id } = request;
    if (crashed) {
      post({ type: 'failed', id, error: crashed });
      return;
    }
    if (!engine) {
      post({ type: 'failed', id, error: { code: 1, message: 'The slicing engine is not loaded.' } });
      return;
    }
    try {
      if (request.type === 'slice') {
        const output = runSlice(
          engine,
          request.job,
          (percent, message) => post({ type: 'progress', id, percent, message }),
          (warning) => post({ type: 'warning', id, warning }),
        );
        post({ type: 'sliced', id, output }, sliceTransferables(output));
      } else {
        const output = runCheck(engine, request.job);
        post({ type: 'checked', id, output }, checkTransferables(output));
      }
    } catch (err) {
      if (err instanceof EngineJobError) {
        post({ type: 'failed', id, error: err.error });
      } else {
        crashed = engineFailure(err);
        post({ type: 'failed', id, error: crashed });
      }
    }
  }

  scope.onmessage = (event) => {
    const request = event.data;
    queue = queue
      .then(() => (request.type === 'init' ? init(request) : runJob(request)))
      .catch((err: unknown) => console.error('Engine worker:', err));
  };
}

// Installed only when this module runs as a worker (Node imports it for its exports).
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  startWorker(globalThis as unknown as WorkerScope);
}
