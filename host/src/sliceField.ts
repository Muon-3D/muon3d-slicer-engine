// The slice field (docs/SLICE_FIELD.md) of a slice: how the plate will be printed, sampled on a voxel grid.
// It is built from the neutral toolpaths the bridge returns (each extrusion's role, path, width and height)
// and the objects' meshes, never from libslic3r's structures, and written as the file
// packages/protocol/src/sliceField.ts reads. Per layer, a fine XY raster (SUBSAMPLES cells along a voxel's edge) is coloured:
// cells under a perimeter bead are wall, under a solid-infill bead skin, and the rest of the object's
// cross-section is the sparse-infill region. Support, skirt, brim, ironing and custom moves are left out.
// The raster is then integrated over each voxel, layer thickness by layer thickness.
import type { SliceFieldArrays, SliceFieldDescription, SliceFieldPattern, SliceFieldRequest, ToolpathExtras } from '../../packages/protocol/src/index.ts';
import { printerGravity, SLICE_FIELD_NO_DIRECTION, SLICE_FIELD_NO_LAYER } from '../../packages/protocol/src/sliceField.ts';
import type { BridgeToolpaths, EngineObject, FlatConfig } from './bridge.ts';

export const SLICE_FIELD_VOXEL_SIZES: readonly number[] = [1, 0.5];
/** Raster cells along a voxel's edge (0.125 mm at 1 mm voxels): fractions are good to about 1/8. */
const SUBSAMPLES = 8;

/** What an extrusion role counts as in the field: null for what it leaves out. */
export type FieldClass = 'wall' | 'skin' | 'infill' | null;

/** The class of a role, by its ';TYPE:' name (Orca's ExtrusionRole names). */
export function fieldClass(role: string): FieldClass {
  const n = role.toLowerCase();
  if (/support|ironing|skirt|brim|tower|wipe|custom/.test(n)) return null;
  if (n.includes('wall') || n.includes('perimeter') || n === 'gap infill') return 'wall';
  if (n === 'sparse infill' || n === 'internal infill') return 'infill';
  if (n.includes('solid infill') || n.includes('top surface') || n.includes('bottom surface') || n.includes('bridge')) return 'skin';
  return null;
}

/** Orca's sparse_infill_pattern values, in the order of the field's pattern ids (0 is none). */
export const INFILL_PATTERNS: readonly string[] = [
  'none', 'rectilinear', 'alignedrectilinear', 'zig-zag', 'crosshatch', 'grid', 'line', 'cubic', 'triangles', 'tri-hexagon',
  'gyroid', 'honeycomb', 'adaptivecubic', 'supportcubic', 'lightning', '3dhoneycomb', 'concentric', 'hilbertcurve',
  'archimedeanchords', 'octagramspiral', 'quartercubic', 'tpmsd', 'tpmsfk', 'lateral-lattice', 'lateral-honeycomb',
];

/** A toolpath size code (Toolpaths.extrusions.width/height) in mm; 0 for unknown. */
export const sizeFromCode = (code: number): number => (code <= 200 ? code * 0.01 : 2 + (code - 200) * 0.05);

export interface SliceFieldSource {
  /** For the printer's gravity (printer_notes). */
  machine: FlatConfig;
  process: FlatConfig;
  filaments: FlatConfig[];
  objects: EngineObject[];
  toolpaths: BridgeToolpaths;
  /** For depositionTime (its per-segment time and feedrate). */
  extras: ToolpathExtras | null;
  request: SliceFieldRequest;
  generator?: string;
}

