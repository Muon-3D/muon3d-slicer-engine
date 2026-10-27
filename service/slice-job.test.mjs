// The slice job service, end to end: the real engine runtime slices real models, and the answers are checked by
// what they say about the print, not by how the code is written.
//   SLICE_JOB_RUNTIME=<runtime folder> node --test service/slice-job.test.mjs
// Skipped when no runtime is given (CI builds one in the runtime job).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { box } from '../examples/node-cli/stl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.env.SLICE_JOB_RUNTIME;
const skip = runtime ? false : 'SLICE_JOB_RUNTIME is not set';

function stl(positions) {
  const n = positions.length / 9;
  const b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let i = 0; i < 9; i++) b.writeFloatLE(positions[t * 9 + i], 84 + t * 50 + 12 + i * 4);
  return b;
}

/** A one-object 3MF holding the soup as an indexed mesh, with a build transform that moves it 50 mm in X. */
function threemf(positions) {
  const verts = [], tris = [];
  for (let i = 0; i < positions.length; i += 3) verts.push(`<vertex x="${positions[i]}" y="${positions[i + 1]}" z="${positions[i + 2]}"/>`);
  for (let t = 0; t < positions.length / 9; t++) tris.push(`<triangle v1="${3 * t}" v2="${3 * t + 1}" v3="${3 * t + 2}"/>`);
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`
    + `<resources><object id="1" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object></resources>`
    + `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></build></model>`;
  return zip({ '[Content_Types].xml': '<Types/>', '3D/3dmodel.model': model });
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), packed = deflateRawSync(data), nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function run(job) {
  const p = spawnSync(process.execPath, [path.join(here, 'slice-job.mjs'), '--runtime', runtime], {
    input: JSON.stringify(job), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300_000,
  });
  return JSON.parse(p.stdout.trim().split('\n').at(-1));
}

const cube = box([20, 20, 20]);

test('a 20 mm cube on the M1 preset: 100 layers of 0.2 mm, to 20 mm, with a source offer', { skip }, () => {
  const a = run({ model: { format: 'stl', data: stl(cube).toString('base64') }, preset: 'muon3d-m1-0.4', name: 'cube' });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(a.stats.layers, 100);
  assert.equal(a.stats.maxZ, 20);
  // A 20 mm cube at 15 % infill and 2 walls takes metres, not centimetres or kilometres, of filament.
  assert.ok(a.stats.filamentMm > 500 && a.stats.filamentMm < 5000, `${a.stats.filamentMm} mm`);
  assert.ok(a.stats.printTimeSeconds > 120 && a.stats.printTimeSeconds < 3600, a.stats.printTimeText);
  const gcode = Buffer.from(a.gcode, 'base64').toString('utf8');
  assert.match(gcode, /^;LAYER_CHANGE/m);
  assert.equal(a.source.licence, 'AGPL-3.0-only');
  assert.match(a.source.repository, /muon3d-slicer-engine/);
  assert.equal(a.preset.names.machine, 'Muon3D M1 0.4 nozzle');
});

test('the same cube as a 3MF slices to the same print (placement is the bed centre either way)', { skip }, () => {
  const s = run({ model: { format: 'stl', data: stl(cube).toString('base64') }, preset: 'muon3d-m1-0.4', name: 'cube' });
  const m = run({ model: { format: '3mf', data: threemf(cube).toString('base64') }, preset: 'muon3d-m1-0.4', name: 'cube' });
  assert.equal(m.ok, true, JSON.stringify(m.error));
  for (const k of ['layers', 'printTimeSeconds', 'filamentMm', 'maxZ']) assert.equal(m.stats[k], s.stats[k], k);
});

test('a taller part takes proportionally more layers', { skip }, () => {
  const a = run({ model: { format: 'stl', data: stl(box([10, 10, 30])).toString('base64') }, preset: 'muon3d-m1-0.4' });
  assert.equal(a.stats.layers, 150);
});

for (const [name, job, pattern] of [
  ['an unknown preset', { model: { format: 'stl', data: stl(cube).toString('base64') }, preset: 'nope' }, /unknown preset/],
  ['a preset path', { model: { format: 'stl', data: stl(cube).toString('base64') }, preset: '../../package' }, /preset name/],
  ['not a model', { model: { format: 'stl', data: Buffer.from('hello').toString('base64') } }, /not an STL/],
  ['a broken 3MF', { model: { format: '3mf', data: Buffer.from('PK nope').toString('base64') } }, /zip/],
  ['an unknown format', { model: { format: 'obj', data: '' } }, /3mf or stl/],
]) {
  test(`refuses ${name}`, { skip }, () => {
    const a = run(job);
    assert.equal(a.ok, false);
    assert.match(a.error.message, pattern);
    assert.equal(a.source.licence, 'AGPL-3.0-only');
  });
}
