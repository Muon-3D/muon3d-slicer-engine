// Test helper. Provenance: copied on 2026-09-27 from the Muon3D Slicer app, where it is the preview's
// G-code parser (web/src/gcode/parse.ts). It is Muon 3D Technologies' own code; this copy is part of
// the engine repository and licensed like it (AGPL-3.0-only). The engine tests read every G-code the
// engine writes back with it and compare the result with the engine's own toolpaths. Only the imports
// were changed.
//
// G-code toolpath parser for the preview. Pure (no DOM, no three.js), so it runs in a Web Worker
// in the browser and under plain Node in tests.
//
// It scans the raw bytes instead of decoded text: one pass over each line reads the command and
// its fields in place, without per-line strings, split() or regexes. That keeps a 5 MB Orca file
// well under a second.
//
// Semantics follow OrcaSlicer's own GCodeProcessor where it matters for drawing:
//   * G90/G91 switch XYZ between absolute and relative; M82/M83 do the same for E, and E is also
//     relative whenever G91 is active (Klipper and Orca agree on this).
//   * G92 re-labels the current position (an origin shift), it never moves the head; G92 with
//     no axes zeroes all of them. G28 homes the named axes (or all) to 0.
//   * Where the head starts, and where "home" physically is, depends on the printer. So an axis
//     counts as unknown until an absolute move sets it (and again after G28), and moves that
//     start from an unknown position are not drawn: no stray travel from a made-up origin.
//   * G2/G3 arcs (I/J centre offsets or R radius) are flattened into short chords.
//   * An extrusion is a move of X, Y or Z with a positive E delta; every other move of the head
//     is a travel. E-only moves (retract/unretract) draw nothing.
//   * ';TYPE:<role>' sets the feature role. ';LAYER_CHANGE' starts a layer whose height comes
//     from the following ';Z:' (or its first extrusion). Anything before the first marker (the
//     purge line in the start G-code) belongs to the first layer. Files without markers are
//     split into layers wherever an extrusion rises above the current layer.
//   * Every extrusion is drawn as wide and as tall as GCodeProcessor::process_G1 makes it, which is
//     what Orca's preview draws. ';HEIGHT:<mm>' sets the bead height of the extrusions that follow
//     (Orca writes one per layer, and others for bridges and overhangs, which it prints taller);
//     before any, the height is the last rise of an extrusion over the previous one. ';WIDTH:<mm>'
//     sets the line width; extrusions before any width tag (the purge line of the start G-code)
//     get the width GCodeProcessor derives from the extruded volume. Widths are capped at
//     max(2 mm, 4 × height), as Orca does.
//   * For Bambu Lab printers Orca writes its other tag set instead (GCodeProcessor::Reserved_Tags,
//     chosen when printer_model starts with "Bambu Lab"): '; FEATURE: <role>', '; CHANGE_LAYER',
//     '; Z_HEIGHT: <z>', '; LAYER_HEIGHT: <mm>' and '; LINE_WIDTH: <mm>'. They mean exactly the
//     same. Only these exact spellings are accepted, so a stray '; Z: …' comment in custom G-code
//     is not a layer tag.
//
// parseGcodeWithExtras also reads, per extrusion, what the in-browser engine hands over with its
// toolpaths (ToolpathExtras), so the preview offers the same "Colour by" modes for G-code sliced
// on the server:
//   * Speed: the commanded feed rate (F, modal, mm/min → mm/s), as GCodeProcessor records it.
//   * Fan: M106 S<0–255> sets the part cooling fan (no P, or P1 as on Bambu Lab printers; other
//     fans are ignored), without S full speed; M107 turns it off (process_M106/process_M107).
//   * Temperature: M104/M109 S (M109 R) of the extruder.
//   * Time: each move's length over its feed rate (E-only moves: the filament moved; G4 dwells
//     count too). That shape is then pinned to Orca's own estimate: every 'M73 P<p>' (p % of the
//     estimated time has passed) and every drop of 'M73 R<min>' (the remaining whole minutes, which
//     GCodeProcessor writes as they tick over) marks a point in time, and the footer's
//     '; estimated printing time (normal mode) = 1h 2m 3s' gives the total. Between those points
//     the times follow the moves; without any, they are the raw sums.
import type { ToolpathExtras, Vec3 } from '../../packages/protocol/src/v1.ts';

export interface SegmentSet {
  /** Segment endpoints, 6 floats each (x0, y0, z0, x1, y1, z1) in mm, in file (= layer) order. */
  positions: Float32Array;
  /** Index of each layer's first segment; `layerCount + 1` entries, the last is `count`. */
  layerStart: Uint32Array;
  count: number;
}

export interface ExtrusionSet extends SegmentSet {
  /** Per segment: index into `ParsedGcode.roles`. */
  roleIndex: Uint8Array;
  /**
   * Per segment: line width as a size code (`sizeCode`, so 42 = 0.42 mm). A segment the file
   * gives no width for gets the width Orca's GCodeProcessor derives from the filament it extrudes.
   * 0 means unknown (use `ParsedGcode.lineWidth` or a default then).
   */
  width: Uint8Array;
  /**
   * Per segment: bead height as a size code, as GCodeProcessor sees it: usually the layer
   * thickness, more for bridges and overhang walls (and sparse infill printed every few layers).
   * The segment's Z is the top of the bead. 0 means unknown.
   */
  height: Uint8Array;
}

// Line widths and bead heights are stored as one byte per segment, a size code: 0.01 mm steps up
// to 2 mm (codes 1–200), then 0.05 mm steps up to 4.75 mm (201–255). Orca caps a line's width at
// max(2 mm, 4 × its height), so that covers every line Orca draws for layers up to 1.19 mm, to
// 0.01 mm up to 2 mm wide and to 0.05 mm beyond. 0 means unknown.
/** Size code step, in mm, up to `SIZE_FINE_CODES`. */
export const SIZE_STEP_MM = 0.01;
/** The largest code in `SIZE_STEP_MM` steps (2 mm); the codes above count in `SIZE_COARSE_STEP_MM`. */
export const SIZE_FINE_CODES = 200;
export const SIZE_COARSE_STEP_MM = 0.05;
/** Largest size code (a byte). */
export const MAX_SIZE_CODE = 255;

