// SPDX-License-Identifier: Apache-2.0
// Transports: how protocol messages travel between a client and a host. The protocol is the same on
// every one; a transport only moves messages (docs/PROTOCOL.md, "Transports"):
//
//   workerTransport       a Web Worker, a MessagePort, or a worker's own global scope (postMessage;
//                         typed arrays transferred when the sender lists them)
//   nodeWorkerTransport   a Node worker_threads Worker or MessagePort (the same, EventEmitter style)
//   byteStreamTransport   anything that carries bytes (a WebSocket, an HTTP body, a native pipe): each
//                         message one frame of framing.ts
//
// Both ends use the same adapters: a host wraps its own side (the worker's global scope, parentPort, a
// socket) the same way a client wraps the worker it started.
import { FrameReader, encodeFrame } from './framing.ts';

export interface Transport {
  /** Sends a message. `transfer`: buffers to move rather than copy (ignored by byte streams). */
  send(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  /**
   * Receives messages; `onClose` is called once when the other end goes away or fails (with the error).
   * Returns a function that stops listening.
   */
  listen(onMessage: (message: unknown) => void, onClose?: (error?: Error) => void): () => void;
  /** Ends the transport (terminates a worker the client started, closes a socket). */
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// postMessage
// ---------------------------------------------------------------------------------------------

/** A Web Worker, a MessagePort, or a DedicatedWorkerGlobalScope. */
export interface PostMessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate?(): void;
  close?(): void;
  start?(): void;
}

export function workerTransport(endpoint: PostMessageEndpoint): Transport {
  return {
    send: (message, transfer = []) => endpoint.postMessage(message, transfer as Transferable[]),
    listen(onMessage, onClose) {
      const message = (event: MessageEvent) => onMessage(event.data);
      const error = (event: Event) => {
        const e = event as ErrorEvent;
        onClose?.(new Error(e.message || (event.type === 'messageerror' ? 'a message could not be read' : 'the worker failed')));
      };
      endpoint.addEventListener('message', message);
      endpoint.addEventListener('error', error);
      endpoint.addEventListener('messageerror', error);
      endpoint.start?.();
      return () => {
        endpoint.removeEventListener('message', message);
        endpoint.removeEventListener('error', error);
        endpoint.removeEventListener('messageerror', error);
      };
    },
    close: () => (endpoint.terminate ? endpoint.terminate() : endpoint.close?.()),
  };
}

/** A Node worker_threads Worker, MessagePort or parentPort (EventEmitter style). */
export interface NodeMessageEndpoint {
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  terminate?(): unknown;
  close?(): unknown;
}

export function nodeWorkerTransport(endpoint: NodeMessageEndpoint): Transport {
  return {
    send: (message, transfer = []) => endpoint.postMessage(message, transfer),
    listen(onMessage, onClose) {
      let closed = false;
      const close = (error?: Error) => {
        if (!closed) {
          closed = true;
          onClose?.(error);
        }
      };
      const message = (m: unknown) => onMessage(m);
      const error = (e: Error) => close(e);
      const exit = (code: number) => close(code === 0 ? undefined : new Error(`the worker exited with code ${code}`));
      endpoint.on('message', message);
      endpoint.on('error', error);
      endpoint.on('exit', exit);
      return () => {
        endpoint.off('message', message);
        endpoint.off('error', error);
        endpoint.off('exit', exit);
      };
    },
    close: () => void (endpoint.terminate ? endpoint.terminate() : endpoint.close?.()),
  };
}

// ---------------------------------------------------------------------------------------------
// Byte streams
// ---------------------------------------------------------------------------------------------

/** Anything that carries bytes both ways. */
export interface ByteChannel {
  write(bytes: Uint8Array): void;
  /** Receives bytes in chunks of any size (a WebSocket message may hold one or more frames). */
  onBytes(listener: (bytes: Uint8Array) => void): () => void;
  onClose?(listener: (error?: Error) => void): () => void;
  close(): void;
}

export function byteStreamTransport(channel: ByteChannel): Transport {
  return {
    send: (message) => channel.write(encodeFrame(message)),
    listen(onMessage, onClose) {
      const reader = new FrameReader();
      let stopClose: (() => void) | undefined;
      const stopBytes = channel.onBytes((bytes) => {
        let messages: unknown[];
        try {
          messages = reader.push(bytes);
        } catch (err) {
          onClose?.(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        for (const m of messages) onMessage(m);
      });
      if (onClose && channel.onClose) stopClose = channel.onClose(onClose);
      return () => {
        stopBytes();
        stopClose?.();
      };
    },
    close: () => channel.close(),
  };
}

/** A WebSocket (browser or Node >= 22) as a byte channel: binary messages, each one or more frames. */
export function webSocketChannel(socket: WebSocket): ByteChannel {
  socket.binaryType = 'arraybuffer';
  return {
    write: (bytes) => socket.send(bytes),
    onBytes(listener) {
      const message = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) listener(new Uint8Array(event.data));
      };
      socket.addEventListener('message', message);
      return () => socket.removeEventListener('message', message);
    },
    onClose(listener) {
      const close = (event: CloseEvent) => listener(event.code === 1000 ? undefined : new Error(`the connection closed (${event.code} ${event.reason})`));
      const error = () => listener(new Error('the connection failed'));
      socket.addEventListener('close', close);
      socket.addEventListener('error', error);
      return () => {
        socket.removeEventListener('close', close);
        socket.removeEventListener('error', error);
      };
    },
    close: () => socket.close(1000),
  };
}

/** Two connected in-memory byte channels (tests, and a host in the same process). */
export function byteChannelPair(): [ByteChannel, ByteChannel] {
  const make = () => ({ listeners: new Set<(b: Uint8Array) => void>(), closers: new Set<(e?: Error) => void>() });
  const a = make();
  const b = make();
  const channel = (self: typeof a, other: typeof a): ByteChannel => ({
    write: (bytes) => {
      // Asynchronous, and split in two, as a network delivers it.
      const copy = bytes.slice();
      const cut = copy.byteLength > 1 ? copy.byteLength >> 1 : copy.byteLength;
      queueMicrotask(() => {
        for (const l of other.listeners) l(copy.subarray(0, cut));
        if (cut < copy.byteLength) for (const l of other.listeners) l(copy.subarray(cut));
      });
    },
    onBytes: (listener) => {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    onClose: (listener) => {
      self.closers.add(listener);
      return () => self.closers.delete(listener);
    },
    close: () => queueMicrotask(() => [...self.closers, ...other.closers].forEach((l) => l())),
  });
  return [channel(a, b), channel(b, a)];
}
