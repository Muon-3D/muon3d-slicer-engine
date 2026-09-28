// SPDX-License-Identifier: Apache-2.0
// A small RPC client for protocol v2 over any Transport: request ids, one promise per request, progress
// and warnings routed to the request's callbacks, the host's state to a listener, cancellation. It holds
// no engine policy (when to start, stop or replace a host is the app's business).
import { ErrorCode, PROTOCOL, type EngineError, type EngineWarning, type HostState, type Progress } from './envelope.ts';
import { configHash, negotiate, transferablesOf } from './helpers.ts';
import type { HelloResult, OpName, OpParams, OpResult } from './ops.ts';
import type { Config } from './data.ts';
import type { ConfigRef, SettingsEditParams, SettingsEditResult, SettingsForm, SettingsInput, SettingsView, SettingsViewParams, ViewOptions } from './settings.ts';
import type { Transport } from './transport.ts';

/** A request the host answered with an error. */
export class EngineRequestError extends Error implements EngineError {
  readonly code: number;
  readonly objects?: string[];
  readonly detail?: string;
  readonly log?: string;
  constructor(error: EngineError) {
    super(error.message);
    this.name = 'EngineRequestError';
    this.code = error.code;
    if (error.objects) this.objects = error.objects;
    if (error.detail !== undefined) this.detail = error.detail;
    if (error.log !== undefined) this.log = error.log;
  }
}

export interface CallOptions {
  onProgress?: (progress: Progress) => void;
  onWarning?: (warning: EngineWarning) => void;
  /** Buffers to move to the host instead of copying: 'auto' = every typed array in the params. Default none. */
  transfer?: readonly ArrayBuffer[] | 'auto';
  /** Aborting cancels the request (see EngineConnection.cancel) and rejects it with Cancelled at once. */
  signal?: AbortSignal;
}

export interface Call<R> {
  id: number;
  result: Promise<R>;
  /** Asks the host to cancel; resolves with whether it could (a running slice cannot, without 'cancel.cooperative'). */
  cancel(): Promise<boolean>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  options: CallOptions;
}

export interface ConnectionOptions {
  /** The host's state messages. */
  onState?: (state: HostState) => void;
  /** The transport closed or failed; every open request has been rejected. */
  onClose?: (error?: Error) => void;
}

export class EngineConnection {
  private readonly transport: Transport;
  private readonly pending = new Map<number, Pending>();
  private readonly stop: () => void;
  private nextId = 1;
  private closed: Error | null = null;
  private helloResult: HelloResult | null = null;
  private readonly options: ConnectionOptions;

  constructor(transport: Transport, options: ConnectionOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.stop = transport.listen(
      (message) => this.receive(message),
      (error) => this.fail(error ?? new Error('The engine connection closed.')),
    );
  }

  /** The host's hello answer, once open() has run. */
  get hello(): HelloResult | null {
    return this.helloResult;
  }

  /**
   * Says hello and checks the answer: rejects (with ProtocolMismatch) when the host does not speak this
   * protocol at `minMinor` or lacks a `required` capability.
   */
  async open(client: { name: string; version: string }, want: { minMinor?: number; required?: readonly string[] } = {}): Promise<HelloResult> {
    const hello = await this.request('hello', { protocol: { major: PROTOCOL.major, minMinor: want.minMinor ?? 0 }, client });
    const n = negotiate(hello, want);
    if (!n.ok) throw new EngineRequestError({ code: ErrorCode.ProtocolMismatch, message: `The engine does not suit this app: ${n.reason}.` });
    this.helloResult = hello;
    return hello;
  }

  /** Whether the host listed `capability` in hello (false before open()). */
  has(capability: string): boolean {
    return this.helloResult?.capabilities.includes(capability) ?? false;
  }

