// Web Worker hosting the slicing engine: OrcaSlicer's libslic3r compiled to WebAssembly
// (engine/, API in engine/bridge/engine.cpp). Implements the EngineRequest/EngineResponse protocol
// of ./protocol.ts; web/src/engine/client.ts is the only sender.
//
// One job at a time: a slice blocks this thread until it is done, so requests simply queue. Every
// typed array in a result is transferred, not copied. Cancelling a slice means terminating this
// worker (client.ts); the engine has no way to receive a message while it slices.
//
// While the engine starts, the worker downloads the .wasm itself (loadEngine) to report progress
// ('loading') and to say which file failed ('fatal'); each job result carries the size of the
// wasm heap (heapBytes), which only grows, so the client knows when to replace the worker.
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
  /** The wasm heap now and at most (it never shrinks); answers even after a trap. Missing in older builds. */
  heapSize?(): { bytes: number; maxBytes: number };
}

/**
 * Emscripten's hook for instantiating the .wasm itself: call `receive` with the instance (and the
 * module, which the pthread workers of 'mt' are started with) and return `{}` right away.
 */
type InstantiateWasm = (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => object;

/** The module factory the build exports (-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createOrcaEngine). */
export type OrcaEngineFactory = (options?: {
  locateFile?: (path: string, prefix: string) => string;
  instantiateWasm?: InstantiateWasm;
}) => Promise<OrcaEngineModule>;

/** An EngineError reported by the engine for a job (as opposed to the engine itself failing). */
export class EngineJobError extends Error {
  readonly error: EngineError;
  constructor(error: EngineError) {
    super(error.message);
    this.name = 'EngineJobError';
    this.error = error;
  }
}

/** The engine could not start: `message` says why in a sentence, `detail` is the browser's own error text. */
export class EngineStartError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'EngineStartError';
    this.detail = detail;
  }
}

const now = () => performance.now();
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const fileName = (url: string) => new URL(url).pathname.split('/').pop() || url;

/** Emscripten appends this to every abort message of a release build; it means nothing to users. */
export function withoutAssertionsHint(message: string): string {
  return message.replace(/\.?\s*Build with -sASSERTIONS for more info\.?/g, '').trim();
}

export interface LoadEngineOptions {
  /** Size of the uncompressed .wasm (the manifest's wasmBytes), for download progress. */
  wasmBytes?: number;
  /** Download progress of the .wasm: bytes of the uncompressed file so far, and the total (0 when unknown). */
  onDownload?: (loadedBytes: number, totalBytes: number) => void;
}

export interface LoadedEngine {
  engine: OrcaEngineModule;
  initMs: number;
  /** The engine's wasm memory (it only ever grows), when this code instantiated the module; null under Node. */
  memory: WebAssembly.Memory | null;
}

/**
 * Imports `engine-<variant>.mjs` from `baseUrl` (a folder URL ending in '/') and instantiates it.
 * The .wasm (and anything else the module asks for) is loaded from the same folder.
 *
 * In a browser this fetches the .wasm itself (through Emscripten's instantiateWasm hook, still
 * compiling while it downloads) to report download progress, to find the engine's memory, and to
 * say which file is missing or broken instead of passing on a bare CompileError. Throws
 * EngineStartError for those; anything else as the engine threw it (see startFailure).
 */
export async function loadEngine(baseUrl: string, variant: EngineVariant, options: LoadEngineOptions = {}): Promise<LoadedEngine> {
  const started = now();
  const moduleUrl = new URL(`engine-${variant}.mjs`, baseUrl).href;
  let imported: { default?: unknown; createOrcaEngine?: unknown };
  try {
    imported = (await import(/* @vite-ignore */ moduleUrl)) as typeof imported;
  } catch (err) {
    throw new EngineStartError(`${fileName(moduleUrl)} could not be loaded.`, messageOf(err));
  }
  const factory = (imported.default ?? imported.createOrcaEngine) as OrcaEngineFactory | undefined;
  if (typeof factory !== 'function') throw new EngineStartError(`${fileName(moduleUrl)} is not the slicing engine (it exports no engine factory).`);
  const locateFile = (path: string) => new URL(path, baseUrl).href;

  // Under Node (the engine tests load file: URLs) Emscripten reads the .wasm from disk itself.
  if (new URL(baseUrl).protocol === 'file:' || typeof fetch !== 'function') {
    const engine = await factory({ locateFile });
    return { engine, initMs: now() - started, memory: null };
  }

  let memory: WebAssembly.Memory | null = null;
  // Emscripten gives the hook no way to fail, so a failure ends the wait for the factory instead.
  let failed!: (err: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    failed = reject;
  });
  const instantiateWasm: InstantiateWasm = (imports, receive) => {
    instantiateEngineWasm(locateFile(`engine-${variant}.wasm`), imports, options)
      .then(({ instance, module }) => {
        memory = findMemory(imports, instance.exports);
        receive(instance, module);
      })
      .catch(failed);
    return {};
  };
  const engine = await Promise.race([factory({ locateFile, instantiateWasm }), failure]);
  return { engine, initMs: now() - started, memory };
}