/** The size code of `mm` (a width or height): the nearest code, at least 1; 0 for none (≤ 0 or NaN). */
export function sizeCode(mm: number): number {
  if (!(mm > 0)) return 0;
  const fine = Math.round(mm / SIZE_STEP_MM);
  if (fine <= SIZE_FINE_CODES) return Math.max(1, fine);
  const coarse = SIZE_FINE_CODES + Math.round((mm - SIZE_FINE_CODES * SIZE_STEP_MM) / SIZE_COARSE_STEP_MM);
  return Math.min(MAX_SIZE_CODE, coarse);
}

/** The size, in mm, a size code stands for (0 for 0). */
export function sizeMm(code: number): number {
  return code <= SIZE_FINE_CODES ? code * SIZE_STEP_MM : SIZE_FINE_CODES * SIZE_STEP_MM + (code - SIZE_FINE_CODES) * SIZE_COARSE_STEP_MM;
}

export interface ParsedGcode {
  layerCount: number;
  /** Print height of each layer in mm. */
  layerZ: Float32Array;
  extrusions: ExtrusionSet;
  travels: SegmentSet;
  /** Feature roles in first-seen order, as named after ';TYPE:' (e.g. "Outer wall"). */
  roles: string[];
  /** Toolpath length in mm extruded for each role, parallel to `roles`. */
  roleLength: number[];
  /**
   * The line width (mm) most of the toolpath length is printed at, from the width tags; null
   * when the file has none. Stands in for segments without a width of their own.
   */
  lineWidth: number | null;
  /** Box around every extrusion, or null when the file extrudes nothing. */
  bounds: { min: Vec3; max: Vec3 } | null;
}

export interface ParseOptions {
  /** Called with the fraction of the input read (0–1), about every 5 %, and once with 1 at the end. */
  onProgress?: (fraction: number) => void;
}

/** Toolpaths with the per-extrusion speed, fan, temperature, time and height read from the G-code. */
export interface ParsedGcodeWithExtras {
  data: ParsedGcode;
  extras: ToolpathExtras;
}

/** Longest chord an arc is flattened into, in mm. */
const MAX_CHORD_MM = 1;
/** Largest angle one chord may span, so small-radius arcs still look round. */
const MAX_CHORD_ANGLE = Math.PI / 12;
/** Guards against absurd arcs (huge radius or a corrupt line) allocating millions of chords. */
const MAX_ARC_CHORDS = 4096;
/** How far an extrusion must rise to start a new layer in files without layer markers. */
const LAYER_RISE_MM = 1e-3;
/** Role name for extrusions that precede any ';TYPE:' comment (Orca's name for erNone). */
const UNTYPED_ROLE = 'Undefined';
/** roleIndex is a Uint8Array; any roles beyond this share the last slot. */
const MAX_ROLES = 256;
const PROGRESS_STEPS = 20;

// Byte values the scanner compares against.
const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const PLUS = 43;
const MINUS = 45;
const DOT = 46;
const DIGIT_0 = 48;
const DIGIT_9 = 57;
const SEMICOLON = 59;
const UPPER_A = 65;
const UPPER_Z = 90;
const LETTER_G = 71;
const LETTER_M = 77;
const LETTER_X = 88;
const LETTER_Y = 89;
const LETTER_Z = 90;
/** Clearing this bit turns an ASCII lower-case letter into upper case. */
const TO_UPPER = 0xdf;

// Slots of the fields a command may carry, and their bits in the "present" mask.
const F_X = 0;
const F_Y = 1;
const F_Z = 2;
const F_E = 3;
const F_I = 4;
const F_J = 5;
const F_R = 6;
const F_F = 7;
const F_S = 8;
const F_P = 9;
const HAS_X = 1 << F_X;
const HAS_Y = 1 << F_Y;
const HAS_Z = 1 << F_Z;
const HAS_E = 1 << F_E;
const HAS_I = 1 << F_I;
const HAS_J = 1 << F_J;
const HAS_R = 1 << F_R;
const HAS_F = 1 << F_F;
const HAS_S = 1 << F_S;
const HAS_P = 1 << F_P;
const ALL_AXES = HAS_X | HAS_Y | HAS_Z;

/** Upper-case letter code → field slot, or -1 for letters the preview does not need. */
const FIELD_SLOT = new Int8Array(256).fill(-1);
FIELD_SLOT[LETTER_X] = F_X;
FIELD_SLOT[LETTER_Y] = F_Y;
FIELD_SLOT[LETTER_Z] = F_Z;
FIELD_SLOT[69 /* E */] = F_E;
FIELD_SLOT[73 /* I */] = F_I;
FIELD_SLOT[74 /* J */] = F_J;
FIELD_SLOT[82 /* R */] = F_R;
FIELD_SLOT[70 /* F */] = F_F;
FIELD_SLOT[83 /* S */] = F_S;
FIELD_SLOT[80 /* P */] = F_P;

const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
// Comment tags, spelled as they follow the ';' (see the file comment for the two tag sets).
const TAG_TYPE = ascii('TYPE:');
const TAG_LAYER_CHANGE = ascii('LAYER_CHANGE');
const TAG_Z = ascii('Z:');
const TAG_WIDTH = ascii('WIDTH:');
const TAG_HEIGHT = ascii('HEIGHT:');
const TAG_BBL_FEATURE = ascii(' FEATURE: ');
const TAG_BBL_CHANGE_LAYER = ascii(' CHANGE_LAYER');
const TAG_BBL_Z = ascii(' Z_HEIGHT: ');
const TAG_BBL_WIDTH = ascii(' LINE_WIDTH: ');
const TAG_BBL_HEIGHT = ascii(' LAYER_HEIGHT: ');
// The config block at the end of an Orca file: '; filament_diameter = 1.75' (one per filament).
const TAG_FILAMENT_DIAMETER = ascii(' filament_diameter = ');
// Orca's estimate of the whole print, in its footer (GCodeProcessor, Estimated_Printing_Time_Placeholder):
// '; estimated printing time (normal mode) = 1h 2m 3s', or for Bambu Lab printers
// '; model printing time: 58m 1s; total estimated time: 1h 2m 3s'.
const TAG_ESTIMATED_TIME = ascii(' estimated printing time (normal mode) = ');
const TAG_BBL_MODEL_TIME = ascii(' model printing time: ');
const TAG_BBL_TOTAL_TIME = ascii('total estimated time: ');

