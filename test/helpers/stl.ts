// A small STL reader and writer for the tests: binary and ASCII STL to a triangle soup (9 floats per
// triangle, in file order), and the placement the engine expects (objects rest on z = 0 in bed
// coordinates). Written for the engine repository; examples/node-cli carries its own copy so that it
// stays a standalone example.

/** The triangles of an STL file (binary or ASCII), 9 floats (3 vertices × xyz) each, in file order. */
export function parseStl(data: Uint8Array): Float32Array {
  if (isBinaryStl(data)) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(80, true);
    const out = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12; // after the facet normal
      for (let i = 0; i < 9; i++) out[t * 9 + i] = view.getFloat32(base + i * 4, true);
    }
    return out;
  }
  const text = new TextDecoder().decode(data);
  const values: number[] = [];
  for (const m of text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/gm)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (values.length === 0 || values.length % 9 !== 0) throw new Error('not an STL file: no triangles found');
  return new Float32Array(values);
}

/** A binary STL is exactly 84 bytes plus 50 per triangle ("solid" at the start does not decide it). */
function isBinaryStl(data: Uint8Array): boolean {
  if (data.byteLength < 84) return false;
  const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(80, true);
  return data.byteLength === 84 + count * 50;
}

/** A binary STL of a triangle soup (normals left zero: Orca recomputes them). */
export function writeStl(positions: Float32Array): Uint8Array {
  const count = positions.length / 9;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12;
    for (let i = 0; i < 9; i++) view.setFloat32(base + i * 4, positions[t * 9 + i], true);
  }
  return out;
}

/**
 * A copy of the mesh centred on (x, y) and resting on z = 0: how an app places an upload before it
 * hands the plate to the engine.
 */
export function placeOnBed(positions: Float32Array, center: [number, number]): Float32Array {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  const shift = [center[0] - (min[0] + max[0]) / 2, center[1] - (min[1] + max[1]) / 2, -min[2]];
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = positions[i + a] + shift[a];
  return out;
}
