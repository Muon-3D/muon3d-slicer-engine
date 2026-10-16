// Painting (protocol 2.2, capability 'paint.v1'): PlateObject.paint, checked by the protocol package's
// checkFacetPaint, carried by the host, and applied by the engine's painted path (the mesh as sent, each code
// read by Orca's own 3MF string reader into the volume's facets). The protocol and host parts run anywhere; the
// engine part needs the built engine (npm run test:engine runs it on st and mt). The painted goldens and the
// unpainted plates' parity are in test/conformance (conformance.test.ts, plates.ts).
//
// Support toolpaths are measured above the first layer: on the first, Orca widens grid support by
// raft_first_layer_expansion (2 mm in the M1 presets) and gives tree support a brim (tree_support_brim_width,
// 3 mm). Above it, Orca's support reaches up to about 2.7 mm past the overhang it holds up (the contact area's
// expansion and the base pattern's grid), hence SUPPORT_MARGIN.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { ErrorCode, type Response } from '../packages/protocol/src/envelope.ts';
import type { FacetPaint, ObjectPaint, SliceParams } from '../packages/protocol/src/ops.ts';
import { PAINT_MAX_STATE, checkFacetPaint, checkObjectPaint, hasPaintKinds, paintCodeMaxState } from '../packages/protocol/src/paint.ts';
import { EngineJobError, meshInputs, runSlice, type EngineObject, type OrcaEngineModule, type SliceOutput } from '../host/src/bridge.ts';
import { createHost } from '../host/src/core.ts';
import { sliceJob as hostSliceJob } from '../host/src/ops.ts';
import { cube, engineSkip, m1Presets, sliceJob, startEngine, type Presets } from './fixtures.ts';
import {
  angleAround,
  bandedCylinder,
  boxOfPoints,
  boxWithin,
  boxesOverlap,
  childCorners,
  corners,
  facetPaint,
  formatBox,
  isSupportRole,
  noPaint,
  oneChildCode,
  paintAll,
  seamPoints,
  segmentTriangles,
  segments,
  tShape,
  wallRoughness,
  type Box,
  type Point,
} from './helpers/paint.ts';

const SUPPORT_MARGIN = 3;

// ---------------------------------------------------------------------------
// 1. checkFacetPaint (packages/protocol)
// ---------------------------------------------------------------------------

