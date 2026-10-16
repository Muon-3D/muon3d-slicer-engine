// `node tools/slice-field/bench.ts [size mm]`: the slice field's build time and file size for a cube (default
// 100 mm, the M1 process, 2 walls, 20 % gyroid) at 1 mm and 0.5 mm voxels, against the slice itself.
// Needs the built engine (dist/, or ENGINE_DIR).
import { runSlice } from '../../host/src/bridge.ts';
import { buildSliceField } from '../../host/src/sliceField.ts';
import { encodeSliceField } from '../../packages/protocol/src/sliceField.ts';
import { cube, m1Presets, sliceJob, startEngine } from '../../test/fixtures.ts';

const size = Number(process.argv[2] ?? 100);
const [{ engine }, presets] = await Promise.all([startEngine(), m1Presets()]);
const job = sliceJob(
  { ...presets, process: { ...presets.process, wall_loops: '2', sparse_infill_density: '20%', sparse_infill_pattern: 'gyroid' } },
  [{ name: 'Cube.stl', positions: cube([100, 90], size) }],
);
let started = performance.now();
const out = runSlice(engine, job);
console.log(`${size} mm cube: slice ${(performance.now() - started).toFixed(0)} ms, ${out.toolpaths!.extrusions.count} extrusions, ${out.toolpaths!.layerCount} layers`);
for (const voxelSize of [1, 0.5]) {
  for (const depositionTime of [false, true]) {
    const runs: number[] = [];
    let bytes = 0;
    for (let n = 0; n < 3; n++) {
      started = performance.now();
      const { description, arrays } = buildSliceField({ ...job, toolpaths: out.toolpaths!, extras: out.toolpathExtras, request: { voxelSize, depositionTime } });
      bytes = encodeSliceField(description, arrays).length;
      runs.push(performance.now() - started);
    }
    const median = runs.sort((a, b) => a - b)[1];
    console.log(`  ${voxelSize} mm${depositionTime ? ' + depositionTime' : ''}: ${median.toFixed(0)} ms (median of 3), ${bytes} bytes (${(bytes / 2 ** 20).toFixed(2)} MiB)`);
  }
}
