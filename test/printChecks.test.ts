// The "Before you print" checks (docs/print-checks.md) on fixtures made to fail: a tall pin, a bridge, a mushroom
// and a large ABS plate, plus a thin wall and a weak neck, each slice checked for its required issues. Every fixture is sliced with the checks
// and without: the G-code must be the same, and the difference in time is what the checks cost (written to
// ENGINE_TEST_OUT/print-checks-timing.json). Skipped until the engine is built, like test/engine.test.ts.
//
//   node --test test/printChecks.test.ts                       # dist/engine-st.mjs
//   ENGINE_VARIANT=mt node --test test/printChecks.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { runSlice, type EngineObject, type OrcaEngineModule, type SliceOutput } from '../host/src/bridge.ts';
import type { PrintCheck, PrintCheckKind } from '../packages/protocol/src/index.ts';
import { box, cylinder, engineSkip, m1Presets, ms, outDir, sliceJob, startEngine, variant, type Presets } from './fixtures.ts';

if (engineSkip) console.log(`# ${engineSkip}`);

const KINDS: readonly PrintCheckKind[] = [
  'unstable-part', 'floating-extrusion', 'long-bridge', 'curled-overhang', 'weak-connection',
  'warp-risk', 'slender', 'thin-feature', 'layer-time', 'overhang', 'roof-gap', 'hanging-mass', 'weak-support-interface',
];
const SEVERITIES = ['critical', 'warning', 'info'];
const FIXES = ['supports', 'brim', 'slower-outer-walls', 'contact-area', 'orientation', 'support-interface'];

function lift(positions: Float32Array, dz: number): Float32Array {
  const out = new Float32Array(positions);
  for (let i = 2; i < out.length; i += 3) out[i] += dz;
  return out;
}

