// Meshes, paint and toolpath measures for the painting tests (test/paint.test.ts, the painted plates of
// test/conformance/plates.ts). The meshes are built face by face, so that a test knows which triangles make
// which face, in which order and with which corners: painted triangles are named by index, and a code's
// pieces are placed by the triangle's corners in the mesh's order (docs/PROTOCOL.md, "Paint codes").
import type { FacetPaint } from '../../packages/protocol/src/ops.ts';
import type { BridgeToolpaths } from '../../host/src/bridge.ts';

export type Point = [number, number, number];

/** A mesh under construction: a triangle soup, and the triangles of each named face. */
class SoupBuilder {
  readonly values: number[] = [];
  readonly faces: Record<string, number[]> = {};

  get triangleCount(): number {
    return this.values.length / 9;
  }

  /** One triangle as given (corners in this order), under `name`. */
  triangle(name: string, a: Point, b: Point, c: Point): number {
    const index = this.triangleCount;
    this.values.push(...a, ...b, ...c);
    (this.faces[name] ??= []).push(index);
    return index;
  }

  /** A planar quad (corners in cyclic order) as two triangles facing `outward`: (a, b, c) and (a, c, d). */
  quad(name: string, corners: [Point, Point, Point, Point], outward: Point): void {
    let [a, b, c, d] = corners;
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, outward) < 0) [b, d] = [d, b];
    this.triangle(name, a, b, c);
    this.triangle(name, a, c, d);
  }

  build(): PaintMesh {
    return { positions: new Float32Array(this.values), faces: this.faces };
  }
}

export interface PaintMesh {
  positions: Float32Array;
  /** Triangle indices of each named face, in mesh order. */
  faces: Record<string, number[]>;
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export interface TShapeOptions {
  /** Stem width along X (mm). */
  stem?: number;
  /** Height of the wings' undersides (mm): the overhang. */
  height?: number;
  /** Length of each wing beyond the stem, along X (mm). */
  wing?: number;
  /** Slab thickness (mm). */
  slab?: number;
  /** Depth along Y (mm). */
  depth?: number;
  /** A degenerate triangle (two equal corners, on the stem's bottom) before every other: the STL import drops it. */
  degenerateFirst?: boolean;
}

/**
 * A T on the bed, centred on `center`: a stem `stem` wide and `height` tall, and a slab on top whose two wings
 * overhang by `wing` on either side in X. Closed, every edge shared by two triangles, outward-facing. Faces:
 * bottom, stemLeft, stemRight, leftWing and rightWing (the overhangs' undersides, z = height), leftEnd,
 * rightEnd, top, front, back (and degenerate).
 */
export function tShape(center: [number, number], options: TShapeOptions = {}): PaintMesh & { box(face: string): Box } {
  const { stem = 10, height = 10, wing = 15, slab = 5, depth = 20 } = options;
  const [cx, cy] = center;
  const x0 = cx - stem / 2 - wing, x1 = cx - stem / 2, x2 = cx + stem / 2, x3 = cx + stem / 2 + wing;
  const y0 = cy - depth / 2, y1 = cy + depth / 2;
  const h1 = height, h2 = height + slab;
  const m = new SoupBuilder();
  if (options.degenerateFirst) m.triangle('degenerate', [x1, y0, 0], [x1, y0, 0], [x2, y1, 0]);
  m.quad('bottom', [[x1, y0, 0], [x2, y0, 0], [x2, y1, 0], [x1, y1, 0]], [0, 0, -1]);
  m.quad('stemLeft', [[x1, y0, 0], [x1, y1, 0], [x1, y1, h1], [x1, y0, h1]], [-1, 0, 0]);
  m.quad('stemRight', [[x2, y0, 0], [x2, y1, 0], [x2, y1, h1], [x2, y0, h1]], [1, 0, 0]);
  m.quad('leftWing', [[x0, y0, h1], [x1, y0, h1], [x1, y1, h1], [x0, y1, h1]], [0, 0, -1]);
  m.quad('rightWing', [[x2, y0, h1], [x3, y0, h1], [x3, y1, h1], [x2, y1, h1]], [0, 0, -1]);
  m.quad('leftEnd', [[x0, y0, h1], [x0, y1, h1], [x0, y1, h2], [x0, y0, h2]], [-1, 0, 0]);
  m.quad('rightEnd', [[x3, y0, h1], [x3, y1, h1], [x3, y1, h2], [x3, y0, h2]], [1, 0, 0]);
  for (const [a, b] of [[x0, x1], [x1, x2], [x2, x3]]) m.quad('top', [[a, y0, h2], [b, y0, h2], [b, y1, h2], [a, y1, h2]], [0, 0, 1]);
  for (const [y, side] of [[y0, 'front'], [y1, 'back']] as const) {
    const outward: Point = [0, side === 'front' ? -1 : 1, 0];
    m.quad(side, [[x1, y, 0], [x2, y, 0], [x2, y, h1], [x1, y, h1]], outward);
    for (const [a, b] of [[x0, x1], [x1, x2], [x2, x3]]) m.quad(side, [[a, y, h1], [b, y, h1], [b, y, h2], [a, y, h2]], outward);
  }
  const mesh = m.build();
  return { ...mesh, box: (face: string) => boxOfTriangles(mesh.positions, mesh.faces[face]) };
}

/**
 * A closed cylinder on the bed whose side is two bands of `segments` quads, split at `split` × height: faces
 * bottom, top, lower and upper (side triangles, two per segment, segment i spanning angles
 * [i, i + 1] × 360° / segments from +X towards +Y).
 */
export function bandedCylinder(center: [number, number], radius: number, height: number, segments = 96, split = 0.5): PaintMesh {
  const [cx, cy] = center;
  const m = new SoupBuilder();
  const at = (i: number, z: number): Point => {
    const a = (2 * Math.PI * i) / segments;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a), z];
  };
  const zm = height * split;
  for (let i = 0; i < segments; i++) {
    m.triangle('bottom', [cx, cy, 0], at(i + 1, 0), at(i, 0));
    m.triangle('top', [cx, cy, height], at(i, height), at(i + 1, height));
  }
  for (const [band, z0, z1] of [['lower', 0, zm], ['upper', zm, height]] as const) {
    for (let i = 0; i < segments; i++) m.quad(band, [at(i, z0), at(i + 1, z0), at(i + 1, z1), at(i, z1)], [Math.cos((2 * Math.PI * (i + 0.5)) / segments), Math.sin((2 * Math.PI * (i + 0.5)) / segments), 0]);
  }
  return m.build();
}

