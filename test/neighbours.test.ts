// Supports and the plate's other objects (protocol 2.3, capabilities 'support.avoidObjects' and 'slice.conflict').
// Orca generates each object's supports seeing only that object, so one object's support could run through
// another and fail the plate's conflict check (-101). The engine adds the other objects within reach as support
// blockers of each object with organic tree supports (engine/bridge/neighbours.hpp), warns ('support_dropped')
// when branches found no way past them, and describes a conflict that still happens (EngineError.conflict, with
// the toolpaths). The plates whose objects are out of reach keep their G-code: the neighbour goldens, in
// test/conformance. Needs the built engine (npm run test:engine runs it on st and mt).
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { EngineJobError, runSlice, type EngineObject, type OrcaEngineModule, type SliceOutput } from '../host/src/bridge.ts';
import type { EngineError } from '../packages/protocol/src/envelope.ts';
import type { Toolpaths } from '../packages/protocol/src/ops.ts';
import { boxAt, capT } from './conformance/plates.ts';
import { engineSkip, m1Presets, sliceJob, startEngine, type Presets } from './fixtures.ts';
import { paintAll } from './helpers/paint.ts';

/** An axis-aligned rectangle on the bed, mm. */
interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const rectOf = (center: [number, number], size: [number, number]): Rect => ({
  x0: center[0] - size[0] / 2,
  x1: center[0] + size[0] / 2,
  y0: center[1] - size[1] / 2,
  y1: center[1] + size[1] / 2,
});

const distance = (x: number, y: number, r: Rect) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));

/** Points along the support extrusions (their ends, and every 0.5 mm), as [x, y, z]. */
function supportPoints(paths: { layerCount: number; layerZ: Float32Array; extrusions: { positions: Float32Array; layerStart: Uint32Array; roleIndex: Uint8Array } }, roles: string[]) {
  const support = new Set(roles.flatMap((name, i) => (/support/i.test(name) ? [i] : [])));
  const out: Array<[number, number, number]> = [];
  for (let l = 0; l < paths.layerCount; l++) {
    for (let s = paths.extrusions.layerStart[l]; s < paths.extrusions.layerStart[l + 1]; s++) {
      if (!support.has(paths.extrusions.roleIndex[s])) continue;
      const p = paths.extrusions.positions;
      // The ends and points every 0.5 mm between them.
      const steps = Math.max(1, Math.ceil(Math.hypot(p[s * 6 + 3] - p[s * 6], p[s * 6 + 4] - p[s * 6 + 1]) / 0.5));
      for (let k = 0; k <= steps; k++) out.push([p[s * 6] + ((p[s * 6 + 3] - p[s * 6]) * k) / steps, p[s * 6 + 1] + ((p[s * 6 + 4] - p[s * 6 + 1]) * k) / steps, paths.layerZ[l]]);
    }
  }
  return out;
}

const outputSupport = (output: SliceOutput) => supportPoints(output.toolpaths!, output.toolpaths!.roles);

/** The T of the plates, and its left arm (x 70..95 for a T at x 100). */
const T_AT: [number, number] = [100, 90];
const leftArm: Rect = rectOf([82.5, 90], [25, 12]);

