// SPDX-License-Identifier: Apache-2.0
// The envelope of protocol v2: requests, responses, errors, progress, warnings and the host's state.
// docs/PROTOCOL.md is the normative description.
import type { OpName, OpParams } from './ops.ts';

/** The protocol these types describe. */
export const PROTOCOL = { major: 2, minor: 0 } as const;

/** Client -> host. `id` is chosen by the client: an integer > 0, unique among its open requests on one connection. */
export interface Request<K extends OpName = OpName> {
  v: 2;
  id: number;
  op: K;
  params: OpParams<K>;
}

/** The final answer to request `id`. `result` has the op's result type. */
export interface ResultResponse<R = unknown> {
  v: 2;
  id: number;
  kind: 'result';
  result: R;
}

/** The request failed. Every request gets exactly one 'result' or one 'error'. */
export interface ErrorResponse {
  v: 2;
  id: number;
  kind: 'error';
  error: EngineError;
}

/** Progress of a running request; zero or more, before its result. */
export interface ProgressResponse {
  v: 2;
  id: number;
  kind: 'progress';
  progress: Progress;
}

/** A warning about a running request; zero or more, before its result (a slice's result lists them again). */
export interface WarningResponse {
  v: 2;
  id: number;
  kind: 'warning';
  warning: EngineWarning;
}

/** Unsolicited: the host's state changed (the engine loading, ready, or dead). Always `id: 0`. */
export interface StateResponse {
  v: 2;
  id: 0;
  kind: 'state';
  state: HostState;
}

export type Response = ResultResponse | ErrorResponse | ProgressResponse | WarningResponse | StateResponse;

/** Any message of protocol v2. */
export type Message = Request | Response;

/** The engine build: 'st' single-threaded, 'mt' with threads (needs SharedArrayBuffer: a cross-origin isolated page). */
export type Variant = 'st' | 'mt';

export type HostState =
  /** The host runs; the engine (wasm) is not loaded. Settings ops never need it. */
  | { state: 'idle' }
  /** The engine is loading: its .wasm downloaded so far (bytes of the uncompressed file; total 0 when unknown). */
  | { state: 'loading'; variant: Variant; loadedBytes: number; totalBytes: number; done?: boolean }
  /** The engine is loaded. `heapBytes` only grows (wasm memory never shrinks): replace the host when it is large. */
  | { state: 'ready'; variant: Variant; initMs: number; heapBytes?: number; maxHeapBytes?: number }
  /** The engine crashed or could not load: every later op that needs it fails with the same error. Start a new host. */
  | { state: 'fatal'; code: number; message: string; detail?: string };

/** Engine error codes 1-8; negative codes are OrcaSlicer's CLI exit codes, passed through (see EngineError). */
export const ErrorCode = {
  /** The engine crashed (a wasm trap or abort). The host is 'fatal' afterwards. */
  Internal: 1,
  /** The engine ran out of memory. The host is 'fatal' afterwards. */
  OutOfMemory: 2,
  /** The request was cancelled before it finished. */
  Cancelled: 3,
  /** Unknown op, or an op or field this host does not support. */
  Unsupported: 4,
  /** The request is malformed: not an envelope, missing or wrong-typed params. `detail` says what. */
  BadRequest: 5,
  /** The op needs the engine, and it could not be loaded (the host is 'fatal'). */
  NotLoaded: 6,
  /** The client's protocol major is not the host's. `detail` lists the majors the host speaks, e.g. "2". */
  ProtocolMismatch: 7,
  /** A config was named by a hash the host does not hold (never sent, or evicted): send it again with the config. */
  NotCached: 8,
} as const;
export type ErrorCodeName = keyof typeof ErrorCode;

/**
 * `code` > 0: ErrorCode. `code` < 0: OrcaSlicer's CLI exit codes (src/libslic3r/Utils.hpp), passed
 * through: -5 bad config, -17 incompatible process, -18 invalid values, -50 nothing on the plate,
 * -51 validation error, -52 partly outside, -63/-64 collisions (also exclusion volumes), -100 slicing
 * error, -102 unprintable area. New codes may appear: treat an unknown negative code as "Orca refused
 * the job" and show `message`.
 */
export interface EngineError {
  code: number;
  /** Orca's own message (English), or the host's. */
  message: string;
  /** The objects the error concerns, by name, when Orca names them. */
  objects?: string[];
  /** Technical detail: the runtime's own error text, or what was wrong with a request. */
  detail?: string;
}

/** `kind` is an open set: Orca's warning step names, 'object_outside', 'exclusion_volume_path', ... */
export interface EngineWarning {
  kind: string;
  message: string;
  objects?: string[];
}

/** `percent` 0-100, never decreasing within a request; `message` Orca's English text. `stage` is optional. */
export interface Progress {
  percent: number;
  stage?: string;
  message: string;
}
