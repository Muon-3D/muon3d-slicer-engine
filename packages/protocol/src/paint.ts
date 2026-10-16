// SPDX-License-Identifier: Apache-2.0
// Painting (protocol 2.2, capability 'paint.v1'): the structural check of PlateObject.paint that the host runs
// before a slice and a client can run before it sends one. docs/PROTOCOL.md, "Paint codes", describes the codes.
//
// A code is the text a 3MF paint attribute holds for one triangle: uppercase hexadecimal digits, read from the
// last one. The last digit is the head h: h & 3 is the number of edges split (0 = a leaf), h >> 2 is x. A leaf
// with x <= 2 has state x; with x = 3 the state continues to the left: a digit e gives state e + 3 when e < 15,
// and e = 15 is followed by a digit f giving state f + 18. A split node (1-3 edges) has x as its special corner
// (0-2) and its 2-4 children's codes to the left of its head, the last child nearest the head.
import type { FacetPaint, ObjectPaint } from './ops.ts';

/** The kinds of painting, in the order a host reports problems. */
export const PAINT_KINDS: readonly (keyof ObjectPaint)[] = ['supports', 'seam', 'fuzzySkin', 'filaments'];

/** The highest state each kind's codes may hold: enforce 1 and block 2; fuzzy skin 1; filaments 1-32. */
export const PAINT_MAX_STATE: Readonly<Record<keyof ObjectPaint, number>> = { supports: 2, seam: 2, fuzzySkin: 1, filaments: 32 };

/** Each kind as a message names it: "the support paint of triangle 4 ...". */
const KIND_WORDS: Readonly<Record<keyof ObjectPaint, string>> = {
  supports: 'support paint',
  seam: 'seam paint',
  fuzzySkin: 'fuzzy skin paint',
  filaments: 'filament paint',
};

/** What checkFacetPaint found wrong: the end of a sentence about one kind's paint, and the triangle concerned. */
export interface FacetPaintProblem {
  /** E.g. "of triangle 1204 is not a valid code" (follows "the seam paint"). */
  message: string;
  /** The mesh triangle the problem is on, when it is on one. */
  triangle?: number;
}

/** A kind's problem on a named object: the kind, and the sentence a BadRequest carries. */
export interface ObjectPaintProblem {
  kind: keyof ObjectPaint;
  /** E.g. 'Cube.stl: the seam paint of triangle 1204 is not a valid code.' */
  message: string;
  triangle?: number;
}

/** The value of one uppercase hexadecimal digit (char code), or -1. */
function digit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return -1;
}

/**
 * The highest state in a code (`code.slice(start, end)`), or -1 when it is not exactly one tree of uppercase
 * hexadecimal digits: a digit outside 0-9 A-F (lowercase included), a split node whose special corner is 3, a
 * tree that ends before its last child (truncated), or digits left over to the left of the tree (trailing).
 */
export function paintCodeMaxState(code: string, start = 0, end = code.length): number {
  let pos = end;
  let open = 1; // nodes still to read
  let max = 0;
  const next = (): number => (pos > start ? digit(code.charCodeAt(--pos)) : -1);
  while (open > 0) {
    const head = next();
    if (head < 0) return -1;
    open--;
    const split = head & 3;
    const x = head >> 2;
    if (split === 0) {
      let state = x;
      if (x === 3) {
        const e = next();
        if (e < 0) return -1;
        if (e < 15) state = e + 3;
        else {
          const f = next();
          if (f < 0) return -1;
          state = f + 18;
        }
      }
      if (state > max) max = state;
    } else {
      if (x > 2) return -1;
      open += split + 1;
    }
  }
  return pos === start ? max : -1;
}

/**
 * Checks one kind of paint against the mesh it is for (`triangleCount` triangles): the three fields and their
 * types, as many ends as triangles, triangles strictly ascending and on the mesh, ends ascending and the last at
 * the end of `codes`, and each code exactly one tree of uppercase hexadecimal digits with no state above
 * `maxState` (PAINT_MAX_STATE of its kind). Null when it is well formed.
 */
export function checkFacetPaint(paint: FacetPaint, triangleCount: number, maxState = 32): FacetPaintProblem | null {
  const value = paint as unknown as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { message: 'must be { triangles, codes, ends }' };
  const { triangles, codes, ends } = value;
  if (!(triangles instanceof Uint32Array)) return { message: '"triangles" must be a Uint32Array' };
  if (typeof codes !== 'string') return { message: '"codes" must be text' };
  if (!(ends instanceof Uint32Array)) return { message: '"ends" must be a Uint32Array' };
  if (ends.length !== triangles.length) return { message: `lists ${triangles.length} triangles and ${ends.length} code ends` };
  let previous = -1;
  let from = 0;
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i];
    if (triangle <= previous) return { message: `lists triangle ${triangle} after triangle ${previous} (they must be strictly ascending)`, triangle };
    if (triangle >= triangleCount) return { message: `of triangle ${triangle} is past the mesh, which has ${triangleCount} triangles`, triangle };
    const to = ends[i];
    if (to <= from || to > codes.length) return { message: `of triangle ${triangle} has no code (its end is ${to}, after ${from}; the codes are ${codes.length} long)`, triangle };
    const state = paintCodeMaxState(codes, from, to);
    if (state < 0) return { message: `of triangle ${triangle} is not a valid code`, triangle };
    if (state > maxState) return { message: `of triangle ${triangle} has state ${state}; this kind's states go up to ${maxState}`, triangle };
    previous = triangle;
    from = to;
  }
  if (from !== codes.length) return { message: `has text after its last code (${codes.length - from} characters)` };
  return null;
}

/**
 * Checks PlateObject.paint for an object named `name` whose mesh has `triangleCount` triangles: it must be an
 * object, and each kind it holds must pass checkFacetPaint with that kind's highest state. Keys that are not a
 * kind are ignored (a later protocol may add kinds). Null when it is well formed.
 */
export function checkObjectPaint(paint: ObjectPaint, triangleCount: number, name: string): ObjectPaintProblem | null {
  const value = paint as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: PAINT_KINDS[0], message: `${name}: its paint must be { supports?, seam?, fuzzySkin?, filaments? }.` };
  }
  for (const kind of PAINT_KINDS) {
    const facets = paint[kind];
    if (facets === undefined) continue;
    const problem = checkFacetPaint(facets, triangleCount, PAINT_MAX_STATE[kind]);
    if (problem) return { kind, message: `${name}: the ${KIND_WORDS[kind]} ${problem.message}.`, ...(problem.triangle !== undefined ? { triangle: problem.triangle } : {}) };
  }
  return null;
}

/** True when `paint` holds at least one kind (even an empty one): the object then takes the painted path. */
export function hasPaintKinds(paint: ObjectPaint | undefined): boolean {
  return paint !== undefined && paint !== null && PAINT_KINDS.some((kind) => paint[kind] !== undefined);
}