describe('checkFacetPaint and the paint codes', () => {
  test('the leaf table and the worked examples are codes, with their highest state', () => {
    const leaves: Array<[string, number]> = [['0', 0], ['4', 1], ['8', 2], ['0C', 3], ['1C', 4], ['EC', 17], ['0FC', 18], ['EFC', 32]];
    for (const [code, state] of leaves) assert.equal(paintCodeMaxState(code), state, code);
    // Split once at corner 0, child 0 enforced; split twice; split three ways with child 3 split once at corner 1.
    for (const code of ['401', '4002', '0004053']) assert.equal(paintCodeMaxState(code), 1, code);
    // Every split count at every special corner.
    for (let split = 1; split <= 3; split++) for (let corner = 0; corner <= 2; corner++) assert.equal(paintCodeMaxState(oneChildCode(split, corner, 0)), 1);
    // A code within a longer text.
    assert.equal(paintCodeMaxState('xx4002yy', 2, 6), 1);
  });

  test('lowercase, other characters, trailing and truncated codes are refused', () => {
    for (const code of ['', '0c', 'efc', '4g', ' 4', '4 ', '44', '0401', '01', '1', '002', '0003', 'C', 'FC', 'D', '00D'])
      assert.equal(paintCodeMaxState(code), -1, JSON.stringify(code));
  });

  test('a well-formed layer passes; each broken rule is named', () => {
    const ok = facetPaint([[0, '4'], [3, '401'], [11, 'EFC']]);
    assert.equal(checkFacetPaint(ok, 12), null);
    assert.equal(checkFacetPaint(noPaint(), 12), null, 'an empty layer');
    const cases: Array<[string, FacetPaint, RegExp]> = [
      ['lengths', { triangles: new Uint32Array([1, 2]), codes: '44', ends: new Uint32Array([1]) }, /lists 2 triangles and 1 code ends/],
      ['not ascending', { triangles: new Uint32Array([5, 2]), codes: '44', ends: new Uint32Array([1, 2]) }, /lists triangle 2 after triangle 5/],
      ['a repeat', { triangles: new Uint32Array([2, 2]), codes: '44', ends: new Uint32Array([1, 2]) }, /lists triangle 2 after triangle 2/],
      ['range', { triangles: new Uint32Array([12]), codes: '4', ends: new Uint32Array([1]) }, /of triangle 12 is past the mesh, which has 12 triangles/],
      ['an empty code', { triangles: new Uint32Array([1, 2]), codes: '4', ends: new Uint32Array([1, 1]) }, /of triangle 2 has no code/],
      ['ends past the codes', { triangles: new Uint32Array([1]), codes: '4', ends: new Uint32Array([2]) }, /of triangle 1 has no code/],
      ['lowercase', facetPaint([[1, '0c']]), /of triangle 1 is not a valid code/],
      ['trailing', facetPaint([[1, '44']]), /of triangle 1 is not a valid code/],
      ['truncated', facetPaint([[1, '01']]), /of triangle 1 is not a valid code/],
      ['text after the last code', { triangles: new Uint32Array([1]), codes: '48', ends: new Uint32Array([1]) }, /text after its last code \(1 characters\)/],
      ['arrays', { triangles: [1] as unknown as Uint32Array, codes: '4', ends: new Uint32Array([1]) }, /"triangles" must be a Uint32Array/],
      ['codes', { triangles: new Uint32Array([1]), codes: 4 as unknown as string, ends: new Uint32Array([1]) }, /"codes" must be text/],
    ];
    for (const [name, paint, message] of cases) {
      const problem = checkFacetPaint(paint, 12);
      assert.ok(problem, name);
      assert.match(problem.message, message, name);
    }
  });

  test("states above a kind's highest are refused: 3 on supports and seam, 2 on fuzzy skin, 33 on filaments", () => {
    assert.deepEqual(PAINT_MAX_STATE, { supports: 2, seam: 2, fuzzySkin: 1, filaments: 32 });
    const at = (code: string) => facetPaint([[4, code]]);
    const over: Array<[keyof ObjectPaint, string, number]> = [['supports', '0C', 3], ['seam', '0C', 3], ['fuzzySkin', '8', 2], ['filaments', 'FFC', 33]];
    for (const [kind, code, state] of over) {
      const problem = checkObjectPaint({ [kind]: at(code) }, 12, 'Cube.stl');
      assert.ok(problem, kind);
      assert.equal(problem.kind, kind);
      assert.match(problem.message, new RegExp(`of triangle 4 has state ${state}; this kind's states go up to ${PAINT_MAX_STATE[kind]}`));
    }
    assert.equal(checkObjectPaint({ supports: at('8'), seam: at('8'), fuzzySkin: at('4'), filaments: at('EFC') }, 12, 'Cube.stl'), null);
  });

  test('checkObjectPaint names the object and the kind; kinds it does not know are ignored', () => {
    const problem = checkObjectPaint({ supports: facetPaint([[0, '4']]), seam: facetPaint([[1204, '4X']]) }, 2000, '3DBenchy');
    assert.deepEqual(problem, { kind: 'seam', message: '3DBenchy: the seam paint of triangle 1204 is not a valid code.', triangle: 1204 });
    assert.equal(checkObjectPaint({ colour: 'red' } as unknown as ObjectPaint, 12, 'Cube.stl'), null);
    assert.match(checkObjectPaint([] as unknown as ObjectPaint, 12, 'Cube.stl')!.message, /^Cube\.stl: its paint must be/);
    assert.equal(hasPaintKinds(undefined), false);
    assert.equal(hasPaintKinds({}), false);
    assert.equal(hasPaintKinds({ seam: noPaint() }), true, 'an empty kind still takes the painted path');
  });
});

