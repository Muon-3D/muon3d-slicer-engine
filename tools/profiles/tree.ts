// The profile tree a set is built from: OrcaSlicer's resources/profiles at the pin (orca/), with the vendors of an
// overlay (profiles/muon3d/) in place of Orca's. Each vendor is a folder as OrcaSlicer holds it: <id>.json, the
// index, and the files its lists name, under <id>/.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PresetScope } from '../../packages/protocol/src/data.ts';
import type { ProfileFolder } from '../../packages/protocol/src/profiles.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LIBRARY = 'OrcaFilamentLibrary';

export const LISTS = {
  machine_model: 'machine_model_list',
  machine: 'machine_list',
  process: 'process_list',
  filament: 'filament_list',
} as const;

export interface VendorSource {
  folder: ProfileFolder;
  /** The folder on disk (<root>/<id>), where the assets are. */
  dir: string;
  /** Whether it comes from the overlay. */
  overlay: boolean;
}

export interface ListEntry {
  name: string;
  subPath: string;
}

/** The { name, sub_path } entries of one list of a vendor index. */
export function listOf(index: Record<string, unknown>, type: PresetScope | 'machine_model'): ListEntry[] {
  const list = index[LISTS[type]];
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is { name: string; sub_path: string } => !!e && typeof e.name === 'string' && typeof e.sub_path === 'string')
    .map((e) => ({ name: e.name, subPath: e.sub_path }));
}

/** The vendor ids of a profiles folder: every <id>.json with a folder <id>/ next to it. */
export function vendorIds(root: string): string[] {
  return readdirSync(root)
    .filter((f) => f.endsWith('.json') && existsSync(path.join(root, f.slice(0, -'.json'.length))))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => statSync(path.join(root, id)).isDirectory())
    .sort();
}

/** Reads one vendor folder: the index and every file its lists name. */
export function readFolder(root: string, id: string): ProfileFolder {
  const index = JSON.parse(readFileSync(path.join(root, `${id}.json`), 'utf8')) as Record<string, unknown>;
  const files: ProfileFolder['files'] = {};
  for (const type of Object.keys(LISTS) as Array<keyof typeof LISTS>) {
    for (const { subPath } of listOf(index, type)) {
      const file = path.join(root, id, subPath);
      try {
        files[subPath] = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`${id}: ${subPath}: ${(err as Error).message}`);
      }
    }
  }
  return { id, index, files };
}

export interface TreeOptions {
  /** OrcaSlicer's profiles folder (default orca/resources/profiles; ORCA_SRC names another checkout). */
  orcaProfiles?: string;
  /** Folders whose vendors replace Orca's (default profiles/muon3d). */
  overlays?: string[];
  /** Only these vendors (the library is always there). */
  vendors?: string[];
}

export function defaultOrcaProfiles(): string {
  return path.join(path.resolve(process.env.ORCA_SRC ?? path.join(repoRoot, 'orca')), 'resources/profiles');
}

export const DEFAULT_OVERLAY = path.join(repoRoot, 'profiles/muon3d');

/** Every vendor of the tree, the library first, then by id. */
export function readTree(options: TreeOptions = {}): VendorSource[] {
  const orca = options.orcaProfiles ?? defaultOrcaProfiles();
  if (!existsSync(orca)) throw new Error(`${orca} not found: check out the orca/ submodule (bash engine/scripts/get-orca.sh).`);
  const sources = new Map<string, { root: string; overlay: boolean }>();
  for (const id of vendorIds(orca)) sources.set(id, { root: orca, overlay: false });
  for (const overlay of options.overlays ?? [DEFAULT_OVERLAY]) {
    if (!existsSync(overlay)) continue;
    for (const id of vendorIds(overlay)) sources.set(id, { root: overlay, overlay: true });
  }
  if (!sources.has(LIBRARY)) throw new Error(`${orca} has no ${LIBRARY}.`);
  const wanted = options.vendors ? new Set([LIBRARY, ...options.vendors]) : null;
  if (wanted) for (const id of wanted) if (!sources.has(id)) throw new Error(`No vendor "${id}" in the tree.`);
  const ids = [...sources.keys()].filter((id) => !wanted || wanted.has(id)).sort((a, b) => (a === LIBRARY ? -1 : b === LIBRARY ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return ids.map((id) => {
    const { root, overlay } = sources.get(id)!;
    return { folder: readFolder(root, id), dir: path.join(root, id), overlay };
  });
}

/** Every file under a folder, as '/'-separated paths relative to it, sorted. */
export function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * A digest of a folder: sha256 of the lines "<sha256 of the file>  <path>\n" (sha256sum's format), sorted by path.
 * `skip` leaves files out (documentation).
 */
export function treeDigest(dir: string, skip: (rel: string) => boolean = () => false): string {
  const lines = filesUnder(dir)
    .filter((rel) => !skip(rel))
    .map((rel) => `${createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex')}  ${rel}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}