/** The side triangles of `band` whose segments lie within [from, to] degrees (from +X towards +Y). */
export function segmentTriangles(mesh: PaintMesh, band: 'lower' | 'upper', segments: number, from: number, to: number): number[] {
  const out: number[] = [];
  const triangles = mesh.faces[band];
  for (let i = 0; i < segments; i++) {
    const a0 = (360 * i) / segments, a1 = (360 * (i + 1)) / segments;
    if (a0 >= from - 1e-9 && a1 <= to + 1e-9) out.push(triangles[2 * i], triangles[2 * i + 1]);
  }
  return out;
}

/** One kind's paint from triangle -> code entries (any order). */
export function facetPaint(entries: Iterable<[number, string]>): FacetPaint {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const ends: number[] = [];
  let codes = '';
  for (const [, code] of sorted) {
    codes += code;
    ends.push(codes.length);
  }
  return { triangles: new Uint32Array(sorted.map(([t]) => t)), codes, ends: new Uint32Array(ends) };
}

/** The same code on every triangle listed. */
export const paintAll = (triangles: Iterable<number>, code: string): FacetPaint => facetPaint([...triangles].map((t): [number, string] => [t, code]));

/** An empty kind: no painted triangle. */
export const noPaint = (): FacetPaint => ({ triangles: new Uint32Array(0), codes: '', ends: new Uint32Array(0) });

/** A triangle's corners, in the mesh's order. */
export function corners(positions: Float32Array, triangle: number): [Point, Point, Point] {
  const p = (c: number): Point => [positions[triangle * 9 + c * 3], positions[triangle * 9 + c * 3 + 1], positions[triangle * 9 + c * 3 + 2]];
  return [p(0), p(1), p(2)];
}

/**
 * The corners of child `child` of a triangle split along `split` edges (1-3) at special corner `corner` (0-2),
 * as docs/PROTOCOL.md "Paint codes" defines them: the corners rotated so that v0 is the special corner, then
 * 1 split: m = mid(v1, v2), children (v0, v1, m), (m, v2, v0);
 * 2 splits: a = mid(v0, v1), b = mid(v0, v2), children (v0, a, b), (a, v1, b), (v1, v2, b);
 * 3 splits: a = mid(v0, v1), b = mid(v1, v2), c = mid(v2, v0), children (v0, a, c), (a, v1, b), (b, v2, c), (a, b, c).
 */
export function childCorners(parent: [Point, Point, Point], split: number, corner: number, child: number): [Point, Point, Point] {
  const v0 = parent[corner], v1 = parent[(corner + 1) % 3], v2 = parent[(corner + 2) % 3];
  if (split === 1) {
    const m = mid(v1, v2);
    return ([[v0, v1, m], [m, v2, v0]] as [Point, Point, Point][])[child];
  }
  if (split === 2) {
    const a = mid(v0, v1), b = mid(v0, v2);
    return ([[v0, a, b], [a, v1, b], [v1, v2, b]] as [Point, Point, Point][])[child];
  }
  const a = mid(v0, v1), b = mid(v1, v2), c = mid(v2, v0);
  return ([[v0, a, c], [a, v1, b], [b, v2, c], [a, b, c]] as [Point, Point, Point][])[child];
}