const text = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const number = (v: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

interface Slab {
  wall: Float32Array;
  skin: Float32Array;
  infill: Float32Array;
  /** Infill fraction × density, for the mean density. */
  density: Float32Array;
  /** Infill fraction per (column, local pattern). */
  votes: Float32Array;
  /** Extruded volume × (cos 2θ, sin 2θ), the volume, and volume × time. */
  cos: Float32Array;
  sin: Float32Array;
  volume: Float32Array;
  time: Float32Array | null;
}

/** Samples the slice on the voxel grid. */
export function buildSliceField(src: SliceFieldSource): { description: SliceFieldDescription; arrays: SliceFieldArrays } {
  const v = src.request.voxelSize ?? 1;
  const withTime = src.request.depositionTime === true && src.extras !== null;
  const paths = src.toolpaths;

  // The grid: the objects' bounding box in XY, from the bed up to their top.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (const o of src.objects) {
    const p = o.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
  const cellsAlong = (span: number) => Math.max(1, Math.ceil(span / v - 1e-6));
  const nx = cellsAlong(maxX - minX), ny = cellsAlong(maxY - minY), nz = cellsAlong(maxZ);
  const ox = minX, oy = minY;
  const columns = nx * ny;
  const voxels = columns * nz;

  // The objects' infill.
  const patterns: SliceFieldPattern[] = INFILL_PATTERNS.map((name, id) => ({ id, name }));
  const patternId = (name: string): number => {
    let id = patterns.findIndex((p) => p.name === name);
    if (id < 0) id = patterns.push({ id: patterns.length, name }) - 1;
    return id;
  };
  const setting = (o: EngineObject, key: string) => o.config?.[key] ?? text(src.process[key]);
  const objects = src.objects.map((o) => ({
    name: o.name,
    wallLoops: Math.round(number(setting(o, 'wall_loops'), 0)),
    infillDensity: Math.min(100, Math.max(0, number(setting(o, 'sparse_infill_density'), 0))),
    infillPattern: patternId(setting(o, 'sparse_infill_pattern') ?? 'crosshatch'),
  }));
  const used = [...new Set(objects.map((o) => o.infillPattern))];
  const localPattern = objects.map((o) => used.indexOf(o.infillPattern));
  const P = Math.max(1, used.length);

  const arrays: SliceFieldArrays = {
    wallFraction: new Uint8Array(voxels),
    skinFraction: new Uint8Array(voxels),
    infillFraction: new Uint8Array(voxels),
    infillDensity: new Uint8Array(voxels),
    infillPattern: new Uint8Array(voxels),
    rasterDirection: new Int8Array(voxels).fill(SLICE_FIELD_NO_DIRECTION),
    layerIndex: new Uint16Array(voxels).fill(SLICE_FIELD_NO_LAYER),
  };
  if (withTime) arrays.depositionTime = new Float32Array(voxels).fill(Number.NaN);

  const layerZ = paths.layerZ;
  const layerCount = paths.layerCount;
  // The layer each voxel slab's centre is printed in.
  const layerOfSlab = new Uint16Array(nz).fill(SLICE_FIELD_NO_LAYER);
  for (let k = 0, n = 0; k < nz && layerCount > 0; k++) {
    const zc = (k + 0.5) * v;
    while (n < layerCount - 1 && layerZ[n] < zc) n++;
    layerOfSlab[k] = n;
  }

  // The XY raster.
  const S = SUBSAMPLES;
  const p = v / S;
  const cx = nx * S, cy = ny * S;
  const region = new Uint8Array(cx * cy);
  const kind = new Uint8Array(cx * cy);
  const WALL = 2, SKIN = 1;
  const colWall = new Float32Array(columns), colSkin = new Float32Array(columns), colInfill = new Float32Array(columns);
  const colDensity = new Float32Array(columns), colVotes = new Float32Array(columns * P);
  const colOfX = Int32Array.from({ length: cx }, (_, i) => Math.floor(i / S));
  const colOfY = Int32Array.from({ length: cy }, (_, j) => Math.floor(j / S) * nx);
  // The counts follow the raster as it is drawn: a cell enters the sparse region when it is filled and
  // leaves it when a bead covers it.
  const enterRegion = (col: number, o: number, sign: number) => {
    colInfill[col] += sign;
    colDensity[col] += sign * objects[o].infillDensity;
    colVotes[col * P + localPattern[o]] += sign;
  };
  const markCell = (i: number, j: number, mark: number) => {
    const c = j * cx + i, was = kind[c];
    if (was >= mark) return;
    kind[c] = mark;
    const col = colOfY[j] + colOfX[i];
    if (was === SKIN) colSkin[col]--;
    else if (region[c] > 0) enterRegion(col, region[c] - 1, -1);
    if (mark === WALL) colWall[col]++;
    else colSkin[col]++;
  };
  const rows: number[][] = Array.from({ length: cy }, () => []);

  const roleClass = paths.roles.map((r) => fieldClass(r));
  const fallbackWidth = paths.lineWidth ?? 0.45;

  const slabs = new Map<number, Slab>();
  const slab = (k: number): Slab => {
    let s = slabs.get(k);
    if (s === undefined) {
      s = {
        wall: new Float32Array(columns), skin: new Float32Array(columns), infill: new Float32Array(columns),
        density: new Float32Array(columns), votes: new Float32Array(columns * P),
        cos: new Float32Array(columns), sin: new Float32Array(columns), volume: new Float32Array(columns),
        time: withTime ? new Float32Array(columns) : null,
      };
      slabs.set(k, s);
    }
    return s;
  };
  const finish = (k: number) => {
    const s = slabs.get(k);
    slabs.delete(k);
    if (s === undefined) return;
    const base = k * columns;
    for (let c = 0; c < columns; c++) {
      let w = s.wall[c], sk = s.skin[c], inf = s.infill[c];
      const sum = w + sk + inf;
      if (sum > 1) (w /= sum), (sk /= sum), (inf /= sum);
      const at = base + c;
      arrays.wallFraction[at] = Math.round(w * 255);
      arrays.skinFraction[at] = Math.round(sk * 255);
      arrays.infillFraction[at] = Math.round(inf * 255);
      if (arrays.infillFraction[at] > 0) {
        arrays.infillDensity[at] = Math.round(s.density[c] / s.infill[c]);
        let best = 0;
        for (let q = 1; q < P; q++) if (s.votes[c * P + q] > s.votes[c * P + best]) best = q;
        arrays.infillPattern[at] = used[best] ?? 0;
      }
      if (sum * 255 >= 0.5 || s.volume[c] > 0) arrays.layerIndex[at] = layerOfSlab[k];
      if (s.volume[c] > 0) {
        const half = (0.5 * Math.atan2(s.sin[c], s.cos[c]) * 180) / Math.PI; // (-90, 90]
        let code = Math.round(half / 2);
        if (code >= 45) code -= 90;
        arrays.rasterDirection[at] = code;
        if (s.time !== null) arrays.depositionTime![at] = s.time[c] / s.volume[c];
      }
    }
  };

  // The objects' triangles by their lowest z, for the cross-sections.
  const meshes = src.objects.map((o) => {
    const n = Math.floor(o.positions.length / 9);
    const lo = new Float32Array(n), hi = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      const q = o.positions;
      lo[t] = Math.min(q[t * 9 + 2], q[t * 9 + 5], q[t * 9 + 8]);
      hi[t] = Math.max(q[t * 9 + 2], q[t * 9 + 5], q[t * 9 + 8]);
    }
    const order = Uint32Array.from({ length: n }, (_, t) => t).sort((a, b) => lo[a] - lo[b]);
    return { positions: o.positions, lo, hi, order, next: 0, active: [] as number[] };
  });

  const { positions, layerStart, roleIndex, width, height } = paths.extrusions;
  const time = src.extras?.time, feedrate = src.extras?.feedrate;

  for (let L = 0; L < layerCount; L++) {
    const zTop = layerZ[L];
    const zBottom = L > 0 ? layerZ[L - 1] : 0;
    if (!(zTop > zBottom)) continue;
    for (const k of [...slabs.keys()]) if ((k + 1) * v <= zBottom + 1e-9) finish(k);

    // 1. Each object's cross-section at mid-layer, filled by even-odd scanlines through cell centres.
    region.fill(0);
    kind.fill(0);
    colWall.fill(0), colSkin.fill(0), colInfill.fill(0), colDensity.fill(0), colVotes.fill(0);
    const zMid = 0.5 * (zBottom + zTop);
    meshes.forEach((m, o) => {
      while (m.next < m.order.length && m.lo[m.order[m.next]] <= zMid) m.active.push(m.order[m.next++]);
      m.active = m.active.filter((t) => m.hi[t] > zMid);
      const touched: number[] = [];
      for (const t of m.active) {
        const q = m.positions;
        let ax = 0, ay = 0, bx = 0, by = 0, found = 0;
        for (let e = 0; e < 3; e++) {
          const a = t * 9 + e * 3, b = t * 9 + ((e + 1) % 3) * 3;
          if (q[a + 2] > zMid === q[b + 2] > zMid) continue;
          const f = (zMid - q[a + 2]) / (q[b + 2] - q[a + 2]);
          const x = q[a] + f * (q[b] - q[a]), y = q[a + 1] + f * (q[b + 1] - q[a + 1]);
          if (found++ === 0) (ax = x), (ay = y);
          else (bx = x), (by = y);
        }
        if (found !== 2 || ay === by) continue;
        const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        const j0 = Math.max(0, Math.ceil((y0 - oy) / p - 0.5)), j1 = Math.min(cy - 1, Math.ceil((y1 - oy) / p - 0.5) - 1);
        for (let j = j0; j <= j1; j++) {
          const yc = oy + (j + 0.5) * p;
          if (rows[j].length === 0) touched.push(j);
          rows[j].push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      for (const j of touched) {
        const xs = rows[j].sort((a, b) => a - b);
        for (let n = 0; n + 1 < xs.length; n += 2) {
          const i0 = Math.max(0, Math.ceil((xs[n] - ox) / p - 0.5)), i1 = Math.min(cx - 1, Math.ceil((xs[n + 1] - ox) / p - 0.5) - 1);
          if (i1 < i0) continue;
          const id = Math.min(o + 1, 255), row = j * cx;
          if (o === 0) {
            region.fill(id, row + i0, row + i1 + 1);
            for (let a = i0; a <= i1; ) {
              const col = colOfX[a], b = Math.min(i1, (col + 1) * S - 1);
              const n = b - a + 1;
              colInfill[colOfY[j] + col] += n;
              colDensity[colOfY[j] + col] += n * objects[0].infillDensity;
              colVotes[(colOfY[j] + col) * P + localPattern[0]] += n;
              a = b + 1;
            }
          } else {
            for (let i = i0; i <= i1; i++) {
              const col = colOfY[j] + colOfX[i];
              if (region[row + i] > 0) enterRegion(col, region[row + i] - 1, -1);
              region[row + i] = id;
              enterRegion(col, id - 1, 1);
            }
          }
        }
        xs.length = 0;
      }
    });

    // 2. The beads: perimeters and solid infill drawn as capsules of their width; every material
    //    extrusion adds its direction (and time) to the voxels it runs through.
    for (let e = layerStart[L], end = layerStart[L + 1]; e < end; e++) {
      const cls = roleClass[roleIndex[e]];
      if (cls === null) continue;
      const x0 = positions[e * 6], y0 = positions[e * 6 + 1], x1 = positions[e * 6 + 3], y1 = positions[e * 6 + 4];
      const w = width[e] > 0 ? sizeFromCode(width[e]) : fallbackWidth;
      const h = height[e] > 0 ? sizeFromCode(height[e]) : zTop - zBottom;
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      if (cls !== 'infill') {
        // In pieces no longer than a few cells, so a diagonal line does not test its whole bounding box.
        const r = w / 2, r2 = r * r, mark = cls === 'wall' ? WALL : SKIN;
        const pieces = Math.max(1, Math.ceil(Math.sqrt(len2) / Math.max(2 * r, 4 * p)));
        const pdx = dx / pieces, pdy = dy / pieces, plen2 = len2 / (pieces * pieces);
        for (let q = 0; q < pieces; q++) {
          const ax = x0 + q * pdx, ay = y0 + q * pdy, bx = ax + pdx, by = ay + pdy;
          const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - r - ox) / p - 0.5)), i1 = Math.min(cx - 1, Math.floor((Math.max(ax, bx) + r - ox) / p - 0.5));
          const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - r - oy) / p - 0.5)), j1 = Math.min(cy - 1, Math.floor((Math.max(ay, by) + r - oy) / p - 0.5));
          for (let j = j0; j <= j1; j++) {
            const py = oy + (j + 0.5) * p - ay;
            for (let i = i0; i <= i1; i++) {
              const px = ox + (i + 0.5) * p - ax;
              const t = plen2 > 0 ? Math.min(1, Math.max(0, (px * pdx + py * pdy) / plen2)) : 0;
              const ex = px - t * pdx, ey = py - t * pdy;
              if (ex * ex + ey * ey <= r2) markCell(i, j, mark);
            }
          }
        }
      }
      if (len2 === 0) continue;
      const len = Math.sqrt(len2);
      const volume = len * w * h;
      const cos2 = (dx * dx - dy * dy) / len2, sin2 = (2 * dx * dy) / len2;
      const zc = Math.min(zTop, Math.max(zBottom, positions[e * 6 + 5] - h / 2));
      const k = Math.min(nz - 1, Math.floor(zc / v));
      const s = slab(k);
      const pieces = Math.max(1, Math.ceil(len / (0.5 * v)));
      const duration = feedrate !== undefined && feedrate[e] > 0 ? len / feedrate[e] : 0;
      for (let q = 0; q < pieces; q++) {
        const f = (q + 0.5) / pieces;
        const i = Math.floor((x0 + f * dx - ox) / v), j = Math.floor((y0 + f * dy - oy) / v);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const c = j * nx + i, part = volume / pieces;
        s.cos[c] += part * cos2;
        s.sin[c] += part * sin2;
        s.volume[c] += part;
        if (s.time !== null && time !== undefined) s.time[c] += part * (time[e] - (1 - f) * duration);
      }
    }

    // 3. Integrate the column counts over the slabs the layer overlaps.
    for (let k = Math.max(0, Math.floor(zBottom / v)); k < nz && k * v < zTop; k++) {
      const dz = Math.min(zTop, (k + 1) * v) - Math.max(zBottom, k * v);
      if (dz <= 0) continue;
      const f = (dz * p * p) / (v * v * v);
      const s = slab(k);
      for (let c = 0; c < columns; c++) {
        if (colWall[c] + colSkin[c] + colInfill[c] === 0) continue;
        s.wall[c] += colWall[c] * f;
        s.skin[c] += colSkin[c] * f;
        s.infill[c] += colInfill[c] * f;
        s.density[c] += colDensity[c] * f;
        for (let q = 0; q < P; q++) s.votes[c * P + q] += colVotes[c * P + q] * f;
      }
    }
  }
  for (const k of [...slabs.keys()].sort((a, b) => a - b)) finish(k);

  const filament = src.filaments[0] ?? {};
  const description: SliceFieldDescription = {
    origin: [ox, oy, 0],
    voxelSize: v,
    dims: [nx, ny, nz],
    buildDirection: [0, 0, 1],
    gravity: printerGravity(src.machine.printer_notes),
    material: { type: text(filament.filament_type) ?? 'PLA', name: text(filament.name) || null, vendor: text(filament.filament_vendor) || null },
    layerHeight: number(text(src.process.layer_height), 0),
    firstLayerHeight: number(text(src.process.initial_layer_print_height), 0),
    layerCount,
    layerZ: Array.from(layerZ, (z) => Math.round(z * 1e4) / 1e4),
    infillPatterns: patterns,
    objects,
    ...(src.generator !== undefined ? { generator: src.generator } : {}),
  };
  return { description, arrays };
}
