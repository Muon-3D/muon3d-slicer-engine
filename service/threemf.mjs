// A minimal 3MF reader for the slice job service: the meshes of every build item, transforms applied, as a triangle
// soup (9 floats per triangle). Enough for single-material parts from CAD exporters; components, colours and
// slicer settings in the archive are ignored. Node's zlib only, no dependencies.
import zlib from 'node:zlib';

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** The archive's entries by name (central directory first, as the format intends). */
export function unzip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a 3MF (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (size > MAX_ENTRY_BYTES) throw new Error(`3MF entry ${name} is too large`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    entries.set(name, () => method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : (() => { throw new Error(`unsupported zip method ${method}`); })());
  }
  return entries;
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function matrix(text) {
  if (!text) return null;
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) throw new Error('bad 3MF transform');
  return v; // m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row vectors, as 3MF writes them)
}

function apply(m, x, y, z) {
  if (!m) return [x, y, z];
  return [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]];
}

export function read3mf(bytes) {
  const entries = unzip(bytes);
  const modelName = [...entries.keys()].find((n) => /^\/?3D\/[^/]+\.model$/i.test(n));
  if (!modelName) throw new Error('3MF has no 3D/*.model part');
  const xml = entries.get(modelName)().toString('utf8');
  const meshes = new Map();
  for (const obj of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attrs(obj[1]).id;
    const body = obj[2];
    const vertices = [...body.matchAll(/<vertex\b([^>]*?)\/?>/g)].map((m) => { const a = attrs(m[1]); return [Number(a.x), Number(a.y), Number(a.z)]; });
    const triangles = [...body.matchAll(/<triangle\b([^>]*?)\/?>/g)].map((m) => { const a = attrs(m[1]); return [Number(a.v1), Number(a.v2), Number(a.v3)]; });
    if (triangles.length) meshes.set(id, { vertices, triangles });
  }
  const items = [...xml.matchAll(/<item\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]));
  const placed = items.length ? items.map((a) => [meshes.get(a.objectid), matrix(a.transform)]) : [...meshes.values()].map((m) => [m, null]);
  const out = [];
  for (const [mesh, m] of placed) {
    if (!mesh) continue;
    for (const [a, b, c] of mesh.triangles) {
      for (const i of [a, b, c]) {
        const v = mesh.vertices[i];
        if (!v) throw new Error(`3MF triangle refers to vertex ${i}, which does not exist`);
        out.push(...apply(m, v[0], v[1], v[2]));
      }
    }
  }
  return new Float32Array(out);
}