describe('supports and the other objects on the plate', { skip: engineSkip }, () => {
  let engine: OrcaEngineModule;
  let presets: Presets;
  before(async () => {
    engine = (await startEngine()).engine;
    presets = await m1Presets();
  });

  const process = (overrides: Record<string, string> = {}) => ({
    ...presets.process,
    enable_support: '1',
    support_type: 'tree(auto)',
    support_on_build_plate_only: '1',
    support_threshold_angle: '30',
    ...overrides,
  });

  function slice(objects: EngineObject[], overrides: Record<string, string> = {}): SliceOutput {
    return runSlice(engine, sliceJob({ ...presets, process: process(overrides) }, objects));
  }

  function failure(objects: EngineObject[], overrides: Record<string, string> = {}, toolpaths = true): EngineError {
    try {
      runSlice(engine, sliceJob({ ...presets, process: process(overrides) }, objects, toolpaths));
    } catch (err) {
      if (err instanceof EngineJobError) return err.error;
      throw err;
    }
    assert.fail('the slice succeeded');
  }

  const dropped = (output: SliceOutput) => output.warnings.filter((w) => w.kind === 'support_dropped');

  test('a T whose arm overhangs a block: organic tree supports go around the block, with no conflict', () => {
    const blockAt: [number, number] = [78, 90];
    const block = rectOf(blockAt, [14, 14]);
    const output = slice([
      { name: 'Tee.stl', positions: capT(T_AT) },
      { name: 'Block.stl', positions: boxAt([14, 14, 20], blockAt, 0) },
    ]);
    const points = outputSupport(output);
    assert.ok(points.length > 0, 'the T has support');
    // Below the block's top nothing of the T's support comes within the support's XY distance of the block.
    const near = points.filter(([x, y, z]) => z <= 20 + 1e-3 && distance(x, y, block) < 0.35);
    assert.deepEqual(near.slice(0, 5), [], `${near.length} support points within 0.35 mm of the block`);
    // The arm over the block is supported: support right under it, reaching the bed beside the block.
    assert.ok(points.some(([x, y, z]) => z > 38 && z < 40 && distance(x, y, block) === 0), 'support under the arm, over the block');
    assert.ok(points.some(([x, y, z]) => z < 1 && distance(x, y, leftArm) < 8), 'support on the bed beside the block');
    assert.deepEqual(dropped(output), []);
  });

  test('two copies of the T around one block: each one\'s support avoids the block and the other T', () => {
    const blockAt: [number, number] = [100, 110];
    const block = rectOf(blockAt, [14, 14]);
    const output = slice([
      { name: 'Tee.stl', positions: capT([100, 90]) },
      { name: 'Block.stl', positions: boxAt([14, 14, 20], blockAt, 0) },
      { name: 'Tee.stl', positions: capT([100, 130]) },
    ]);
    const points = outputSupport(output);
    const near = points.filter(([x, y, z]) => z <= 20 + 1e-3 && distance(x, y, block) < 0.35);
    assert.deepEqual(near.slice(0, 5), [], `${near.length} support points within 0.35 mm of the block`);
    for (const pillar of [rectOf([100, 90], [10, 10]), rectOf([100, 130], [10, 10])]) {
      const inside = points.filter(([x, y, z]) => z < 40 && distance(x, y, pillar) === 0);
      assert.deepEqual(inside.slice(0, 5), [], `${inside.length} support points inside a pillar`);
    }
  });

  test('support blocker paint still works next to a neighbour', () => {
    // The left arm's underside painted as a blocker, a block under the right arm.
    const t = capT(T_AT);
    // capT: the pillar's 12 triangles, then the cap's: its bottom face is triangles 12 and 13 (box() order).
    const output = slice([
      { name: 'Tee.stl', positions: t, paint: { supports: paintAll([12, 13], '8') } },
      { name: 'Block.stl', positions: boxAt([14, 14, 20], [122, 90], 0) },
    ]);
    // The whole underside is blocked: no support at all.
    assert.deepEqual(outputSupport(output).slice(0, 5), []);
  });

  test('where no route exists, the slice warns that support was dropped', () => {
    // A block 42 x 100 x 32 mm under the left arm, 8 mm below it: no branch can lean out from under it in time.
    const output = slice([
      { name: 'Tee.stl', positions: capT(T_AT) },
      { name: 'Block.stl', positions: boxAt([42, 100, 32], [71, 90], 0) },
    ]);
    const warnings = dropped(output);
    assert.equal(warnings.length, 1, JSON.stringify(output.warnings));
    assert.deepEqual(warnings[0].objects, ['Tee.stl', 'Block.stl']);
    assert.match(warnings[0].message, /^Some of the tree support of "Tee\.stl" found no way down past "Block\.stl": from Z = \d+\.\d\d mm, about \d+ mm2 of overhang have no support/);
    // And the support that was made stays out of the block.
    const block = rectOf([71, 90], [42, 100]);
    const inside = outputSupport(output).filter(([x, y, z]) => z <= 32 && distance(x, y, block) === 0);
    assert.deepEqual(inside.slice(0, 5), []);
  });

  test('other support types keep failing the conflict check, now saying where and whose support', () => {
    const objects = [
      { name: 'Tee.stl', positions: capT(T_AT) },
      { name: 'Block.stl', positions: boxAt([14, 14, 20], [78, 90], 0) },
    ];
    const variants: Array<Record<string, string>> = [{ support_type: 'normal(auto)' }, { support_type: 'tree(auto)', support_style: 'tree_hybrid' }];
    for (const overrides of variants) {
      const error = failure(objects, overrides);
      const label = JSON.stringify(overrides);
      assert.equal(error.code, -101, label);
      assert.match(error.message, /^Found gcode path conflicts between object (Block|Tee)\.stl and (Block|Tee)\.stl$/, label);
      assert.ok(error.conflict, label);
      assert.deepEqual([...error.conflict.objects].sort(), ['Block.stl', 'Tee.stl'], label);
      assert.equal(error.conflict.supportOf, 'Tee.stl', label);
      const toolpaths = error.toolpaths as Toolpaths;
      assert.ok(toolpaths && toolpaths.layerCount > 0, label);
      assert.ok(Math.abs(toolpaths.layerZ[error.conflict.layer] - error.conflict.z) < 1e-3, label);
      assert.ok(error.conflict.z <= 20 + 1e-3, label);
      // The T's support does cross the block on that layer.
      const block = rectOf([78, 90], [14, 14]);
      const crossing = supportPoints(toolpaths, toolpaths.roles.map((r) => r.name)).filter(
        ([x, y, z]) => Math.abs(z - error.conflict!.z) < 1e-3 && distance(x, y, block) === 0,
      );
      assert.ok(crossing.length > 0, label);
      // The lowest conflicting layer, on every variant and every run (the mt engines check the layers in parallel,
      // and Orca keeps whichever conflict a thread found first; the engine looks for the lowest: neighbours.hpp).
      const again = failure(objects, overrides);
      assert.deepEqual([again.conflict?.layer, again.conflict?.z, again.message], [error.conflict.layer, error.conflict.z, error.message], label);
    }
  });

  test('a conflict between two objects\' walls names no support', () => {
    // Two cubes that overlap: their walls cross on every layer.
    const error = failure([
      { name: 'A.stl', positions: boxAt([20, 20, 5], [100, 90], 0) },
      { name: 'B.stl', positions: boxAt([20, 20, 5], [110, 90], 0) },
    ], { enable_support: '0' }, false);
    if (error.code !== -101) return; // Orca's validation may refuse overlapping objects first
    assert.equal(error.conflict?.supportOf, null);
    assert.equal(error.toolpaths, undefined);
  });
});