/** The wasm memory: exported by 'st', imported (shared with the pthreads) by 'mt'. */
function findMemory(imports: WebAssembly.Imports, exports: WebAssembly.Exports): WebAssembly.Memory | null {
  const values = [...Object.values(exports), ...Object.values(imports).flatMap((module) => Object.values(module))];
  return values.find((value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory) ?? null;
}

const COMPILE_FAILED =
  'The engine files on the server are incomplete or come from different builds. Reload the page; if that does not help, the engine has to be published again.';

/**
 * Fetches and instantiates the engine's .wasm the way Emscripten does, reporting the download and
 * naming what failed (EngineStartError). Exported for the tests.
 */
export async function instantiateEngineWasm(
  url: string,
  imports: WebAssembly.Imports,
  options: LoadEngineOptions,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const file = fileName(url);
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch (err) {
    throw new EngineStartError(`${file} could not be downloaded.`, messageOf(err));
  }
  if (!response.ok) throw new EngineStartError(`${file} could not be downloaded (HTTP ${response.status}).`);

  const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
  const contentLength = Number(response.headers.get('content-length'));
  const total = options.wasmBytes && options.wasmBytes > 0 ? options.wasmBytes : !encoded && contentLength > 0 ? contentLength : 0;
  const report = downloadReporter(options.onDownload, total);
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  // A server that answers every unknown path with the app's page.
  if (type === 'text/html') throw new EngineStartError(`${file} is missing on the server (it sent a web page instead).`);
  try {
    if (type === 'application/wasm' && response.body && typeof WebAssembly.instantiateStreaming === 'function') {
      // Compile while downloading, from the response itself (as Emscripten does); a copy of the
      // stream counts the bytes.
      const counting = report ? countBytes(response.clone(), report) : null;
      try {
        return await WebAssembly.instantiateStreaming(response, imports);
      } catch (err) {
        counting?.stop();
        throw err;
      }
    }
    // Not served as application/wasm, which instantiateStreaming refuses: compile the bytes (as
    // Emscripten falls back to).
    return await WebAssembly.instantiate(await readBytes(response, report), imports);
  } catch (err) {
    if (err instanceof EngineStartError) throw err;
    // A .wasm that does not fit its .mjs fails to link ("Import #0 …"), a cut-off one to compile.
    const mismatch = err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError || /Import #\d/.test(messageOf(err));
    if (mismatch) throw new EngineStartError(COMPILE_FAILED, messageOf(err));
    // Otherwise a TypeError is the download breaking off.
    if (err instanceof TypeError) throw new EngineStartError(`${file} could not be downloaded.`, messageOf(err));
    throw err;
  }
}

/** Throttles download progress to about ten reports a second (plus the last one). */
function downloadReporter(onDownload: LoadEngineOptions['onDownload'], total: number): ((loaded: number, done: boolean) => void) | null {
  if (!onDownload) return null;
  let last = -Infinity;
  return (loaded, done) => {
    const t = now();
    if (!done && t - last < 100) return;
    last = t;
    try {
      onDownload(loaded, total);
    } catch (err) {
      console.error('Engine download callback failed:', err);
    }
  };
}

/** Reads a copy of a response to count its bytes; its errors are the real response's to report. `stop` drops the copy. */
function countBytes(response: Response, report: (loaded: number, done: boolean) => void): { stop(): void } {
  const reader = response.body?.getReader();
  let loaded = 0;
  void (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        report(loaded, false);
      }
      report(loaded, true);
    } catch {
      // The download failed; instantiateStreaming reports it.
    }
  })();
  return {
    stop: () => {
      reader?.cancel().catch(() => undefined);
    },
  };
}