// ---------------------------------------------------------------------------
// 2. Bad paint fails cleanly (the host; the engine's own guard below)
// ---------------------------------------------------------------------------

const cubeMesh = () => ({ positions: cube([100, 90]) });

/** Paint the host must refuse, with the kind its message names. */
const BAD_PAINT: Array<{ name: string; paint: ObjectPaint; message: string }> = [
  { name: 'unsorted', paint: { supports: { triangles: new Uint32Array([5, 2]), codes: '44', ends: new Uint32Array([1, 2]) } }, message: 'Cube.stl: the support paint lists triangle 2 after triangle 5 (they must be strictly ascending).' },
  { name: 'out of range', paint: { seam: facetPaint([[12, '4']]) }, message: 'Cube.stl: the seam paint of triangle 12 is past the mesh, which has 12 triangles.' },
  { name: 'bad hex', paint: { seam: facetPaint([[3, '4G']]) }, message: 'Cube.stl: the seam paint of triangle 3 is not a valid code.' },
  { name: 'lowercase', paint: { fuzzySkin: facetPaint([[3, '0c']]) }, message: 'Cube.stl: the fuzzy skin paint of triangle 3 is not a valid code.' },
  { name: 'state 3 on supports', paint: { supports: facetPaint([[3, '0C']]) }, message: "Cube.stl: the support paint of triangle 3 has state 3; this kind's states go up to 2." },
  { name: 'state 2 on fuzzy skin', paint: { fuzzySkin: facetPaint([[3, '8']]) }, message: "Cube.stl: the fuzzy skin paint of triangle 3 has state 2; this kind's states go up to 1." },
  { name: 'state 33 on filaments', paint: { filaments: facetPaint([[3, 'FFC']]) }, message: "Cube.stl: the filament paint of triangle 3 has state 33; this kind's states go up to 32." },
  { name: 'truncated', paint: { supports: facetPaint([[0, '4'], [3, '402']]) }, message: 'Cube.stl: the support paint of triangle 3 is not a valid code.' },
];