  call<K extends OpName>(op: K, params: OpParams<K>, options: CallOptions = {}): Call<OpResult<K>> {
    const id = this.nextId++;
    const result = new Promise<OpResult<K>>((resolve, reject) => {
      if (this.closed) {
        reject(this.closed);
        return;
      }
      if (options.signal?.aborted) {
        reject(new EngineRequestError({ code: ErrorCode.Cancelled, message: 'Cancelled.' }));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, options });
      options.signal?.addEventListener(
        'abort',
        () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          p.reject(new EngineRequestError({ code: ErrorCode.Cancelled, message: 'Cancelled.' }));
          this.sendCancel(id).catch(() => undefined);
        },
        { once: true },
      );
      const transfer = options.transfer === 'auto' ? transferablesOf(params) : (options.transfer ?? []);
      try {
        this.transport.send({ v: 2, id, op, params }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { id, result, cancel: () => this.sendCancel(id) };
  }

  request<K extends OpName>(op: K, params: OpParams<K>, options?: CallOptions): Promise<OpResult<K>> {
    return this.call(op, params, options).result;
  }

  private async sendCancel(target: number): Promise<boolean> {
    if (this.closed) return false;
    const { accepted } = await this.request('cancel', { target });
    return accepted;
  }

  /** Stops listening and closes the transport (terminating a worker); open requests are rejected. */
  close(): void {
    this.fail(new Error('The engine connection was closed.'));
    this.transport.close();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.stop();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(error);
    this.options.onClose?.(error);
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const m = message as { v?: unknown; id?: unknown; kind?: unknown } & Record<string, unknown>;
    if (m.v !== 2 || typeof m.id !== 'number') return;
    if (m.kind === 'state') {
      this.options.onState?.(m.state as HostState);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.kind) {
      case 'progress':
        safely(() => p.options.onProgress?.(m.progress as Progress));
        break;
      case 'warning':
        safely(() => p.options.onWarning?.(m.warning as EngineWarning));
        break;
      case 'result':
        this.pending.delete(m.id);
        p.resolve(m.result);
        break;
      case 'error':
        this.pending.delete(m.id);
        p.reject(new EngineRequestError(m.error as EngineError));
        break;
    }
  }
}

function safely(callback: () => void): void {
  try {
    callback();
  } catch (err) {
    console.error('Engine callback failed:', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface SettingsPresets {
  machine: Config;
  process: Config;
  filament: Config;
}

type Plain<P> = Omit<P, 'presets'> & { presets: SettingsPresets };

/**
 * settings.view and settings.edit with the bookkeeping done: presets are sent once and then by hash
 * (again when the host has dropped one), and each scope's form is cached, so the host sends it once and
 * every document returned here has its `form`.
 */
export class SettingsClient {
  private readonly connection: EngineConnection;
  private readonly sent = new Set<string>();
  private readonly forms = new Map<string, SettingsForm>();

  constructor(connection: EngineConnection) {
    this.connection = connection;
  }

  async view(params: Plain<SettingsViewParams>): Promise<SettingsView> {
    const run = (full: boolean) => {
      const { form: _form, ...rest } = params;
      return this.connection.request('settings.view', { ...rest, presets: this.refs(params.presets, full), ...this.formOption(params.scope, params.omit) });
    };
    return this.withForm(await this.retry(run));
  }

  async edit(params: Plain<SettingsEditParams>): Promise<SettingsEditResult> {
    const view = params.view === undefined || params.view === false ? undefined : params.view === true ? {} : params.view;
    const run = (full: boolean) =>
      this.connection.request('settings.edit', {
        ...params,
        presets: this.refs(params.presets, full),
        ...(view ? { view: { ...view, ...this.formOption(params.scope, view.omit) } } : {}),
      });
    const result = await this.retry(run);
    return result.view ? { ...result, view: this.withForm(result.view) } : result;
  }

  private formOption(scope: string, omit: readonly string[] | undefined): ViewOptions {
    const form = this.forms.get(`${scope}\n${[...(omit ?? [])].sort().join(',')}`);
    return form ? { form: form.id } : {};
  }

  private withForm(view: SettingsView): SettingsView {
    if (view.form) {
      this.forms.set(`${view.scope}\n${omitKey(view.form)}`, view.form);
      return view;
    }
    for (const form of this.forms.values()) if (form.id === view.formId) return { ...view, form };
    return view;
  }

  private refs(presets: SettingsPresets, full: boolean): SettingsInput['presets'] {
    const ref = (config: Config): ConfigRef => {
      const hash = configHash(config);
      if (!full && this.sent.has(hash)) return { hash };
      this.sent.add(hash);
      return { hash, config };
    };
    return { machine: ref(presets.machine), process: ref(presets.process), filament: ref(presets.filament) };
  }

  private async retry<R>(run: (full: boolean) => Promise<R>): Promise<R> {
    try {
      return await run(false);
    } catch (err) {
      if (err instanceof EngineRequestError && err.code === ErrorCode.NotCached) return run(true);
      throw err;
    }
  }
}

/** The omit list a form was built for, as the cache key uses it. */
function omitKey(form: SettingsForm): string {
  return [...form.omit].sort().join(',');
}
