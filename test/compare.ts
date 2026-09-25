// Slices the same plates with the browser engine and with the server's OrcaSlicer CLI, invoked
// exactly as server/jobs.ts does, and compares the results.
//
//   node engine/test/compare.ts                 # CLI from server/config.ts (ORCA_EXE / ORCA_DIR)
//   ORCA_EXE=path/to/orca-slicer.exe node engine/test/compare.ts
//   node engine/test/compare.ts --cli-only      # only the CLI side (checks the reference setup)
//
// The server's CLI is a different Orca build (the muon3d-m1 release) than the engine (branch
// muon3d-wasm), so the comparison is deliberately loose: layer count within 1, print time within
// 10 %, filament within 5 %, max Z within 0.05 mm. Byte parity against a CLI built from the same
// commit is the job of the parity suite (docs/WASM_ENGINE_SPEC.md §8). Both get the same flattened
// presets; like the server, the CLI's process preset is pinned to the printer by name. Exits 1
// when a plate is outside the tolerances or either side fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GcodeStats } from '../../shared/types.ts';
import { runSlice } from '../../web/src/engine/worker.ts';
import { M1, benchy, benchyAvailable, cube, engineBuilt, engineModulePath, m1Presets, ms, outDir, sliceJob, startEngine, type Presets } from './fixtures.ts';

interface Plate {
  name: string;
  objects: Array<{ name: string; positions: Float32Array }>;
}

interface Tolerance {
  field: keyof GcodeStats;
  /** Accepted difference: absolute, or relative to the CLI's value. */
  absolute?: number;
  relative?: number;
}

const TOLERANCES: Tolerance[] = [
  { field: 'layers', absolute: 1 },
  { field: 'maxZ', absolute: 0.05 },
  { field: 'printTimeSeconds', relative: 0.1 },
  { field: 'filamentMm', relative: 0.05 },
  { field: 'filamentG', relative: 0.05 },
];

async function sliceWithCli(plate: Plate, presets: Presets): Promise<{ stats: GcodeStats; wallMs: number }> {
  // Imported late: server/config.ts reads the environment once, after fixtures.ts has set it up.
  const { config } = await import('../../server/config.ts');
  const { buildOrcaArgs, ORCA_FILES, normalizeExitCode } = await import('../../server/orca.ts');
  const { writeBinaryStl } = await import('../../server/meshio.ts');
  const { pinProcessToPrinter } = await import('../../server/profiles.ts');
  const { parseGcodeStats } = await import('../../server/gcodeStats.ts');

  const dir = path.join(outDir, 'compare', plate.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'cfg'), { recursive: true });
  mkdirSync(path.join(dir, ORCA_FILES.outDir), { recursive: true });
  const processPreset = await pinProcessToPrinter(presets.process, { vendor: M1.vendor, name: M1.machine });
  writeFileSync(path.join(dir, ORCA_FILES.machineCfg), JSON.stringify(presets.machine, null, 2));
  writeFileSync(path.join(dir, ORCA_FILES.processCfg), JSON.stringify(processPreset, null, 2));
  writeFileSync(path.join(dir, ORCA_FILES.filamentCfg), JSON.stringify(presets.filaments[0], null, 2));
  for (const object of plate.objects) writeFileSync(path.join(dir, object.name), writeBinaryStl(object.positions));

  const args = buildOrcaArgs({ datadir: path.join(dir, 'datadir'), inputs: plate.objects.map((o) => o.name), exportProject: false });
  const started = performance.now();
  const run = spawnSync(config.orcaExe, args, { cwd: dir, windowsHide: true, timeout: 15 * 60_000, stdio: 'ignore' });
  const wallMs = performance.now() - started;
  if (run.error) throw new Error(`${config.orcaExe} could not be run: ${run.error.message}`);
  const code = run.status === null ? null : normalizeExitCode(run.status);
  if (code !== 0) throw new Error(`the CLI exited with ${code ?? run.signal} (log: ${path.join(dir, ORCA_FILES.log)})`);
  return { stats: await parseGcodeStats(path.join(dir, ORCA_FILES.gcode)), wallMs };
}

function withinTolerance(tolerance: Tolerance, engine: number | null, cli: number | null): boolean {
  if (engine === null || cli === null) return false;
  const difference = Math.abs(engine - cli);
  if (tolerance.absolute !== undefined) return difference <= tolerance.absolute;
  return difference <= Math.abs(cli) * (tolerance.relative ?? 0);
}

async function plates(): Promise<Plate[]> {
  const list: Plate[] = [{ name: 'cube', objects: [{ name: 'Cube.stl', positions: cube([100, 90]) }] }];
  if (benchyAvailable) list.push({ name: 'benchy', objects: [{ name: 'Benchy.stl', positions: await benchy([100, 90]) }] });
  else console.log('# data/samples/benchy-raw.stl not found: comparing the cube only.');
  return list;
}

/** Runs only the CLI side, to check the reference setup without an engine build. */
async function cliOnly(): Promise<number> {
  const presets = await m1Presets();
  for (const plate of await plates()) {
    const cli = await sliceWithCli(plate, presets);
    console.log(`${plate.name}: CLI ${ms(cli.wallMs)}`, cli.stats);
  }
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--cli-only')) return cliOnly();
  if (!engineBuilt) {
    console.error(`${engineModulePath} not found: build the engine first.`);
    return 1;
  }
  const { engine, initMs } = await startEngine();
  console.log(`engine ready in ${ms(initMs)}: OrcaSlicer ${engine.version().orcaVersion} (${engine.version().orcaCommit})`);
  const presets = await m1Presets();

  let ok = true;
  for (const plate of await plates()) {
    console.log(`\n== ${plate.name}`);
    const started = performance.now();
    const output = runSlice(engine, sliceJob(presets, plate.objects, false));
    const engineMs = performance.now() - started;
    mkdirSync(path.join(outDir, 'compare', plate.name), { recursive: true });

    let cli: { stats: GcodeStats; wallMs: number };
    try {
      cli = await sliceWithCli(plate, presets);
    } catch (err) {
      console.error(`CLI failed: ${(err as Error).message}`);
      ok = false;
      continue;
    }
    writeFileSync(path.join(outDir, 'compare', plate.name, 'engine.gcode'), output.gcode);

    const rows = TOLERANCES.map((tolerance) => {
      const e = output.stats[tolerance.field] as number | null;
      const c = cli.stats[tolerance.field] as number | null;
      const pass = withinTolerance(tolerance, e, c);
      ok &&= pass;
      return {
        field: tolerance.field,
        engine: e,
        cli: c,
        difference: e !== null && c !== null ? `${(((e - c) / (c || 1)) * 100).toFixed(2)} %` : '-',
        allowed: tolerance.absolute !== undefined ? `±${tolerance.absolute}` : `±${(tolerance.relative ?? 0) * 100} %`,
        pass,
      };
    });
    console.table(rows);
    console.log(`print time text: engine ${output.stats.printTimeText}, CLI ${cli.stats.printTimeText}`);
    console.log(`wall time: engine ${ms(engineMs)} (slice ${ms(output.timings.slice)}), CLI ${ms(cli.wallMs)}`);
  }
  console.log(ok ? '\nAll plates within tolerance.' : '\nSome plates are outside the tolerances (see above).');
  return ok ? 0 : 1;
}

process.exitCode = await main();
