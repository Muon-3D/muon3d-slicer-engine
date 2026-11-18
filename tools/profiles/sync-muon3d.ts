// The Muon3D vendor (profiles/muon3d) is a copy of the Muon3D folder of Muon-3D/OrcaSlicer's muon3d-m1 branch, the
// profiles the desktop OrcaSlicer build ships, at the commit muon3d-source.json pins. One set of files serves both
// slicers; this tool writes the copy, and with --check proves the committed copy is what it would write (CI runs it, so
// the two cannot drift apart unnoticed).
//
//   node tools/profiles/sync-muon3d.ts [--from <dir>] [--orca <dir>] [--check] [--latest]
//
// --from: a profiles folder holding Muon3D.json and Muon3D/ (default: fetched from the pinned commit with git, only
// that folder). --latest: the head of the source's branch instead of the pinned commit (the scheduled check that
// muon3d-m1 has not moved on without this repository; without --check it also pins that commit). --orca: the OrcaSlicer tree whose scripts/orca_profile_tool.py shapes the files (default: orca/, the
// engine's pin). The copy differs from its source in exactly these ways, each needed because the engine's OrcaSlicer
// (the muon3d-wasm branch: OrcaSlicer#13777, exclusion volumes) is not the desktop build's:
//
//   1. The M1's 3D exclusion zone. The desktop build reads it from `bed_exclude_area`, a point list with a Z range
//      ("0..5;119.5x0,..."); the engine's OrcaSlicer reads `bed_exclude_volumes`, the same text as one string, and
//      keeps `bed_exclude_area` for 2D areas. A `bed_exclude_area` entry with a Z range moves to `bed_exclude_volumes`.
//      (Once muon3d-m1 takes #13777's option, this step is a no-op and can go.)
//   2. The shape OrcaSlicer's own tools write at the engine's pin: orca_profile_tool.py `normalize` (key order,
//      vectors, keys that OrcaSlicer no longer reads) and `update-index` (the vendor index's lists).
//
// Every other byte of meaning comes from the fork. To change an M1 profile, change it in Muon-3D/OrcaSlicer
// (muon3d-m1), then point muon3d-source.json at the merged commit and run this tool without --check.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { repoRoot } from './tree.ts';

export interface Muon3dSource {
  repository: string;
  branch: string;
  commit: string;
  path: string;
}

const OVERLAY = path.join(repoRoot, 'profiles', 'muon3d');
const SOURCE_FILE = path.join(repoRoot, 'tools', 'profiles', 'muon3d-source.json');
/** Files of the overlay that are its own, not copies: kept as they are, never compared. */
const OWN = new Set(['README.md']);

/** A Z range at the start of an exclusion entry: "0..5;" (the desktop build's 3D syntax). */
const Z_RANGE = /^\s*-?\d+(?:\.\d+)?\.\.-?\d+(?:\.\d+)?;/;

/**
 * Step 1 on one machine file: a `bed_exclude_area` whose entries carry a Z range becomes `bed_exclude_volumes`.
 * Answers the file and whether it changed. Entries with and without a Z range in one list are refused: the engine
 * has no way to say both in one option, and the M1 has no such zone.
 */
export function moveExclusionVolumes(file: Record<string, unknown>): { file: Record<string, unknown>; changed: boolean } {
  const area = file.bed_exclude_area;
  if (!Array.isArray(area) || area.length === 0) return { file, changed: false };
  const ranged = area.filter((e) => typeof e === 'string' && Z_RANGE.test(e));
  if (ranged.length === 0) return { file, changed: false };
  if (ranged.length !== area.length) throw new Error(`bed_exclude_area mixes 3D and 2D entries in ${String(file.name)}: the engine cannot take both`);
  if (file.bed_exclude_volumes !== undefined) throw new Error(`${String(file.name)} has both bed_exclude_area with a Z range and bed_exclude_volumes`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(file)) {
    if (k === 'bed_exclude_area') {
      out.bed_exclude_area = [];
      out.bed_exclude_volumes = (ranged as string[]).join(';');
    } else out[k] = v;
  }
  return { file: out, changed: true };
}

const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The fork's Muon3D folder at the pinned commit, fetched with git (that folder only), into `dir`. */
function fetchSource(source: Muon3dSource, dir: string): string {
  const git = (...args: string[]) => run('git', args, dir);
  git('init', '-q');
  git('remote', 'add', 'origin', source.repository);
  git('config', 'core.sparseCheckout', 'true');
  writeFileSync(path.join(dir, '.git', 'info', 'sparse-checkout'), `/${source.path}/Muon3D/\n/${source.path}/Muon3D.json\n`);
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', source.commit);
  git('checkout', '-q', 'FETCH_HEAD');
  const got = git('rev-parse', 'HEAD').trim();
  if (got !== source.commit) throw new Error(`fetched ${got}, not the pinned ${source.commit}`);
  return path.join(dir, source.path);
}

