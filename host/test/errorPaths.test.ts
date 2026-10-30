// Error paths at the host boundary: failures must be classified for clients, and a failed subsystem must
// either remain safely dead (the Wasm engine) or be retryable (the dynamically loaded settings service).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ErrorCode, type Response } from '../../packages/protocol/src/envelope.ts';
import type { OrcaEngineModule } from '../src/bridge.ts';
import { readConfigDefinitions } from '../src/configDefinitions.ts';
import { createHost, type SettingsModule } from '../src/core.ts';

function harness(options: Partial<Parameters<typeof createHost>[0]> = {}) {
  const responses: Response[] = [];
  const host = createHost({
    base: 'file:///engine/',
    environment: { kind: 'node', threads: false, memory64: false, hardwareConcurrency: 1 },
    send: (message) => responses.push(message),
    readManifest: async () => null,
    ...options,
  });
  let id = 0;
  const request = (op: string, params: unknown = {}) => {
    const requestId = ++id;
    host.receive({ v: 2, id: requestId, op, params });
    return new Promise<Response>((resolve) => {
      const poll = () => {
        const response = responses.find((message) => message.id === requestId && (message.kind === 'result' || message.kind === 'error'));
        if (response) resolve(response);
        else setImmediate(poll);
      };
      poll();
    });
  };
  return { host, request, responses };
}

const errorOf = (response: Response) => {
  assert.equal(response.kind, 'error');
  return response.error;
};

describe('engine host error paths', () => {
  test('a start failure makes the engine fatal and every later engine request reuses that failure', async () => {
    let loads = 0;
    const h = harness({
      loadEngine: async () => {
        loads++;
        throw new Error('wasm download broke');
      },
    });

    const first = errorOf(await h.request('load'));
    const second = errorOf(await h.request('load'));
    assert.equal(first.code, ErrorCode.NotLoaded);
    assert.match(first.message, /could not start/i);
    assert.match(`${first.message} ${first.detail ?? ''}`, /wasm download broke/);
    assert.deepEqual(second, first);
    assert.equal(loads, 1, 'a dead engine must not be instantiated again');
    assert.equal(h.host.state().state, 'fatal');
  });

  test('a settings import failure is internal but does not poison the next request', async () => {
    let imports = 0;
    class SettingsRequestError extends Error {
      code = ErrorCode.BadRequest;
    }
    class SettingsService {
      catalogueDocument() {
        return { format: 2 };
      }
      view() {
        return {};
      }
      edit() {
        return {};
      }
    }
    const h = harness({
      loadSettings: async () => {
        if (++imports === 1) throw new Error('chunk unavailable');
        return { SettingsRequestError, SettingsService } as unknown as SettingsModule;
      },
    });

    const failure = errorOf(await h.request('settings.catalogue'));
    assert.equal(failure.code, ErrorCode.Internal);
    assert.equal(failure.message, 'The settings service could not be loaded.');
    assert.equal(failure.detail, 'chunk unavailable');
    const retry = await h.request('settings.catalogue');
    assert.equal(retry.kind, 'result');
    assert.deepEqual(retry.kind === 'result' && retry.result, { format: 2 });
    assert.equal(imports, 2);
  });

  test('settings validation errors retain their public details; unexpected failures do not masquerade as validation', async () => {
    class SettingsRequestError extends Error {
      readonly code: number;
      readonly detail?: string;
      constructor(message: string, code: number, detail?: string) {
        super(message);
        this.code = code;
        this.detail = detail;
      }
    }
    class SettingsService {
      catalogueDocument() {
        return {};
      }
      view() {
        throw new SettingsRequestError('Unknown setting.', ErrorCode.BadRequest, 'bad_key');
      }
      edit() {
        throw new Error('invariant failed');
      }
    }
    const h = harness({ loadSettings: async () => ({ SettingsRequestError, SettingsService }) as unknown as SettingsModule });

    assert.deepEqual(errorOf(await h.request('settings.view')), {
      code: ErrorCode.BadRequest,
      message: 'Unknown setting.',
      detail: 'bad_key',
    });
    assert.deepEqual(errorOf(await h.request('settings.edit')), {
      code: ErrorCode.Internal,
      message: 'The settings service failed: invariant failed',
    });
  });
});

test('config definitions reject absent, engine-error, and incompatible catalogue data', () => {
  assert.throws(() => readConfigDefinitions({} as OrcaEngineModule), /rebuild the engine/);
  assert.throws(() => readConfigDefinitions({ configDefinitions: () => JSON.stringify({ error: 'cannot enumerate options' }) } as OrcaEngineModule), /cannot enumerate options/);
  assert.throws(() => readConfigDefinitions({ configDefinitions: () => JSON.stringify({ format: 99, options: {} }) } as OrcaEngineModule), /format 99/);
  assert.throws(() => readConfigDefinitions({ configDefinitions: () => JSON.stringify({ format: 1, options: null }) } as OrcaEngineModule), /format 1/);

  const definitions = { format: 1 as const, options: { layer_height: { type: 'float' } }, keys: { machine: [], process: ['layer_height'], filament: [] } };
  assert.deepEqual(readConfigDefinitions({ configDefinitions: () => JSON.stringify(definitions) } as OrcaEngineModule), definitions);
});
