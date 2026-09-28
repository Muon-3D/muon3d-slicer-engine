// The protocol package's helpers on their own: frames, transferables, negotiation, config hashes and the
// connection's bookkeeping (packages/protocol/src). The hosts are tested against it in test/conformance/.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EngineConnection,
  EngineRequestError,
  ErrorCode,
  FrameError,
  FrameReader,
  configHash,
  decodeFrame,
  encodeFrame,
  negotiate,
  transferablesOf,
  workerTransport,
  type HelloResult,
  type PostMessageEndpoint,
  type Transport,
} from '../../packages/protocol/src/index.ts';

describe('frames', () => {
  const message = {
    v: 2,
    id: 5,
    kind: 'result',
    result: {
      gcode: new Uint8Array([59, 10, 71]),
      toolpaths: { layerZ: new Float32Array([0.2, 0.4]), extrusions: { layerStart: new Uint32Array([0, 1, 2]) } },
      stats: { layers: 2, printTimeText: null },
      raw: new Uint8Array([1, 2, 3, 4, 5]).buffer,
    },
  };

  test('a message and its typed arrays survive a frame exactly, each array with a buffer of its own', () => {
    const decoded = decodeFrame(encodeFrame(message)) as typeof message;
    assert.deepEqual(decoded, message);
    assert.ok(decoded.result.toolpaths.layerZ instanceof Float32Array);
    assert.equal(decoded.result.toolpaths.layerZ.buffer.byteLength, 8);
    assert.ok(decoded.result.raw instanceof ArrayBuffer);
  });

  test('attachments start at multiples of 8, and the frame says its own length', () => {
    const frame = encodeFrame(message);
    const view = new DataView(frame.buffer);
    assert.equal(new TextDecoder().decode(frame.subarray(0, 4)), 'M3SE');
    assert.equal(view.getUint32(4, true), frame.byteLength);
    assert.equal(frame.byteLength % 8, 0);
  });

  test('a stream in chunks of any size gives the messages back in order', () => {
    const bytes = new Uint8Array([...encodeFrame({ v: 2, id: 1 }), ...encodeFrame(message), ...encodeFrame({ v: 2, id: 2 })]);
    for (const size of [1, 3, 7, 64, bytes.length]) {
      const reader = new FrameReader();
      const out: unknown[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(...reader.push(bytes.subarray(i, i + size)));
      assert.deepEqual(out, [{ v: 2, id: 1 }, message, { v: 2, id: 2 }], `chunks of ${size}`);
    }
  });

  test('bytes that are not a frame are refused', () => {
    assert.throws(() => decodeFrame(new Uint8Array(32)), FrameError);
    assert.throws(() => new FrameReader().push(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n')), FrameError);
  });
});

test('transferablesOf lists each buffer once, never a shared one, and walks arrays of objects', () => {
  const a = new Float32Array(4);
  const shared = new Float32Array(new SharedArrayBuffer(8));
  const value = { a, again: new Uint8Array(a.buffer), list: [{ b: new Uint16Array(2) }, 'text'], shared, raw: new ArrayBuffer(3) };
  const buffers = transferablesOf(value);
  assert.equal(buffers.length, 3);
  assert.ok(buffers.includes(a.buffer as ArrayBuffer));
  assert.ok(!buffers.includes(shared.buffer as unknown as ArrayBuffer));
});

test('configHash: the same content gives the same hash, whatever the key order; other content another', () => {
  const a = configHash({ layer_height: '0.2', wall_loops: '3', nozzle: ['0.4'] });
  assert.equal(configHash({ nozzle: ['0.4'], wall_loops: '3', layer_height: '0.2' }), a);
  assert.notEqual(configHash({ layer_height: '0.2', wall_loops: '4', nozzle: ['0.4'] }), a);
  assert.notEqual(configHash({ layer_height: '0.2', wall_loops: '3', nozzle: '0.4' }), a, 'a list is not a string');
});

test('negotiate: the major, the minor and the capabilities a client needs', () => {
  const hello = { protocol: { major: 2, minor: 1 }, capabilities: ['slice', 'settings.view'] } as HelloResult;
  assert.deepEqual(negotiate(hello), { ok: true, minor: 1 });
  assert.equal(negotiate(hello, { minMinor: 2 }).ok, false);
  assert.equal(negotiate({ ...hello, protocol: { major: 3, minor: 0 } }).ok, false);
  const missing = negotiate(hello, { required: ['slice', 'mesh.cut'] });
  assert.equal(missing.ok, false);
  assert.deepEqual(!missing.ok && missing.missing, ['mesh.cut']);
});

describe('EngineConnection', () => {
  /** A transport whose other end the test plays by hand. */
  function manual() {
    const sent: Array<{ message: Record<string, unknown>; transfer?: readonly ArrayBuffer[] }> = [];
    let deliver: (m: unknown) => void = () => undefined;
    let closeIt: (e?: Error) => void = () => undefined;
    const transport: Transport = {
      send: (message, transfer) => sent.push({ message: message as Record<string, unknown>, transfer }),
      listen: (onMessage, onClose) => {
        deliver = onMessage;
        closeIt = onClose ?? (() => undefined);
        return () => undefined;
      },
      close: () => undefined,
    };
    return { transport, sent, deliver: (m: unknown) => deliver(m), close: (e?: Error) => closeIt(e) };
  }

  test('routes progress, warnings and the result to their request, and states to the listener', async () => {
    const end = manual();
    const states: unknown[] = [];
    const connection = new EngineConnection(end.transport, { onState: (s) => states.push(s) });
    const progress: number[] = [];
    const call = connection.call('status', {}, { onProgress: (p) => progress.push(p.percent) });
    assert.deepEqual(end.sent[0].message, { v: 2, id: call.id, op: 'status', params: {} });
    end.deliver({ v: 2, id: 0, kind: 'state', state: { state: 'idle' } });
    end.deliver({ v: 2, id: call.id, kind: 'progress', progress: { percent: 50, message: 'half' } });
    end.deliver({ v: 2, id: call.id + 1, kind: 'result', result: 'not mine' });
    end.deliver({ v: 2, id: call.id, kind: 'result', result: { state: 'idle' } });
    assert.deepEqual(await call.result, { state: 'idle' });
    assert.deepEqual(progress, [50]);
    assert.deepEqual(states, [{ state: 'idle' }]);
  });

  test("an error answer rejects with the host's code; 'auto' transfers the params' buffers", async () => {
    const end = manual();
    const connection = new EngineConnection(end.transport);
    const positions = new Float32Array(9);
    const call = connection.call('check', { configs: { machine: {}, process: {}, filaments: [{}] }, objects: [{ name: 'a', mesh: { positions } }] }, { transfer: 'auto' });
    assert.deepEqual(end.sent[0].transfer, [positions.buffer]);
    end.deliver({ v: 2, id: call.id, kind: 'error', error: { code: -51, message: 'Orca says no', objects: ['a'] } });
    const err = await call.result.catch((e: unknown) => e);
    assert.ok(err instanceof EngineRequestError);
    assert.equal(err.code, -51);
    assert.deepEqual(err.objects, ['a']);
  });

  test('aborting rejects at once with Cancelled and asks the host to cancel', async () => {
    const end = manual();
    const connection = new EngineConnection(end.transport);
    const abort = new AbortController();
    const call = connection.call('slice', {} as never, { signal: abort.signal });
    abort.abort();
    const err = await call.result.catch((e: unknown) => e);
    assert.equal((err as EngineRequestError).code, ErrorCode.Cancelled);
    assert.deepEqual(end.sent[1].message.op, 'cancel');
    assert.deepEqual(end.sent[1].message.params, { target: call.id });
  });

  test('the transport closing rejects every open request, and later ones', async () => {
    const end = manual();
    const connection = new EngineConnection(end.transport);
    const open = connection.request('status', {});
    end.close(new Error('the worker exited'));
    await assert.rejects(open, /the worker exited/);
    await assert.rejects(connection.request('status', {}), /the worker exited/);
  });
});

test('a browser Worker, a MessagePort and a worker scope are PostMessageEndpoints (types only)', () => {
  const check = (endpoint: PostMessageEndpoint) => workerTransport(endpoint);
  // Compile-time: these must type-check against the DOM's own types.
  if (false as boolean) {
    check(new Worker('x'));
    check(new MessageChannel().port1);
    check(globalThis as unknown as DedicatedWorkerGlobalScope);
  }
});