// GCodeProcessor's defaults for extrusions without a width (or height) of their own.
const DEFAULT_FILAMENT_DIAMETER_MM = 1.75;
const DEFAULT_BEAD_HEIGHT_MM = 0.2;
const DEFAULT_BEAD_WIDTH_MM = 0.4;
/** A rise smaller than this is not a new bead height (libslic3r's EPSILON). */
const HEIGHT_EPSILON = 1e-4;

/** GCodeProcessor's cap on a line's width, against implausible heights: max(2 mm, 4 × height). */
const widthCap = (height: number) => Math.max(2, 4 * height);

// The cross-section GCodeProcessor assumes when it derives a width from the extruded volume.
/** A rectangle with semicircular ends (most roles). */
const SHAPE_ROUNDED = 0;
/** A rectangle, from 5 % wider filament (outer walls). */
const SHAPE_RECTANGLE = 1;
/** A circle (bridges, and extrusions without a role). */
const SHAPE_CIRCLE = 2;

function beadShape(role: string): number {
  if (role === 'Outer wall') return SHAPE_RECTANGLE;
  if (role === 'Bridge' || role === 'Internal Bridge' || role === UNTYPED_ROLE) return SHAPE_CIRCLE;
  return SHAPE_ROUNDED;
}

/**
 * Extrusions without a width tag. Their width depends on the filament diameter, which Orca
 * writes at the end of the file, so it is worked out once the whole file has been read.
 */
class UntaggedWidths {
  index = new Uint32Array(64);
  /** Filament length extruded per mm of toolpath. */
  rate = new Float32Array(64);
  height = new Float32Array(64);
  shape = new Uint8Array(64);
  count = 0;

  push(index: number, rate: number, height: number, shape: number): void {
    if (this.count === this.index.length) this.grow();
    this.index[this.count] = index;
    this.rate[this.count] = rate;
    this.height[this.count] = height;
    this.shape[this.count] = shape;
    this.count++;
  }

  /** Writes each segment's width into `widths` (size codes), as GCodeProcessor::process_G1 does. */
  apply(widths: Uint8Array, filamentDiameter: number): void {
    const area = Math.PI * (filamentDiameter / 2) ** 2;
    for (let k = 0; k < this.count; k++) {
      const rate = this.rate[k];
      const h = this.height[k];
      let w: number;
      if (this.shape[k] === SHAPE_CIRCLE) w = filamentDiameter * Math.sqrt(rate);
      else if (this.shape[k] === SHAPE_RECTANGLE) w = (rate * area * 1.05 * 1.05) / h;
      else w = (rate * area) / h + (1 - 0.25 * Math.PI) * h;
      if (!(w > 0)) w = DEFAULT_BEAD_WIDTH_MM;
      widths[this.index[k]] = sizeCode(Math.min(w, widthCap(h)));
    }
  }

  private grow(): void {
    const size = this.index.length * 2;
    const index = new Uint32Array(size);
    index.set(this.index);
    this.index = index;
    const rate = new Float32Array(size);
    rate.set(this.rate);
    this.rate = rate;
    const height = new Float32Array(size);
    height.set(this.height);
    this.height = height;
    const shape = new Uint8Array(size);
    shape.set(this.shape);
    this.shape = shape;
  }
}

/**
 * Per extrusion segment, what parseGcodeWithExtras hands the preview (ToolpathExtras), with the
 * segment's time still on the moves' own clock (see `pinTimes`).
 */
class ExtrasBuffer {
  feedrate = new Float32Array(64);
  fanSpeed = new Uint8Array(64);
  temperature = new Uint16Array(64);
  time = new Float64Array(64);
  height = new Float32Array(64);
  count = 0;

  push(feedrate: number, fan: number, temperature: number, time: number, height: number): void {
    if (this.count === this.feedrate.length) this.grow();
    const k = this.count++;
    this.feedrate[k] = feedrate;
    // Rounded like the engine's (the typed arrays would truncate).
    this.fanSpeed[k] = Math.min(100, Math.max(0, Math.round(fan)));
    this.temperature[k] = Math.min(65535, Math.max(0, Math.round(temperature)));
    this.time[k] = time;
    this.height[k] = height;
  }

  private grow(): void {
    const size = this.feedrate.length * 2;
    const grown = <T extends Float32Array | Float64Array | Uint8Array | Uint16Array>(from: T, to: T): T => {
      to.set(from);
      return to;
    };
    this.feedrate = grown(this.feedrate, new Float32Array(size));
    this.fanSpeed = grown(this.fanSpeed, new Uint8Array(size));
    this.temperature = grown(this.temperature, new Uint16Array(size));
    this.time = grown(this.time, new Float64Array(size));
    this.height = grown(this.height, new Float32Array(size));
  }
}

/** A point where Orca's own clock is known: `at` seconds of the moves' clock is `seconds` into the print. */
export interface TimeAnchor {
  at: number;
  seconds: number;
}

/**
 * Maps times on the moves' own clock (`times`, non-decreasing) onto Orca's estimate, through the
 * anchors (in file order): piecewise linear between them, and after the last one at the pace of
 * the last stretch. Anchors that would run the clock backwards are dropped. Pure, for the tests.
 */
