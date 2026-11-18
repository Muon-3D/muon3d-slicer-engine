// tools/profiles/sync-muon3d.ts: the one change the copy makes to the fork's files, and how two copies are compared.
// (The whole tool, fetch and OrcaSlicer's profile tool included, runs in CI: build.yml, "sync-muon3d.ts --check".)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { differences, moveExclusionVolumes } from './sync-muon3d.ts';

const ZONE = '0..5;119.5x0,80.5x0,80.5x2.629,83.753x24.748,119.5x34';

describe('the M1 exclusion zone, from the desktop build\'s option to the engine\'s', () => {
  it('moves a Z-ranged bed_exclude_area to bed_exclude_volumes, in its place, and leaves an empty area', () => {
    const { file, changed } = moveExclusionVolumes({ name: 'fdm_common_muon_m1', printable_area: ['0x0'], bed_exclude_area: [ZONE], printable_height: '165' });
    assert.equal(changed, true);
    assert.deepEqual(Object.keys(file), ['name', 'printable_area', 'bed_exclude_area', 'bed_exclude_volumes', 'printable_height']);
    assert.deepEqual(file.bed_exclude_area, []);
    assert.equal(file.bed_exclude_volumes, ZONE);
  });

  it('leaves a 2D area, an empty one, and a file without one alone', () => {
    for (const f of [{ name: 'a', bed_exclude_area: ['0x0,10x0,10x10'] }, { name: 'b', bed_exclude_area: [] }, { name: 'c' }]) {
      const { file, changed } = moveExclusionVolumes(f);
      assert.equal(changed, false);
      assert.equal(file, f);
    }
  });

  it('refuses what the engine could not say in one option', () => {
    assert.throws(() => moveExclusionVolumes({ name: 'm', bed_exclude_area: [ZONE, '0x0,1x0,1x1'] }), /mixes 3D and 2D/);
    assert.throws(() => moveExclusionVolumes({ name: 'm', bed_exclude_area: [ZONE], bed_exclude_volumes: ZONE }), /both/);
  });
});

describe('comparing the committed copy with a fresh one', () => {
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-test-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };

  it('names each file that differs or is on one side only, ignores line ends and the README', () => {
    const a = tree({ 'Muon3D.json': '{\n}\n', 'Muon3D/filament/PLA.json': '{"a": 1}\n', 'Muon3D/old.json': '{}', 'README.md': 'ours' });
    const b = tree({ 'Muon3D.json': '{\r\n}\r\n', 'Muon3D/filament/PLA.json': '{"a": 2}\n', 'Muon3D/new.json': '{}' });
    try {
      assert.deepEqual(differences(a, b), ['Muon3D/filament/PLA.json: differs', 'Muon3D/new.json: only in the fork', 'Muon3D/old.json: only in the committed copy']);
      assert.deepEqual(differences(a, a), []);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