async function readBytes(response: Response, report: ((loaded: number, done: boolean) => void) | null): Promise<Uint8Array<ArrayBuffer>> {
  if (!report || !response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    report(loaded, false);
  }
  report(loaded, true);
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  return {
    ...result,
    // The engine builds them with the toolpaths whether asked or not; they are dropped here so
    // they are not posted to the page.
    toolpathExtras: job.toolpathExtras === false ? null : result.toolpathExtras,
    // The engine times its own stages; the total also covers the conversions on this side.
    timings: { ...result.timings, total: now() - started },
  };
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

/** The engine's heap size: from the bridge (heapSize) where the build has it, else from the memory the worker found. */
export function engineHeap(engine: OrcaEngineModule | null, memory: WebAssembly.Memory | null): { bytes: number; maxBytes?: number } | null {
  try {
    if (typeof engine?.heapSize === 'function') return engine.heapSize();
  } catch {
    // Fall back to the memory object.
  }
  return memory ? { bytes: memory.buffer.byteLength } : null;
}

/**
 * Turns an exception thrown by the engine itself (a wasm trap, abort(), a failed allocation) into
 * the protocol's code 2 (out of memory) or 1 (crash). After either, the module is unusable.
 * `heap` is the heap size after the failure: a trap with the heap (nearly) at its maximum was a
 * failed allocation, whatever the trap says ("unreachable", "unwind").
 */
export function engineFailure(err: unknown, heap?: { bytes: number; maxBytes?: number } | null): EngineError {
  const detail = withoutAssertionsHint(messageOf(err));
  const heapFull = !!heap?.maxBytes && heap.bytes >= 0.9 * heap.maxBytes;
  if (OUT_OF_MEMORY.test(detail) || heapFull) return { code: 2, message: `The slicing engine ran out of memory (${detail}).` };
  return { code: 1, message: `The slicing engine crashed: ${detail}` };
}

/**
 * Why the engine could not start, for the 'fatal' message: one sentence (it follows "The slicing
 * engine could not start:" in the UI), code 2 when memory ran out, and the browser's own text.
 */
export function startFailure(err: unknown): { code: number; message: string; detail?: string } {
  if (err instanceof EngineStartError) return { code: 1, message: err.message, ...(err.detail ? { detail: withoutAssertionsHint(err.detail) } : {}) };
  const detail = withoutAssertionsHint(messageOf(err));
  if (OUT_OF_MEMORY.test(detail)) {
    return { code: 2, message: 'This browser does not have enough memory free for it. Close other tabs and try again.', detail };
  }
  // Emscripten wraps them in its abort message: "Aborted(CompileError: …)".
  if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError || /\b(CompileError|LinkError)\b/.test(detail)) {
    return { code: 1, message: COMPILE_FAILED, detail };
  }
  return { code: 1, message: detail || 'The engine stopped while starting.' };
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
      paths.extrusions.height,
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
  let memory: WebAssembly.Memory | null = null;
  let ready: Extract<EngineResponse, { type: 'ready' }> | null = null;
  /** Set once the engine has crashed: the module is dead and every later job fails. */
  let crashed: EngineError | null = null;
  let queue: Promise<void> = Promise.resolve();

  const post = (message: EngineResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
  /** The heap size to report with a job result, when known. */
  const heap = (): { heapBytes?: number } => {
    const size = engineHeap(engine, memory);
    return size ? { heapBytes: size.bytes } : {};
  };

  async function init(request: Extract<EngineRequest, { type: 'init' }>): Promise<void> {
    if (ready) {
      post(ready);
      return;
    }
    try {
      if (request.variant === 'mt' && request.threads) limitThreads(request.threads);
      const loaded = await loadEngine(request.baseUrl, request.variant, {
        wasmBytes: request.wasmBytes,
        onDownload: (loadedBytes, totalBytes) => post({ type: 'loading', loadedBytes, totalBytes }),
      });
      const version = loaded.engine.version();
      engine = loaded.engine;
      memory = loaded.memory;
      ready = { type: 'ready', variant: request.variant, orcaVersion: version.orcaVersion, orcaCommit: version.orcaCommit, initMs: loaded.initMs };
      post(ready);
    } catch (err) {
      post({ type: 'fatal', ...startFailure(err) });
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
        post({ type: 'sliced', id, output, ...heap() }, sliceTransferables(output));
      } else {
        const output = runCheck(engine, request.job);
        post({ type: 'checked', id, output, ...heap() }, checkTransferables(output));
      }
    } catch (err) {
      if (err instanceof EngineJobError) {
        post({ type: 'failed', id, error: err.error, ...heap() });
      } else {
        crashed = engineFailure(err, engineHeap(engine, memory));
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