export function pinTimes(times: ArrayLike<number>, anchors: readonly TimeAnchor[], out: Float32Array = new Float32Array(times.length)): Float32Array {
  const at: number[] = [0];
  const seconds: number[] = [0];
  for (const anchor of anchors) {
    if (!(anchor.at > at[at.length - 1]) || !(anchor.seconds >= seconds[seconds.length - 1])) continue;
    at.push(anchor.at);
    seconds.push(anchor.seconds);
  }
  const last = at.length - 1;
  let k = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    while (k < last && t > at[k + 1]) k++;
    if (last === 0) out[i] = t;
    else {
      const j = Math.min(k, last - 1);
      const pace = (seconds[j + 1] - seconds[j]) / (at[j + 1] - at[j]);
      out[i] = seconds[j] + (t - at[j]) * pace;
    }
  }
  return out;
}

/** "1d 2h 3m 4s", "44m 38s", "12s" (Orca's get_time_dhms) → seconds; NaN when there is no number. */
export function parseDhms(text: string): number {
  let total = 0;
  let any = false;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    total += Number(value) * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
    any = true;
  }
  return any ? total : NaN;
}

/** Values of the fields read by `readFields`, indexed by slot. Reused for every line. */
const fields = new Float64Array(10);
/**
 * Index just past the number the last `readNumber` or `commandNumber` call read. The scanner is
 * synchronous and not re-entrant, so a module-level cursor avoids allocating a result per field.
 */
let cursor = 0;

const isDigit = (c: number) => c >= DIGIT_0 && c <= DIGIT_9;
const isLineEnd = (c: number) => c === LF || c === CR || c === SEMICOLON;
const isBlank = (c: number) => c === SPACE || c === TAB;

/**
 * Reads a decimal number such as `12`, `-.4` or `+3.25` starting at `i`; returns NaN when there
 * are no digits. Exponents are deliberately unsupported: G-code never uses them, and "E" is the
 * extruder axis (`X1E5` means X=1, E=5).
 */
function readNumber(b: Uint8Array, i: number, end: number): number {
  let negative = false;
  if (i < end && (b[i] === MINUS || b[i] === PLUS)) {
    negative = b[i] === MINUS;
    i++;
  }
  let whole = 0;
  let digits = 0;
  while (i < end && isDigit(b[i])) {
    whole = whole * 10 + (b[i] - DIGIT_0);
    digits++;
    i++;
  }
  let fraction = 0;
  let scale = 1;
  if (i < end && b[i] === DOT) {
    i++;
    while (i < end && isDigit(b[i])) {
      // Digits beyond double precision change nothing; skip them rather than overflow `scale`.
      if (scale < 1e15) {
        fraction = fraction * 10 + (b[i] - DIGIT_0);
        scale *= 10;
      }
      digits++;
      i++;
    }
  }
  cursor = i;
  if (digits === 0) return NaN;
  const value = whole + fraction / scale;
  return negative ? -value : value;
}

/**
 * Reads the `<letter><number>` fields of a command from `i` to the end of the line (or its
 * comment) into `fields`, and returns the bit mask of the ones present. Letters without a number
 * and unknown tokens are skipped.
 */
function readFields(b: Uint8Array, i: number, end: number): number {
  let mask = 0;
  while (i < end) {
    const c = b[i];
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (isLineEnd(c)) break;
    const slot = FIELD_SLOT[c & TO_UPPER];
    const value = readNumber(b, i + 1, end);
    if (cursor === i + 1) {
      // Not a field (a stray word or symbol): skip to the next blank.
      i++;
      while (i < end && !isBlank(b[i]) && !isLineEnd(b[i])) i++;
      continue;
    }
    i = cursor;
    if (slot >= 0 && value === value) {
      fields[slot] = value;
      mask |= 1 << slot;
    }
  }
  return mask;
}

/** Which of X, Y and Z a G28 line names (values are irrelevant: `G28 X Y` and `G28 X0` both home X). */
function readHomedAxes(b: Uint8Array, i: number, end: number): number {
  let mask = 0;
  for (; i < end && !isLineEnd(b[i]); i++) {
    const c = b[i] & TO_UPPER;
    if (c === LETTER_X) mask |= HAS_X;
    else if (c === LETTER_Y) mask |= HAS_Y;
    else if (c === LETTER_Z) mask |= HAS_Z;
  }
  return mask;
}

function startsWith(b: Uint8Array, i: number, end: number, tag: Uint8Array): boolean {
  if (i + tag.length > end) return false;
  for (let k = 0; k < tag.length; k++) if (b[i + k] !== tag[k]) return false;
  return true;
}

/** Growable list of segments (and, for extrusions, their role, width and height). */
class SegmentBuffer {
  positions: Float32Array;
  roles: Uint8Array | null;
  widths: Uint8Array | null;
  heights: Uint8Array | null;
  count = 0;

  constructor(capacity: number, withAttributes: boolean) {
    const segments = Math.max(64, Math.ceil(capacity));
    this.positions = new Float32Array(segments * 6);
    this.roles = withAttributes ? new Uint8Array(segments) : null;
    this.widths = withAttributes ? new Uint8Array(segments) : null;
    this.heights = withAttributes ? new Uint8Array(segments) : null;
  }

  push(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, role: number, width: number, height: number): void {
    if ((this.count + 1) * 6 > this.positions.length) this.grow();
    const p = this.positions;
    const o = this.count * 6;
    p[o] = x0;
    p[o + 1] = y0;
    p[o + 2] = z0;
    p[o + 3] = x1;
    p[o + 4] = y1;
    p[o + 5] = z1;
    if (this.roles) this.roles[this.count] = role;
    if (this.widths) this.widths[this.count] = width;
    if (this.heights) this.heights[this.count] = height;
    this.count++;
  }

  /** Exact-size copies, so the worker can transfer them without shipping spare capacity. */
  positionsTrimmed(): Float32Array {
    return this.positions.slice(0, this.count * 6);
  }

  rolesTrimmed(): Uint8Array {
    return (this.roles ?? new Uint8Array(0)).slice(0, this.count);
  }

  widthsTrimmed(): Uint8Array {
    return (this.widths ?? new Uint8Array(0)).slice(0, this.count);
  }

