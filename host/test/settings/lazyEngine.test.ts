// Settings must work without evaluating any slicing/field modules. An eager engine import adds
// startup and allocation work to every new settings worker even though settings need no engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('settings views and edits do not evaluate the engine or field modules', () => {
  const source = `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    registerHooks({ load(url, context, next) {
      if (/host\\/src\\/(bridge|ops|profiles|configDefinitions|sliceField)\\.ts$/.test(url) || /protocol\\/src\\/sliceField\\.ts$/.test(url))
        throw new Error('Settings evaluated an engine module: ' + url);
      return next(url, context);
    }});
    const { createHost } = await import('./host/src/core.ts');
    const { machine, process, filaments } = JSON.parse(readFileSync('./test/fixtures/presets/muon3d-m1-0.4.json'));
    let resolve;
    const host = createHost({ base: 'file:///missing-engine/', send(message) { resolve(message); } });
    let id = 0;
    const request = (op, params) => new Promise(done => { resolve = done; host.receive({ v: 2, id: ++id, op, params }); });
    const presets = { machine: { hash: 'm', config: machine }, process: { hash: 'p', config: process }, filament: { hash: 'f', config: filaments[0] } };
    for (const scope of ['process', 'filament', 'machine', 'object']) {
      const result = await request('settings.view', { scope, presets });
      assert.equal(result.kind, 'result', JSON.stringify(result));
      assert.equal(result.result.scope, scope);
    }
    const edited = await request('settings.edit', { scope: 'process', presets, edit: { set: 'layer_height', value: '0' }, view: true });
    assert.equal(edited.kind, 'result', JSON.stringify(edited));
    assert.deepEqual(edited.result.writes, { layer_height: '0.08' });
    assert.deepEqual(host.state(), { state: 'idle' });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