/** Writes the copy of `from` (a folder with Muon3D.json and Muon3D/) into `out`, shaped by `orca`'s profile tool. */
export function buildCopy(from: string, out: string, orca: string): void {
  const tool = path.join(orca, 'scripts', 'orca_profile_tool.py');
  if (!existsSync(tool)) throw new Error(`no ${tool}: give --orca an OrcaSlicer tree (git submodule update --init orca)`);
  // The tool resolves inheritance across vendors, so it gets the library beside the vendor.
  const tree = mkdtempSync(path.join(tmpdir(), 'muon3d-tree-'));
  try {
    for (const name of ['OrcaFilamentLibrary', 'OrcaFilamentLibrary.json']) cpSync(path.join(orca, 'resources', 'profiles', name), path.join(tree, name), { recursive: true });
    cpSync(path.join(from, 'Muon3D'), path.join(tree, 'Muon3D'), { recursive: true });
    cpSync(path.join(from, 'Muon3D.json'), path.join(tree, 'Muon3D.json'));
    const machines = path.join(tree, 'Muon3D', 'machine');
    for (const f of readdirSync(machines).filter((f) => f.endsWith('.json'))) {
      const p = path.join(machines, f);
      const { file, changed } = moveExclusionVolumes(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>);
      if (changed) writeFileSync(p, `${JSON.stringify(file, null, '\t')}\n`);
    }
    const py = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    run(py, [tool, 'normalize', '--profiles', tree, '--vendor', 'Muon3D', '--force']);
    run(py, [tool, 'update-index', '--profiles', tree, '--vendor', 'Muon3D']);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(path.join(tree, 'Muon3D'), path.join(out, 'Muon3D'), { recursive: true });
    cpSync(path.join(tree, 'Muon3D.json'), path.join(out, 'Muon3D.json'));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/** Every file under `dir`, as paths relative to it with / separators. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

/** Text files compare with their line ends made LF (a Windows checkout may hold CRLF); others byte for byte. */
const content = (p: string) => (/\.(json|svg|txt|md)$/i.test(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : readFileSync(p));

/** The files that differ between two copies (missing on either side included). */
export function differences(a: string, b: string): string[] {
  const fa = new Set(filesUnder(a).filter((f) => !OWN.has(f)));
  const fb = new Set(filesUnder(b).filter((f) => !OWN.has(f)));
  const out: string[] = [];
  for (const f of [...new Set([...fa, ...fb])].sort()) {
    if (!fa.has(f) || !fb.has(f)) out.push(`${f}: only in ${fa.has(f) ? 'the committed copy' : 'the fork'}`);
    else {
      const x = content(path.join(a, f));
      const y = content(path.join(b, f));
      if (typeof x === 'string' ? x !== y : !(y instanceof Buffer && x.equals(y))) out.push(`${f}: differs`);
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { from: { type: 'string' }, orca: { type: 'string' }, check: { type: 'boolean' }, latest: { type: 'boolean' } } });
  const pinned = JSON.parse(readFileSync(SOURCE_FILE, 'utf8')) as Muon3dSource;
  let source = pinned;
  if (values.latest) {
    const head = run('git', ['ls-remote', pinned.repository, `refs/heads/${pinned.branch}`]).split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`${pinned.repository} has no branch ${pinned.branch}`);
    source = { ...pinned, commit: head };
  }
  const orca = path.resolve(values.orca ?? path.join(repoRoot, 'orca'));
  const scratch = mkdtempSync(path.join(tmpdir(), 'muon3d-sync-'));
  try {
    const from = values.from ? path.resolve(values.from) : fetchSource(source, scratch);
    const label = values.from ? from : `${source.repository} ${source.branch} @ ${source.commit.slice(0, 10)}`;
    const out = path.join(scratch, 'copy');
    buildCopy(from, out, orca);
    if (values.check) {
      const diff = differences(OVERLAY, out);
      if (diff.length) {
        if (values.latest) console.error(`${source.branch} has moved on to ${source.commit}, and its Muon3D folder is not what this repository builds. Pin it: node tools/profiles/sync-muon3d.ts --latest, then review and commit.`);
        console.error(`profiles/muon3d is not the copy of ${label}:\n  ${diff.join('\n  ')}\nChange the M1's profiles in Muon-3D/OrcaSlicer (muon3d-m1), pin the commit in tools/profiles/muon3d-source.json, and run node tools/profiles/sync-muon3d.ts.`);
        process.exit(1);
      }
      console.log(`profiles/muon3d is the copy of ${label}.`);
      return;
    }
    for (const f of readdirSync(OVERLAY)) if (!OWN.has(f)) rmSync(path.join(OVERLAY, f), { recursive: true, force: true });
    cpSync(out, OVERLAY, { recursive: true });
    if (source.commit !== pinned.commit) writeFileSync(SOURCE_FILE, `${JSON.stringify(source, null, '	')}
`);
    console.log(`profiles/muon3d written from ${label}.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
