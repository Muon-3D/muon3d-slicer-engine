// Protocol v2 conformance: every target host (targets.ts: in process, behind a byte stream, in a Node
// worker from the sources, and the built host file) against the protocol package's own client. The same
// suite is what any other host (a cloud service, an app runtime) would have to pass.
//
//   node --test test/conformance/conformance.test.ts
//
// The engine part (load, slice, check, config.definitions, the slice goldens of v0.1.0) runs when the
// engine is built (ENGINE_DIR, default dist/; npm run test:engine requires it); the rest needs no wasm.
// Settings: settings.view's dynamic state must come back within 5 ms at p95, messaging included.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { EngineRequestError, SettingsClient } from '../../packages/protocol/src/connection.ts';
import { ErrorCode, PROTOCOL, type Progress } from '../../packages/protocol/src/envelope.ts';
import { configHash } from '../../packages/protocol/src/helpers.ts';
import { OPS, type SliceParams } from '../../packages/protocol/src/ops.ts';
import { HOST_CANARY } from '../../host/src/canary.ts';
import { cube, engineDir, engineSkip, m1Presets, variant as engineVariant, type Presets } from '../fixtures.ts';
import { PLATES, comparable } from './plates.ts';
import { TARGETS, type Connected } from './targets.ts';

const client = { name: 'conformance', version: '2.0.0' };
const SETTINGS_P95_MS = 5;

const slices = JSON.parse(readFileSync(new URL('../goldens/slices.json', import.meta.url), 'utf8')) as {
  reference: { version: string; orcaCommit: string };
  plates: Record<string, Record<'st' | 'mt', { sha256: string; bytes: number; layers: number }>>;
};
// The slice goldens hold for an engine built from their Orca commit (not for the upstream canary's builds).
const builtManifest = existsSync(path.join(engineDir, 'manifest.json')) ? JSON.parse(readFileSync(path.join(engineDir, 'manifest.json'), 'utf8')) : null;
const goldenSkip: string | false =
  builtManifest?.orcaCommit === slices.reference.orcaCommit ? false : `the engine is built from Orca ${builtManifest?.orcaCommit}, the slice goldens from ${slices.reference.orcaCommit}`;