  heightsTrimmed(): Uint8Array {
    return (this.heights ?? new Uint8Array(0)).slice(0, this.count);
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    const grown = (bytes: Uint8Array) => {
      const out = new Uint8Array(bytes.length * 2);
      out.set(bytes);
      return out;
    };
    if (this.roles) this.roles = grown(this.roles);
    if (this.widths) this.widths = grown(this.widths);
    if (this.heights) this.heights = grown(this.heights);
  }
}

function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function parseGcode(input: Uint8Array | ArrayBuffer | string, options: ParseOptions = {}): ParsedGcode {
  return parse(input, options, false).data;
}

/**
 * parseGcode, plus each extrusion's speed, fan, temperature, time and height (ToolpathExtras, see
 * the file comment), for G-code that does not come with the engine's.
 */
export function parseGcodeWithExtras(input: Uint8Array | ArrayBuffer | string, options: ParseOptions = {}): ParsedGcodeWithExtras {
  const { data, extras } = parse(input, options, true);
  return { data, extras: extras! };
}

function parse(input: Uint8Array | ArrayBuffer | string, options: ParseOptions, withExtras: boolean): { data: ParsedGcode; extras: ToolpathExtras | null } {
  const b = toBytes(input);
  const n = b.length;
  const { onProgress } = options;
  const decoder = new TextDecoder();

  // Roughly one segment per 30 bytes of Orca output; the buffers grow if that is short.
  const extrusions = new SegmentBuffer(n / 30, true);
  const travels = new SegmentBuffer(n / 60, false);

  // What parseGcodeWithExtras reads besides the toolpaths (see the file comment).
  const extras = withExtras ? new ExtrasBuffer() : null;
  /** Feed rate in mm/min (F is modal); 0 until the file sets one. */
  let feed = 0;
  /** Part cooling fan, 0–100 %. */
  let fan = 0;
  let temperature = 0;
  /** Seconds on the moves' own clock (see `pinTimes`). */
  let clock = 0;
  const anchors: Array<{ at: number; percent: number; minutes: number }> = [];
  let lastPercent = -1;
  let lastMinutes = NaN;
  /** The first 'M73 R': the whole print in minutes, should the footer have no estimate. */
  let firstMinutes = NaN;
  let estimate = NaN;
  /** Moves `distance` mm (or E mm) at the current feed rate. */
  const advance = (distance: number) => {
    if (feed > 0) clock += distance / (feed / 60);
  };

  const roles: string[] = [];
  const roleLength: number[] = [];
  const roleShape: number[] = [];
  const roleIds = new Map<string, number>();
  // A role is registered on its first extrusion, so roles that never print stay out of the list.
  let roleName = UNTYPED_ROLE;
  let role = -1;
  // The bead of the extrusions, as GCodeProcessor tracks it (its m_forced_width, m_forced_height,
  // m_height and m_extruded_last_z).
  /** Width from the last width tag, in mm; 0 or less: none, the width is derived from the volume. */
  let forcedWidth = 0;
  /** Height from the last height tag, in mm; 0 or less: none. */
  let forcedHeight = 0;
  /** The current bead height (mm): the height tag's, else the last rise of a G1 extrusion over the previous one. */
  let beadHeight = 0;
  let lastExtrudedZ = 0;
  // Size codes of the bead, worked out again only when its width or height changes.
  let codedWidth = NaN, codedHeight = NaN;
  let widthCode = 0, heightCode = 0;
  /** Extruded length per width code, to find the file's dominant width. */
  const widthLength = new Float64Array(MAX_SIZE_CODE + 1);
  const untagged = new UntaggedWidths();
  let filamentDiameter = NaN;

  const roleId = (name: string): number => {
    let id = roleIds.get(name);
    if (id === undefined) {
      if (roles.length < MAX_ROLES) {
        id = roles.length;
        roles.push(name);
        roleLength.push(0);
        roleShape.push(beadShape(name));
      } else {
        id = MAX_ROLES - 1;
      }
      roleIds.set(name, id);
    }
    return id;
  };

  // Layers: layer 0 exists from the start and collects everything before the first marker.
  const extrusionStarts: number[] = [0];
  const travelStarts: number[] = [0];
  const layerZ: number[] = [NaN];
  let sawLayerMarker = false;
  /** The current layer's height is still unknown (no ';Z:' or extrusion yet). */
  let zPending = true;

  const startLayer = (z: number) => {
    extrusionStarts.push(extrusions.count);
    travelStarts.push(travels.count);
    layerZ.push(z);
  };

  const onLayerMarker = () => {
    if (!sawLayerMarker) {
      // Everything so far is start G-code on the first layer: drop any layers the fallback
      // split it into.
      sawLayerMarker = true;
      extrusionStarts.length = 1;
      travelStarts.length = 1;
      layerZ.length = 1;
      layerZ[0] = NaN;
    } else {
      startLayer(NaN);
    }
    zPending = true;
  };

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  /**
   * Draws a segment: an extrusion when it extrudes `de` > 0 mm of filament, else a travel. `g1`
   * is false for the chords of an arc, which GCodeProcessor does not take a bead height from.
   */
  const emit = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, de: number, g1: boolean) => {
    if (!(de > 0)) {
      travels.push(x0, y0, z0, x1, y1, z1, 0, 0, 0);
      return;
    }
    const last = layerZ.length - 1;
    if (zPending) {
      layerZ[last] = z1;
      zPending = false;
    } else if (!sawLayerMarker && z1 > layerZ[last] + LAYER_RISE_MM) {
      startLayer(z1);
    }
    if (role < 0) role = roleId(roleName);
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // GCodeProcessor::process_G1: the bead height first, then the width, capped by that height.
    if (forcedHeight > 0) beadHeight = forcedHeight;
    else if (g1 && z1 > lastExtrudedZ + HEIGHT_EPSILON) beadHeight = z1 - lastExtrudedZ;
    if (beadHeight === 0) beadHeight = DEFAULT_BEAD_HEIGHT_MM;
    if (g1) lastExtrudedZ = z1;
    if (beadHeight !== codedHeight || forcedWidth !== codedWidth) {
      codedHeight = beadHeight;
      codedWidth = forcedWidth;
      heightCode = sizeCode(beadHeight);
      widthCode = forcedWidth > 0 ? sizeCode(Math.min(forcedWidth, widthCap(beadHeight))) : 0;
    }
    if (widthCode === 0) untagged.push(extrusions.count, de / length, beadHeight, roleShape[role]);
    extrusions.push(x0, y0, z0, x1, y1, z1, role, widthCode, heightCode);
    extras?.push(feed / 60, fan, temperature, clock, beadHeight);
    roleLength[role] += length;
    widthLength[widthCode] += length;
    minX = Math.min(minX, x0, x1);
    minY = Math.min(minY, y0, y1);
    minZ = Math.min(minZ, z0, z1);
    maxX = Math.max(maxX, x0, x1);
    maxY = Math.max(maxY, y0, y1);
    maxZ = Math.max(maxZ, z0, z1);
  };

  // Machine state. Positions are physical; o* are the G92 origins that commands are relative to.
  let x = 0, y = 0, z = 0, e = 0;
  let ox = 0, oy = 0, oz = 0, oe = 0;
  let absoluteXyz = true;
  let absoluteE = true;
  /** HAS_X | HAS_Y | HAS_Z bits of the axes whose position is known (see the file comment). */
  let known = 0;

  // Target of a motion command, computed by `target()`.
  let tx = 0, ty = 0, tz = 0, te = 0;
  const target = (mask: number) => {
    tx = mask & HAS_X ? (absoluteXyz ? ox + fields[F_X] : x + fields[F_X]) : x;
    ty = mask & HAS_Y ? (absoluteXyz ? oy + fields[F_Y] : y + fields[F_Y]) : y;
    tz = mask & HAS_Z ? (absoluteXyz ? oz + fields[F_Z] : z + fields[F_Z]) : z;
    te = mask & HAS_E ? (absoluteXyz && absoluteE ? oe + fields[F_E] : e + fields[F_E]) : e;
  };

  // linearMove and arcMove draw the move to the target (and, with extras, run the clock: a
  // segment's time is the moment it ends); commitMove then makes it the position.
  const linearMove = () => {
    const moves = tx !== x || ty !== y || tz !== z;
    if (known === ALL_AXES && moves) {
      if (extras) advance(Math.hypot(tx - x, ty - y, tz - z));
      emit(x, y, z, tx, ty, tz, te - e, true);
    } else if (extras && !moves) {
      // Retracting or priming: the extruder moves alone.
      advance(Math.abs(te - e));
    }
  };

  const arcMove = (mask: number, clockwise: boolean) => {
    if (known !== ALL_AXES) return;
    let cx: number, cy: number;
    if (mask & HAS_R) {
      // Centre from the radius, as Orca's ArcWelder::arc_center: a positive R is the shorter arc.
      const r = fields[F_R];
      const vx = tx - x, vy = ty - y;
      const q2 = vx * vx + vy * vy;
      if (r === 0 || q2 === 0) return linearMove();
      const t2 = (r * r) / q2 - 0.25;
      const t = t2 > 0 ? Math.sqrt(t2) : 0;
      const side = (r > 0) === !clockwise ? 1 : -1;
      cx = (x + tx) / 2 - vy * t * side;
      cy = (y + ty) / 2 + vx * t * side;
    } else if (mask & (HAS_I | HAS_J)) {
      cx = x + (mask & HAS_I ? fields[F_I] : 0);
      cy = y + (mask & HAS_J ? fields[F_J] : 0);
    } else {
      return linearMove();
    }

    const sx = x - cx, sy = y - cy;
    const ex = tx - cx, ey = ty - cy;
    const r0 = Math.hypot(sx, sy);
    const r1 = Math.hypot(ex, ey);
    if (r0 < 1e-6) return linearMove();

    let sweep: number;
    if (Math.abs(tx - x) < 1e-4 && Math.abs(ty - y) < 1e-4) {
      sweep = clockwise ? -2 * Math.PI : 2 * Math.PI; // start = end with a centre: a full circle
    } else {
      sweep = Math.atan2(sx * ey - sy * ex, sx * ex + sy * ey);
      if (sweep < 0) sweep += 2 * Math.PI;
      if (clockwise) sweep -= 2 * Math.PI;
    }
    const arcLength = Math.abs(sweep) * Math.max(r0, r1);
    const chords = Math.min(
      MAX_ARC_CHORDS,
      Math.max(1, Math.ceil(arcLength / MAX_CHORD_MM), Math.ceil(Math.abs(sweep) / MAX_CHORD_ANGLE)),
    );

    // The chords are equally long, so each extrudes the same share.
    const de = (te - e) / chords;
    const a0 = Math.atan2(sy, sx);
    let px = x, py = y, pz = z;
    for (let k = 1; k <= chords; k++) {
      let qx = tx, qy = ty, qz = tz;
      // The last chord ends exactly on the commanded point, so rounding never drifts.
      if (k < chords) {
        const f = k / chords;
        const a = a0 + sweep * f;
        const radius = r0 + (r1 - r0) * f;
        qx = cx + radius * Math.cos(a);
        qy = cy + radius * Math.sin(a);
        qz = z + (tz - z) * f;
      }
      if (extras) advance(Math.hypot(qx - px, qy - py, qz - pz));
      emit(px, py, pz, qx, qy, qz, de, false);
      px = qx;
      py = qy;
      pz = qz;
    }
  };

  const commitMove = (mask: number) => {
    x = tx;
    y = ty;
    z = tz;
    e = te;
    if (absoluteXyz) known |= mask & ALL_AXES;
  };

  const setPosition = (mask: number) => {
    if (mask === 0) {
      ox = x;
      oy = y;
      oz = z;
      oe = e;
      return;
    }
    if (mask & HAS_X) ox = x - fields[F_X];
    if (mask & HAS_Y) oy = y - fields[F_Y];
    if (mask & HAS_Z) oz = z - fields[F_Z];
    if (mask & HAS_E) oe = e - fields[F_E];
  };

  const home = (axes: number) => {
    const homed = axes === 0 ? ALL_AXES : axes;
    if (homed & HAS_X) x = ox = 0;
    if (homed & HAS_Y) y = oy = 0;
    if (homed & HAS_Z) z = oz = 0;
    known &= ~homed;
  };

  /** The role name runs from `start` to the end of the line, minus trailing blanks. */
  const setRole = (start: number, end: number) => {
    let stop = end;
    while (stop > start && (b[stop - 1] === CR || isBlank(b[stop - 1]))) stop--;
    roleName = decoder.decode(b.subarray(start, stop)) || UNTYPED_ROLE;
    role = -1;
  };

  /** A layer marker is the whole tag (`;LAYER_CHANGE`, not `;LAYER_CHANGES_DONE`). */
  const layerMarker = (after: number, end: number) => {
    if (after === end || b[after] === CR || isBlank(b[after])) onLayerMarker();
  };

  const setLayerZ = (start: number, end: number) => {
    const value = readNumber(b, start, end);
    if (sawLayerMarker && zPending && value === value) {
      layerZ[layerZ.length - 1] = value;
      zPending = false;
    }
  };

  const setFilamentDiameter = (start: number, end: number) => {
    const value = readNumber(b, start, end);
    if (!(filamentDiameter > 0) && value > 0) filamentDiameter = value;
  };

  // Like GCodeProcessor, a tag without a number keeps the previous value, and a value of 0 or less
  // switches the tag off (widths are derived again, heights taken from the moves).
  const setWidth = (start: number, end: number) => {
    const value = readNumber(b, start, end);
    if (value === value) forcedWidth = value;
  };

  const setHeight = (start: number, end: number) => {
    const value = readNumber(b, start, end);
    if (value === value) forcedHeight = value;
  };

  const setEstimate = (start: number, end: number) => {
    const seconds = parseDhms(decoder.decode(b.subarray(start, end)));
    if (!(estimate >= 0) && seconds >= 0) estimate = seconds;
  };

  /** '; model printing time: 58m 1s; total estimated time: 1h 2m 3s': the total. */
  const setBambuEstimate = (start: number, end: number) => {
    for (let k = start; k < end; k++) {
      if (b[k] === SEMICOLON && startsWith(b, k + 2, end, TAG_BBL_TOTAL_TIME)) return setEstimate(k + 2 + TAG_BBL_TOTAL_TIME.length, end);
    }
  };

  /** M73: where Orca's own clock stands (see `pinTimes`). */
  const progress = (mask: number) => {
    const minutes = mask & HAS_R ? fields[F_R] : NaN;
    // A new percentage, or the remaining minutes ticking down, is a moment Orca's clock is known.
    const percent = mask & HAS_P ? fields[F_P] : lastPercent;
    if (percent > lastPercent || minutes < lastMinutes) anchors.push({ at: clock, percent: percent > lastPercent ? percent : NaN, minutes: minutes < lastMinutes ? minutes : NaN });
    if (percent > lastPercent) lastPercent = percent;
    if (minutes === minutes) {
      if (firstMinutes !== firstMinutes) firstMinutes = minutes;
      lastMinutes = minutes;
    }
  };

  /** Handles a comment line; `i` is just past the ';'. */
  const comment = (i: number, end: number) => {
    if (b[i] === SPACE) {
      // Bambu Lab tag set; any other comment with a blank after the ';' is just a comment.
      if (startsWith(b, i, end, TAG_BBL_WIDTH)) setWidth(i + TAG_BBL_WIDTH.length, end);
      else if (startsWith(b, i, end, TAG_BBL_FEATURE)) setRole(i + TAG_BBL_FEATURE.length, end);
      else if (startsWith(b, i, end, TAG_BBL_HEIGHT)) setHeight(i + TAG_BBL_HEIGHT.length, end);
      else if (startsWith(b, i, end, TAG_BBL_CHANGE_LAYER)) layerMarker(i + TAG_BBL_CHANGE_LAYER.length, end);
      else if (startsWith(b, i, end, TAG_BBL_Z)) setLayerZ(i + TAG_BBL_Z.length, end);
      else if (startsWith(b, i, end, TAG_FILAMENT_DIAMETER)) setFilamentDiameter(i + TAG_FILAMENT_DIAMETER.length, end);
      else if (extras && startsWith(b, i, end, TAG_ESTIMATED_TIME)) setEstimate(i + TAG_ESTIMATED_TIME.length, end);
      else if (extras && startsWith(b, i, end, TAG_BBL_MODEL_TIME)) setBambuEstimate(i + TAG_BBL_MODEL_TIME.length, end);
    } else if (startsWith(b, i, end, TAG_WIDTH)) {
      setWidth(i + TAG_WIDTH.length, end);
    } else if (startsWith(b, i, end, TAG_HEIGHT)) {
      setHeight(i + TAG_HEIGHT.length, end);
    } else if (startsWith(b, i, end, TAG_TYPE)) {
      setRole(i + TAG_TYPE.length, end);
    } else if (startsWith(b, i, end, TAG_LAYER_CHANGE)) {
      layerMarker(i + TAG_LAYER_CHANGE.length, end);
    } else if (startsWith(b, i, end, TAG_Z)) {
      setLayerZ(i + TAG_Z.length, end);
    }
  };

  /** Reads the integer after a G or M; -1 when it is not a plain command word (e.g. `G29.1`, `M_MACRO`). */
  const commandNumber = (i: number, end: number): number => {
    let code = 0;
    let digits = 0;
    while (i < end && isDigit(b[i])) {
      code = code * 10 + (b[i] - DIGIT_0);
      digits++;
      i++;
    }
    cursor = i;
    if (digits === 0) return -1;
    if (i === end) return code;
    // `G1 X5` and `G1X5` are commands; `G29.1` or `M_START` are not.
    const next = b[i];
    const letter = next & TO_UPPER;
    return isBlank(next) || isLineEnd(next) || (letter >= UPPER_A && letter <= UPPER_Z) ? code : -1;
  };

  const progressStep = Math.max(1, Math.floor(n / PROGRESS_STEPS));
  let nextProgress = progressStep;

  // Skip a UTF-8 byte-order mark.
  let i = n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < n) {
    if (onProgress && i >= nextProgress) {
      onProgress(i / n);
      nextProgress = i + progressStep;
    }
    let end = b.indexOf(LF, i);
    if (end < 0) end = n;

    while (i < end && isBlank(b[i])) i++;
    const c = i < end ? b[i] & TO_UPPER : 0;
    if (i < end && b[i] === SEMICOLON) {
      comment(i + 1, end);
    } else if (c === LETTER_G) {
      const code = commandNumber(i + 1, end);
      const at = cursor;
      switch (code) {
        case 0:
        case 1: {
          const mask = readFields(b, at, end);
          if (mask & HAS_F) feed = fields[F_F];
          target(mask);
          linearMove();
          commitMove(mask);
          break;
        }
        case 2:
        case 3: {
          const mask = readFields(b, at, end);
          if (mask & HAS_F) feed = fields[F_F];
          target(mask);
          arcMove(mask, code === 2);
          commitMove(mask);
          break;
        }
        case 4:
          // A dwell: P in milliseconds, S in seconds.
          if (extras) {
            const mask = readFields(b, at, end);
            if (mask & HAS_P && fields[F_P] > 0) clock += fields[F_P] / 1000;
            else if (mask & HAS_S && fields[F_S] > 0) clock += fields[F_S];
          }
          break;
        case 28:
          home(readHomedAxes(b, at, end));
          break;
        case 90:
          absoluteXyz = true;
          break;
        case 91:
          absoluteXyz = false;
          break;
        case 92:
          setPosition(readFields(b, at, end));
          break;
      }
    } else if (c === LETTER_M) {
      const code = commandNumber(i + 1, end);
      if (code === 82) absoluteE = true;
      else if (code === 83) absoluteE = false;
      else if (extras) {
        const at = cursor;
        switch (code) {
          case 73:
            progress(readFields(b, at, end));
            break;
          case 104:
          case 109: {
            const mask = readFields(b, at, end);
            if (code === 109 && mask & HAS_R) temperature = fields[F_R];
            else if (mask & HAS_S) temperature = fields[F_S];
            break;
          }
          case 106: {
            // The part cooling fan: no P, or P1 (Bambu Lab); P2, P3… are other fans.
            const mask = readFields(b, at, end);
            if (!(mask & HAS_P) || fields[F_P] === 1) fan = mask & HAS_S ? (100 / 255) * fields[F_S] : 100;
            break;
          }
          case 107:
            fan = 0;
            break;
        }
      }
    }
    // Anything else (T, Klipper macros such as EXCLUDE_OBJECT_START NAME=…) is irrelevant here.
    i = end + 1;
  }
  onProgress?.(1);

  const empty = extrusions.count === 0 && travels.count === 0;
  const layerCount = empty ? 0 : layerZ.length;
  const z0 = extrusions.count > 0 ? minZ : 0;
  // A layer with neither ';Z:' nor an extrusion (an empty layer) sits on the one below it.
  const zs = new Float32Array(layerCount);
  for (let l = 0; l < layerCount; l++) zs[l] = layerZ[l] === layerZ[l] ? layerZ[l] : l > 0 ? zs[l - 1] : z0;

  const starts = (list: number[], total: number) => {
    const out = new Uint32Array(layerCount + 1);
    for (let l = 0; l < layerCount; l++) out[l] = list[l];
    out[layerCount] = total;
    return out;
  };

  // The dominant width: the one the most toolpath length is printed at (0 = no width given).
  let dominant = 0;
  for (let w = 1; w <= MAX_SIZE_CODE; w++) if (widthLength[w] > (dominant > 0 ? widthLength[dominant] : 0)) dominant = w;

  const widths = extrusions.widthsTrimmed();
  untagged.apply(widths, filamentDiameter > 0 ? filamentDiameter : DEFAULT_FILAMENT_DIAMETER_MM);

  const data: ParsedGcode = {
    layerCount,
    layerZ: zs,
    extrusions: {
      positions: extrusions.positionsTrimmed(),
      roleIndex: extrusions.rolesTrimmed(),
      width: widths,
      height: extrusions.heightsTrimmed(),
      layerStart: starts(extrusionStarts, extrusions.count),
      count: extrusions.count,
    },
    travels: {
      positions: travels.positionsTrimmed(),
      layerStart: starts(travelStarts, travels.count),
      count: travels.count,
    },
    roles,
    roleLength,
    lineWidth: dominant > 0 ? sizeMm(dominant) : null,
    bounds: extrusions.count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null,
  };
  if (!extras) return { data, extras: null };

  // Pin the moves' clock to Orca's estimate: its total (the footer, else the first M73 R, which
  // rounds it to the minute), where each percentage and each remaining minute began, and the end.
  const total = estimate >= 0 ? estimate : firstMinutes >= 0 ? (firstMinutes + 0.5) * 60 : NaN;
  const pins: TimeAnchor[] = [];
  if (total >= 0) {
    for (const anchor of anchors) {
      // GCodeProcessor writes P = floor(100 × elapsed / total) and R = floor((remaining + 0.5 s) / 60).
      const seconds = anchor.percent >= 0 ? (anchor.percent / 100) * total : Math.max(0, total - (anchor.minutes + 1) * 60);
      pins.push({ at: anchor.at, seconds });
    }
    pins.push({ at: clock, seconds: total });
  }
  const count = extrusions.count;
  return {
    data,
    extras: {
      feedrate: extras.feedrate.slice(0, count),
      fanSpeed: extras.fanSpeed.slice(0, count),
      temperature: extras.temperature.slice(0, count),
      time: pinTimes(extras.time.subarray(0, count), pins),
      height: extras.height.slice(0, count),
    },
  };
}
