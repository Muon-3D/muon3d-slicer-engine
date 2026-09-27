// STL files for the example: binary or ASCII STL to a triangle soup (9 floats per triangle, in file
// order), a box, and the placement the engine expects (objects rest on z = 0 in bed coordinates).

/** The triangles of an STL file (binary or ASCII), 9 floats (3 vertices × xyz) each, in file order. */
export function parseStl(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // A binary STL is exactly 84 bytes plus 50 per triangle ("solid" at the start does not decide it).
  if (data.byteLength >= 84 && data.byteLength === 84 + view.getUint32(80, true) * 50) {
    const count = view.getUint32(80, true);
    const out = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12; // after the facet normal
      for (let i = 0; i < 9; i++) out[t * 9 + i] = view.getFloat32(base + i * 4, true);
    }
    return out;
  }
  const values = [];
  for (const m of new TextDecoder().decode(data).matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/gm)) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (values.length === 0 || values.length % 9 !== 0) throw new Error('not an STL file: no triangles found');
  return new Float32Array(values);
}

/** A box of `size` mm, centred on the origin in X and Y, standing on z = 0. */
export function box(size) {
  const [sx, sy, sz] = size;
  const [x0, x1, y0, y1] = [-sx / 2, sx / 2, -sy / 2, sy / 2];
  const v = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, sz], [x1, y0, sz], [x1, y1, sz], [x0, y1, sz]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(faces.flatMap((face) => face.flatMap((i) => v[i])));
}

/** A copy of the mesh centred on (x, y) and resting on z = 0. */
export function placeOnBed(positions, [x, y]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  const shift = [x - (min[0] + max[0]) / 2, y - (min[1] + max[1]) / 2, -min[2]];
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = positions[i + a] + shift[a];
  return out;
}