/** The code of a triangle split along `split` edges at `corner`, with child `child` in state 1 and the others bare. */
export function oneChildCode(split: number, corner: number, child: number): string {
  let code = '';
  for (let i = 0; i <= split; i++) code += i === child ? '4' : '0';
  return code + (split + 4 * corner).toString(16).toUpperCase();
}

// ---------------------------------------------------------------------------
// Toolpath measures
// ---------------------------------------------------------------------------

export interface Box {
  min: [number, number];
  max: [number, number];
}

export function boxOfPoints(points: Iterable<readonly number[]>): Box | null {
  let box: Box | null = null;
  for (const [x, y] of points) {
    if (!box) box = { min: [x, y], max: [x, y] };
    else {
      box.min = [Math.min(box.min[0], x), Math.min(box.min[1], y)];
      box.max = [Math.max(box.max[0], x), Math.max(box.max[1], y)];
    }
  }
  return box;
}

export function boxOfTriangles(positions: Float32Array, triangles: readonly number[]): Box {
  return boxOfPoints(triangles.flatMap((t) => corners(positions, t)))!;
}

/** `inner` lies within `outer` grown by `margin` on every side. */
export const boxWithin = (inner: Box, outer: Box, margin: number) =>
  inner.min[0] >= outer.min[0] - margin && inner.min[1] >= outer.min[1] - margin && inner.max[0] <= outer.max[0] + margin && inner.max[1] <= outer.max[1] + margin;

/** The two boxes overlap (each grown by `margin`). */
export const boxesOverlap = (a: Box, b: Box, margin = 0) =>
  a.min[0] - margin <= b.max[0] + margin && b.min[0] - margin <= a.max[0] + margin && a.min[1] - margin <= b.max[1] + margin && b.min[1] - margin <= a.max[1] + margin;

export const formatBox = (box: Box | null) => (box ? `[${box.min.map((v) => v.toFixed(2))}]-[${box.max.map((v) => v.toFixed(2))}]` : 'none');

/** Every extrusion segment whose role passes `role`, as [x0, y0, z0, x1, y1, z1, layer]. */
export function* segments(toolpaths: BridgeToolpaths, role: (name: string) => boolean): Generator<number[]> {
  const { extrusions, roles } = toolpaths;
  const wanted = roles.map(role);
  for (let layer = 0; layer < toolpaths.layerCount; layer++) {
    for (let s = extrusions.layerStart[layer]; s < extrusions.layerStart[layer + 1]; s++) {
      if (!wanted[extrusions.roleIndex[s]]) continue;
      const p = extrusions.positions.subarray(s * 6, s * 6 + 6);
      yield [p[0], p[1], p[2], p[3], p[4], p[5], layer];
    }
  }
}

export const isSupportRole = (name: string) => /support/i.test(name);

/** The XY box of every support extrusion, or null when there is none. */
export function supportBox(toolpaths: BridgeToolpaths): Box | null {
  return boxOfPoints((function* () {
    for (const s of segments(toolpaths, isSupportRole)) {
      yield [s[0], s[1]];
      yield [s[3], s[4]];
    }
  })());
}

/** Per layer: where its outer wall starts (the seam), as [x, y, z]; layers without an outer wall are left out. */
export function seamPoints(toolpaths: BridgeToolpaths): Point[] {
  const out: Point[] = [];
  let lastLayer = -1;
  for (const s of segments(toolpaths, (name) => name === 'Outer wall')) {
    if (s[6] === lastLayer) continue;
    lastLayer = s[6];
    out.push([s[0], s[1], s[2]]);
  }
  return out;
}

/** The angle (degrees, 0-360, from +X towards +Y) of a point around `center`. */
export function angleAround(center: [number, number], p: readonly number[]): number {
  const a = (Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

/** Per layer with an outer wall: its z, and the largest distance of a wall point from the layer's median radius. */
export function wallRoughness(toolpaths: BridgeToolpaths, center: [number, number]): Array<{ z: number; deviation: number; points: number }> {
  const byLayer = new Map<number, { z: number; radii: number[] }>();
  for (const s of segments(toolpaths, (name) => name === 'Outer wall')) {
    const entry = byLayer.get(s[6]) ?? { z: s[2], radii: [] };
    entry.radii.push(Math.hypot(s[0] - center[0], s[1] - center[1]), Math.hypot(s[3] - center[0], s[4] - center[1]));
    byLayer.set(s[6], entry);
  }
  return [...byLayer.values()].map(({ z, radii }) => {
    const sorted = [...radii].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { z, deviation: Math.max(...radii.map((r) => Math.abs(r - median))), points: radii.length / 2 };
  });
}
