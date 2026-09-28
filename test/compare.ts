// Slices the same plates with the engine and with a native OrcaSlicer CLI, and compares the results.
//
//   ORCA_EXE=path/to/orca-slicer node test/compare.ts            # both sides
//   ORCA_EXE=path/to/orca-slicer node test/compare.ts --cli-only # only the CLI side (checks the setup)
//
// The CLI is run the way Orca's one-plate CLI path is driven for the engine's bridge: the flattened
// presets as --load-settings / --load-filaments, the objects as STL files already placed on the bed,
// `--arrange 0 --slice 0`. Like the CLI needs, the process preset is pinned to the printer by name.
//
// With a CLI built from another Orca commit than the engine (an older release, say) the G-code
// differs, so the comparison is deliberately loose: layer count within 1, print time within 10 %,
// filament within 5 %, max Z within 0.05 mm. Byte parity against a CLI built from the same commit is
// the job of a parity suite (docs/WASM_ENGINE_SPEC.md §8). Exits 1 when a plate is outside the
// tolerances or either side fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runSlice } from '../host/src/bridge.ts';
import type { GcodeStats } from '../packages/protocol/src/index.ts';
import { M1, benchy, benchyAvailable, cube, engineBuilt, engineModulePath, m1Presets, ms, outDir, presetNames, sliceJob, startEngine, type Presets } from './fixtures.ts';
import { parseStatsText } from './helpers/gcodeStats.ts';
import { pinProcessToPrinterName } from './helpers/overrides.ts';
import { writeStl } from './helpers/stl.ts';

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

const FILES = { machine: 'cfg/machine.json', process: 'cfg/process.json', filament: 'cfg/filament.json', log: 'orca.log', out: 'out', gcode: 'out/plate_1.gcode' };

/** Orca's exit codes are small negative numbers; Windows reports them as large unsigned ones. */
const signedExitCode = (code: number) => (code > 0x7fffffff ? code - 2 ** 32 : code);

/** The stats of a G-code file, from its first 16 KB and last 512 KB. */
function statsOfFile(file: string): GcodeStats {
  const text = readFileSync(file, 'utf8');
  return parseStatsText(text.slice(0, 16 * 1024), text.slice(Math.max(0, text.length - 512 * 1024)));
}

function sliceWithCli(plate: Plate, presets: Presets): { stats: GcodeStats; wallMs: number } {
  const exe = process.env.ORCA_EXE;
  if (!exe) throw new Error('set ORCA_EXE to an OrcaSlicer executable (the CLI to compare with)');
  const dir = path.join(outDir, 'compare', plate.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'cfg'), { recursive: true });
  mkdirSync(path.join(dir, FILES.out), { recursive: true });
  const processPreset = pinProcessToPrinterName(presets.process, presetNames(M1).machine);
  writeFileSync(path.join(dir, FILES.machine), JSON.stringify(presets.machine, null, 2));
  writeFileSync(path.join(dir, FILES.process), JSON.stringify(processPreset, null, 2));
  writeFileSync(path.join(dir, FILES.filament), JSON.stringify(presets.filaments[0], null, 2));
  for (const object of plate.objects) writeFileSync(path.join(dir, object.name), writeStl(object.positions));

  const args = [
    '--debug', '4',
    '--logfile', FILES.log,
    // A data folder of its own, so the CLI never reads or changes the user's Orca settings.
    '--datadir', path.join(dir, 'datadir'),
    '--load-settings', `${FILES.machine};${FILES.process}`,
    '--load-filaments', FILES.filament,
    // The objects arrive placed in bed coordinates; Orca's arranger would move them.
    '--arrange', '0',
    '--slice', '0',
    '--outputdir', FILES.out,
    ...plate.objects.map((o) => o.name),
  ];
  const started = performance.now();
  const run = spawnSync(exe, args, { cwd: dir, windowsHide: true, timeout: 15 * 60_000, stdio: 'ignore' });
  const wallMs = performance.now() - started;
  if (run.error) throw new Error(`${exe} could not be run: ${run.error.message}`);
  const code = run.status === null ? null : signedExitCode(run.status);
  if (code !== 0) throw new Error(`the CLI exited with ${code ?? run.signal} (log: ${path.join(dir, FILES.log)})`);
  return { stats: statsOfFile(path.join(dir, FILES.gcode)), wallMs };
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
  else console.log('# No Benchy STL (ENGINE_TEST_BENCHY): comparing the cube only.');
  return list;
}

/** Runs only the CLI side, to check the reference setup without an engine build. */
async function cliOnly(): Promise<number> {
  const presets = await m1Presets();
  for (const plate of await plates()) {
    const cli = sliceWithCli(plate, presets);
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

    let cli: { stats: GcodeStats; wallMs: number };
    try {
      cli = sliceWithCli(plate, presets);
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