describe('bad paint fails cleanly', () => {
  test('the host refuses it with BadRequest naming the object and the kind, and never loads the engine', async () => {
    const presets = await m1Presets();
    let loads = 0;
    const answers = new Map<number, (r: Response) => void>();
    const host = createHost({
      base: 'file:///nowhere/',
      environment: { kind: 'node' },
      readManifest: async () => null,
      loadEngine: async () => {
        loads++;
        throw new Error('this test never loads the engine');
      },
      send: (message) => {
        if (message.kind === 'result' || message.kind === 'error') answers.get(message.id)?.(message);
      },
    });
    let id = 0;
    for (const { name, paint, message } of BAD_PAINT) {
      const answer = new Promise<Response>((resolve) => answers.set(++id, resolve));
      const params: SliceParams = { configs: presets, objects: [{ name: 'Cube.stl', mesh: cubeMesh(), paint }] };
      host.receive({ v: 2, id, op: 'slice', params });
      const response = await answer;
      assert.equal(response.kind, 'error', name);
      if (response.kind !== 'error') continue;
      assert.equal(response.error.code, ErrorCode.BadRequest, name);
      assert.equal(response.error.message, message, name);
      assert.deepEqual(response.error.objects, ['Cube.stl'], name);
    }
    assert.equal(loads, 0, 'nothing was loaded, so nothing was sliced');
    assert.deepEqual(host.state(), { state: 'idle' });
  });

  test("the host passes paint on as it came, triangle i being an indexed mesh's i-th index triple", () => {
    const presets = { machine: {}, process: {}, filaments: [{}] };
    const supports = facetPaint([[1, '4']]);
    const job = hostSliceJob({
      configs: presets,
      objects: [
        { name: 'A', mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) }, paint: { supports } },
        { name: 'B', mesh: cubeMesh(), paint: {} },
        { name: 'C', mesh: cubeMesh(), paint: { seam: noPaint(), colour: 1 } as unknown as ObjectPaint },
      ],
    });
    assert.deepEqual(job.objects[0].paint, { supports });
    assert.equal(job.objects[1].paint, undefined, 'no kind: the object loads as before');
    assert.deepEqual(job.objects[2].paint, { seam: noPaint() }, 'an empty kind is kept; an unknown key is not');
    assert.throws(() => hostSliceJob({ configs: presets, objects: [{ name: 'A', mesh: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }, paint: { supports: facetPaint([[1, '4']]) } }] }), /past the mesh, which has 1 triangles/);
    const inputs = meshInputs(job.objects);
    assert.deepEqual(inputs.map((o) => 'paint' in o), [true, false, true]);
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Run {
  output: SliceOutput;
  progress: number[];
}

/** Support extrusions above the first layer: their XY box and the centre of their length. */
function supportAboveFirstLayer(output: SliceOutput): { box: Box | null; centre: [number, number] | null } {
  const points: number[][] = [];
  let length = 0;
  let cx = 0;
  let cy = 0;
  for (const s of segments(output.toolpaths!, isSupportRole)) {
    if (s[6] === 0) continue;
    points.push([s[0], s[1]], [s[3], s[4]]);
    const l = Math.hypot(s[3] - s[0], s[4] - s[1]);
    length += l;
    cx += ((s[0] + s[3]) / 2) * l;
    cy += ((s[1] + s[4]) / 2) * l;
  }
  return { box: boxOfPoints(points), centre: length > 0 ? [cx / length, cy / length] : null };
}

const hasSupport = (output: SliceOutput) =>
  /^;TYPE:Support/m.test(new TextDecoder().decode(output.gcode)) || output.toolpaths!.roles.some(isSupportRole);

const centroid = (t: [Point, Point, Point]): [number, number] => [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];

describe('the painted path', { skip: engineSkip }, () => {
  let engine: OrcaEngineModule;
  let presets: Presets;
  before(async () => {
    engine = (await startEngine()).engine;
    presets = await m1Presets();
  });

  function slice(process: Record<string, string>, objects: EngineObject[]): Run {
    const progress: number[] = [];
    const job = sliceJob({ ...presets, process: { ...presets.process, ...process } }, objects);
    return { output: runSlice(engine, job, (p) => progress.push(p)), progress };
  }

  const support = (type: string) => ({ enable_support: '1', support_type: type });

  test('2. the engine refuses bad paint itself, with the same words, before any mesh loads', () => {
    for (const { name, paint, message } of BAD_PAINT) {
      const progress: number[] = [];
      try {
        runSlice(engine, sliceJob(presets, [{ name: 'Cube.stl', positions: cube([100, 90]), paint }]), (p) => progress.push(p));
        assert.fail(`${name}: sliced`);
      } catch (err) {
        if (!(err instanceof EngineJobError)) throw err;
        assert.equal(err.error.code, ErrorCode.BadRequest, name);
        assert.equal(err.error.message, message, name);
        assert.deepEqual(err.error.objects, ['Cube.stl'], name);
      }
      assert.ok(Math.max(0, ...progress) <= 2, `${name}: stopped while loading the objects (${progress.join(', ')})`);
    }
    // Shapes the host never passes on, straight to the engine module.
    const shapes: unknown[] = [[], 'seam', { seam: { triangles: [1], codes: '4', ends: new Uint32Array([1]) } }, { seam: { triangles: new Uint32Array([1]), codes: 4, ends: new Uint32Array([1]) } }];
    for (const paint of shapes) {
      const json = (config: object) => JSON.stringify(config);
      const objects = [{ name: 'Cube.stl', positions: cube([100, 90]), paint: paint as ObjectPaint }];
      const result = engine.slice(json(presets.machine), json(presets.process), presets.filaments.map(json), objects, false, () => undefined, () => undefined, 0, true);
      assert.ok('error' in result, `sliced with paint ${JSON.stringify(paint)}`);
      assert.equal(result.error.code, ErrorCode.BadRequest);
      assert.match(result.error.message, /^Cube\.stl: (its paint|the seam paint) must be \{/);
    }
  });

  test('3. the order is kept: a degenerate triangle before the painted ones moves nothing', () => {
    const t = tShape([100, 90], { degenerateFirst: true });
    assert.deepEqual(t.faces.degenerate, [0]);
    // The STL import drops the degenerate triangle; triangle i would then be the client's i + 1, and the paint on
    // the left overhang's two triangles would land on its second and the right overhang's first.
    const { output } = slice(support('normal(manual)'), [{ name: 'T.stl', positions: t.positions, paint: { supports: paintAll(t.faces.leftWing, '4') } }]);
    const { box } = supportAboveFirstLayer(output);
    assert.ok(box, 'support under the painted overhang');
    assert.ok(boxWithin(box, t.box('leftWing'), SUPPORT_MARGIN), `support ${formatBox(box)} under the left overhang ${formatBox(t.box('leftWing'))}`);
    assert.ok(!boxesOverlap(box, t.box('rightWing')), `no support under the right overhang ${formatBox(t.box('rightWing'))}`);
  });

  for (const type of ['tree(auto)', 'normal(auto)']) {
    test(`4. blockers on the whole underside remove ${type} support`, () => {
      const t = tShape([100, 90]);
      const bare = slice(support(type), [{ name: 'T.stl', positions: t.positions }]);
      assert.ok(hasSupport(bare.output), 'support without paint');
      const blocked = slice(support(type), [{ name: 'T.stl', positions: t.positions, paint: { supports: paintAll([...t.faces.leftWing, ...t.faces.rightWing], '8') } }]);
      assert.doesNotMatch(new TextDecoder().decode(blocked.output.gcode), /^;TYPE:Support/m);
      assert.deepEqual(blocked.output.toolpaths!.roles.filter(isSupportRole), []);
    });
  }

  for (const type of ['tree(manual)', 'normal(manual)']) {
    test(`5. ${type}: support only under the enforced half of the underside`, () => {
      const t = tShape([100, 90]);
      assert.ok(!hasSupport(slice(support(type), [{ name: 'T.stl', positions: t.positions }]).output), 'no support without enforcers');
      const { output } = slice(support(type), [{ name: 'T.stl', positions: t.positions, paint: { supports: paintAll(t.faces.leftWing, '4') } }]);
      const { box } = supportAboveFirstLayer(output);
      assert.ok(box, 'support under the enforced half');
      assert.ok(boxWithin(box, t.box('leftWing'), SUPPORT_MARGIN), `support ${formatBox(box)} within the enforced half ${formatBox(t.box('leftWing'))}`);
      assert.ok(!boxesOverlap(box, t.box('rightWing')), `none under the other half ${formatBox(t.box('rightWing'))}`);
    });
  }

  test("6. support off: an enforcer gives no support, and Orca's warning", () => {
    const t = tShape([100, 90]);
    const { output } = slice({ enable_support: '0' }, [{ name: 'T.stl', positions: t.positions, paint: { supports: paintAll(t.faces.leftWing, '4') } }]);
    assert.ok(!hasSupport(output));
    assert.ok(
      output.warnings.some((w) => w.kind === 'validation' && /Support enforcers are used but support is not enabled/.test(w.message)),
      JSON.stringify(output.warnings),
    );
  });

  test('7. split codes: each split (1-3 edges) at each special corner puts the enforced child where the codes say', () => {
    // A large overhang, so that the children of one triangle are far apart; its first triangle is the one split.
    const t = tShape([100, 90], { wing: 30, depth: 30 });
    const triangle = t.faces.leftWing[0];
    const parent = corners(t.positions, triangle);
    for (let split = 1; split <= 3; split++) {
      for (let corner = 0; corner <= 2; corner++) {
        const child = (split + corner) % (split + 1);
        const code = oneChildCode(split, corner, child);
        const { output } = slice(support('normal(manual)'), [{ name: 'T.stl', positions: t.positions, paint: { supports: facetPaint([[triangle, code]]) } }]);
        const { box, centre } = supportAboveFirstLayer(output);
        const what = `${code} (${split} split${split > 1 ? 's' : ''} at corner ${corner}, child ${child})`;
        assert.ok(box && centre, `${what}: support`);
        const pieces = Array.from({ length: split + 1 }, (_, i) => childCorners(parent, split, corner, i));
        const target = boxOfPoints(pieces[child])!;
        assert.ok(boxWithin(box, target, SUPPORT_MARGIN), `${what}: support ${formatBox(box)} under the child ${formatBox(target)}`);
        const distances = pieces.map((piece) => Math.hypot(centroid(piece)[0] - centre[0], centroid(piece)[1] - centre[1]));
        const nearest = distances.indexOf(Math.min(...distances));
        assert.equal(nearest, child, `${what}: the support's centre ${centre.map((v) => v.toFixed(2))} is nearest child ${nearest}`);
      }
    }
  });

  describe('8. seam', () => {
    const C: [number, number] = [100, 90];
    const SEGMENTS = 96;
    const RADIUS = 15;
    const cylinder = bandedCylinder(C, RADIUS, 10, SEGMENTS);
    const strip = (from: number, to: number) => [...segmentTriangles(cylinder, 'lower', SEGMENTS, from, to), ...segmentTriangles(cylinder, 'upper', SEGMENTS, from, to)];
    /** The XY distance from a point to the cylinder's surface between two angles. */
    const distanceToStrip = (p: Point, from: number, to: number) => {
      const angle = angleAround(C, p);
      const nearest = angle >= from && angle <= to ? angle : Math.abs(angle - from) < Math.abs(angle - to) ? from : to;
      const a = (nearest * Math.PI) / 180;
      return Math.hypot(p[0] - (C[0] + RADIUS * Math.cos(a)), p[1] - (C[1] + RADIUS * Math.sin(a)));
    };
    // A strip at -X: no seam position puts the seam there on its own ('back' and 'aligned_back' put it at +Y).
    const [FROM, TO] = [176.25, 183.75];
    const seams = (process: Record<string, string>, paint?: ObjectPaint) => {
      const { output } = slice(process, [{ name: 'Cylinder.stl', positions: cylinder.positions, ...(paint ? { paint } : {}) }]);
      return { points: seamPoints(output.toolpaths!), lineWidth: output.toolpaths!.lineWidth! };
    };

    for (const position of ['nearest', 'aligned', 'aligned_back', 'back', 'random']) {
      test(`${position}: every layer's seam on the enforced strip`, () => {
        const bare = seams({ seam_position: position });
        assert.ok(bare.points.some((p) => distanceToStrip(p, FROM, TO) > 1), 'without paint the seam is elsewhere on some layer');
        const { points, lineWidth } = seams({ seam_position: position }, { seam: paintAll(strip(FROM, TO), '4') });
        assert.equal(points.length, 50);
        // Orca marks a wall point enforced within one line width of the paint (SeamPlacer is_enforced); a random
        // seam may sit one oversampling step (0.2 mm, enforcer_oversampling_distance) beyond that.
        const limit = lineWidth + 0.2;
        for (const p of points) assert.ok(distanceToStrip(p, FROM, TO) <= limit, `seam at ${angleAround(C, p).toFixed(2)}° z ${p[2].toFixed(2)}: ${distanceToStrip(p, FROM, TO).toFixed(3)} mm from the strip`);
      });
    }

    test('aligned: a blocker strip where the seam was moves it off the strip', () => {
      const bare = seams({ seam_position: 'aligned' });
      const angles = bare.points.map((p) => angleAround(C, p));
      const where = angles[Math.floor(angles.length / 2)];
      // The segments within 15° of it, either side.
      const step = 360 / SEGMENTS;
      const from = Math.floor((where - 15) / step) * step;
      const to = Math.ceil((where + 15) / step) * step;
      assert.ok(angles.every((a) => a >= from && a <= to), `the unpainted seam ${where.toFixed(2)}° lies within the strip ${from}-${to}°`);
      const { points } = seams({ seam_position: 'aligned' }, { seam: paintAll(strip(from, to), '8') });
      assert.equal(points.length, 50);
      for (const p of points) {
        const a = angleAround(C, p);
        assert.ok(a < from || a > to, `seam at ${a.toFixed(2)}° z ${p[2].toFixed(2)} is on the blocked strip ${from}-${to}°`);
      }
    });
  });

  test("9. fuzzy skin 'Painted areas only' (none): rough walls only on the painted upper half", () => {
    const C: [number, number] = [100, 90];
    const cylinder = bandedCylinder(C, 15, 10, 96);
    const paint = { fuzzySkin: paintAll(cylinder.faces.upper, '4') };
    const run = (fuzzy: string) => wallRoughness(slice({ fuzzy_skin: fuzzy }, [{ name: 'Cylinder.stl', positions: cylinder.positions, paint }]).output.toolpaths!, C);
    const painted = run('none');
    // fuzzy_skin_thickness is 0.3 mm: a fuzzy wall strays well over 0.1 mm from its median radius, a smooth one by
    // a few hundredths at most (the 96-gon's vertices).
    for (const { z, deviation } of painted) {
      if (z < 5 - 0.5) assert.ok(deviation < 0.05, `smooth at z ${z.toFixed(2)} (${deviation.toFixed(3)} mm)`);
      if (z > 5 + 0.5) assert.ok(deviation > 0.1, `fuzzy at z ${z.toFixed(2)} (${deviation.toFixed(3)} mm)`);
    }
    for (const { z, deviation } of run('disabled_fuzzy')) assert.ok(deviation < 0.05, `fuzzy skin off: smooth at z ${z.toFixed(2)} (${deviation.toFixed(3)} mm)`);
  });

  test('11. filament paint with one filament: the same G-code as no paint', () => {
    const t = tShape([100, 90]);
    const text = (run: Run) => new TextDecoder().decode(run.output.gcode).replace(/^; generated by .*$/m, '');
    const plain = slice({}, [{ name: 'T.stl', positions: t.positions }]);
    const filaments = facetPaint([...t.faces.leftWing.map((i): [number, string] => [i, '8']), ...t.faces.top.map((i): [number, string] => [i, '0C']), [t.faces.rightWing[0], '0FC']]);
    const painted = slice({}, [{ name: 'T.stl', positions: t.positions, paint: { filaments } }]);
    assert.equal(text(painted), text(plain));
    // And the painted path with no paint at all gives the STL path's G-code for this mesh.
    assert.equal(text(slice({}, [{ name: 'T.stl', positions: t.positions, paint: { filaments: noPaint() } }])), text(plain));
  });

  test('corners weld by value (-0 is +0), and a corner that is not a finite number fails the job', () => {
    const t = tShape([100, 90]);
    const text = (run: Run) => new TextDecoder().decode(run.output.gcode).replace(/^; generated by .*$/m, '');
    const paint = { supports: noPaint() };
    const plain = slice({}, [{ name: 'T.stl', positions: t.positions, paint }]);
    // Every other corner on the bed as z = -0: welded with the +0 corners all the same, so nothing changes.
    const negativeZero = new Float32Array(t.positions);
    for (let i = 2; i < negativeZero.length; i += 6) if (negativeZero[i] === 0) negativeZero[i] = -0;
    assert.ok([...negativeZero].some((v) => Object.is(v, -0)));
    assert.equal(text(slice({}, [{ name: 'T.stl', positions: negativeZero, paint }])), text(plain));
    const bad = new Float32Array(t.positions);
    bad[5] = Number.NaN;
    try {
      slice({}, [{ name: 'T.stl', positions: bad, paint }]);
      assert.fail('sliced a corner that is not a number');
    } catch (err) {
      if (!(err instanceof EngineJobError)) throw err;
      assert.ok(err.error.code < 0, `Orca's code for a mesh it cannot read (${err.error.code})`);
      assert.match(err.error.message, /^The object "T\.stl" has a coordinate that is not a finite number, in triangle 0/);
    }
  });
});