/** A cone frustum around the z axis through `center`: radius r0 at z0 to r1 at z1, closed. */
function frustum(center: [number, number], r0: number, r1: number, z0: number, z1: number, segments = 96): Float32Array {
  const [cx, cy] = center;
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (2 * Math.PI * i) / segments, a1 = (2 * Math.PI * (i + 1)) / segments;
    const p = (r: number, a: number, z: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
    out.push(cx, cy, z0, ...p(r0, a1, z0), ...p(r0, a0, z0)); // bottom (-z)
    out.push(cx, cy, z1, ...p(r1, a0, z1), ...p(r1, a1, z1)); // top (+z)
    out.push(...p(r0, a0, z0), ...p(r0, a1, z0), ...p(r1, a1, z1), ...p(r0, a0, z0), ...p(r1, a1, z1), ...p(r1, a0, z1)); // side
  }
  return new Float32Array(out);
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface Fixture {
  name: string;
  objects: EngineObject[];
  presets?: (presets: Presets) => Presets;
  /** Each of these kinds must be found on the fixture. */
  expect: PrintCheckKind[];
}

const FIXTURES: Fixture[] = [
  {
    // 3 mm across and 40 mm tall: bends under the nozzle.
    name: 'tall pin',
    objects: [{ name: 'Pin.stl', positions: cylinder([100, 90], 1.5, 40, 48) }],
    expect: ['slender', 'unstable-part', 'layer-time'],
  },
  {
    // Two 11 mm pillars 35 mm apart under a 2 mm deck, no supports: the deck is a bridge over 16 mm.
    name: 'bridge',
    objects: [{
      name: 'Bridge.stl',
      positions: join(box([6, 12, 11], [77, 90]), box([6, 12, 11], [123, 90]), lift(box([52, 12, 2], [100, 90]), 10)),
    }],
    expect: ['long-bridge', 'floating-extrusion'],
  },
  {
    // A 40 mm cap on a 6 mm stem, no supports: the cap's underside (68° from vertical) overhangs and curls, and its
    // rim floats.
    name: 'mushroom',
    objects: [{
      name: 'Mushroom.stl',
      positions: join(cylinder([100, 90], 3, 16, 48), frustum([100, 90], 3, 20, 15, 22), lift(cylinder([100, 90], 20, 3, 96), 21.5)),
    }],
    expect: ['curled-overhang', 'floating-extrusion', 'unstable-part'],
  },
  {
    // 150 × 130 mm of ABS, no brim, chamber unheated.
    name: 'large ABS plate',
    objects: [{ name: 'Plate.stl', positions: box([150, 130, 2], [100, 100]) }],
    presets: (p) => ({
      ...p,
      process: { ...p.process, brim_type: 'no_brim' },
      filaments: p.filaments.map((f) => ({ ...f, filament_type: ['ABS'] })),
    }),
    expect: ['warp-risk'],
  },
  {
    // 0.6 mm across: less than two 0.42 mm external-perimeter lines.
    name: 'thin wall',
    objects: [{ name: 'ThinWall.stl', positions: box([0.6, 20, 4], [100, 90]) }],
    expect: ['thin-feature'],
  },
  {
    // A broad foot, a 1 mm neck and a gentle taper to a 3 mm pin: the nozzle load breaks the neck.
    // The taper avoids unsupported cap extrusions, whose proposed supports would reinforce the search's neck.
    name: 'weak neck',
    objects: [{
      name: 'WeakNeck.stl',
      positions: join(box([30, 30, 3], [100, 90]), lift(cylinder([100, 90], 0.5, 5, 32), 2.8),
        frustum([100, 90], 0.5, 1.5, 7.5, 15.5, 32), lift(cylinder([100, 90], 1.5, 30, 32), 15.3)),
    }],
    expect: ['weak-connection'],
  },
];

function sliceWith(engine: OrcaEngineModule, presets: Presets, objects: EngineObject[], printChecks: boolean): { output: SliceOutput; wallMs: number } {
  const started = performance.now();
  const output = runSlice(engine, { ...sliceJob(presets, objects, false), printChecks }, () => {}, () => {});
  return { output, wallMs: performance.now() - started };
}

/** The G-code without its header line holding the time. */
const gcodeText = (output: SliceOutput) => new TextDecoder().decode(output.gcode).replace(/^; generated by .*$/m, '');

function assertWellFormed(check: PrintCheck, output: SliceOutput) {
  const where = `${check.kind} "${check.message}"`;
  assert.ok(KINDS.includes(check.kind), `kind ${check.kind}`);
  assert.ok(SEVERITIES.includes(check.severity), `${where}: severity ${check.severity}`);
  assert.ok(FIXES.includes(check.fix), `${where}: fix ${check.fix}`);
  assert.ok(Number.isInteger(check.layer) && check.layer >= 0 && check.layer < (output.stats.layers ?? Infinity) + 1, `${where}: layer ${check.layer}`);
  assert.equal(check.position.length, 3, `${where}: position`);
  for (const v of check.position) assert.ok(Number.isFinite(v), `${where}: position ${check.position}`);
  assert.ok(check.position[2] > 0 && check.position[2] <= (output.stats.maxZ ?? Infinity) + 1e-3, `${where}: z ${check.position[2]}`);
  assert.ok(check.message.length > 0 && check.message.length <= 120, `${where}: message`);
  if (check.value !== undefined) assert.ok(Number.isFinite(check.value), `${where}: value`);
}

describe(`print checks, engine-${variant}`, { skip: engineSkip }, () => {
  let engine: OrcaEngineModule;
  let presets: Presets;
  const timing: Record<string, { withoutMs: number; withMs: number; checksMs: number; issues: number }> = {};

  before(async () => {
    engine = (await startEngine()).engine;
    presets = await m1Presets();
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.name}: ${fixture.expect.join(', ')}`, (t) => {
      const p = fixture.presets ? fixture.presets(presets) : presets;
      sliceWith(engine, p, fixture.objects, false); // warm-up: the first slice of a plate pays for allocations
      const without = sliceWith(engine, p, fixture.objects, false);
      const withChecks = sliceWith(engine, p, fixture.objects, true);
      const checks = withChecks.output.printChecks;

      assert.equal(without.output.printChecks, undefined, 'no printChecks when output.printChecks is false');
      assert.ok(Array.isArray(checks), 'printChecks returned');
      assert.equal(gcodeText(withChecks.output), gcodeText(without.output), 'the checks do not change the G-code');
      for (const check of checks) assertWellFormed(check, withChecks.output);
      const rank = { critical: 0, warning: 1, info: 2 };
      for (let i = 1; i < checks.length; i++) {
        const [a, b] = [checks[i - 1], checks[i]];
        assert.ok(rank[a.severity] < rank[b.severity] || (a.severity === b.severity && a.layer <= b.layer), 'critical first, then by layer');
      }

      const kinds = new Set(checks.map((c) => c.kind));
      t.diagnostic(checks.map((c) => `${c.severity} ${c.kind} L${c.layer} (${c.position.map((v) => v.toFixed(1)).join(', ')}) ${c.fix}: ${c.message}`).join('\n'));
      for (const kind of fixture.expect) assert.ok(kinds.has(kind), `${fixture.name}: ${kind} found (got ${[...kinds].join(', ') || 'none'})`);

      const checksMs = withChecks.output.timings.checks ?? NaN;
      assert.ok(checksMs >= 0, 'timings.checks');
      timing[fixture.name] = {
        withoutMs: Math.round(without.output.timings.total),
        withMs: Math.round(withChecks.output.timings.total),
        checksMs: Math.round(checksMs),
        issues: checks.length,
      };
      t.diagnostic(`slice ${ms(without.output.timings.total)} without the checks, ${ms(withChecks.output.timings.total)} with; checks ${ms(checksMs)}`);
    });
  }

  test('a cube on the bed has nothing critical', () => {
    const { output } = sliceWith(engine, presets, [{ name: 'Cube.stl', positions: box([20, 20, 20], [100, 90]) }], true);
    const critical = (output.printChecks ?? []).filter((c) => c.severity === 'critical');
    assert.deepEqual(critical, []);
  });

  // The same parts with gravity along the build direction (the M1, hanging from the bed) and against it (an
  // upright printer): the results must differ the way the physics says (docs/print-checks.md, "Gravity").
  const withGravity = (p: Presets, gravity: string): Presets => ({ ...p, machine: { ...p.machine, gravity } });
  const checksOf = (p: Presets, objects: EngineObject[]) => {
    const { output } = sliceWith(engine, p, objects, true);
    return { output, checks: output.printChecks ?? [] };
  };
  // A 30 mm block on a 4 mm stem 30 mm tall: hanging, the block's weight hangs from the stem.
  const lollipop: EngineObject[] = [{ name: 'Lollipop.stl', positions: join(cylinder([100, 90], 2, 30.5, 48), lift(box([30, 30, 20], [100, 90]), 30)) }];

  test('gravity: a tall top-heavy part, along vs against the build direction', (t) => {
    const along = checksOf(withGravity(presets, 'along_build'), lollipop);
    const against = checksOf(withGravity(presets, 'against_build'), lollipop);
    assert.equal(along.output.gravity, 'along_build');
    assert.equal(against.output.gravity, 'against_build');
    const line = (c: PrintCheck) => `${c.severity} ${c.kind} L${c.layer} ${c.value ?? ''}: ${c.message}`;
    t.diagnostic(`along:\n${along.checks.map(line).join('\n')}\nagainst:\n${against.checks.map(line).join('\n')}`);
    // Hanging, the block's weight loads the stem: the hanging-mass check finds it, at the stem.
    const hanging = along.checks.find((c) => c.kind === 'hanging-mass');
    assert.ok(hanging, 'along: hanging-mass found');
    assert.ok(hanging.position[2] < 30.5, `along: the neck is the stem (z ${hanging.position[2]})`);
    assert.ok(!against.checks.some((c) => c.kind === 'hanging-mass'), 'against: the weight presses down, no hanging-mass');
    // And the weight never steadies it: no fewer critical issues hanging.
    const critical = (cs: PrintCheck[]) => cs.filter((c) => c.severity === 'critical').length;
    assert.ok(critical(along.checks) > critical(against.checks), `more critical issues along (${critical(along.checks)}) than against (${critical(against.checks)})`);
  });

  test('gravity: the ABS plate warps more hanging (its weight peels it)', () => {
    const plate = FIXTURES.find((f) => f.name === 'large ABS plate')!;
    const p = plate.presets!(presets);
    const score = (gravity: string) => checksOf(withGravity(p, gravity), plate.objects).checks.find((c) => c.kind === 'warp-risk')?.value ?? 0;
    const along = score('along_build'), against = score('against_build');
    assert.ok(against > 0 && along > against, `warp score along ${along} > against ${against}`);
  });

  test('gravity: supports on', () => {
    const supported = (p: Presets): Presets => ({ ...p, process: { ...p.process, enable_support: '1', support_type: 'normal(auto)' } });
    const mushroom = FIXTURES.find((f) => f.name === 'mushroom')!.objects;
    const against = checksOf(withGravity(supported(presets), 'against_build'), mushroom).checks;
    // Upright, supports hold what floated (PrusaSlicer reports these only with supports off).
    assert.ok(!against.some((c) => c.kind === 'floating-extrusion' || c.kind === 'long-bridge'), 'against: nothing floating with supports');
    assert.ok(!against.some((c) => c.kind === 'weak-support-interface'), 'against: supports push, no interface check');
    // Hanging, supports hold the cap by what sticks: the M1 preset's 0.2 mm top gap is flagged.
    const along = checksOf(withGravity(supported(presets), 'along_build'), mushroom).checks;
    assert.ok(along.some((c) => c.kind === 'weak-support-interface'), 'along: weak support interface found');
    const fused = checksOf(withGravity({ ...supported(presets), process: { ...supported(presets).process, support_top_z_distance: '0', support_interface_top_layers: '3', support_interface_spacing: '0' } }, 'along_build'), mushroom).checks;
    assert.ok(!fused.some((c) => c.kind === 'weak-support-interface'), 'along: a dense interface with no gap is not flagged');
  });

  test('gravity: a preset without it is upright; a wrong value fails the slice', () => {
    const { gravity: _, ...machine } = presets.machine;
    assert.equal(checksOf({ ...presets, machine }, [{ name: 'Cube.stl', positions: box([20, 20, 20], [100, 90]) }]).output.gravity, 'against_build');
    assert.throws(() => sliceWith(engine, withGravity(presets, 'sideways'), [{ name: 'Cube.stl', positions: box([20, 20, 20], [100, 90]) }], true), /gravity/);
  });

  test('writes the timing', () => {
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `print-checks-timing-${variant}.json`);
    writeFileSync(file, JSON.stringify(timing, null, 2) + '\n');
    console.log(`# print checks timing (${variant}): ${JSON.stringify(timing)}`);
  });
});
