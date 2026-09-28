// SPDX-License-Identifier: Apache-2.0
// The few globals the package uses, which every browser and Node (>= 18) has: declared here so the package
// builds with no DOM or Node types (npm run build:protocol), and its .d.ts files need no more than
// AbortSignal from a consumer.
declare var console: { error(...data: unknown[]): void };
declare function queueMicrotask(callback: () => void): void;
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}