/** The error a request fails with (fails the test when it succeeds). */
async function rejection(promise: Promise<unknown>): Promise<EngineRequestError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof EngineRequestError, `an EngineRequestError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the request to fail');
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

for (const target of TARGETS) {
  describe(`conformance: ${target.name}`, { skip: target.skip }, () => {
    let host: Connected;
    let presets: Presets;
    before(async () => {
      host = await target.connect();
      presets = await m1Presets();
    });
    after(async () => host?.close());

    const settingsPresets = () => ({ machine: presets.machine, process: presets.process, filament: presets.filaments[0] });

    test('hello: protocol 2.0, every op, the engine and its licence', async () => {
      const hello = await host.connection.open(client, { required: [...OPS] });
      assert.deepEqual(hello.protocol, { major: PROTOCOL.major, minor: PROTOCOL.minor });
      for (const op of OPS) assert.ok(hello.capabilities.includes(op), op);
      assert.equal(hello.engine.license, 'AGPL-3.0-only');
      assert.equal(hello.engine.canary, HOST_CANARY);
      assert.match(hello.engine.source, /^https:\/\/github\.com\/Muon-3D\/muon3d-slicer-engine/);
      assert.match(hello.engine.notice, /NOTICE$/);
      assert.ok(hello.engine.name.includes('OrcaSlicer'));
      // What can run here: nothing before the engine is built (npm run build:host alone).
      if (!engineSkip) assert.ok(hello.variants.includes('st'));
      assert.ok(hello.variants.every((v) => v === 'st' || v === 'mt'));
      assert.ok(hello.limits.maxThreads >= 1 && hello.limits.maxHeapBytes > 0);
      assert.deepEqual(hello.formats, { definitions: 1, catalogue: 2, toolpaths: 1, settingsView: 1 });
    });

    test('hello with another protocol major fails with ProtocolMismatch, naming the majors served', async () => {
      const err = await rejection(host.connection.request('hello', { protocol: { major: 3 }, client }));
      assert.equal(err.code, ErrorCode.ProtocolMismatch);
      assert.equal(err.detail, '2');
    });

    test('unknown ops, bad params and slices without objects are refused in words', async () => {
      assert.equal((await rejection(host.connection.request('mesh.teleport' as never, {} as never))).code, ErrorCode.Unsupported);
      assert.equal((await rejection(host.connection.request('settings.view', { scope: 'kitchen' } as never))).code, ErrorCode.BadRequest);
      const err = await rejection(host.connection.request('slice', { configs: { machine: {}, process: {}, filaments: [{}] }, objects: [{ name: 'X', mesh: { positions: new Float32Array(10) } }] }));
      assert.equal(err.code, ErrorCode.BadRequest);
      assert.match(err.message, /9 floats per triangle/);
    });

    test('status: idle until an op needs the engine (settings never do)', async () => {
      await host.connection.request('settings.catalogue', {});
      assert.deepEqual(await host.connection.request('status', {}), { state: 'idle' });
    });

    test('settings.catalogue: format 2, every tab', async () => {
      const catalogue = await host.connection.request('settings.catalogue', {});
      assert.equal(catalogue.format, 2);
      assert.deepEqual(catalogue.tabs.map((t) => t.id), ['process', 'filament', 'machine']);
      assert.ok(Object.keys(catalogue.options).length > 500);
    });

    test('settings.view: the form once, then the dynamic state by form id; configs by hash', async () => {
      const refs = {
        machine: { hash: configHash(presets.machine), config: presets.machine },
        process: { hash: configHash(presets.process), config: presets.process },
        filament: { hash: configHash(presets.filaments[0]), config: presets.filaments[0] },
      };
      const first = await host.connection.request('settings.view', { scope: 'process', presets: refs, version: 7 });
      assert.equal(first.format, 1);
      assert.equal(first.version, 7);
      assert.ok(first.form && first.form.id === first.formId);
      assert.ok(first.tab!.pages.length > 0);
      const byHash = { machine: { hash: refs.machine.hash }, process: { hash: refs.process.hash }, filament: { hash: refs.filament.hash } };
      const second = await host.connection.request('settings.view', { scope: 'process', presets: byHash, form: first.formId });
      assert.equal(second.form, undefined, 'the form is left out when the client holds it');
      assert.deepEqual(second.tab, first.tab);
      const err = await rejection(host.connection.request('settings.view', { scope: 'process', presets: { ...byHash, process: { hash: 'never-sent' } } }));
      assert.equal(err.code, ErrorCode.NotCached);
    });

    test('settings.edit: writes, notices and the document after the edit, version-stamped', async () => {
      const settings = new SettingsClient(host.connection);
      const result = await settings.edit({ scope: 'process', presets: settingsPresets(), edit: { set: 'layer_height', value: '0' }, version: 3, view: true });
      assert.equal(result.version, 3);
      assert.deepEqual(result.writes, { layer_height: '0.08' });
      assert.match(result.notices[0], /minimum \(0\.08 mm\)/);
      assert.ok(result.view?.form, 'SettingsClient fills in the cached form');
      const object = await settings.edit({ scope: 'object', presets: settingsPresets(), object: {}, edit: { add: 'wall_loops' } });
      assert.deepEqual(object.writes, { wall_loops: presets.process.wall_loops }, 'the value it has now');
      const plate = await settings.edit({ scope: 'plate', presets: settingsPresets(), objects: [{ id: 'a' }], edit: { set: 'spiral_mode', value: '1' } });
      assert.deepEqual(plate.writes, {});
      assert.equal(plate.prompts[0].blocking, true);
    });

    test(`settings.view: the dynamic state within ${SETTINGS_P95_MS} ms at p95, messaging included`, async () => {
      const settings = new SettingsClient(host.connection);
      const views = [
        { scope: 'process' as const, env: { mode: 'expert' as const } },
        { scope: 'filament' as const, env: { mode: 'advanced' as const } },
        { scope: 'machine' as const, env: { mode: 'expert' as const } },
        { scope: 'object' as const, object: { wall_loops: '3', layer_height: '0.12' } },
      ];
      const run = (i: number) => {
        const v = views[i % views.length];
        return settings.view({ ...v, presets: settingsPresets(), overrides: { process: { wall_loops: String(1 + (i % 5)) } }, version: i });
      };
      // Warm up (the first request sends the presets and the forms, and the JIT compiles).
      for (let i = 0; i < 40; i++) await run(i);
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const started = performance.now();
        await run(i);
        times.push(performance.now() - started);
      }
      const p50 = percentile(times, 0.5);
      const p95 = percentile(times, 0.95);
      console.log(`# ${target.name}: settings.view p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (${times.length} requests)`);
      // The budget is the settings worker's: a host in a worker thread of its own. In process (client and host
      // share one thread) and behind the in-memory byte stream the time is reported only.
      if (target.settingsBudget) assert.ok(p95 < SETTINGS_P95_MS, `p95 ${p95.toFixed(2)} ms`);
    });

    describe('engine', { skip: engineSkip }, () => {
      const sliceParams = (): SliceParams => ({ configs: presets, objects: [{ name: 'Cube.stl', mesh: { positions: cube([100, 90]) } }] });

      test('load: the engine loads once, with loading and ready states', async () => {
        const loaded = await host.connection.request('load', { variant: engineVariant });
        assert.equal(loaded.variant, engineVariant);
        assert.deepEqual(await host.connection.request('load', {}), loaded, 'a second load answers with the first');
        assert.ok(host.states.some((s) => s.state === 'loading'));
        const status = await host.connection.request('status', {});
        assert.equal(status.state, 'ready');
        const other = engineVariant === 'st' ? 'mt' : 'st';
        assert.equal((await rejection(host.connection.request('load', { variant: other }))).code, ErrorCode.BadRequest);
      });

      test('slice: G-code, stats, toolpaths format 1, progress that never goes back', async () => {
        const progress: Progress[] = [];
        const result = await host.connection.request('slice', sliceParams(), { onProgress: (p) => progress.push(p) });
        assert.equal(result.stats.layers, 100);
        assert.equal(result.toolpaths?.format, 1);
        assert.ok(result.toolpaths!.roles.some((r) => r.name === 'Outer wall' && r.lengthMm > 0));
        assert.ok(result.toolpathExtras && result.toolpathExtras.feedrate.length === result.toolpaths!.extrusions.count);
        assert.ok(progress.length > 0);
        for (let i = 1; i < progress.length; i++) assert.ok(progress[i].percent >= progress[i - 1].percent);
        const bare = await host.connection.request('slice', { ...sliceParams(), output: { toolpaths: false } });
        assert.equal(bare.toolpaths, null);
      });

      test(`slice: the same G-code as ${slices.reference.version} for the golden plates`, { skip: goldenSkip }, async () => {
        for (const plate of PLATES) {
          const result = await host.connection.request('slice', { ...plate.params(), output: { toolpaths: false } });
          const expected = slices.plates[plate.id][engineVariant];
          assert.equal(createHash('sha256').update(comparable(result.gcode)).digest('hex'), expected.sha256, plate.id);
          assert.equal(result.gcode.length, expected.bytes, plate.id);
        }
      });

      test('slice: an indexed mesh slices like its triangle soup', { skip: goldenSkip }, async () => {
        const soup = cube([100, 90]);
        const vertices: number[] = [];
        const indices: number[] = [];
        const seen = new Map<string, number>();
        for (let i = 0; i < soup.length; i += 3) {
          const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`;
          if (!seen.has(key)) {
            seen.set(key, vertices.length / 3);
            vertices.push(soup[i], soup[i + 1], soup[i + 2]);
          }
          indices.push(seen.get(key)!);
        }
        const indexed = await host.connection.request('slice', {
          configs: presets,
          objects: [{ name: 'Cube.stl', mesh: { positions: new Float32Array(vertices), indices: new Uint32Array(indices) } }],
          output: { toolpaths: false },
        });
        assert.equal(createHash('sha256').update(comparable(indexed.gcode)).digest('hex'), slices.plates['m1-cube'][engineVariant].sha256);
      });

      test("Orca's own refusals pass through with its negative codes", async () => {
        const err = await rejection(host.connection.request('slice', { configs: presets, objects: [{ name: 'Far.stl', mesh: { positions: cube([400, 400]) } }] }));
        assert.ok(err.code < 0, `code ${err.code}`);
        assert.equal((await host.connection.request('status', {})).state, 'ready', 'the engine stays loaded');
      });

      test('check: inside, outside and exclusion hits per object', async () => {
        const result = await host.connection.request('check', {
          configs: presets,
          objects: [
            { name: 'Centre.stl', mesh: { positions: cube([100, 90]) } },
            { name: 'Far.stl', mesh: { positions: cube([400, 90]) } },
          ],
        });
        assert.deepEqual(result.objects.map((o) => [o.name, o.inside]), [['Centre.stl', true], ['Far.stl', false]]);
        for (const o of result.objects) for (const hit of o.exclusionHits) assert.ok(hit.triangles instanceof Float32Array && typeof hit.region === 'number');
      });

      test('config.definitions: format 1, the option table of the engine that slices', async () => {
        const defs = await host.connection.request('config.definitions', {});
        assert.equal(defs.format, 1);
        assert.ok(defs.options.layer_height && defs.objectKeys.includes('layer_height'));
      });

      test('cancel: a queued request ends with Cancelled; a finished one cannot be', async () => {
        // A fresh host: the first slice waits for the engine to load, so the second is still queued.
        const fresh = await target.connect();
        try {
          const first = fresh.connection.call('slice', sliceParams());
          const second = fresh.connection.call('slice', sliceParams());
          // The request's error comes before the cancel's answer.
          const cancelled = rejection(second.result);
          assert.equal(await second.cancel(), true);
          assert.equal((await cancelled).code, ErrorCode.Cancelled);
          await first.result;
          assert.equal(await first.cancel(), false);
        } finally {
          await fresh.close();
        }
      });
    });
  });
}
